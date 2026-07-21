/**
 * 主进程单元测试
 *
 * 测试范围：
 * - LocalServer 启动和停止
 * - IPC 通道定义完整性
 * - AICommunications 模块方法存在性
 * - WindowManager 多账号逻辑（mock）
 */

import express from 'express';
import http from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';
import axios from 'axios';

// ── Mock electron 模块 ────────────────────────────────────────

jest.mock('electron', () => ({
  app: {
    getVersion: jest.fn(() => '1.0.0'),
    getPath: jest.fn((name: string) => {
      const paths: Record<string, string> = {
        userData: path.join(os.tmpdir(), 'vaysen-crm-test'),
        temp: os.tmpdir(),
      };
      return paths[name] || path.join(os.tmpdir(), 'vaysen-crm-test');
    }),
    requestSingleInstanceLock: jest.fn(() => true),
    quit: jest.fn(),
    whenReady: jest.fn(() => Promise.resolve()),
    on: jest.fn(),
    once: jest.fn(),
  },
  BrowserWindow: jest.fn().mockImplementation(() => ({
    loadURL: jest.fn(),
    show: jest.fn(),
    hide: jest.fn(),
    focus: jest.fn(),
    close: jest.fn(),
    minimize: jest.fn(),
    maximize: jest.fn(),
    unmaximize: jest.fn(),
    isMaximized: jest.fn(() => false),
    isMinimized: jest.fn(() => false),
    isVisible: jest.fn(() => true),
    isDestroyed: jest.fn(() => false),
    restore: jest.fn(),
    getBounds: jest.fn(() => ({ x: 0, y: 0, width: 1440, height: 900 })),
    getContentSize: jest.fn(() => [1440, 900]),
    webContents: {
      send: jest.fn(),
      openDevTools: jest.fn(),
      loadURL: jest.fn(),
      executeJavaScript: jest.fn(() => Promise.resolve()),
      setUserAgent: jest.fn(),
      setWindowOpenHandler: jest.fn(),
      on: jest.fn(),
      once: jest.fn(),
    },
    contentView: {
      addChildView: jest.fn(),
      removeChildView: jest.fn(),
    },
    on: jest.fn(),
    once: jest.fn(),
    off: jest.fn(),
  })),
  WebContentsView: jest.fn().mockImplementation(() => ({
    webContents: {
      loadURL: jest.fn(),
      setUserAgent: jest.fn(),
      executeJavaScript: jest.fn(() => Promise.resolve()),
      setWindowOpenHandler: jest.fn(),
      on: jest.fn(),
      once: jest.fn(),
    },
    setBounds: jest.fn(),
    getBounds: jest.fn(() => ({ x: 0, y: 0, width: 0, height: 0 })),
  })),
  ipcMain: {
    handle: jest.fn(),
    on: jest.fn(),
    once: jest.fn(),
    off: jest.fn(),
    removeAllListeners: jest.fn(),
    removeHandler: jest.fn(),
  },
  safeStorage: {
    isEncryptionAvailable: jest.fn(() => true),
    encryptString: jest.fn((s: string) => Buffer.from(`enc:${s}`, 'utf8')),
    decryptString: jest.fn((b: Buffer) => {
      const str = b.toString('utf8');
      return str.startsWith('enc:') ? str.slice(4) : str;
    }),
  },
  Tray: jest.fn().mockImplementation(() => ({
    setToolTip: jest.fn(),
    setContextMenu: jest.fn(),
    on: jest.fn(),
    destroy: jest.fn(),
  })),
  Menu: {
    buildFromTemplate: jest.fn(() => ({})),
  },
  nativeImage: {
    createFromPath: jest.fn(() => ({ isEmpty: () => false })),
    createEmpty: jest.fn(() => ({ isEmpty: () => true })),
  },
  shell: {
    openExternal: jest.fn(),
  },
}));

// ── Mock electron-store ───────────────────────────────────────

jest.mock('electron-store', () => {
  return jest.fn().mockImplementation((options?: any) => {
    const defaults = options?.defaults || {};
    let data = { ...defaults };

    return {
      get: (key: string) => {
        return key.split('.').reduce((obj: any, k: string) => obj?.[k], data);
      },
      set: (key: string | object, value?: any) => {
        if (typeof key === 'string') {
          const keys = key.split('.');
          let obj: any = data;
          for (let i = 0; i < keys.length - 1; i++) {
            if (!obj[keys[i]]) obj[keys[i]] = {};
            obj = obj[keys[i]];
          }
          obj[keys[keys.length - 1]] = value;
        } else {
          Object.assign(data, key);
        }
      },
      clear: () => { data = { ...defaults }; },
      get store() { return data; },
      onDidChange: jest.fn(),
    };
  });
});

