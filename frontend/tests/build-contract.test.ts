/**
 * TASK-110 构建契约测试（vitest）
 *
 * 放置于 frontend/tests/（next lint 默认不扫描此目录，避免构建配置层的正则触发安全规则误报）。
 *
 * 验证双目标构建产物满足契约：
 *   1. Web（standalone）产物存在且由 next.config 独立 distDir (.next-web) 产出。
 *   2. Electron 静态导出产物存在且位于稳定契约路径 electron-export/（TASK-111 消费）。
 *   3. 产物中不包含“硬编码的 API 基地址 / 私网 IP”：
 *      - http(s)://localhost[:port]、http(s)://127.0.0.1、192.168./10./172.16-31. 私网段、
 *        以及 /api/api 双斜杠。
 *      （注意：Next.js 框架内部运行时会包含 localhost 字样，如相对 URL 解析、middleware
 *        URL 解析正则等，不属于本项目硬编码 API，故仅匹配上述“硬编码 API”形态。）
 *   4. Web 模式下被内联的 NEXT_PUBLIC_API_URL 为同源 /api（非 localhost/私网 IP）。
 *
 * 该测试面向“已构建”的产物，由独立 Vitest 配置运行。任一产物缺失都必须失败，
 * 不得以 skip 返回假绿。正式一条命令入口为 `npm run verify:build-contract`。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = resolve(__dirname, '..');
const WEB_STANDALONE = join(ROOT, '.next-web', 'standalone', 'server.js');
const ELECTRON_EXPORT = join(ROOT, 'electron-export', 'index.html');
const ELECTRON_CONTRACT = join(ROOT, 'electron-export', 'electron-build-contract.json');

// 仅匹配“硬编码 API / 私网 IP”形态：
//   - 本项目历史使用的 API 回退地址 http://localhost:4000[/api]（端口 4000 为本项目特征）
//   - 127.0.0.1 及私网网段、/api/api 双斜杠
// 说明：Next.js 框架运行时会包含 http://localhost（无端口，相对 URL 回退）等字样，
//   属框架内部实现，非本项目硬编码 API，故不以无端口 localhost 作为禁止模式。
const FORBIDDEN = [
  /https?:\/\/localhost:4000/i,
  /https?:\/\/127\.0\.0\.1(:\d+)?/i,
  /\b192\.168\.\d{1,3}\.\d{1,3}/,
  /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}/,
  /\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}/,
  /\/api\/api/i,
];

const MAX_SCAN_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', 'cache']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (!name.endsWith('.map')) out.push(full);
  }
  return out;
}

function scanForbidden(rootDir: string, allowedLiterals: string[] = []): string[] {
  const hits: string[] = [];
  for (const file of walk(rootDir)) {
    let content: string;
    try {
      const buf = readFileSync(file);
      if (buf.length > MAX_SCAN_BYTES) continue;
      if (buf.includes(0)) continue; // 跳过二进制
      content = buf.toString('utf8');
      for (const allowed of allowedLiterals) {
        if (allowed) content = content.split(allowed).join('<approved-api-origin>');
      }
    } catch {
      continue;
    }
    for (const re of FORBIDDEN) {
      if (re.test(content)) {
        hits.push(`${file} ~ ${re.source}`);
        break;
      }
    }
  }
  return hits;
}

const webBuilt = existsSync(WEB_STANDALONE);
const electronBuilt = existsSync(ELECTRON_EXPORT);

describe('TASK-110 双目标构建契约', () => {
  it('Web standalone 产物存在（distDir=.next-web）', () => {
    expect(webBuilt, `.next-web/standalone/server.js 不存在，请先 npm run build:web`).toBe(true);
  });

  it('Electron 导出契约路径 electron-export/ 存在（供 TASK-111 消费）', () => {
    expect(electronBuilt, `electron-export/index.html 不存在，请先 npm run build:electron`).toBe(
      true,
    );
  });

  it('Web standalone 产物不含硬编码 API / 私网 IP / /api/api', () => {
    expect(webBuilt, `.next-web/standalone/server.js 不存在`).toBe(true);
    const hits = scanForbidden(join(ROOT, '.next-web'));
    expect(hits, `发现违禁模式: ${hits.join(', ')}`).toEqual([]);
  });

  it('Electron 导出产物不含硬编码 API / 私网 IP / /api/api', () => {
    expect(electronBuilt, `electron-export/index.html 不存在`).toBe(true);
    expect(existsSync(ELECTRON_CONTRACT), 'electron-build-contract.json 不存在').toBe(true);
    const contract = JSON.parse(readFileSync(ELECTRON_CONTRACT, 'utf8')) as {
      apiBaseUrl?: string;
      apiOrigin?: string;
    };
    const hits = scanForbidden(join(ROOT, 'electron-export'), [
      contract.apiBaseUrl || '',
      contract.apiOrigin || '',
    ]);
    expect(hits, `发现违禁模式: ${hits.join(', ')}`).toEqual([]);
  });

  it('Web 内联 NEXT_PUBLIC_API_URL 非 localhost/私网 IP', () => {
    expect(webBuilt, `.next-web/standalone/server.js 不存在`).toBe(true);
    const server = readFileSync(WEB_STANDALONE, 'utf8');
    for (const re of FORBIDDEN) {
      expect(re.test(server), `server.js 命中违禁模式 ${re.source}`).toBe(false);
    }
  });

  it('Electron 产物包含受控 API 构建契约', () => {
    expect(existsSync(ELECTRON_CONTRACT), 'electron-build-contract.json 不存在').toBe(true);
    const contract = JSON.parse(readFileSync(ELECTRON_CONTRACT, 'utf8')) as {
      schemaVersion?: number;
      target?: string;
      apiBaseUrl?: string;
      apiOrigin?: string;
      privateOrigin?: boolean;
      localProxy?: boolean;
    };
    expect(contract.schemaVersion).toBe(1);
    expect(contract.target).toBe('electron');
    expect(contract.apiBaseUrl).toBeTruthy();
    if (contract.localProxy) {
      expect(contract.apiBaseUrl).toBe('/api');
      expect(contract.apiOrigin).toBeNull();
      expect(contract.privateOrigin).toBe(false);
    } else {
      const parsed = new URL(contract.apiBaseUrl!);
      expect(contract.apiOrigin).toBe(parsed.origin);
      if (contract.privateOrigin) {
      const approvedOrigins = (process.env.APPROVED_ZEROTIER_API_ORIGINS || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => new URL(value).origin);
        expect(
          approvedOrigins,
          '私网/ZeroTier 契约必须在当前 APPROVED_ZEROTIER_API_ORIGINS 中精确批准',
        ).toContain(parsed.origin);
      } else {
        expect(parsed.protocol).toBe('https:');
      }
    }
    if (process.env.NEXT_PUBLIC_API_URL) {
      const expected = process.env.NEXT_PUBLIC_API_URL === '/api'
        ? '/api'
        : new URL(process.env.NEXT_PUBLIC_API_URL).toString();
      expect(contract.apiBaseUrl).toBe(expected);
    }
  });
});
