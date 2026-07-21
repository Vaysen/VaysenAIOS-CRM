/**
 * E2E 测试环境配置
 *
 * 功能：
 * - 配置测试环境变量
 * - 启动 Express mock 服务器（模拟后端 API）
 * - 提供 beforeEach / afterEach 全局钩子
 *
 * 此文件通过 jest.config.js 的 setupFilesAfterEnv 加载，
 * 在所有测试文件执行前自动运行。
 */

import express, { Express } from 'express';
import http from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';

// ── 环境变量配置 ──────────────────────────────────────────────

// 测试模式标记
process.env.NODE_ENV = 'test';

// v1.2b 复审红线 #5 修正：loadRuntimeConfig 现在跑严格校验，setup.ts
// 注入的 API_BASE_URL 必须是合法 https 公网 URL（不能是 http://127.0.0.1:0/api
// —— 那是私网 HTTP，会被 RuntimeConfigError 拒绝，导致所有依赖 getApiBaseUrl
// 的单测全炸）。这里默认用 https 公网占位；具体测试可以临时改 env 覆盖。
delete process.env.API_BASE_URL;
delete process.env.ELECTRON_UPDATER_URL;

// 前端地址（测试中不实际使用）
process.env.FRONTEND_URL = 'http://127.0.0.1:3000';

// 临时用户数据目录（避免污染真实 electron-store 数据）
const tempUserDataDir = path.join(os.tmpdir(), `vaysen-crm-test-${Date.now()}`);
process.env.APPDATA = tempUserDataDir;

// ── Mock 服务器 ───────────────────────────────────────────────

let mockServer: http.Server | null = null;
let mockServerPort = 0;
let mockApp: Express;

/**
 * 消息记录（供测试断言使用）
 */
export const mockCallLog: Array<{ method: string; path: string; body: any; timestamp: number }> = [];

/**
 * 创建并启动 Mock 后端服务器
 */
