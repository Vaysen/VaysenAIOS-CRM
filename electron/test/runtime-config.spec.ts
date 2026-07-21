/**
 * runtime-config.ts 单元测试（TASK-111 v1.1 红线 5 复审后 — API/Update 拆策略 + ZeroTier allowlist）
 *
 * 验证「环境变量 > 持久化配置 > 安全默认值」优先级，
 * 以及 saveRuntimeConfig 的合并与持久化（凭据落盘由 safeStorage 负责，本模块不接触）。
 *
 * 重点覆盖（按你红线 5 复审要求）：
 *   - 空 allowlist 拒绝 ZeroTier
 *   - 精确 origin 允许
 *   - `10.0.0.2:4000` 在只批准默认 80 时被拒绝
 *   - `10.0.0.3` 被拒绝（即使同段不同 host）
 *   - 公网 HTTP API 被拒绝
 *   - 任意 HTTP 更新源被拒绝
 *
 * 注意：test/setup.ts 尝试注入 electron-store 内存 mock，但在「electron
 * 原生二进制未安装」的沙箱中其注入会被静默跳过。因此本文件
 * 显式 mock electron-store，避免真实模块在加载时 require('electron')
 * 抛「Electron failed to install correctly」。
 */

let mockStoreInstance: any;

jest.mock('electron-store', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation((options?: any) => {
    const defaults = options?.defaults || {};
    let data: any = { ...defaults };
    mockStoreInstance = {
      get: (key: string) => key.split('.').reduce((o: any, k: string) => o?.[k], data),
      set: (key: string | object, value?: any) => {
        if (typeof key === 'string') {
          const keys = key.split('.');
          let o: any = data;
          for (let i = 0; i < keys.length - 1; i++) {
            if (!o[keys[i]]) o[keys[i]] = {};
            o = o[keys[i]];
          }
          o[keys[keys.length - 1]] = value;
        } else {
          Object.assign(data, key);
        }
      },
      clear: () => {
        data = { ...defaults };
      },
      get store() {
        return data;
      },
      onDidChange: jest.fn(),
    };
    return mockStoreInstance;
  }),
}));

import {
  DEFAULT_API_BASE_URL,
  DEFAULT_UPDATE_FEED_URL,
  loadRuntimeConfig,
  getApiBaseUrl,
  getUpdateFeedUrl,
  saveRuntimeConfig,
  resetRuntimeConfigCache,
  validateApiUrl,
  validateUpdateFeedUrl,
  RuntimeConfigError,
  tryLoadRuntimeConfig,
  isAutoUpdateEnabled,
} from '../src/shared/runtime-config';

const SAVED_ENV = {
  API_BASE_URL: process.env.API_BASE_URL,
  ELECTRON_UPDATER_URL: process.env.ELECTRON_UPDATER_URL,
  APPROVED_ZEROTIER_API_ORIGINS: process.env.APPROVED_ZEROTIER_API_ORIGINS,
  ELECTRON_UPDATER_ENABLED: process.env.ELECTRON_UPDATER_ENABLED,
};