// ── Mock axios ────────────────────────────────────────────────

jest.mock('axios', () => ({
  __esModule: true,
  default: jest.fn((config: any) => {
    // 返回模拟响应
    return Promise.resolve({
      data: { success: true, mockResponse: true, url: config.url },
      status: 200,
    });
  }),
}));

// ── 导入被测模块 ──────────────────────────────────────────────

import { LocalServer, LOCAL_SERVER_PORT } from '../src/main/local-server';
import { IPC_CHANNELS, IpcChannel } from '../src/shared/ipc-channels';
import { AICommunications } from '../src/main/ai-communications';
import { WindowManager } from '../src/main/window-manager';
import { IpcHandlers } from '../src/main/ipc-handlers';

// ════════════════════════════════════════════════════════════
// LocalServer 测试
// ════════════════════════════════════════════════════════════

describe('LocalServer', () => {
  let server: LocalServer;
  let tempDir: string;

  beforeEach(() => {
    // Production intentionally owns a stable port. Tests use an ephemeral
    // loopback port so they can run while the installed desktop app is open.
    server = new LocalServer(null, 0);
    // 创建临时前端目录
    tempDir = path.join(os.tmpdir(), `wa-test-frontend-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    // 创建 index.html
    fs.writeFileSync(
      path.join(tempDir, 'index.html'),
      '<!DOCTYPE html><html><body>Test Frontend</body></html>'
    );
    fs.writeFileSync(path.join(tempDir, '404.html'), '<html><body>Not Found</body></html>');
    fs.writeFileSync(path.join(tempDir, 'login.html'), '<html><body>LOGIN_PAGE</body></html>');
    fs.mkdirSync(path.join(tempDir, 'leads'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'leads.html'), '<html><body>LEADS_PAGE</body></html>');
    fs.writeFileSync(path.join(tempDir, 'leads', 'new.html'), '<html><body>LEADS_NEW_PAGE</body></html>');
    fs.writeFileSync(path.join(tempDir, 'leads', '__static.html'), '<html><body>LEAD_DYNAMIC_PAGE</body></html>');
  });

  afterEach(async () => {
    await server.stop();
    // 清理临时目录
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // 忽略
    }
  });

  describe('start()', () => {
    it('应该成功启动并返回端口号', async () => {
      const port = await server.start(tempDir);

      expect(port).toBeDefined();
      expect(typeof port).toBe('number');
      expect(port).toBeGreaterThan(0);
    });

    it('应该监听 127.0.0.1 地址', async () => {
      const port = await server.start(tempDir);
      const url = server.getUrl();

      expect(url).toBe(`http://127.0.0.1:${port}`);
    });

    it('应该能响应 HTTP 请求并提供静态文件', async () => {
      const port = await server.start(tempDir);
      const http = require('http');

      const response: any = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/index.html`, { agent: false }, (res: any) => {
          let data = '';
          res.on('data', (chunk: any) => (data += chunk));
          res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        }).on('error', reject);
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('Test Frontend');
    });

    it('应该对未知路由返回真实 404，不能伪装成首页', async () => {
      const port = await server.start(tempDir);
      const http = require('http');

      const response: any = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/some/unknown/route`, { agent: false }, (res: any) => {
          let data = '';
          res.on('data', (chunk: any) => (data += chunk));
          res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        }).on('error', reject);
      });

      expect(response.statusCode).toBe(404);
      expect(response.body).toContain('Not Found');
    });

    it.each([
      ['/login', 'LOGIN_PAGE'],
      ['/login/', 'LOGIN_PAGE'],
      ['/leads', 'LEADS_PAGE'],
      ['/leads/', 'LEADS_PAGE'],
      ['/leads/new', 'LEADS_NEW_PAGE'],
      ['/leads/abc-123', 'LEAD_DYNAMIC_PAGE'],
    ])('应该把静态导出路由 %s 映射到对应 HTML 而不是根首页', async (route, marker) => {
      const port = await server.start(tempDir);
      const response: any = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}${route}`, { agent: false }, (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ statusCode: res.statusCode, body }));
        }).on('error', reject);
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(marker);
      expect(response.body).not.toContain('Test Frontend');
    });

    it('应该对 _next 静态资源路径返回 404', async () => {
      const port = await server.start(tempDir);
      const http = require('http');

      const response: any = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/_next/static/missing.js`, { agent: false }, (res: any) => {
          res.on('data', () => {});
          res.on('end', () => resolve({ statusCode: res.statusCode }));
        }).on('error', reject);
      });

      expect(response.statusCode).toBe(404);
    });

    it('应该把同源 /api 请求完整转发到局域网后端并移除浏览器 Origin', async () => {
      let received: any = null;
      const upstream = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          received = { url: req.url, method: req.method, headers: req.headers, body };
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
        });
      });
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const upstreamAddress = upstream.address() as any;

      await server.stop();
      server = new LocalServer(`http://127.0.0.1:${upstreamAddress.port}/api`, 0);
      const port = await server.start(tempDir);
      const body = JSON.stringify({ email: 'lan@example.com' });
      const response: any = await new Promise((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${port}/api/auth/login?source=desktop`,
          {
            method: 'POST',
            agent: false,
            headers: {
              origin: `http://127.0.0.1:${port}`,
              authorization: 'Bearer test-token',
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(body),
            },
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
          },
        );
        req.on('error', reject);
        req.end(body);
      });

      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ ok: true });
      expect(received).toMatchObject({
        url: '/api/auth/login?source=desktop',
        method: 'POST',
        body,
      });
      expect(received.headers.authorization).toBe('Bearer test-token');
      expect(received.headers.origin).toBeUndefined();
      expect(received.headers['x-vaysen-crm-client']).toBe('electron-lan-proxy');
    });

    it('应该拒绝非本机同源页面借用 /api 代理', async () => {
      await server.stop();
      server = new LocalServer('http://127.0.0.1:9/api', 0);
      const port = await server.start(tempDir);
      const response: any = await new Promise((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${port}/api/health`,
          { agent: false, headers: { origin: 'https://evil.example' } },
          (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
          },
        );
        req.on('error', reject);
        req.end();
      });

      expect(response.statusCode).toBe(403);
      expect(response.body).toContain('LOCAL_PROXY_ORIGIN_REJECTED');
    });

    it('应该代理上传与定制素材路径并保留 Range/206 响应', async () => {
      const received: Array<{ url?: string; range?: string }> = [];
      const upstream = http.createServer((req, res) => {
        received.push({ url: req.url, range: req.headers.range });
        if (req.url?.includes('missing')) {
          res.statusCode = 404;
          res.end('missing');
          return;
        }
        res.statusCode = 206;
        res.setHeader('content-range', 'bytes 0-3/10');
        res.end('data');
      });
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const upstreamAddress = upstream.address() as any;
      await server.stop();
      server = new LocalServer(`http://127.0.0.1:${upstreamAddress.port}/api`, 0);
      const port = await server.start(tempDir);

      const request = (pathname: string, headers: Record<string, string> = {}) => new Promise<any>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}${pathname}`, { agent: false, headers }, (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
      });

      const upload = await request('/uploads/customer/photo.png', { range: 'bytes=0-3' });
      const customizer = await request('/customizer-assets/design.pdf');
      const missing = await request('/uploads/missing.png');
      await new Promise<void>((resolve) => upstream.close(() => resolve()));

      expect(upload.statusCode).toBe(206);
      expect(upload.headers['content-range']).toBe('bytes 0-3/10');
      expect(customizer.statusCode).toBe(206);
      expect(missing.statusCode).toBe(404);
      expect(received).toEqual([
        { url: '/uploads/customer/photo.png', range: 'bytes=0-3' },
        { url: '/customizer-assets/design.pdf', range: undefined },
        { url: '/uploads/missing.png', range: undefined },
      ]);
    });

    it('真实 Electron 导出中的全部静态页面都应返回自身 HTML，而不是根首页', async () => {
      const exportDir = path.resolve(__dirname, '..', '..', 'frontend', 'electron-export');
      if (!fs.existsSync(path.join(exportDir, 'electron-build-contract.json'))) return;
      const pageFiles: string[] = [];
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const absolute = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(absolute);
          else if (entry.name.endsWith('.html')) pageFiles.push(absolute);
        }
      };
      walk(exportDir);
      const exactPages = pageFiles.filter((file) => {
        const relative = path.relative(exportDir, file).replace(/\\/g, '/');
        return relative !== 'index.html' && relative !== '404.html'
          && !relative.split('/').includes('__static') && !relative.endsWith('__static.html');
      });
      expect(exactPages.length).toBeGreaterThanOrEqual(40);

      await server.stop();
      server = new LocalServer(null, 0);
      const port = await server.start(exportDir);
      for (const file of exactPages) {
        const relative = path.relative(exportDir, file).replace(/\\/g, '/');
        const route = `/${relative.replace(/\.html$/, '')}`;
        const response: any = await new Promise((resolve, reject) => {
          http.get(`http://127.0.0.1:${port}${route}`, { agent: false }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks) }));
          }).on('error', reject);
        });
        expect(response.statusCode).toBe(200);
        expect(response.body.equals(fs.readFileSync(file))).toBe(true);
      }
    });
  });

  describe('getUrl()', () => {
    it('启动前后都应返回固定回环 origin，保证登录态跨重启复用', () => {
      const url = new LocalServer().getUrl();
      expect(url).toBe(`http://127.0.0.1:${LOCAL_SERVER_PORT}`);
    });

    it('启动后应返回正确的 URL', async () => {
      const port = await server.start(tempDir);
      const url = server.getUrl();
      expect(url).toBe(`http://127.0.0.1:${port}`);
      await server.stop();
      expect(server.getUrl()).toBe(`http://127.0.0.1:${port}`);
    });
  });

  describe('stop()', () => {
    it('应该在启动后成功停止', async () => {
      await server.start(tempDir);
      await expect(server.stop()).resolves.not.toThrow();
    });

    it('未启动时调用 stop 不应抛出异常', async () => {
      await expect(server.stop()).resolves.not.toThrow();
    });

    it('停止后再次调用 stop 不应抛出异常', async () => {
      await server.start(tempDir);
      await server.stop();
      await expect(server.stop()).resolves.not.toThrow();
    });
  });
});

