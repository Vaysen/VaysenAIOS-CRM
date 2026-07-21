/**
 * Electron 本地服务器。
 *
 * - 仅监听 127.0.0.1，为 Next.js 静态导出提供同源页面；
 * - 将渲染层的相对 `/api` 请求转发到经过严格校验的局域网/ZeroTier 后端；
 * - 不把后端地址烘焙进前端静态资源，避免随机本地端口触发生产 CORS。
 */

import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import http from 'http';
import https from 'https';

const DYNAMIC_ROUTE_FALLBACKS: Array<{ pattern: RegExp; file: string }> = [
  { pattern: /^\/customers\/[^/]+\/?$/, file: path.join('customers', '__static.html') },
  { pattern: /^\/duplicate-leads\/[^/]+\/?$/, file: path.join('duplicate-leads', '__static.html') },
  { pattern: /^\/email-accounts\/[^/]+\/edit\/?$/, file: path.join('email-accounts', '__static', 'edit.html') },
  { pattern: /^\/emails\/[^/]+\/?$/, file: path.join('emails', '__static.html') },
  { pattern: /^\/email-templates\/[^/]+\/edit\/?$/, file: path.join('email-templates', '__static', 'edit.html') },
  { pattern: /^\/follow-ups\/[^/]+\/?$/, file: path.join('follow-ups', '__static.html') },
  { pattern: /^\/imports\/[^/]+\/?$/, file: path.join('imports', '__static.html') },
  { pattern: /^\/leads\/[^/]+\/edit\/?$/, file: path.join('leads', '__static', 'edit.html') },
  { pattern: /^\/leads\/[^/]+\/?$/, file: path.join('leads', '__static.html') },
  { pattern: /^\/orders\/[^/]+\/?$/, file: path.join('orders', '__static.html') },
  { pattern: /^\/products\/[^/]+\/edit\/?$/, file: path.join('products', '__static', 'edit.html') },
  { pattern: /^\/quotes\/[^/]+\/?$/, file: path.join('quotes', '__static.html') },
  { pattern: /^\/unsubscribe\/[^/]+\/?$/, file: path.join('unsubscribe', '__static.html') },
];

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** 固定回环端口，确保 Electron 重启后 localStorage/sessionStorage origin 不变。 */
export const LOCAL_SERVER_PORT = 47831;

function getDynamicRouteFallback(requestPath: string): string | null {
  const route = DYNAMIC_ROUTE_FALLBACKS.find((item) => item.pattern.test(requestPath));
  return route?.file || null;
}