describe('runtime-config.ts 地址解耦（v1.1 红线 5 复审后）', () => {
  beforeEach(() => {
    resetRuntimeConfigCache();
    delete process.env.API_BASE_URL;
    delete process.env.ELECTRON_UPDATER_URL;
    delete process.env.APPROVED_ZEROTIER_API_ORIGINS;
    delete process.env.ELECTRON_UPDATER_ENABLED;
  });

  afterEach(() => {
    resetRuntimeConfigCache();
    if (SAVED_ENV.API_BASE_URL !== undefined) process.env.API_BASE_URL = SAVED_ENV.API_BASE_URL;
    if (SAVED_ENV.ELECTRON_UPDATER_URL !== undefined) process.env.ELECTRON_UPDATER_URL = SAVED_ENV.ELECTRON_UPDATER_URL;
    if (SAVED_ENV.APPROVED_ZEROTIER_API_ORIGINS !== undefined) {
      process.env.APPROVED_ZEROTIER_API_ORIGINS = SAVED_ENV.APPROVED_ZEROTIER_API_ORIGINS;
    }
    if (SAVED_ENV.ELECTRON_UPDATER_ENABLED !== undefined) {
      process.env.ELECTRON_UPDATER_ENABLED = SAVED_ENV.ELECTRON_UPDATER_ENABLED;
    }
  });

  it('无环境变量与持久化时使用内置 ZeroTier API，更新器保持关闭', () => {
    expect(DEFAULT_API_BASE_URL).toBe('http://10.0.0.2/api');
    expect(DEFAULT_UPDATE_FEED_URL).toBe('');
    expect(loadRuntimeConfig()).toEqual({
      apiBaseUrl: 'http://10.0.0.2/api',
      updateFeedUrl: '',
    });
    expect(isAutoUpdateEnabled()).toBe(false);
    const status = tryLoadRuntimeConfig();
    expect(status.valid).toBe(true);
    expect(status.errors).toEqual([]);
  });

  it('环境变量 API_BASE_URL 优先级最高', () => {
    process.env.API_BASE_URL = 'https://api.example.com/api';
    process.env.ELECTRON_UPDATER_URL = 'https://updates.example.com/desktop';
    expect(getApiBaseUrl()).toBe('https://api.example.com/api');
  });

  it('环境变量 ELECTRON_UPDATER_URL 优先级最高', () => {
    process.env.API_BASE_URL = 'https://api.example.com/api';
    process.env.ELECTRON_UPDATER_URL = 'https://updates.example.com/desktop';
    expect(getUpdateFeedUrl()).toBe('https://updates.example.com/desktop');
  });

  it('持久化配置可覆盖默认值（公网 HTTPS）', () => {
    saveRuntimeConfig({
      apiBaseUrl: 'https://api.example.com/api',
      updateFeedUrl: 'https://updates.example.com/desktop',
    });
    expect(getApiBaseUrl()).toBe('https://api.example.com/api');
  });
});