// ════════════════════════════════════════════════════════════
// IPC 通道定义测试
// ════════════════════════════════════════════════════════════

describe('IPC_CHANNELS', () => {
  it('应该是一个对象', () => {
    expect(typeof IPC_CHANNELS).toBe('object');
    expect(IPC_CHANNELS).not.toBeNull();
  });

  it('应该包含所有必需的频道分类', () => {
    // API 请求
    expect(IPC_CHANNELS.API_REQUEST).toBe('api:request');
    expect(IPC_CHANNELS.API_RESPONSE).toBe('api:response');
    expect(IPC_CHANNELS.API_ERROR).toBe('api:error');

    // 认证管理
    expect(IPC_CHANNELS.AUTH_GET_TOKEN).toBe('auth:get-token');
    expect(IPC_CHANNELS.AUTH_SET_TOKEN).toBe('auth:set-token');
    expect(IPC_CHANNELS.AUTH_CLEAR_TOKEN).toBe('auth:clear-token');
    expect(IPC_CHANNELS.AUTH_GET_COMPANY).toBe('auth:get-company');
    expect(IPC_CHANNELS.AUTH_SET_COMPANY).toBe('auth:set-company');

    // WhatsApp 消息
    expect(IPC_CHANNELS.WA_NEW_MESSAGE).toBe('wa:new-message');
    expect(IPC_CHANNELS.WA_SEND_TEXT).toBe('wa:send-text');
    expect(IPC_CHANNELS.WA_SEND_RESULT).toBe('wa:send-result');
    expect(IPC_CHANNELS.WA_LOGIN_STATUS).toBe('wa:login-status');
    expect(IPC_CHANNELS.WA_CONTACTS_SYNC).toBe('wa:contacts-sync');
    expect(IPC_CHANNELS.WA_INJECT_TEXT).toBe('wa:inject-text');
    expect(IPC_CHANNELS.WA_CURRENT_CHAT).toBe('wa:current-chat');
    expect(IPC_CHANNELS.WA_REQUEST_CURRENT_CHAT).toBe('wa:request-current-chat');
    expect(IPC_CHANNELS.WA_SEND_DOCUMENT).toBe('wa:send-document');

    // WhatsApp 多账号
    expect(IPC_CHANNELS.WA_CREATE_ACCOUNT).toBe('wa:create-account');
    expect(IPC_CHANNELS.WA_SWITCH_ACCOUNT).toBe('wa:switch-account');
    expect(IPC_CHANNELS.WA_REMOVE_ACCOUNT).toBe('wa:remove-account');
    expect(IPC_CHANNELS.WA_LIST_ACCOUNTS).toBe('wa:list-accounts');
    expect(IPC_CHANNELS.WA_ACCOUNT_SWITCHED).toBe('wa:account-switched');

    // AI 功能
    expect(IPC_CHANNELS.AI_SUGGESTION).toBe('ai:suggestion');
    expect(IPC_CHANNELS.AI_TRANSLATE).toBe('ai:translate');
    expect(IPC_CHANNELS.AI_RESULT).toBe('ai:result');
    expect(IPC_CHANNELS.AGENT_DESKTOP_CAPABILITIES).toBe('agent:desktop-capabilities');
    expect(IPC_CHANNELS.AGENT_DESKTOP_HEARTBEAT).toBe('agent:desktop-heartbeat');
    expect(IPC_CHANNELS.AGENT_PREPARE_QUOTE_DELIVERY).toBe('agent:prepare-quote-delivery');

    // 窗口管理
    expect(IPC_CHANNELS.WINDOW_MINIMIZE).toBe('window:minimize');
    expect(IPC_CHANNELS.WINDOW_MAXIMIZE).toBe('window:maximize');
    expect(IPC_CHANNELS.WINDOW_CLOSE).toBe('window:close');
    expect(IPC_CHANNELS.WINDOW_IS_MAXIMIZED).toBe('window:is-maximized');

    // 系统
    expect(IPC_CHANNELS.APP_VERSION).toBe('app:version');
    expect(IPC_CHANNELS.APP_CHECK_UPDATE).toBe('app:check-update');
    expect(IPC_CHANNELS.APP_DOWNLOAD_UPDATE).toBe('app:download-update');
    expect(IPC_CHANNELS.APP_INSTALL_UPDATE).toBe('app:install-update');
    expect(IPC_CHANNELS.APP_UPDATE_STATUS).toBe('app:update-status');
    expect(IPC_CHANNELS.APP_ONLINE_STATUS).toBe('app:online-status');
  });

  it('所有频道值应该使用 "命名空间:动作" 格式', () => {
    const channels = Object.values(IPC_CHANNELS) as string[];
    for (const channel of channels) {
      expect(channel).toMatch(/^[a-z-]+:[a-z-]+$/);
    }
  });

  it('所有频道值应该唯一（无重复）', () => {
    const channels = Object.values(IPC_CHANNELS) as string[];
    const unique = new Set(channels);
    expect(unique.size).toBe(channels.length);
  });

  it('频道总数应 >= 30', () => {
    const channels = Object.keys(IPC_CHANNELS);
    expect(channels.length).toBeGreaterThanOrEqual(30);
  });

  it('IpcChannel 类型应能正确推导', () => {
    const channel: IpcChannel = IPC_CHANNELS.API_REQUEST;
    expect(channel).toBe('api:request');
  });

  it('应该包含完整的 API 频道组', () => {
    const apiChannels = Object.entries(IPC_CHANNELS)
      .filter(([key]) => key.startsWith('API_'))
      .map(([, value]) => value);
    expect(apiChannels.length).toBeGreaterThanOrEqual(3);
  });

  it('应该包含完整的认证频道组', () => {
    const authChannels = Object.entries(IPC_CHANNELS)
      .filter(([key]) => key.startsWith('AUTH_'))
      .map(([, value]) => value);
    expect(authChannels.length).toBeGreaterThanOrEqual(5);
  });

  it('应该包含完整的 WhatsApp 频道组', () => {
    const waChannels = Object.entries(IPC_CHANNELS)
      .filter(([key]) => key.startsWith('WA_'))
      .map(([, value]) => value);
    expect(waChannels.length).toBeGreaterThanOrEqual(12);
  });

  it('应该包含完整的窗口管理频道组', () => {
    const windowChannels = Object.entries(IPC_CHANNELS)
      .filter(([key]) => key.startsWith('WINDOW_'))
      .map(([, value]) => value);
    expect(windowChannels.length).toBeGreaterThanOrEqual(4);
  });

  it('应该包含完整的系统/应用频道组', () => {
    const appChannels = Object.entries(IPC_CHANNELS)
      .filter(([key]) => key.startsWith('APP_'))
      .map(([, value]) => value);
    expect(appChannels.length).toBeGreaterThanOrEqual(6);
  });

  it('应该包含完整的 AI 频道组', () => {
    const aiChannels = Object.entries(IPC_CHANNELS)
      .filter(([key]) => key.startsWith('AI_'))
      .map(([, value]) => value);
    expect(aiChannels.length).toBeGreaterThanOrEqual(3);
  });
});