async function startMockServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    const app = express();
    mockApp = app;

    app.use(express.json());

    // 请求日志中间件
    app.use((req, _res, next) => {
      mockCallLog.push({
        method: req.method,
        path: req.path,
        body: req.body,
        timestamp: Date.now(),
      });
      next();
    });

    // ── AI 通信接口 ────────────────────────────────────────

    // AI 回复建议
    app.post('/api/ai-communications/suggest-replies/:messageId', (req, res) => {
      res.json({
        success: true,
        data: {
          messageId: req.params.messageId,
          targetLanguage: req.body.targetLanguage || 'en',
          suggestions: [
            'Thank you for your inquiry. Let me check and get back to you.',
            'Could you please provide more details about your requirements?',
          ],
        },
      });
    });

    // 实时翻译草稿
    app.post('/api/ai-communications/translate-draft', (req, res) => {
      res.json({
        success: true,
        data: {
          original: req.body.text,
          translated: `[EN] ${req.body.text}`,
          targetLanguage: req.body.targetLanguage || 'en',
        },
      });
    });

    // 翻译消息
    app.post('/api/ai-communications/translate/:messageId', (req, res) => {
      res.json({
        success: true,
        data: {
          messageId: req.params.messageId,
          translated: '[ZH] translated message',
          targetLang: req.body.targetLang || 'zh',
        },
      });
    });

    // 客户分析
    app.post('/api/ai-communications/customer-analysis/:leadId', (req, res) => {
      res.json({
        success: true,
        data: {
          leadId: req.params.leadId,
          analysis: {
            intent: 'high',
            budget: 'medium',
            timeline: '1-3 months',
          },
        },
      });
    });

    // AI 生成报价
    app.post('/api/ai-communications/generate-quote/:conversationId', (req, res) => {
      res.json({
        success: true,
        data: {
          conversationId: req.params.conversationId,
          type: req.body.type || 'quote',
          quote: {
            items: [],
            total: 0,
            currency: 'USD',
          },
        },
      });
    });

    // 提取报价字段
    app.post('/api/ai-communications/extract-quote/:conversationId', (req, res) => {
      res.json({
        success: true,
        data: {
          conversationId: req.params.conversationId,
          fields: {
            product: 'packaging box',
            quantity: 1000,
            unitPrice: 0.5,
          },
        },
      });
    });

    // ── WhatsApp Electron Webhook ─────────────────────────

    // 消息推送
    app.post('/api/whatsapp/electron-webhook/message', (req, res) => {
      res.json({ success: true, received: true });
    });

    // 状态推送
    app.post('/api/whatsapp/electron-webhook/status', (req, res) => {
      res.json({ success: true, received: true });
    });

    // 联系人推送
    app.post('/api/whatsapp/electron-webhook/contacts', (req, res) => {
      res.json({ success: true, received: true, count: req.body.total || 0 });
    });

    // ── 认证接口 ──────────────────────────────────────────

    app.post('/api/auth/login', (req, res) => {
      res.json({
        success: true,
        data: {
          token: 'mock-jwt-token',
          refreshToken: 'mock-refresh-token',
          user: { id: 'test-user', name: 'Test User' },
        },
      });
    });

    app.post('/api/auth/refresh', (req, res) => {
      res.json({
        success: true,
        data: {
          token: 'mock-jwt-token-refreshed',
          refreshToken: 'mock-refresh-token-refreshed',
        },
      });
    });

    // ── 通用 API 代理测试端点 ─────────────────────────────

    app.get('/api/test-endpoint', (_req, res) => {
      res.json({ success: true, message: 'mock-response' });
    });

    app.post('/api/test-endpoint', (req, res) => {
      res.json({ success: true, received: req.body });
    });

    // 401 测试端点
    app.get('/api/unauthorized', (_req, res) => {
      res.status(401).json({ success: false, message: 'Unauthorized' });
    });

    // 500 测试端点
    app.get('/api/server-error', (_req, res) => {
      res.status(500).json({ success: false, message: 'Internal Server Error' });
    });

    // 健康检查
    app.get('/api/health', (_req, res) => {
      res.json({ status: 'ok', timestamp: Date.now() });
    });

    // 启动服务器
    mockServer = app.listen(0, '127.0.0.1', () => {
      const addr = mockServer!.address();
      if (addr && typeof addr === 'object') {
        mockServerPort = addr.port;
        // v1.2b 红线 #5：loadRuntimeConfig 现在跑严格校验，私网 HTTP
        // http://127.0.0.1:port/api 会被 RuntimeConfigError 拒绝。
        // 这里 mock 服务器地址不应注入到 API_BASE_URL（那是测试 private network
        // 工具的产物，不是生产允许的私网 HTTP）。改用合法 https 公网占位，
        // 各测试如果需要真实 mock 端口连接，应直接读 mockServerPort 而不走 runtime-config。
        process.env.API_BASE_URL = 'https://api.test.invalid/api';
        console.log(`[Test Setup] Mock 服务器已启动: http://127.0.0.1:${mockServerPort}`);
        resolve(mockServerPort);
      } else {
        reject(new Error('无法获取 mock 服务器端口'));
      }
    });

    mockServer.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * 停止 Mock 服务器
 */