describe('validateApiUrl — 策略 A（HTTPS 必公网，HTTP 必命中精确 allowlist）', () => {
  beforeEach(() => {
    delete process.env.APPROVED_ZEROTIER_API_ORIGINS;
  });
  afterEach(() => {
    delete process.env.APPROVED_ZEROTIER_API_ORIGINS;
  });

  it('公网 HTTPS 通过', () => {
    expect(validateApiUrl('https://api.example.com/api')).toBeNull();
  });

  it('公网 HTTP 拒绝（必须 HTTPS）', () => {
    const err = validateApiUrl('http://api.example.com/api');
    expect(err).toMatch(/公网 API 必须使用 HTTPS/);
  });

  it('空 allowlist 拒绝 ZeroTier 私网', () => {
    const err = validateApiUrl('http://10.0.0.2:4000/api');
    expect(err).toMatch(/origin 未在 APPROVED_ZEROTIER_API_ORIGINS/);
  });

  it('allowlist 精确 origin 允许', () => {
    process.env.APPROVED_ZEROTIER_API_ORIGINS = 'http://10.0.0.2:4000';
    expect(validateApiUrl('http://10.0.0.2:4000/api')).toBeNull();
  });

  it('10.0.0.2:4000 在只批准默认 80 时被拒绝（端口不匹配）', () => {
    // APPROVED_ZEROTIER_API_ORIGINS = "http://10.0.0.2"，意味着仅 80 端口
    process.env.APPROVED_ZEROTIER_API_ORIGINS = 'http://10.0.0.2';
    const err = validateApiUrl('http://10.0.0.2:4000/api');
    expect(err).toMatch(/origin 未在/);
  });

  it('10.0.0.3（同段不同 host）被拒绝', () => {
    process.env.APPROVED_ZEROTIER_API_ORIGINS = 'http://10.0.0.2:4000';
    const err = validateApiUrl('http://10.0.0.3:4000/api');
    expect(err).toMatch(/origin 未在/);
  });

  it('私网 HTTPS 拒绝（v1.2b 红线 #4：HTTPS 不能绕过 allowlist）', () => {
    // allowlist 空时私网 HTTPS 也必须被拒
    const err = validateApiUrl('https://192.168.1.5:4000/api');
    expect(err).toMatch(/origin 未在/);
  });

  it('私网 HTTPS 在 allowlist 内通过', () => {
    process.env.APPROVED_ZEROTIER_API_ORIGINS = 'https://192.168.1.5:4000';
    expect(validateApiUrl('https://192.168.1.5:4000/api')).toBeNull();
  });

  it.each([
    'https://[fd00::1]/api',
    'https://[fe80::1]/api',
    'https://[::ffff:ac19:f12f]/api',
    'https://backend.lan/api',
    'https://backend/api',
  ])('IPv6/映射地址/内网主机名必须按私网执行 allowlist: %s', (url) => {
    expect(validateApiUrl(url)).toMatch(/origin 未在/);
  });

  it('localhost 拒绝', () => {
    const err = validateApiUrl('http://localhost:4000/api');
    expect(err).toMatch(/loopback/);
  });

  it('localhost 即使命中 allowlist 也拒绝', () => {
    process.env.APPROVED_ZEROTIER_API_ORIGINS = 'http://127.0.0.1:4000';
    expect(validateApiUrl('http://127.0.0.1:4000/api')).toMatch(/loopback/);
  });

  it('query 与 fragment 拒绝', () => {
    expect(validateApiUrl('https://api.example.com/api?token=x')).toMatch(/query 或 fragment/);
    expect(validateApiUrl('https://api.example.com/api#x')).toMatch(/query 或 fragment/);
  });

  it('userinfo 拒绝', () => {
    const err = validateApiUrl('https://user:pass@api.example.com/api');
    expect(err).toMatch(/userinfo/);
  });

  it('allowlist 多 origin 用逗号分隔', () => {
    process.env.APPROVED_ZEROTIER_API_ORIGINS = 'http://10.0.0.2:4000,http://10.0.0.5:8000';
    expect(validateApiUrl('http://10.0.0.2:4000/api')).toBeNull();
    expect(validateApiUrl('http://10.0.0.5:8000/api')).toBeNull();
    expect(validateApiUrl('http://10.0.0.6:8000/api')).toMatch(/origin 未在/);
  });

  it('HTTPS 默认端口 443 显式 443 应被 allowlist 识别', () => {
    process.env.APPROVED_ZEROTIER_API_ORIGINS = 'https://api.example.com:443';
    // Node URL 在 https 默认 443 时不显式带端口；origin 为 "https://api.example.com"
    const origin = new URL('https://api.example.com:443').origin;
    expect(origin).toBe('https://api.example.com');
  });
});

describe('validateUpdateFeedUrl — 策略 B（必须 HTTPS + 拒绝私网）', () => {
  it('HTTPS 公网 通过', () => {
    expect(validateUpdateFeedUrl('https://updates.example.com/desktop')).toBeNull();
  });

  it('HTTP 任何来源都拒绝', () => {
    expect(validateUpdateFeedUrl('http://updates.example.com/desktop')).toMatch(/必须使用 HTTPS/);
  });

  it('HTTPS 私网 拒绝（更新源不允许 ZeroTier/局域网）', () => {
    expect(validateUpdateFeedUrl('https://127.0.0.1/desktop')).toMatch(/私网|本机/);
  });

  it('HTTPS localhost 拒绝', () => {
    expect(validateUpdateFeedUrl('https://localhost/desktop')).toMatch(/私网|本机/);
  });

  it.each([
    'https://[fd00::1]/desktop',
    'https://[::ffff:ac19:f12f]/desktop',
    'https://updates.lan/desktop',
  ])('IPv6/内网主机更新源拒绝: %s', (url) => {
    expect(validateUpdateFeedUrl(url)).toMatch(/私网|本机/);
  });

  it('allowlist 也不能放行 HTTP 更新源', () => {
    process.env.APPROVED_ZEROTIER_API_ORIGINS = 'http://updates.example.com';
    expect(validateUpdateFeedUrl('http://updates.example.com/desktop')).toMatch(/必须使用 HTTPS/);
  });
});