describe('legacy WhatsApp automatic document sender is disabled', () => {
  const ipcHandlersSource = fs.readFileSync(
    path.resolve(__dirname, '..', 'src', 'main', 'ipc-handlers.ts'),
    'utf-8',
  );

  it('contains no debugger/DOM injection path and only returns a permanent denial', () => {
    expect(ipcHandlersSource).not.toContain('Page.setInterceptFileChooserDialog');
    expect(ipcHandlersSource).not.toContain('DOM.setFileInputFiles');
    expect(ipcHandlersSource).not.toContain('Page.fileChooserOpened');
    expect(ipcHandlersSource).toContain('自动发送报价单已永久禁用');
  });
});

// ════════════════════════════════════════════════════════════
// AICommunications 测试
// ════════════════════════════════════════════════════════════

describe('IpcHandlers authentication synchronization', () => {
  it('prefers the current renderer token over a stale encrypted token', async () => {
    const executeJavaScript = jest.fn().mockResolvedValue('fresh-renderer-token');
    const windowManager = {
      getMainWindow: () => ({
        isDestroyed: () => false,
        webContents: { executeJavaScript },
      }),
    } as unknown as WindowManager;
    const handlers = new IpcHandlers(windowManager, 'http://127.0.0.1:4000/api');
    const authStore = (handlers as any).authStore;
    authStore.set(
      'token',
      Buffer.from('enc:stale-electron-token', 'utf8').toString('base64'),
    );

    await expect((handlers as any).getTokenAsync()).resolves.toBe(
      'fresh-renderer-token',
    );
    expect(executeJavaScript).toHaveBeenCalledWith(
      `localStorage.getItem('access_token')`,
    );
  });
});