function getExactExportedPage(frontendOutDir: string, requestPath: string): string | null {
  const relative = requestPath.replace(/^\/+|\/+$/g, '');
  if (!relative) return path.join(frontendOutDir, 'index.html');
  const segments = relative.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\0'))) {
    return null;
  }
  const root = path.resolve(frontendOutDir);
  const candidate = path.resolve(root, ...segments) + '.html';
  if (!candidate.startsWith(root + path.sep)) return null;
  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function normalizeApiBaseUrl(apiBaseUrl: string | null): URL | null {
  if (!apiBaseUrl) return null;
  const parsed = new URL(apiBaseUrl);
  parsed.pathname = parsed.pathname.replace(/\/$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed;
}

export class LocalServer {
  private server: http.Server | null = null;
  private port: number;
  private app = express();
  private readonly apiTarget: URL | null;

  constructor(
    apiBaseUrl: string | null = null,
    private readonly listenPort: number = LOCAL_SERVER_PORT,
  ) {
    this.apiTarget = normalizeApiBaseUrl(apiBaseUrl);
    this.port = listenPort;
  }

  private proxyBackend(req: Request, res: Response, targetBasePath: string): void {
    if (!this.apiTarget) {
      res.status(503).json({
        statusCode: 503,
        error: 'LAN_API_NOT_CONFIGURED',
        message: '局域网后端地址尚未配置',
      });
      return;
    }

    const expectedOrigin = this.getUrl();
    const requestOrigin = req.get('origin');
    if (requestOrigin && requestOrigin !== expectedOrigin) {
      res.status(403).json({
        statusCode: 403,
        error: 'LOCAL_PROXY_ORIGIN_REJECTED',
      });
      return;
    }

    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    for (const name of HOP_BY_HOP_HEADERS) delete headers[name];
    // 浏览器看到的是本机同源；后端不应再对随机 127.0.0.1 端口执行 CORS。
    delete headers.origin;
    delete headers.referer;
    headers.host = this.apiTarget.host;
    headers['x-forwarded-for'] = req.socket.remoteAddress || '127.0.0.1';
    headers['x-forwarded-proto'] = 'http';
    headers['x-vaysen-crm-client'] = 'electron-lan-proxy';

    // express app.use 会从 req.url 中移除挂载前缀；把剩余路径拼到
    // 对应的后端基路径。Range/流式响应由原始 headers + pipe 保留。
    const basePath = targetBasePath.replace(/\/$/, '');
    const suffix = req.url.startsWith('/') ? req.url : `/${req.url}`;
    const requestPath = `${basePath}${suffix}` || '/';
    const transport = this.apiTarget.protocol === 'https:' ? https : http;

    const upstream = transport.request(
      {
        protocol: this.apiTarget.protocol,
        hostname: this.apiTarget.hostname,
        port: this.apiTarget.port || undefined,
        method: req.method,
        path: requestPath,
        headers,
        agent: false,
      },
      (upstreamResponse) => {
        res.status(upstreamResponse.statusCode || 502);
        for (const [name, value] of Object.entries(upstreamResponse.headers)) {
          if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) {
            res.setHeader(name, value);
          }
        }
        upstreamResponse.pipe(res);
      },
    );

    upstream.on('error', (error) => {
      console.error(`[LocalServer] 局域网后端代理失败: ${error.message}`);
      if (!res.headersSent) {
        res.status(502).json({
          statusCode: 502,
          error: 'LAN_API_UNREACHABLE',
          message: '无法连接局域网后端，请检查 ZeroTier 与服务器状态',
        });
      } else {
        res.end();
      }
    });

    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  }

  /** 启动本地静态服务器并返回系统分配的端口。 */
  async start(frontendOutDir: string): Promise<number> {
    return new Promise((resolve, reject) => {
      // API 必须早于静态资源与 SPA 回退注册。
      this.app.use('/api', (req, res) => this.proxyBackend(req, res, this.apiTarget?.pathname || '/api'));
      this.app.use('/uploads', (req, res) => this.proxyBackend(req, res, '/uploads'));
      this.app.use('/customizer-assets', (req, res) => this.proxyBackend(req, res, '/customizer-assets'));

      // Next static export emits route.html files. Resolve these before
      // express.static sees same-named directories and issues a wrong 301.
      this.app.get('*', (req, res, next) => {
        const exactPage = getExactExportedPage(frontendOutDir, req.path);
        if (exactPage) return res.sendFile(exactPage);
        return next();
      });

      this.app.use(express.static(frontendOutDir, {
        index: 'index.html',
        fallthrough: true,
        redirect: false,
      }));

      this.app.get('*', (req, res) => {
        if (req.path.startsWith('/_next/') || req.path.startsWith('/favicon')) {
          return res.status(404).send('Not found');
        }
        const dynamicFallback = getDynamicRouteFallback(req.path);
        if (dynamicFallback) {
          return res.sendFile(path.join(frontendOutDir, dynamicFallback));
        }
        const notFound = path.join(frontendOutDir, '404.html');
        return res.status(404).sendFile(notFound, (error) => {
          if (error && !res.headersSent) res.status(404).send('Not found');
        });
      });

      this.server = this.app.listen(this.listenPort, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
          console.log(`[LocalServer] 前端服务启动: ${this.getUrl()}`);
          resolve(this.port);
        } else {
          reject(new Error('无法获取分配的端口'));
        }
      });

      this.server.on('error', (err) => {
        console.error('[LocalServer] 启动失败:', err);
        reject(err);
      });
    });
  }

  getUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        console.log('[LocalServer] 服务已停止');
        this.server = null;
        resolve();
      });
    });
  }
}
