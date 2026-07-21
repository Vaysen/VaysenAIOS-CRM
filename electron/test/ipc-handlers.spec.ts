/**
 * IpcHandlers 单元测试（TASK-111 自干补齐）
 *
 * 目标：在不依赖真实 Electron 主循环 / 原生二进制的前提下，
 * 真实地注册并调用 IPC 处理器，使 ipc-handlers.ts 的覆盖率
 * 超过受审阅的低阈值（不关闭覆盖率门禁，与 jest.config.js
 * 的分级门禁一致）。
 *
 * 沙箱中 electron 原生二进制未安装，故本文件显式 mock
 * electron / electron-store / axios，避免 require('electron') 抛
 * 「Electron failed to install correctly」。
 */

// 截获 ipcMain.handle / ipcMain.on 注册的处理器（变量名以 mock 前缀，
// 满足 jest.mock 工厂函数可引用外层变量的规则）
const mockRegistered: Record<string, (...args: any[]) => any> = {};
const mockStoreDataByName = new Map<string, any>();

jest.mock("electron", () => ({
  app: {
    getVersion: jest.fn(() => "1.0.0"),
    getPath: jest.fn((name: string) =>
      name === "userData" ? "/tmp/vaysen-crm-test" : "/tmp",
    ),
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
    contentView: { addChildView: jest.fn(), removeChildView: jest.fn() },
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
    handle: jest.fn((ch: string, cb: any) => {
      mockRegistered[ch] = cb;
    }),
    on: jest.fn((ch: string, cb: any) => {
      mockRegistered[ch] = cb;
    }),
    once: jest.fn(),
    off: jest.fn(),
    removeAllListeners: jest.fn(),
    removeHandler: jest.fn(),
  },
  safeStorage: {
    isEncryptionAvailable: jest.fn(() => true),
    encryptString: jest.fn((s: string) => Buffer.from(`enc:${s}`, "utf8")),
    decryptString: jest.fn((b: Buffer) => {
      const str = b.toString("utf8");
      return str.startsWith("enc:") ? str.slice(4) : str;
    }),
  },
  Tray: jest.fn().mockImplementation(() => ({
    setToolTip: jest.fn(),
    setContextMenu: jest.fn(),
    on: jest.fn(),
    destroy: jest.fn(),
  })),
  Menu: { buildFromTemplate: jest.fn(() => ({})) },
  nativeImage: {
    createFromPath: jest.fn(() => ({ isEmpty: () => false })),
    createEmpty: jest.fn(() => ({ isEmpty: () => true })),
  },
  shell: { openExternal: jest.fn() },
}));

jest.mock("electron-store", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation((options?: any) => {
    const defaults = options?.defaults || {};
    const storeName = options?.name || "__default__";
    const makeDefaultData = () => ({
      ...defaults,
      ...(Array.isArray(defaults.items) ? { items: [...defaults.items] } : {}),
    });
    if (!mockStoreDataByName.has(storeName)) {
      mockStoreDataByName.set(storeName, makeDefaultData());
    }
    const getData = () => {
      if (!mockStoreDataByName.has(storeName)) {
        mockStoreDataByName.set(storeName, makeDefaultData());
      }
      return mockStoreDataByName.get(storeName);
    };
    return {
      get: (key: string) =>
        key.split(".").reduce((o: any, k: string) => o?.[k], getData()),
      set: (key: string | object, value?: any) => {
        const data = getData();
        if (typeof key === "string") {
          const keys = key.split(".");
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
        mockStoreDataByName.set(storeName, makeDefaultData());
      },
      get store() {
        return getData();
      },
      onDidChange: jest.fn(),
    };
  }),
}));

jest.mock("axios", () => {
  const request = jest.fn(() =>
    Promise.resolve({ data: { success: true, mock: true }, status: 200 }),
  );
  (request as any).get = jest.fn();
  (request as any).post = jest.fn();
  return { __esModule: true, default: request };
});

import axios from "axios";
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { IpcHandlers } from "../src/main/ipc-handlers";
import { IPC_CHANNELS } from "../src/shared/ipc-channels";

function makeFakeWindow() {
  return {
    isDestroyed: jest.fn(() => false),
    isMaximized: jest.fn(() => false),
    minimize: jest.fn(),
    maximize: jest.fn(),
    unmaximize: jest.fn(),
    close: jest.fn(),
    webContents: {
      send: jest.fn(),
      startDrag: jest.fn(),
      executeJavaScript: jest.fn(() => Promise.resolve(null)),
      setWindowOpenHandler: jest.fn(),
    },
  };
}

function makeFakeView() {
  return {
    webContents: {
      send: jest.fn(),
      startDrag: jest.fn(),
      executeJavaScript: jest.fn(() => Promise.resolve(null)),
      sendInputEvent: jest.fn(),
      debugger: {
        isAttached: jest.fn(() => false),
        attach: jest.fn(),
        detach: jest.fn(),
        on: jest.fn(),
        sendCommand: jest.fn(() => Promise.resolve({})),
      },
    },
  };
}

let fakeWin: any;
let fakeView: any;
let sent: Array<{ channel: string; data: any }>;

function makeFakeWindowManager() {
  return {
    getMainWindow: () => fakeWin,
    sendToRenderer: (channel: string, data: any) =>
      sent.push({ channel, data }),
    getActiveWhatsappView: () => fakeView,
    getActiveAccountId: () => "default",
    getWhatsappAccountIdForSender: (sender: unknown) =>
      sender === fakeView.webContents ? "default" : null,
    setActiveAccount: jest.fn(() => true),
    removeWhatsappAccount: jest.fn(),
    getAccountList: () => [{ id: "default", label: "主账号", isActive: true }],
    updateLayout: jest.fn(),
    showWhatsappView: jest.fn(),
    hideWhatsappView: jest.fn(),
    setRendererOverlayWidth: jest.fn(),
    createWhatsappView: jest.fn(() => fakeView),
  } as unknown as any;
}