describe('AICommunications', () => {
  let ai: AICommunications;

  beforeEach(() => {
    (axios as unknown as jest.Mock).mockClear();
    ai = new AICommunications('http://127.0.0.1:4000/api');
  });

  describe('实例方法存在性', () => {
    it('应该有 suggestReplies 方法', () => {
      expect(typeof ai.suggestReplies).toBe('function');
    });

    it('应该有 translateDraft 方法', () => {
      expect(typeof ai.translateDraft).toBe('function');
    });

    it('应该有 translateMessage 方法', () => {
      expect(typeof ai.translateMessage).toBe('function');
    });

    it('应该有 customerAnalysis 方法', () => {
      expect(typeof ai.customerAnalysis).toBe('function');
    });

    it('应该有 generateQuote 方法', () => {
      expect(typeof ai.generateQuote).toBe('function');
    });

    it('应该有 extractQuote 方法', () => {
      expect(typeof ai.extractQuote).toBe('function');
    });
  });

  describe('方法调用', () => {
    it('suggestReplies 应该返回结果对象', async () => {
      const result = await ai.suggestReplies('msg-001', 'en');
      expect(result).toBeDefined();
      expect(result).toHaveProperty('success');
    });

    it('translateDraft 应该接受文本和目标语言', async () => {
      const result = await ai.translateDraft('你好', 'en');
      expect(result).toBeDefined();
      expect(result).toHaveProperty('success');
    });

    it('translateDraft 应该有默认目标语言 en', async () => {
      const result = await ai.translateDraft('你好');
      expect(result).toBeDefined();
    });

    it('translateMessage 应该接受消息 ID 和目标语言', async () => {
      const result = await ai.translateMessage('msg-001', 'zh');
      expect(result).toBeDefined();
    });

    it('translateMessage 应该有默认目标语言 zh', async () => {
      const result = await ai.translateMessage('msg-001');
      expect(result).toBeDefined();
    });

    it('customerAnalysis 应该接受 leadId', async () => {
      const result = await ai.customerAnalysis('lead-001');
      expect(result).toBeDefined();
    });

    it('generateQuote 应该接受 conversationId 和 type', async () => {
      const result = await ai.generateQuote('conv-001', 'quote');
      expect(result).toBeDefined();
    });

    it('generateQuote 应该有默认 type=quote', async () => {
      const result = await ai.generateQuote('conv-001');
      expect(result).toBeDefined();
    });

    it('extractQuote 应该接受 conversationId', async () => {
      const result = await ai.extractQuote('conv-001');
      expect(result).toBeDefined();
    });
  });

  describe('API 路径验证', () => {
    it('suggestReplies 应该调用正确路径', async () => {
      await ai.suggestReplies('msg-123');
      expect(axios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          url: expect.stringContaining('/ai-communications/suggest-replies/msg-123'),
        })
      );
    });

    it('translateDraft 应该调用正确路径', async () => {
      await ai.translateDraft('hello');
      expect(axios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          url: expect.stringContaining('/ai-communications/translate-draft'),
        })
      );
    });

    it('customerAnalysis 应该调用正确路径', async () => {
      await ai.customerAnalysis('lead-456');
      expect(axios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining('/ai-communications/customer-analysis/lead-456'),
        })
      );
    });

    it('所有请求应该有 60 秒超时', async () => {
      await ai.suggestReplies('msg-001');
      expect(axios).toHaveBeenCalledWith(
        expect.objectContaining({
          timeout: 60000,
        })
      );
    });

    it('请求应该包含 Content-Type header', async () => {
      await ai.translateDraft('test');
      expect(axios).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        })
      );
    });
  });
});