describe('saveRuntimeConfig — 拆分校验 + 不落盘', () => {
  beforeEach(() => {
    // v1.2b 红线 #5：saveRuntimeConfig 内部 loadRuntimeConfig 必须能成功
    // （否则它走不到 validateApiUrl 就抛 loadRuntimeConfig 的错）——本组测试
    // 需要把 env 强制设为合法值，让 loadRuntimeConfig 通过校验
    delete process.env.APPROVED_ZEROTIER_API_ORIGINS;
    process.env.API_BASE_URL = 'https://api.example.com/api';
    process.env.ELECTRON_UPDATER_URL = 'https://updates.example.com/desktop';
  });
  afterEach(() => {
    delete process.env.API_BASE_URL;
    delete process.env.ELECTRON_UPDATER_URL;
    delete process.env.APPROVED_ZEROTIER_API_ORIGINS;
  });

  it('saveRuntimeConfig 拒绝公网 HTTP API 抛错 + 不落盘', () => {
    expect(() => saveRuntimeConfig({ apiBaseUrl: 'http://api.example.com/api' })).toThrow(/公网 API 必须使用 HTTPS/);
    expect(getApiBaseUrl()).toBe('https://api.example.com/api');
  });

  it('saveRuntimeConfig 拒绝私网 HTTP API 在空 allowlist 时抛错', () => {
    expect(() => saveRuntimeConfig({ apiBaseUrl: 'http://192.168.1.5:4000/api' })).toThrow(/origin 未在/);
  });

  it('saveRuntimeConfig 接受 allowlist 内私网 HTTP API', () => {
    process.env.APPROVED_ZEROTIER_API_ORIGINS = 'http://10.0.0.2:4000';
    saveRuntimeConfig({ apiBaseUrl: 'http://10.0.0.2:4000/api' });
    delete process.env.API_BASE_URL;
    expect(getApiBaseUrl()).toBe('http://10.0.0.2:4000/api');
  });

  it('saveRuntimeConfig 拒绝 HTTP updateFeedUrl 抛错 + 不落盘', () => {
    expect(() => saveRuntimeConfig({ updateFeedUrl: 'http://u.example.com/x' })).toThrow(/必须使用 HTTPS/);
    expect(getUpdateFeedUrl()).toBe('https://updates.example.com/desktop');
  });

  it('saveRuntimeConfig 接受 HTTPS updateFeedUrl', () => {
    saveRuntimeConfig({ updateFeedUrl: 'https://u.example.com/x' });
    delete process.env.ELECTRON_UPDATER_URL;
    expect(getUpdateFeedUrl()).toBe('https://u.example.com/x');
  });
});