async function stopMockServer(): Promise<void> {
  return new Promise((resolve) => {
    if (mockServer) {
      mockServer.close(() => {
        console.log('[Test Setup] Mock 服务器已停止');
        mockServer = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

/**
 * 获取 Mock 服务器地址
 */
export function getMockServerUrl(): string {
  return `http://127.0.0.1:${mockServerPort}`;
}

/**
 * 获取 Mock 服务器 API 基础地址
 */
export function getMockApiBaseUrl(): string {
  return `http://127.0.0.1:${mockServerPort}/api`;
}

/**
 * 清空调用日志
 */
export function clearMockCallLog(): void {
  mockCallLog.length = 0;
}

/**
 * 查询调用日志
 */
export function findMockCalls(method: string, pathPattern: RegExp): Array<{ method: string; path: string; body: any }> {
  return mockCallLog.filter(
    (entry) => entry.method === method && pathPattern.test(entry.path)
  );
}

// ── 全局 Mock：electron 模块 ──────────────────────────────────

/**
 * 由于 Electron 模块无法在纯 Node.js 环境中加载，
 * 在 setup 阶段注入全局 mock，供所有测试文件使用。
 *
 * 注意：各测试文件仍可通过 jest.mock('electron', ...) 覆盖。
 */
const electronMock = {
  app: {
    getVersion: jest.fn(() => '1.0.0'),
    getPath: jest.fn((name: string) => {
      const paths: Record<string, string> = {
        userData: tempUserDataDir,
        temp: os.tmpdir(),
        home: os.homedir(),
        desktop: path.join(os.homedir(), 'Desktop'),
      };
      return paths[name] || tempUserDataDir;
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
  ipcRenderer: {
    send: jest.fn(),
    invoke: jest.fn(),
    on: jest.fn(),
    once: jest.fn(),
    off: jest.fn(),
    removeListener: jest.fn(),
    removeAllListeners: jest.fn(),
  },
  contextBridge: {
    exposeInMainWorld: jest.fn(),
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
};

// 注入 mock 到 require 缓存
try {
  require.cache[require.resolve('electron')] = {
    id: 'electron-mock',
    filename: 'electron',
    loaded: true,
    exports: electronMock,
    children: [],
    paths: [],
  } as any;
} catch {
  // electron 模块可能尚未被 require，忽略
}

// ── 全局 Mock：electron-store ─────────────────────────────────

/**
 * electron-store 的内存 mock 实现
 */
class MockStore<T extends Record<string, any>> {
  private data: T;
  private defaults: T;

  constructor(options?: { defaults?: T; name?: string; encryptionKey?: string }) {
    this.defaults = (options?.defaults || {}) as T;
    this.data = { ...this.defaults };
  }

  get(key: string): any {
    return key.split('.').reduce((obj, k) => obj?.[k], this.data as any);
  }

  set(key: string | Partial<T>, value?: any): void {
    if (typeof key === 'string') {
      // 支持 dot notation
      const keys = key.split('.');
      let obj: any = this.data;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!obj[keys[i]]) obj[keys[i]] = {};
        obj = obj[keys[i]];
      }
      obj[keys[keys.length - 1]] = value;
    } else {
      Object.assign(this.data as any, key);
    }
  }

  clear(): void {
    this.data = { ...this.defaults };
  }

  get store(): T {
    return this.data;
  }

  onDidChange(_key: string, _callback: (newValue: any, oldValue: any) => void): void {
    // no-op
  }
}

try {
  require.cache[require.resolve('electron-store')] = {
    id: 'electron-store-mock',
    filename: 'electron-store',
    loaded: true,
    exports: MockStore,
    children: [],
    paths: [],
  } as any;
} catch {
  // electron-store 可能尚未被 require，忽略
}

// ── 全局生命周期钩子 ──────────────────────────────────────────

// 所有测试开始前：启动 mock 服务器
beforeAll(async () => {
  await startMockServer();

  // 创建临时用户数据目录
  if (!fs.existsSync(tempUserDataDir)) {
    fs.mkdirSync(tempUserDataDir, { recursive: true });
  }
});

// 所有测试结束后：停止 mock 服务器，清理临时目录
afterAll(async () => {
  await stopMockServer();

  // 清理临时目录
  try {
    if (fs.existsSync(tempUserDataDir)) {
      fs.rmSync(tempUserDataDir, { recursive: true, force: true });
    }
  } catch {
    // 忽略清理失败
  }
});

// 每个测试前：清空调用日志
beforeEach(() => {
  clearMockCallLog();
});

// 每个测试后：重置 mock 函数调用记录
afterEach(() => {
  jest.clearAllMocks();
});