// ════════════════════════════════════════════════════════════
// WindowManager 测试（mock Electron）
// ════════════════════════════════════════════════════════════

describe('WindowManager', () => {
  let wm: WindowManager;

  beforeEach(() => {
    wm = new WindowManager();
  });

  afterEach(() => {
    wm.destroyAll();
  });

  describe('createMainWindow()', () => {
    it('应该创建并返回 BrowserWindow 实例', () => {
      const win = wm.createMainWindow('http://127.0.0.1:3000', false);
      expect(win).toBeDefined();
      expect(win).not.toBeNull();
    });

    it('应该在开发模式下创建窗口并注册 DevTools 监听', () => {
      const win = wm.createMainWindow('http://127.0.0.1:3000', true);
      expect(win).toBeDefined();
      expect(win.webContents.on).toHaveBeenCalledWith(
        'devtools-opened',
        expect.any(Function),
      );
    });

    it('应该在生产模式下不打开 DevTools', () => {
      const win = wm.createMainWindow('http://127.0.0.1:3000', false);
      expect(win.webContents.openDevTools).not.toHaveBeenCalled();
    });

    it('应该加载传入的 URL', () => {
      const win = wm.createMainWindow('http://127.0.0.1:8080', false);
      expect(win.loadURL).toHaveBeenCalledWith('http://127.0.0.1:8080');
    });

    it('getMainWindow 应该返回已创建的窗口', () => {
      const win = wm.createMainWindow('http://127.0.0.1:3000', false);
      expect(wm.getMainWindow()).toBe(win);
    });
  });

  describe('createWhatsappView() — 多账号逻辑', () => {
    beforeEach(() => {
      wm.createMainWindow('http://127.0.0.1:3000', false);
    });

    it('应该创建默认账号视图', () => {
      const view = wm.createWhatsappView('default', '主账号');
      expect(view).not.toBeNull();
    });

    it('创建第一个账号后应设为活跃', () => {
      wm.createWhatsappView('default', '主账号');
      expect(wm.getActiveAccountId()).toBe('default');
    });

    it('应该创建多个账号', () => {
      wm.createWhatsappView('default', '主账号');
      wm.createWhatsappView('account-2', '客服二号');

      const list = wm.getAccountList();
      expect(list.length).toBe(2);
    });

    it('默认账号应该使用 persist:whatsapp partition', () => {
      const { WebContentsView } = require('electron');
      wm.createWhatsappView('default', '主账号');

      expect(WebContentsView).toHaveBeenCalledWith(
        expect.objectContaining({
          webPreferences: expect.objectContaining({
            partition: 'persist:whatsapp',
          }),
        })
      );
    });

    it('非默认账号应该使用 persist:whatsapp-{id} partition', () => {
      const { WebContentsView } = require('electron');
      wm.createWhatsappView('sales-01', '销售一号');

      expect(WebContentsView).toHaveBeenCalledWith(
        expect.objectContaining({
          webPreferences: expect.objectContaining({
            partition: 'persist:whatsapp-sales-01',
          }),
        })
      );
    });

    it('重复创建同 ID 账号应该先移除旧的', () => {
      wm.createWhatsappView('default', '主账号');
      wm.createWhatsappView('default', '新主账号');

      const list = wm.getAccountList();
      expect(list.length).toBe(1);
      expect(list[0].label).toBe('新主账号');
    });
  });

  describe('setActiveAccount()', () => {
    beforeEach(() => {
      wm.createMainWindow('http://127.0.0.1:3000', false);
    });

    it('应该成功切换到已存在的账号', () => {
      wm.createWhatsappView('default', '主账号');
      wm.createWhatsappView('account-2', '二号');

      const result = wm.setActiveAccount('account-2');
      expect(result).toBe(true);
      expect(wm.getActiveAccountId()).toBe('account-2');
    });

    it('切换到不存在的账号应返回 false', () => {
      wm.createWhatsappView('default', '主账号');

      const result = wm.setActiveAccount('nonexistent');
      expect(result).toBe(false);
      expect(wm.getActiveAccountId()).toBe('default');
    });

    it('切换账号后应发送 wa:account-switched 事件', () => {
      const win = wm.getMainWindow()!;
      wm.createWhatsappView('default', '主账号');
      wm.createWhatsappView('account-2', '二号');

      wm.setActiveAccount('account-2');

      expect(win.webContents.send).toHaveBeenCalledWith(
        'wa:account-switched',
        expect.objectContaining({
          accountId: 'account-2',
          label: '二号',
        })
      );
    });
  });

  describe('getAccountList()', () => {
    beforeEach(() => {
      wm.createMainWindow('http://127.0.0.1:3000', false);
    });

    it('无账号时应返回空数组', () => {
      const list = wm.getAccountList();
      expect(list).toEqual([]);
    });

    it('应返回所有账号及其状态', () => {
      wm.createWhatsappView('default', '主账号');
      wm.createWhatsappView('account-2', '二号');

      const list = wm.getAccountList();
      expect(list.length).toBe(2);

      const ids = list.map((a) => a.id);
      expect(ids).toContain('default');
      expect(ids).toContain('account-2');

      // 每个账号应有 label 和 isActive 字段
      for (const account of list) {
        expect(account).toHaveProperty('label');
        expect(account).toHaveProperty('isActive');
        expect(typeof account.isActive).toBe('boolean');
      }
    });

    it('活跃账号的 isActive 应为 true', () => {
      wm.createWhatsappView('default', '主账号');
      wm.createWhatsappView('account-2', '二号');
      wm.setActiveAccount('account-2');

      const list = wm.getAccountList();
      const active = list.find((a) => a.isActive);
      expect(active?.id).toBe('account-2');
    });
  });

  describe('removeWhatsappAccount()', () => {
    beforeEach(() => {
      wm.createMainWindow('http://127.0.0.1:3000', false);
    });

    it('应该成功移除已存在的账号', () => {
      wm.createWhatsappView('default', '主账号');
      wm.createWhatsappView('account-2', '二号');

      wm.removeWhatsappAccount('account-2');
      const list = wm.getAccountList();
      expect(list.length).toBe(1);
      expect(list[0].id).toBe('default');
    });

    it('移除活跃账号后应自动切换到第一个可用账号', () => {
      wm.createWhatsappView('default', '主账号');
      wm.createWhatsappView('account-2', '二号');

      wm.setActiveAccount('account-2');
      wm.removeWhatsappAccount('account-2');

      expect(wm.getActiveAccountId()).toBe('default');
    });

    it('移除最后一个账号后活跃 ID 应为 null', () => {
      wm.createWhatsappView('default', '主账号');
      wm.removeWhatsappAccount('default');

      expect(wm.getActiveAccountId()).toBeNull();
    });

    it('移除不存在的账号不应抛出异常', () => {
      expect(() => wm.removeWhatsappAccount('nonexistent')).not.toThrow();
    });
  });

  describe('getWhatsappView()', () => {
    beforeEach(() => {
      wm.createMainWindow('http://127.0.0.1:3000', false);
    });

    it('无活跃账号时应返回 null', () => {
      expect(wm.getWhatsappView()).toBeNull();
    });

    it('应返回活跃账号的视图', () => {
      wm.createWhatsappView('default', '主账号');
      const view = wm.getWhatsappView();
      expect(view).not.toBeNull();
    });

    it('getWhatsappViewById 应返回指定账号的视图', () => {
      wm.createWhatsappView('default', '主账号');
      wm.createWhatsappView('account-2', '二号');

      const view = wm.getWhatsappViewById('account-2');
      expect(view).not.toBeNull();
    });

    it('getWhatsappViewById 对不存在的 ID 应返回 null', () => {
      expect(wm.getWhatsappViewById('nonexistent')).toBeNull();
    });
  });

  describe('renderer overlay reservation', () => {
    it('reserves enough space for a 540px quote panel and restores the base layout', () => {
      wm.createMainWindow('http://127.0.0.1:3000', false);
      const view = wm.createWhatsappView('default', 'main')!;

      wm.updateLayout({
        leftNavWidth: 240,
        chatListWidth: 0,
        rightPanelWidth: 360,
        topOffset: 64,
        bottomOffset: 0,
      });
      wm.showWhatsappView();

      wm.setRendererOverlayWidth(540);
      expect(view.setBounds).toHaveBeenLastCalledWith({
        x: 240,
        y: 64,
        width: 660,
        height: 836,
      });

      wm.setRendererOverlayWidth(0);
      expect(view.setBounds).toHaveBeenLastCalledWith({
        x: 240,
        y: 64,
        width: 840,
        height: 836,
      });
    });
  });

  describe('sendToRenderer()', () => {
    beforeEach(() => {
      wm.createMainWindow('http://127.0.0.1:3000', false);
    });

    it('应该通过主窗口 webContents.send 发送消息', () => {
      const win = wm.getMainWindow()!;
      wm.sendToRenderer('test:channel', { data: 'hello' });

      expect(win.webContents.send).toHaveBeenCalledWith('test:channel', { data: 'hello' });
    });
  });

  describe('destroyAll()', () => {
    it('应该清理所有账号和窗口', () => {
      wm.createMainWindow('http://127.0.0.1:3000', false);
      wm.createWhatsappView('default', '主账号');
      wm.createWhatsappView('account-2', '二号');

      wm.destroyAll();

      expect(wm.getMainWindow()).toBeNull();
      expect(wm.getActiveAccountId()).toBeNull();
      expect(wm.getAccountList().length).toBe(0);
    });

    it('未初始化时调用不应抛出异常', () => {
      expect(() => wm.destroyAll()).not.toThrow();
    });
  });

  describe('executeWhatsappScript()', () => {
    beforeEach(() => {
      wm.createMainWindow('http://127.0.0.1:3000', false);
    });

    it('无活跃视图时应 reject', async () => {
      await expect(wm.executeWhatsappScript('1+1')).rejects.toThrow('WhatsApp 视图未初始化');
    });

    it('有活跃视图时应执行脚本', async () => {
      wm.createWhatsappView('default', '主账号');
      await expect(wm.executeWhatsappScript('document.title')).resolves.not.toThrow();
    });
  });
});