describe("IpcHandlers", () => {
  let ipc: IpcHandlers;
  let wm: any;

  function authenticateElectron(companyId = "company-1") {
    mockRegistered[IPC_CHANNELS.AUTH_SET_TOKEN](null, {
      token: "jwt-token",
      refreshToken: "refresh-token",
    });
    mockRegistered[IPC_CHANNELS.AUTH_SET_COMPANY](null, companyId);
  }

  function selectPrivateWhatsappChat(phone = "12025550123") {
    mockRegistered[IPC_CHANNELS.WA_LOGIN_STATUS](
      { sender: fakeView.webContents },
      { status: "logged_in" },
    );
    mockRegistered[IPC_CHANNELS.WA_CURRENT_CHAT](
      { sender: fakeView.webContents },
      { name: "Buyer", phone: `+${phone}`, isGroup: false },
    );
    fakeView.webContents.executeJavaScript.mockResolvedValue({
      name: "Buyer",
      phone,
      isGroup: false,
    });
    (ipc as any).getTokenAsync = jest.fn().mockResolvedValue("jwt-token");
    (ipc as any).getCompanyIdAsync = jest.fn().mockResolvedValue("company-1");
    return mockRegistered[IPC_CHANNELS.AGENT_DESKTOP_CAPABILITIES]().whatsapp.currentChat;
  }

  function makeQuoteProposal(
    expiresAt: string,
    overrides: Record<string, any> = {},
  ) {
    return {
      kind: "PREPARE_QUOTE_DELIVERY",
      status: "REQUIRES_CONFIRMATION",
      expiresAt,
      quote: { id: "quote-1", referenceNo: "QT-1" },
      target: { phone: "12025550123" },
      ...overrides,
    };
  }

  function claimedQuoteResponse(proposal: any, claimToken = "c".repeat(43)) {
    return {
      data: {
        status: "PREPARATION_CLAIMED",
        accepted: false,
        actionStatus: "PREPARATION_IN_PROGRESS",
        claimToken,
        claimExpiresAt: new Date(Date.now() + 30_000).toISOString(),
        actionProposal: proposal,
      },
    };
  }

  function confirmedQuoteResponse(proposal: any) {
    return {
      data: {
        status: "PREPARATION_CONFIRMED",
        accepted: true,
        actionStatus: "PREPARATION_CONFIRMED",
        actionProposal: proposal,
      },
    };
  }

  function releasedQuoteResponse(proposal: any) {
    return {
      data: {
        status: "PREPARATION_RELEASED",
        accepted: false,
        actionStatus: "REQUIRES_CONFIRMATION",
        actionProposal: proposal,
      },
    };
  }

  function preparedQuoteResult() {
    return {
      success: true,
      data: {
        preparedFileId: "prepared-1",
        quoteId: "quote-1",
        filename: "QT-1.pdf",
        size: 100,
        sha256: "abc",
        targetPhone: "12025550123",
      },
    };
  }

  function seedPreparedQuote(
    expiresAt: string,
    overrides: Record<string, any> = {},
  ) {
    (ipc as any).preparedQuoteFiles.set("prepared-1", {
      preparedFileId: "prepared-1",
      quoteId: "quote-1",
      filename: "QT-1.pdf",
      filePath: path.resolve(
        "/tmp",
        "Vaysen AI CRM",
        "待发送报价",
        "QT-1.pdf",
      ),
      size: 100,
      sha256: "abc",
      targetPhone: "12025550123",
      accountId: "default",
      proposalId: "proposal-1",
      quoteReferenceNo: "QT-1",
      expiresAt,
      ...overrides,
    });
  }

  beforeEach(() => {
    Object.keys(mockRegistered).forEach((k) => delete mockRegistered[k]);
    mockStoreDataByName.clear();
    (axios as unknown as jest.Mock).mockClear();
    (axios as any).get.mockReset();
    (axios as any).post.mockReset();
    fakeWin = makeFakeWindow();
    fakeView = makeFakeView();
    sent = [];
    wm = makeFakeWindowManager();
    // 中和 registerAppHandlers 内的 setInterval(checkOnline, 30000)
    jest.useFakeTimers();
    ipc = new IpcHandlers(wm, "http://127.0.0.1:4000/api");
    ipc.registerAll();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("registerAll 应该注册全部 IPC 处理器", () => {
    expect(Object.keys(mockRegistered).length).toBeGreaterThanOrEqual(20);
    expect(mockRegistered[IPC_CHANNELS.AUTH_GET_TOKEN]).toBeDefined();
    expect(mockRegistered[IPC_CHANNELS.API_REQUEST]).toBeDefined();
    expect(mockRegistered[IPC_CHANNELS.APP_CONFIG_SET]).toBeDefined();
    expect(mockRegistered[IPC_CHANNELS.WA_NEW_MESSAGE]).toBeDefined();
    expect(mockRegistered[IPC_CHANNELS.AI_SUGGESTION]).toBeDefined();
  });

  it("APP_VERSION 应该返回 app.getVersion()", () => {
    const v = mockRegistered[IPC_CHANNELS.APP_VERSION]();
    expect(v).toBe("1.0.0");
  });

  it("APP_CONFIG_GET 首启返回局域网默认 API，更新源为空但不影响业务", () => {
    const status = mockRegistered[IPC_CHANNELS.APP_CONFIG_GET]();
    expect(status.valid).toBe(true);
    expect(status.config.apiBaseUrl).toBe(
      process.env.API_BASE_URL || "http://127.0.0.1/api",
    );
    expect(status.config.updateFeedUrl).toBe("");
    expect(status.errors).toEqual([]);
  });

  it("在线状态应探测实际局域网后端 /health，而不是公网 DNS", async () => {
    await Promise.resolve();
    await Promise.resolve();
    expect(axios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        url: "http://127.0.0.1:4000/health",
        timeout: 5000,
      }),
    );
    expect(
      sent.some(
        (item) =>
          item.channel === IPC_CHANNELS.APP_ONLINE_STATUS && item.data === true,
      ),
    ).toBe(true);
  });

  it("API 未配置时配置 IPC 可用，但业务与 AI 请求 fail-closed", async () => {
    Object.keys(mockRegistered).forEach((k) => delete mockRegistered[k]);
    const unconfigured = new IpcHandlers(wm, null);
    unconfigured.registerAll();

    expect(() => mockRegistered[IPC_CHANNELS.APP_CONFIG_GET]()).not.toThrow();
    await expect(
      mockRegistered[IPC_CHANNELS.API_REQUEST](null, {
        method: "GET",
        url: "/health",
      }),
    ).resolves.toMatchObject({
      success: false,
      status: 0,
      message: expect.stringContaining("API 尚未配置"),
    });
    await expect(
      mockRegistered[IPC_CHANNELS.AI_SUGGESTION](null, { messageId: "m1" }),
    ).rejects.toThrow(/AI 请求已被阻断/);
  });

  it("APP_CONFIG_SET 应该写入并返回 { success: true, config } + 广播 need-restart", async () => {
    const result = await mockRegistered[IPC_CHANNELS.APP_CONFIG_SET](null, {
      apiBaseUrl: "https://api.example.com/api",
      updateFeedUrl: "https://updates.example.com/desktop",
    });
    expect(result.success).toBe(true);
    expect(result.config.apiBaseUrl).toBe("https://api.example.com/api");
    expect(result.config.updateFeedUrl).toBe(
      "https://updates.example.com/desktop",
    );
    // 应广播 APP_NEED_RESTART 给渲染进程
    expect(sent.some((s) => s.channel === IPC_CHANNELS.APP_NEED_RESTART)).toBe(
      true,
    );
  });

  it("APP_CONFIG_SET 非法 URL 应返回 { success: false, error } + 不广播", async () => {
    // 注意：setup.ts 全局设置了 APPROVED_ZEROTIER_API_ORIGINS 为空，
    // 私网 HTTP 会被新校验器拒绝（origin 不在 allowlist）。
    // 此处用公网 HTTP（应被"公网 API 必须使用 HTTPS"拒绝），与 allowlist 无关。
    const result = await mockRegistered[IPC_CHANNELS.APP_CONFIG_SET](null, {
      apiBaseUrl: "http://api.example.com/api",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/公网 API 必须使用 HTTPS|origin 未在/);
    // 失败路径不应广播 need-restart
    expect(sent.some((s) => s.channel === IPC_CHANNELS.APP_NEED_RESTART)).toBe(
      false,
    );
  });

  it("AUTH_SET_TOKEN / AUTH_GET_TOKEN 应该经 safeStorage 加解密", () => {
    mockRegistered[IPC_CHANNELS.AUTH_SET_TOKEN](null, {
      token: "tok-1",
      refreshToken: "ref-1",
    });
    const got = mockRegistered[IPC_CHANNELS.AUTH_GET_TOKEN]();
    expect(got).toBe("tok-1");
  });

  it("AUTH_GET_TOKEN 无 token 时应返回 null", () => {
    const got = mockRegistered[IPC_CHANNELS.AUTH_GET_TOKEN]();
    expect(got).toBeNull();
  });

  it("AUTH_CLEAR_TOKEN 应该清空认证存储", () => {
    mockRegistered[IPC_CHANNELS.AUTH_SET_TOKEN](null, {
      token: "tok-2",
      refreshToken: "ref-2",
    });
    mockRegistered[IPC_CHANNELS.AUTH_CLEAR_TOKEN]();
    const got = mockRegistered[IPC_CHANNELS.AUTH_GET_TOKEN]();
    expect(got).toBeNull();
  });

  it("WINDOW_MINIMIZE / CLOSE 应该调用主窗口方法", () => {
    mockRegistered[IPC_CHANNELS.WINDOW_MINIMIZE]();
    expect(fakeWin.minimize).toHaveBeenCalled();
    mockRegistered[IPC_CHANNELS.WINDOW_CLOSE]();
    expect(fakeWin.close).toHaveBeenCalled();
  });

  it("WINDOW_IS_MAXIMIZED 应该返回主窗口状态", () => {
    const r = mockRegistered[IPC_CHANNELS.WINDOW_IS_MAXIMIZED]();
    expect(r).toBe(false);
    expect(fakeWin.isMaximized).toHaveBeenCalled();
  });

  it("WINDOW_MAXIMIZE 应该在未最大化时调用 maximize", () => {
    fakeWin.isMaximized.mockReturnValue(false);
    mockRegistered[IPC_CHANNELS.WINDOW_MAXIMIZE]();
    expect(fakeWin.maximize).toHaveBeenCalled();
  });

  it("API_REQUEST 应该经 axios 转发并返回结果", async () => {
    const res = await mockRegistered[IPC_CHANNELS.API_REQUEST](null, {
      method: "GET",
      url: "/ping",
    });
    expect(res.success).toBe(true);
    expect(axios).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://127.0.0.1:4000/api/ping" }),
    );
  });

  it("WA_SEND_TEXT 应 fail-closed，不能把未绑定目标的文本注入当前聊天", async () => {
    const result = await mockRegistered[IPC_CHANNELS.WA_SEND_TEXT](null, {
      chatId: "c1",
      text: "hi",
    });
    expect(result).toEqual(expect.objectContaining({ success: false }));
    expect(result.error).toContain("自动文本发送已禁用");
    expect(sent.some((s) => s.channel === IPC_CHANNELS.WA_INJECT_TEXT)).toBe(
      false,
    );
  });

  it("WA_NEW_MESSAGE 应该先持久化，再在后端确认后删除", async () => {
    authenticateElectron();
    (axios as unknown as jest.Mock).mockResolvedValue({
      data: { status: "ok" },
      status: 200,
    });

    await mockRegistered[IPC_CHANNELS.WA_NEW_MESSAGE](
      { sender: fakeView.webContents },
      {
        id: "message-1",
        chatPhone: "8613800000000",
        text: "hello",
      },
    );

    expect(sent.some((s) => s.channel === IPC_CHANNELS.WA_NEW_MESSAGE)).toBe(
      true,
    );
    expect((ipc as any).whatsappMessageOutboxStore.get("items")).toHaveLength(
      1,
    );

    await jest.advanceTimersByTimeAsync(0);

    expect(axios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        url: "http://127.0.0.1:4000/api/whatsapp/electron-webhook/message",
        data: expect.objectContaining({
          id: "message-1",
          accountId: "default",
          selectedCompanyId: "company-1",
        }),
        headers: expect.objectContaining({
          Authorization: "Bearer jwt-token",
          "X-Company-Id": "company-1",
        }),
      }),
    );
    expect((ipc as any).whatsappMessageOutboxStore.get("items")).toEqual([]);
  });

  it("消息在公司 A 观测后即使切换到公司 B，重试仍只能投递到公司 A", async () => {
    authenticateElectron("company-A");
    (axios as unknown as jest.Mock).mockResolvedValue({
      data: { status: "ok" },
      status: 200,
    });

    await mockRegistered[IPC_CHANNELS.WA_NEW_MESSAGE](
      { sender: fakeView.webContents },
      {
        id: "message-bound-before-switch",
        chatPhone: "8613800000000",
        text: "tenant-bound",
      },
    );
    mockRegistered[IPC_CHANNELS.AUTH_SET_COMPANY](null, "company-B");

    await jest.advanceTimersByTimeAsync(0);

    const messageCall = (axios as unknown as jest.Mock).mock.calls.find(
      ([config]) => config?.url?.endsWith("/whatsapp/electron-webhook/message"),
    )?.[0];
    expect(messageCall).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ selectedCompanyId: "company-A" }),
        headers: expect.objectContaining({ "X-Company-Id": "company-A" }),
      }),
    );
    expect(messageCall.headers["X-Company-Id"]).not.toBe("company-B");
  });

  it("观测时未选择公司则持久化隔离，不在稍后选择公司时自动改绑", async () => {
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mockRegistered[IPC_CHANNELS.AUTH_SET_TOKEN](null, {
      token: "jwt-token",
      refreshToken: "refresh-token",
    });

    await mockRegistered[IPC_CHANNELS.WA_NEW_MESSAGE](
      { sender: fakeView.webContents },
      {
        id: "message-without-company",
        chatPhone: "8613800000000",
        text: "quarantine me",
      },
    );
    mockRegistered[IPC_CHANNELS.AUTH_SET_COMPANY](null, "company-later");
    await jest.advanceTimersByTimeAsync(0);

    const stored = (ipc as any).whatsappMessageOutboxStore.get("items");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual(
      expect.objectContaining({
        id: "unbound:default:message-without-company",
        attemptCount: 1,
        lastError: expect.stringContaining("quarantined"),
      }),
    );
    expect(
      (axios as unknown as jest.Mock).mock.calls.filter(([config]) =>
        config?.url?.endsWith("/whatsapp/electron-webhook/message"),
      ),
    ).toEqual([]);
    consoleError.mockRestore();
  });

  it("WA_NEW_MESSAGE should attribute a hidden WhatsApp view to its owning account", async () => {
    authenticateElectron();
    const hiddenView = makeFakeView();
    wm.getWhatsappAccountIdForSender = jest.fn((sender: unknown) => {
      if (sender === fakeView.webContents) return "default";
      if (sender === hiddenView.webContents) return "secondary";
      return null;
    });
    (axios as unknown as jest.Mock).mockResolvedValue({
      data: { status: "ok" },
      status: 200,
    });

    await mockRegistered[IPC_CHANNELS.WA_NEW_MESSAGE](
      { sender: hiddenView.webContents },
      {
        id: "secondary-message-1",
        chatPhone: "12025550199",
        text: "from hidden account",
        isOutgoing: true,
      },
    );

    expect(
      sent.find((entry) => entry.channel === IPC_CHANNELS.WA_NEW_MESSAGE)?.data,
    ).toEqual(
      expect.objectContaining({
        accountId: "secondary",
        id: "secondary-message-1",
      }),
    );
    expect((ipc as any).whatsappMessageOutboxStore.get("items")[0]).toEqual(
      expect.objectContaining({
        id: "company-1:secondary:secondary-message-1",
      }),
    );

    await jest.advanceTimersByTimeAsync(0);

    expect(axios).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://127.0.0.1:4000/api/whatsapp/electron-webhook/message",
        data: expect.objectContaining({
          accountId: "secondary",
          id: "secondary-message-1",
          isOutgoing: true,
          selectedCompanyId: "company-1",
        }),
      }),
    );
    expect((ipc as any).whatsappMessageOutboxStore.get("items")).toEqual([]);
  });

  it("WA_NEW_MESSAGE should drop unread counters, missing ids and forged senders", () => {
    mockRegistered[IPC_CHANNELS.WA_NEW_MESSAGE](
      { sender: fakeView.webContents },
      {
        id: "unread-counter-1",
        type: "unread-count",
        count: 7,
      },
    );
    mockRegistered[IPC_CHANNELS.WA_NEW_MESSAGE](
      { sender: fakeView.webContents },
      {
        text: "missing id",
        chatPhone: "8613800000000",
      },
    );
    mockRegistered[IPC_CHANNELS.WA_NEW_MESSAGE](
      { sender: {} },
      {
        id: "forged-message-1",
        text: "forged",
        chatPhone: "8613800000000",
      },
    );

    expect(
      sent.filter((entry) => entry.channel === IPC_CHANNELS.WA_NEW_MESSAGE),
    ).toEqual([]);
    expect((ipc as any).whatsappMessageOutboxStore.get("items")).toEqual([]);
    expect(
      (axios as unknown as jest.Mock).mock.calls.filter(([config]) =>
        config?.url?.endsWith("/whatsapp/electron-webhook/message"),
      ),
    ).toEqual([]);
  });

  it("HTTP 200 的 status:error 必须保留消息并指数退避重试", async () => {
    authenticateElectron();
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    let messageAttempts = 0;
    (axios as unknown as jest.Mock).mockImplementation((config: any) => {
      if (config?.url?.endsWith("/whatsapp/electron-webhook/message")) {
        messageAttempts += 1;
        if (messageAttempts <= 2) {
          return Promise.resolve({
            data: { status: "error", message: "database unavailable" },
            status: 200,
          });
        }
        return Promise.resolve({ data: { status: "ok" }, status: 200 });
      }
      return Promise.resolve({ data: { status: "ok" }, status: 200 });
    });

    await mockRegistered[IPC_CHANNELS.WA_NEW_MESSAGE](
      { sender: fakeView.webContents },
      {
        id: "message-retry",
        chatPhone: "8613800000000",
        text: "retry me",
      },
    );
    await jest.advanceTimersByTimeAsync(0);

    const failed = (ipc as any).whatsappMessageOutboxStore.get("items");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toEqual(
      expect.objectContaining({
        id: "company-1:default:message-retry",
        attemptCount: 1,
        lastError: "database unavailable",
      }),
    );
    expect(messageAttempts).toBe(1);

    await jest.advanceTimersByTimeAsync(1_999);
    expect(messageAttempts).toBe(1);
    await jest.advanceTimersByTimeAsync(1);

    expect(messageAttempts).toBe(2);
    expect((ipc as any).whatsappMessageOutboxStore.get("items")[0]).toEqual(
      expect.objectContaining({ attemptCount: 2 }),
    );

    await jest.advanceTimersByTimeAsync(3_999);
    expect(messageAttempts).toBe(2);
    await jest.advanceTimersByTimeAsync(1);

    expect(messageAttempts).toBe(3);
    expect((ipc as any).whatsappMessageOutboxStore.get("items")).toEqual([]);
    consoleError.mockRestore();
  });

  it("应用重启后应从持久化 outbox 恢复未投递消息", async () => {
    authenticateElectron();
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    (axios as unknown as jest.Mock).mockImplementation((config: any) => {
      if (config?.url?.endsWith("/whatsapp/electron-webhook/message")) {
        return Promise.reject(new Error("backend offline"));
      }
      return Promise.resolve({ data: { status: "ok" }, status: 200 });
    });

    await mockRegistered[IPC_CHANNELS.WA_NEW_MESSAGE](
      { sender: fakeView.webContents },
      {
        id: "message-survives-restart",
        chatPhone: "8613800000000",
        text: "persist me",
      },
    );
    await jest.advanceTimersByTimeAsync(0);
    expect((ipc as any).whatsappMessageOutboxStore.get("items")).toHaveLength(
      1,
    );

    // 模拟进程退出：旧调度器消失，但 electron-store 数据仍存在。
    jest.clearAllTimers();
    Object.keys(mockRegistered).forEach((key) => delete mockRegistered[key]);
    (axios as unknown as jest.Mock).mockResolvedValue({
      data: { status: "ok" },
      status: 200,
    });
    const restarted = new IpcHandlers(wm, "http://127.0.0.1:4000/api");
    restarted.registerAll();

    await jest.advanceTimersByTimeAsync(2_000);

    expect((restarted as any).whatsappMessageOutboxStore.get("items")).toEqual(
      [],
    );
    expect(axios).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://127.0.0.1:4000/api/whatsapp/electron-webhook/message",
        data: expect.objectContaining({ id: "message-survives-restart" }),
      }),
    );
    consoleError.mockRestore();
  });

  it("WA_LOGIN_STATUS 应该转发给渲染进程", () => {
    mockRegistered[IPC_CHANNELS.WA_LOGIN_STATUS](
      { sender: fakeView.webContents },
      { status: "logged_in" },
    );
    expect(sent.some((s) => s.channel === IPC_CHANNELS.WA_LOGIN_STATUS)).toBe(
      true,
    );
  });

  it("AI 业务助理桌面桥只开放人工确认的报价准备能力", () => {
    const snapshot = mockRegistered[IPC_CHANNELS.AGENT_DESKTOP_CAPABILITIES]();

    expect(snapshot).toEqual(
      expect.objectContaining({
        schemaVersion: 2,
        mode: "human-confirmed",
        executor: {
          supported: true,
          actions: [
            "prepare_quote_delivery",
            "fill_whatsapp_draft",
            "send_whatsapp_text_human_confirmed",
          ],
        },
        safety: {
          automaticSend: false,
          offlineCatchUp: false,
          retryUnknownResult: false,
          domInjection: true,
          targetIdentityRequired: true,
          manualWhatsappSendRequired: true,
        },
      }),
    );
    expect(snapshot.whatsapp.activeAccount).toEqual({
      id: "default",
      label: expect.any(String),
    });
    expect(snapshot.whatsapp.login.status).toBe("unknown");
    expect(snapshot.whatsapp.currentChat).toBeNull();
  });

  it("fills a WhatsApp draft only after the active direct-chat identity is verified", async () => {
    const selected = selectPrivateWhatsappChat("12025550123");

    const pending = mockRegistered[IPC_CHANNELS.WA_FILL_DRAFT](
      { sender: fakeWin.webContents },
      {
        text: "Hello Buyer",
        targetPhone: "+1 202 555 0123",
        targetName: "Buyer",
        targetAccountId: "default",
        selectionProof: selected.selectionProof,
      },
    );
    await Promise.resolve();
    await Promise.resolve();

    const fillCall = fakeView.webContents.send.mock.calls.find(
      ([channel]: [string]) => channel === IPC_CHANNELS.WA_FILL_DRAFT,
    );
    expect(fillCall).toBeDefined();
    expect(fillCall[1]).toEqual(
      expect.objectContaining({
        requestId: expect.any(String),
        text: "Hello Buyer",
        targetPhone: "12025550123",
      }),
    );

    mockRegistered[IPC_CHANNELS.WA_FILL_DRAFT_RESULT](
      { sender: fakeView.webContents },
      { requestId: fillCall[1].requestId, success: true },
    );
    await expect(pending).resolves.toEqual({ success: true });
  });

  it("refuses to fill a WhatsApp draft when the live chat changed", async () => {
    const selected = selectPrivateWhatsappChat("12025550123");
    fakeView.webContents.executeJavaScript.mockResolvedValue({
      name: "Other Buyer",
      phone: "12025550124",
      isGroup: false,
    });

    await expect(
      mockRegistered[IPC_CHANNELS.WA_FILL_DRAFT](
        { sender: fakeWin.webContents },
        {
          text: "Hello Buyer",
          targetPhone: "12025550123",
          targetName: "Buyer",
          targetAccountId: "default",
          selectionProof: selected.selectionProof,
        },
      ),
    ).resolves.toEqual(
      expect.objectContaining({ success: false }),
    );
    expect(fakeView.webContents.send).not.toHaveBeenCalledWith(
      IPC_CHANNELS.WA_FILL_DRAFT,
      expect.anything(),
    );
  });

  it("accepts the selected modern LID chat when the live page exposes the same name but no phone", async () => {
    const selected = selectPrivateWhatsappChat("12025550123");
    fakeView.webContents.executeJavaScript.mockResolvedValue({
      name: "Buyer",
      phone: "",
      isGroup: false,
    });
    const pending = mockRegistered[IPC_CHANNELS.WA_FILL_DRAFT](
      { sender: fakeWin.webContents },
      {
        text: "Hello Buyer",
        targetPhone: "12025550123",
        targetName: "Buyer",
        targetAccountId: "default",
        selectionProof: selected.selectionProof,
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    const fillCall = fakeView.webContents.send.mock.calls.find(
      ([channel]: [string]) => channel === IPC_CHANNELS.WA_FILL_DRAFT,
    );
    expect(fillCall).toBeDefined();
    mockRegistered[IPC_CHANNELS.WA_FILL_DRAFT_RESULT](
      { sender: fakeView.webContents },
      { requestId: fillCall[1].requestId, success: true },
    );
    await expect(pending).resolves.toEqual({ success: true });
  });

  it("rejects a stale or fabricated WhatsApp selection proof", async () => {
    selectPrivateWhatsappChat("12025550123");
    await expect(mockRegistered[IPC_CHANNELS.WA_FILL_DRAFT](
      { sender: fakeWin.webContents },
      {
        text: "Hello Buyer",
        targetPhone: "12025550123",
        targetName: "Buyer",
        targetAccountId: "default",
        selectionProof: "99999999-9999-4999-8999-999999999999",
      },
    )).resolves.toEqual(expect.objectContaining({ success: false }));
  });

  it("refuses WhatsApp draft fill requests from untrusted renderer senders", async () => {
    selectPrivateWhatsappChat("12025550123");

    await expect(
      mockRegistered[IPC_CHANNELS.WA_FILL_DRAFT](
        { sender: {} },
        { text: "Hello Buyer", targetPhone: "12025550123" },
      ),
    ).resolves.toEqual(expect.objectContaining({ success: false }));
  });

  it("sends text only after an exact backend grant and a matching live WhatsApp identity", async () => {
    const selected = selectPrivateWhatsappChat("12025550123");
    const conversationId = "22222222-2222-4222-8222-222222222222";
    const actionId = "33333333-3333-4333-8333-333333333333";
    const text = "Hello verified buyer";
    const textDigest = createHash("sha256")
      .update(JSON.stringify({ text }), "utf8")
      .digest("hex");
    (axios.post as jest.Mock).mockImplementation((url: string, body: any) => {
      if (url.endsWith("/authorize")) {
        return Promise.resolve({
          data: {
            status: "CLAIMED",
            actionId,
            requestId: body.requestId,
            conversationId,
            targetPhone: "12025550123",
            textDigest,
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
          },
        });
      }
      if (url.endsWith(`/${actionId}/complete`)) {
        return Promise.resolve({ data: { state: "SUCCEEDED" } });
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    const pending = mockRegistered[IPC_CHANNELS.AGENT_SEND_WHATSAPP_TEXT](
      { sender: fakeWin.webContents },
      {
        conversationId,
        targetPhone: "+1 202 555 0123",
        targetName: "Buyer",
        targetAccountId: "default",
        selectionProof: selected.selectionProof,
        text,
      },
    );
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    await jest.advanceTimersByTimeAsync(1);

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining("/external-actions/whatsapp-text/authorize"),
      expect.objectContaining({ conversationId, text, confirmed: true }),
      expect.any(Object),
    );

    const sendCall = fakeView.webContents.send.mock.calls.find(
      ([channel]: [string]) => channel === IPC_CHANNELS.WA_SEND_AUTHORIZED,
    );
    expect(sendCall).toBeDefined();
    expect(sendCall[1]).toEqual(expect.objectContaining({
      requestId: expect.any(String),
      actionId,
      text,
      targetPhone: "12025550123",
    }));
    mockRegistered[IPC_CHANNELS.WA_SEND_AUTHORIZED_RESULT](
      { sender: fakeView.webContents },
      {
        requestId: sendCall[1].requestId,
        actionId,
        sent: true,
        reason: "click-dispatched",
      },
    );

    await expect(pending).resolves.toEqual({ success: true, actionId });
    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining(`/${actionId}/complete`),
      { outcome: "SUCCEEDED", code: "CLICK_DISPATCHED" },
      expect.any(Object),
    );
  });

  it("AI 业务助理快照只接受活跃 WhatsApp view 的状态事件", () => {
    mockRegistered[IPC_CHANNELS.WA_LOGIN_STATUS](
      { sender: {} },
      { status: "logged_in" },
    );
    expect(
      mockRegistered[IPC_CHANNELS.AGENT_DESKTOP_CAPABILITIES]().whatsapp.login
        .status,
    ).toBe("unknown");

    mockRegistered[IPC_CHANNELS.WA_LOGIN_STATUS](
      { sender: fakeView.webContents },
      { status: "logged_in" },
    );
    mockRegistered[IPC_CHANNELS.WA_CURRENT_CHAT](
      { sender: fakeView.webContents },
      { name: "Buyer A", phone: "+12025550123", isGroup: false },
    );

    const snapshot = mockRegistered[IPC_CHANNELS.AGENT_DESKTOP_CAPABILITIES]();
    expect(snapshot.whatsapp.login.status).toBe("logged_in");
    expect(snapshot.whatsapp.currentChat).toEqual(
      expect.objectContaining({
        accountId: "default",
        name: "Buyer A",
        phone: "+12025550123",
        isGroup: false,
      }),
    );
  });

  it("WA_REQUEST_CURRENT_CHAT 应同步返回并重放已缓存的真实聊天快照", async () => {
    mockRegistered[IPC_CHANNELS.WA_CURRENT_CHAT](
      { sender: fakeView.webContents },
      { name: "Sample Buyer", phone: "12025550123", isGroup: false },
    );
    sent = [];

    const result = await mockRegistered[IPC_CHANNELS.WA_REQUEST_CURRENT_CHAT]();

    expect(result).toEqual({
      requested: true,
      chat: expect.objectContaining({
        accountId: "default",
        name: "Sample Buyer",
        phone: "12025550123",
        isGroup: false,
      }),
    });
    expect(fakeView.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.WA_REQUEST_CURRENT_CHAT,
    );
    expect(sent).toContainEqual({
      channel: IPC_CHANNELS.WA_CURRENT_CHAT,
      data: expect.objectContaining({
        name: "Sample Buyer",
        phone: "12025550123",
      }),
    });
  });

  it("WA_REQUEST_CURRENT_CHAT 应用主世界只读结果补全可信号码", async () => {
    fakeView.webContents.executeJavaScript.mockResolvedValue({
      name: "Sample Buyer",
      phone: "12025550123",
      isGroup: false,
    });

    const result = await mockRegistered[IPC_CHANNELS.WA_REQUEST_CURRENT_CHAT]();

    expect(result.chat).toEqual(
      expect.objectContaining({
        name: "Sample Buyer",
        phone: "12025550123",
      }),
    );
    expect(sent).toContainEqual({
      channel: IPC_CHANNELS.WA_CURRENT_CHAT,
      data: expect.objectContaining({ phone: "12025550123" }),
    });
  });

  it("AI 业务助理 heartbeat 应声明仅支持人工确认执行器", () => {
    const heartbeat = mockRegistered[IPC_CHANNELS.AGENT_DESKTOP_HEARTBEAT]();
    expect(heartbeat).toEqual(
      expect.objectContaining({
        schemaVersion: 2,
        mode: "human-confirmed",
        activeAccountId: "default",
        loginStatus: "unknown",
        loginObservedAt: null,
        currentChatKnown: false,
        currentChatObservedAt: null,
        executorSupported: true,
      }),
    );
  });

  it("报价准备桥拒绝非主窗口和无效提案，且旧自动发送入口永久拒绝", async () => {
    const baseRequest = { proposalId: "proposal-1" };
    await expect(
      mockRegistered[IPC_CHANNELS.AGENT_PREPARE_QUOTE_DELIVERY](
        { sender: {} },
        baseRequest,
      ),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("主业务窗口"),
    });
    await expect(
      mockRegistered[IPC_CHANNELS.AGENT_PREPARE_QUOTE_DELIVERY](
        { sender: fakeWin.webContents },
        { proposalId: "" },
      ),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("提案无效"),
    });
    await expect(
      mockRegistered[IPC_CHANNELS.WA_SEND_DOCUMENT](
        { sender: fakeWin.webContents },
        {},
      ),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("永久禁用"),
    });
  });

  it("报价准备桥按 claim -> PDF -> complete 的顺序完成，成功后不复用 token", async () => {
    selectPrivateWhatsappChat();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const proposal = makeQuoteProposal(expiresAt);
    const claimToken = "s".repeat(43);
    (axios as any).post
      .mockResolvedValueOnce(claimedQuoteResponse(proposal, claimToken))
      .mockResolvedValueOnce(confirmedQuoteResponse(proposal));
    const prepare = jest.fn().mockResolvedValue(preparedQuoteResult());
    (ipc as any).prepareQuoteFile = prepare;

    const result = await mockRegistered[
      IPC_CHANNELS.AGENT_PREPARE_QUOTE_DELIVERY
    ]({ sender: fakeWin.webContents }, { proposalId: "proposal-1" });

    expect(result).toEqual(preparedQuoteResult());
    expect(
      (axios as any).post.mock.calls.map((call: any[]) => call[0]),
    ).toEqual([
      "http://127.0.0.1:4000/api/agent-runs/assistant/actions/proposal-1/confirm",
      "http://127.0.0.1:4000/api/agent-runs/assistant/actions/proposal-1/complete",
    ]);
    expect((axios as any).post.mock.calls[1][1]).toEqual({ claimToken });
    expect(prepare).toHaveBeenCalledWith(
      { quoteId: "quote-1", filename: "QT-1.pdf" },
      {
        targetPhone: "12025550123",
        accountId: "default",
        proposalId: "proposal-1",
        quoteReferenceNo: "QT-1",
        expiresAt,
      },
    );
  });

  it("claim 后联系人漂移会安全 release，且不会准备 PDF", async () => {
    selectPrivateWhatsappChat();
    fakeView.webContents.executeJavaScript.mockResolvedValue({
      name: "Buyer B",
      phone: "12025550999",
      isGroup: false,
    });
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const proposal = makeQuoteProposal(expiresAt);
    const claimToken = "m".repeat(43);
    (axios as any).post
      .mockResolvedValueOnce(claimedQuoteResponse(proposal, claimToken))
      .mockResolvedValueOnce(releasedQuoteResponse(proposal));
    const prepare = jest.fn();
    (ipc as any).prepareQuoteFile = prepare;

    const result = await mockRegistered[
      IPC_CHANNELS.AGENT_PREPARE_QUOTE_DELIVERY
    ]({ sender: fakeWin.webContents }, { proposalId: "proposal-1" });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("联系人已变化"),
    });
    expect(prepare).not.toHaveBeenCalled();
    expect((axios as any).post).toHaveBeenLastCalledWith(
      "http://127.0.0.1:4000/api/agent-runs/assistant/actions/proposal-1/release",
      { claimToken, failureCode: "WHATSAPP_CONTACT_CHANGED" },
      expect.any(Object),
    );
  });

  it("PDF 准备失败会安全 release，且不会调用 complete", async () => {
    selectPrivateWhatsappChat();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const proposal = makeQuoteProposal(expiresAt);
    const claimToken = "p".repeat(43);
    (axios as any).post
      .mockResolvedValueOnce(claimedQuoteResponse(proposal, claimToken))
      .mockResolvedValueOnce(releasedQuoteResponse(proposal));
    (ipc as any).prepareQuoteFile = jest.fn().mockResolvedValue({
      success: false,
      error: "PDF 无效",
    });

    const result = await mockRegistered[
      IPC_CHANNELS.AGENT_PREPARE_QUOTE_DELIVERY
    ]({ sender: fakeWin.webContents }, { proposalId: "proposal-1" });

    expect(result).toEqual({ success: false, error: "PDF 无效" });
    expect(
      (axios as any).post.mock.calls.map((call: any[]) => call[0]),
    ).toEqual([
      "http://127.0.0.1:4000/api/agent-runs/assistant/actions/proposal-1/confirm",
      "http://127.0.0.1:4000/api/agent-runs/assistant/actions/proposal-1/release",
    ]);
    expect((axios as any).post.mock.calls[1][1]).toEqual({
      claimToken,
      failureCode: "PDF_PREPARATION_FAILED",
    });
  });

  it("complete 回包丢失时 probe 到终态并保留原 prepared handle", async () => {
    selectPrivateWhatsappChat();
    const exists = jest.spyOn(fs, "existsSync").mockReturnValue(true);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const proposal = makeQuoteProposal(expiresAt);
    const claimToken = "n".repeat(43);
    (axios as any).post
      .mockResolvedValueOnce(claimedQuoteResponse(proposal, claimToken))
      .mockRejectedValueOnce(new Error("socket closed after commit"))
      .mockResolvedValueOnce(confirmedQuoteResponse(proposal));
    (ipc as any).prepareQuoteFile = jest.fn().mockImplementation(async () => {
      seedPreparedQuote(expiresAt);
      return preparedQuoteResult();
    });

    try {
      const result = await mockRegistered[
        IPC_CHANNELS.AGENT_PREPARE_QUOTE_DELIVERY
      ]({ sender: fakeWin.webContents }, { proposalId: "proposal-1" });

      expect(result).toEqual(preparedQuoteResult());
      expect((ipc as any).preparedQuoteFiles.has("prepared-1")).toBe(true);
      expect(
        (axios as any).post.mock.calls.map((call: any[]) => call[0]),
      ).toEqual([
        "http://127.0.0.1:4000/api/agent-runs/assistant/actions/proposal-1/confirm",
        "http://127.0.0.1:4000/api/agent-runs/assistant/actions/proposal-1/complete",
        "http://127.0.0.1:4000/api/agent-runs/assistant/actions/proposal-1/confirm",
      ]);
    } finally {
      exists.mockRestore();
    }
  });

  it("初始 confirm 已终态时从唯一且严格匹配的本地 handle 恢复，不重复准备", async () => {
    selectPrivateWhatsappChat();
    const exists = jest.spyOn(fs, "existsSync").mockReturnValue(true);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const proposal = makeQuoteProposal(expiresAt);
    seedPreparedQuote(expiresAt);
    (ipc as any).preparedQuoteFiles.set("wrong-account", {
      ...(ipc as any).preparedQuoteFiles.get("prepared-1"),
      preparedFileId: "wrong-account",
      accountId: "other",
    });
    (axios as any).post.mockResolvedValueOnce(confirmedQuoteResponse(proposal));
    const prepare = jest.fn();
    (ipc as any).prepareQuoteFile = prepare;

    try {
      const result = await mockRegistered[
        IPC_CHANNELS.AGENT_PREPARE_QUOTE_DELIVERY
      ]({ sender: fakeWin.webContents }, { proposalId: "proposal-1" });

      expect(result).toEqual(preparedQuoteResult());
      expect(prepare).not.toHaveBeenCalled();
      expect((axios as any).post).toHaveBeenCalledTimes(1);
    } finally {
      exists.mockRestore();
    }
  });

  it("非法 claim token 被 fail-closed 拒绝，不向 complete 或 release 泄露", async () => {
    selectPrivateWhatsappChat();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const proposal = makeQuoteProposal(expiresAt);
    (axios as any).post.mockResolvedValueOnce(
      claimedQuoteResponse(proposal, "not-a-token"),
    );
    const prepare = jest.fn();
    (ipc as any).prepareQuoteFile = prepare;

    const result = await mockRegistered[
      IPC_CHANNELS.AGENT_PREPARE_QUOTE_DELIVERY
    ]({ sender: fakeWin.webContents }, { proposalId: "proposal-1" });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("授权"),
    });
    expect(prepare).not.toHaveBeenCalled();
    expect((axios as any).post).toHaveBeenCalledTimes(1);
  });

  it("complete/probe/release 均拒绝已消费 token 时保留本地 handle 等待终态恢复", async () => {
    selectPrivateWhatsappChat();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const proposal = makeQuoteProposal(expiresAt);
    const claimToken = "r".repeat(43);
    (axios as any).post
      .mockResolvedValueOnce(claimedQuoteResponse(proposal, claimToken))
      .mockRejectedValueOnce(new Error("claim already consumed"))
      .mockRejectedValueOnce(
        new Error("terminal probe temporarily unavailable"),
      )
      .mockRejectedValueOnce(new Error("claim already consumed"));
    (ipc as any).prepareQuoteFile = jest.fn().mockImplementation(async () => {
      seedPreparedQuote(expiresAt);
      return preparedQuoteResult();
    });

    const result = await mockRegistered[
      IPC_CHANNELS.AGENT_PREPARE_QUOTE_DELIVERY
    ]({ sender: fakeWin.webContents }, { proposalId: "proposal-1" });

    expect(result).toMatchObject({
      success: false,
      error: "claim already consumed",
    });
    expect((ipc as any).preparedQuoteFiles.has("prepared-1")).toBe(true);
    expect((axios as any).post.mock.calls[3][0]).toContain("/release");
    expect((axios as any).post.mock.calls[3][1]).toEqual({
      claimToken,
      failureCode: "DESKTOP_PREPARATION_FAILED",
    });
  });

  it("complete 未达终态且 release 被明确确认后才删除本地 handle", async () => {
    selectPrivateWhatsappChat();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const proposal = makeQuoteProposal(expiresAt);
    const claimToken = "d".repeat(43);
    (axios as any).post
      .mockResolvedValueOnce(claimedQuoteResponse(proposal, claimToken))
      .mockResolvedValueOnce({ data: { status: "UNKNOWN" } })
      .mockRejectedValueOnce(new Error("not terminal"))
      .mockResolvedValueOnce(releasedQuoteResponse(proposal));
    (ipc as any).prepareQuoteFile = jest.fn().mockImplementation(async () => {
      seedPreparedQuote(expiresAt);
      return preparedQuoteResult();
    });

    const result = await mockRegistered[
      IPC_CHANNELS.AGENT_PREPARE_QUOTE_DELIVERY
    ]({ sender: fakeWin.webContents }, { proposalId: "proposal-1" });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("未确认"),
    });
    expect((ipc as any).preparedQuoteFiles.has("prepared-1")).toBe(false);
    expect((axios as any).post.mock.calls[3][0]).toContain("/release");
  });

  it("普通准备与 AI 准备使用不同的一次性句柄，不能覆盖客户绑定", async () => {
    const mkdir = jest
      .spyOn(fs, "mkdirSync")
      .mockImplementation(() => undefined as any);
    const exists = jest.spyOn(fs, "existsSync").mockReturnValue(false);
    const write = jest
      .spyOn(fs, "writeFileSync")
      .mockImplementation(() => undefined);
    const rename = jest
      .spyOn(fs, "renameSync")
      .mockImplementation(() => undefined);
    (axios as any).get.mockResolvedValue({
      data: Buffer.from("%PDF-1.4\nfixture"),
    });
    (ipc as any).getTokenAsync = jest.fn().mockResolvedValue("jwt-token");
    (ipc as any).getCompanyIdAsync = jest.fn().mockResolvedValue("company-1");

    try {
      const generic = await (ipc as any).prepareQuoteFile({
        quoteId: "quote-1",
        filename: "QT-1.pdf",
      });
      const bound = await (ipc as any).prepareQuoteFile(
        { quoteId: "quote-1", filename: "QT-1.pdf" },
        {
          targetPhone: "12025550123",
          accountId: "default",
          proposalId: "proposal-1",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      );

      expect(generic.data.preparedFileId).not.toBe(bound.data.preparedFileId);
      expect((ipc as any).preparedQuoteFiles.size).toBe(2);
      expect(
        (ipc as any).preparedQuoteFiles.get(generic.data.preparedFileId)
          .targetPhone,
      ).toBeUndefined();
      expect(
        (ipc as any).preparedQuoteFiles.get(bound.data.preparedFileId)
          .targetPhone,
      ).toBe("12025550123");
    } finally {
      mkdir.mockRestore();
      exists.mockRestore();
      write.mockRestore();
      rename.mockRestore();
    }
  });

  it("群聊即使号码看似匹配也禁止准备客户报价 PDF", async () => {
    mockRegistered[IPC_CHANNELS.WA_LOGIN_STATUS](
      { sender: fakeView.webContents },
      { status: "logged_in" },
    );
    mockRegistered[IPC_CHANNELS.WA_CURRENT_CHAT](
      { sender: fakeView.webContents },
      { name: "Buyer Group", phone: "+12025550123", isGroup: true },
    );
    const prepare = jest.fn();
    (ipc as any).prepareQuoteFile = prepare;

    const result = await mockRegistered[
      IPC_CHANNELS.AGENT_PREPARE_QUOTE_DELIVERY
    ]({ sender: fakeWin.webContents }, { proposalId: "proposal-group" });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("聊天身份"),
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("联系人切换后会在原生拖拽前再次阻止旧报价文件", async () => {
    mockRegistered[IPC_CHANNELS.WA_LOGIN_STATUS](
      { sender: fakeView.webContents },
      { status: "logged_in" },
    );
    mockRegistered[IPC_CHANNELS.WA_CURRENT_CHAT](
      { sender: fakeView.webContents },
      { name: "Buyer B", phone: "+12025550999", isGroup: false },
    );
    fakeView.webContents.executeJavaScript.mockResolvedValue({
      name: "Buyer B",
      phone: "12025550999",
      isGroup: false,
    });
    (ipc as any).preparedQuoteFiles.set("prepared-1", {
      preparedFileId: "prepared-1",
      quoteId: "quote-1",
      filename: "QT-1.pdf",
      filePath: __filename,
      size: 100,
      sha256: "abc",
      targetPhone: "12025550123",
      accountId: "default",
      proposalId: "proposal-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await mockRegistered[IPC_CHANNELS.QUOTE_FILE_START_DRAG](
      { sender: fakeWin.webContents },
      { preparedFileId: "prepared-1" },
    );
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("联系人已变化"),
    });
  });

  it("匹配当前账号与实时联系人时仅允许消费一次拖拽句柄", async () => {
    const exists = jest.spyOn(fs, "existsSync").mockReturnValue(true);
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath =
      "/tmp/resources";
    mockRegistered[IPC_CHANNELS.WA_LOGIN_STATUS](
      { sender: fakeView.webContents },
      { status: "logged_in" },
    );
    mockRegistered[IPC_CHANNELS.WA_CURRENT_CHAT](
      { sender: fakeView.webContents },
      { name: "Buyer A", phone: "+12025550123", isGroup: false },
    );
    fakeView.webContents.executeJavaScript.mockResolvedValue({
      name: "Buyer A",
      phone: "12025550123",
      isGroup: false,
    });
    (ipc as any).preparedQuoteFiles.set("prepared-once", {
      preparedFileId: "prepared-once",
      quoteId: "quote-1",
      filename: "QT-1.pdf",
      filePath: path.resolve(
        "/tmp",
        "Vaysen AI CRM",
        "待发送报价",
        "QT-1.pdf",
      ),
      size: 100,
      sha256: "abc",
      targetPhone: "12025550123",
      accountId: "default",
      proposalId: "proposal-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const first = await mockRegistered[IPC_CHANNELS.QUOTE_FILE_START_DRAG](
      { sender: fakeWin.webContents },
      { preparedFileId: "prepared-once" },
    );
    const second = await mockRegistered[IPC_CHANNELS.QUOTE_FILE_START_DRAG](
      { sender: fakeWin.webContents },
      { preparedFileId: "prepared-once" },
    );

    expect(first).toEqual({ success: true });
    expect(fakeWin.webContents.startDrag).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({
      success: false,
      error: expect.stringContaining("重新生成"),
    });
    exists.mockRestore();
  });

  it("WA_CONTACTS_SYNC 应该转发并推送后端", async () => {
    await mockRegistered[IPC_CHANNELS.WA_CONTACTS_SYNC](
      { sender: fakeView.webContents },
      { contacts: [] },
    );
    expect(sent.some((s) => s.channel === IPC_CHANNELS.WA_CONTACTS_SYNC)).toBe(
      true,
    );
  });

  it("WA_REQUEST_CURRENT_CHAT 应该向活跃 WhatsApp 视图请求重发快照", async () => {
    const result = await mockRegistered[IPC_CHANNELS.WA_REQUEST_CURRENT_CHAT]();
    expect(result).toEqual({ requested: true, chat: null });
    expect(fakeView.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.WA_REQUEST_CURRENT_CHAT,
    );
  });

  it("WA_API_REQUEST 应该经 axios 转发", async () => {
    const res = await mockRegistered[IPC_CHANNELS.WA_API_REQUEST](null, {
      method: "GET",
      url: "/wa-ping",
    });
    expect(res.success).toBe(true);
  });

  it("WA 多账号管理应该代理到 WindowManager", () => {
    const created = mockRegistered[IPC_CHANNELS.WA_CREATE_ACCOUNT](null, {
      accountId: "a2",
      label: "A2",
    });
    expect(created.success).toBe(true);
    const switched = mockRegistered[IPC_CHANNELS.WA_SWITCH_ACCOUNT](null, {
      accountId: "a2",
    });
    expect(switched.success).toBe(true);
    const removed = mockRegistered[IPC_CHANNELS.WA_REMOVE_ACCOUNT](null, {
      accountId: "a2",
    });
    expect(removed.success).toBe(true);
    const list = mockRegistered[IPC_CHANNELS.WA_LIST_ACCOUNTS]();
    expect(Array.isArray(list)).toBe(true);
  });

  it("WA 视图布局控制应该代理到 WindowManager", () => {
    mockRegistered[IPC_CHANNELS.WA_SHOW_VIEW](null, { leftNavWidth: 240 });
    mockRegistered[IPC_CHANNELS.WA_HIDE_VIEW]();
    mockRegistered[IPC_CHANNELS.WA_SET_LAYOUT](null, { topOffset: 64 });
    mockRegistered[IPC_CHANNELS.WA_SET_OVERLAY_WIDTH](null, 540);
    expect(wm.showWhatsappView).toHaveBeenCalled();
    expect(wm.hideWhatsappView).toHaveBeenCalled();
    expect(wm.updateLayout).toHaveBeenCalled();
    expect(wm.setRendererOverlayWidth).toHaveBeenCalledWith(540);
  });

  it("AI_SUGGESTION / AI_TRANSLATE 应该调用 AICommunications", async () => {
    const r1 = await mockRegistered[IPC_CHANNELS.AI_SUGGESTION](null, {
      messageId: "m1",
      targetLanguage: "en",
    });
    expect(r1.success).toBe(true);
    const r2 = await mockRegistered[IPC_CHANNELS.AI_TRANSLATE](null, {
      text: "你好",
      targetLanguage: "en",
    });
    expect(r2.success).toBe(true);
  });
});