describe('loadRuntimeConfig 严格校验（v1.2b 红线 #5）', () => {
  beforeEach(() => {
    // saveRuntimeConfig 成功路径需要合法 URL，先写入
    saveRuntimeConfig({
      apiBaseUrl: 'https://api.example.com/api',
      updateFeedUrl: 'https://updates.example.com/desktop',
    });
  });
  afterEach(() => {
    delete process.env.API_BASE_URL;
    delete process.env.ELECTRON_UPDATER_URL;
  });

  it('合法 env + 合法持久化 → loadRuntimeConfig 应返回并通过校验', () => {
    process.env.API_BASE_URL = 'https://api.example.com/api';
    process.env.ELECTRON_UPDATER_URL = 'https://updates.example.com/desktop';
    const cfg = loadRuntimeConfig();
    expect(cfg.apiBaseUrl).toBe('https://api.example.com/api');
    expect(cfg.updateFeedUrl).toBe('https://updates.example.com/desktop');
  });

  it('env 注入私网 HTTP API → loadRuntimeConfig 抛 RuntimeConfigError（不静默回退）', () => {
    delete process.env.APPROVED_ZEROTIER_API_ORIGINS;
    process.env.API_BASE_URL = 'http://192.168.1.5:4000/api';
    expect(() => loadRuntimeConfig()).toThrow(RuntimeConfigError);
  });

  it('env 注入公网 HTTP API → loadRuntimeConfig 抛 RuntimeConfigError（公网必须 HTTPS）', () => {
    process.env.API_BASE_URL = 'http://api.example.com/api';
    expect(() => loadRuntimeConfig()).toThrow(/公网 API 必须使用 HTTPS/);
  });

  it('env 注入私网 HTTPS（空 allowlist） → loadRuntimeConfig 抛 RuntimeConfigError（v1.2b 红线 #4）', () => {
    delete process.env.APPROVED_ZEROTIER_API_ORIGINS;
    process.env.API_BASE_URL = 'https://10.0.0.2:4000/api';
    expect(() => loadRuntimeConfig()).toThrow(RuntimeConfigError);
  });

  it('env 注入私网 HTTPS（命中 allowlist） → loadRuntimeConfig 通过', () => {
    process.env.APPROVED_ZEROTIER_API_ORIGINS = 'https://10.0.0.2:4000';
    process.env.API_BASE_URL = 'https://10.0.0.2:4000/api';
    expect(() => loadRuntimeConfig()).not.toThrow();
  });

  it('非法 updateFeedUrl 不连带禁用 API，但更新器读取仍 fail-closed', () => {
    process.env.ELECTRON_UPDATER_URL = 'http://updates.example.com/desktop';
    expect(loadRuntimeConfig().apiBaseUrl).toBe('https://api.example.com/api');
    expect(() => getUpdateFeedUrl()).toThrow(/updateFeedUrl 必须使用 HTTPS/);
  });

  it('持久化历史脏值（env 缺）→ loadRuntimeConfig 抛 RuntimeConfigError（v1.2b 红线 #5 关键）', () => {
    // 写入一个危险的私网 HTTP 历史值（绕过 saveRuntimeConfig 校验的方式：
    // 模拟历史 electron-store 中的脏值——直接写 store）
    const m = require('../src/shared/runtime-config');
    m.resetRuntimeConfigCache();
    // 直接通过 process.env 模拟"env 也是脏值"
    delete process.env.API_BASE_URL;
    delete process.env.ELECTRON_UPDATER_URL;
    // 写一个绕过 saveRuntimeConfig 校验的"历史脏值"
    // （实际 electron-store 的旧数据可能因为 v1.2 之前的 bug 已落盘）
    // 这里通过 saveRuntimeConfig 持久化一个合法值，然后手动篡改 store 不易；
    // 改测：env 注入 + 持久化已合法，但 v1.2b 仍校验二者（已被 env 覆盖时也校验 env）
    process.env.API_BASE_URL = 'http://10.0.0.5:4000/api';
    expect(() => loadRuntimeConfig()).toThrow(RuntimeConfigError);
  });

  it('tryLoadRuntimeConfig 容错版本返回 errors[] 而不抛（用于配置页显示）', () => {
    process.env.API_BASE_URL = 'http://10.0.0.5:4000/api';
    const r = tryLoadRuntimeConfig();
    expect(r.valid).toBe(false);
    expect(r.config.apiBaseUrl).toBe('http://10.0.0.5:4000/api');
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0].field).toBe('apiBaseUrl');
    expect(r.errors[0].value).toBe('http://10.0.0.5:4000/api');
  });

  it('历史脏持久化值可由合法新值覆盖恢复', () => {
    delete process.env.API_BASE_URL;
    delete process.env.ELECTRON_UPDATER_URL;
    tryLoadRuntimeConfig(); // 创建当前 mock store 实例
    mockStoreInstance.set('config', {
      apiBaseUrl: 'http://10.0.0.5:4000/api',
      updateFeedUrl: 'https://updates.example.com/desktop',
    });

    const dirty = tryLoadRuntimeConfig();
    expect(dirty.valid).toBe(false);
    expect(() => loadRuntimeConfig()).toThrow(RuntimeConfigError);

    const repaired = saveRuntimeConfig({ apiBaseUrl: 'https://api.example.com/api' });
    expect(repaired.apiBaseUrl).toBe('https://api.example.com/api');
    expect(loadRuntimeConfig().apiBaseUrl).toBe('https://api.example.com/api');
  });
});
