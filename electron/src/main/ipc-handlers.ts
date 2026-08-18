/**
 * IPC 通信处理器
 * 处理渲染进程与主进程之间的所有 IPC 通信
 */

import {
  ipcMain,
  safeStorage,
  app,
  BrowserWindow,
  nativeImage,
  shell,
} from "electron";
import Store from "electron-store";
import axios from "axios";
import fs from "fs";
import path from "path";
import { createHash, randomUUID } from "crypto";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import {
  saveRuntimeConfig,
  tryLoadRuntimeConfig,
} from "../shared/runtime-config";
import { checkApiConnection } from './connection-check';
import { WindowManager } from "./window-manager";
import { AICommunications } from "./ai-communications";
import type {
  AgentDesktopCapabilitySnapshot,
  AgentDesktopHeartbeat,
  AgentQuoteDeliveryRequest,
  AgentQuoteDeliveryResult,
  AgentWhatsappTextSendRequest,
  AgentWhatsappTextSendResult,
} from "../shared/agent-bridge-types";

interface AuthStore {
  token: string | null;
  refreshToken: string | null;
  companyId: string | null;
}

interface WhatsAppMessageOutboxEntry {
  id: string;
  payloadCiphertext: string;
  payloadEncoding: "safe-storage" | "plain-json";
  createdAt: number;
  attemptCount: number;
  nextAttemptAt: number;
  lastError?: string;
}

interface WhatsAppMessageOutboxStore {
  items: WhatsAppMessageOutboxEntry[];
}

interface PreparedQuoteFile {
  preparedFileId: string;
  quoteId: string;
  filename: string;
  filePath: string;
  size: number;
  sha256: string;
  targetPhone?: string;
  accountId?: string;
  proposalId?: string;
  quoteReferenceNo?: string;
  expiresAt: string;
}

interface ValidatedQuoteActionProposal {
  raw: any;
  quoteId: string;
  referenceNo: string;
  targetPhone: string;
  expiresAt: string;
  expiryMs: number;
}

const WHATSAPP_OUTBOX_RETRY_BASE_MS = 2_000;
const WHATSAPP_OUTBOX_RETRY_MAX_MS = 5 * 60_000;
const WHATSAPP_OUTBOX_BATCH_SIZE = 20;

export class IpcHandlers {
  private authStore = new Store<AuthStore>({
    name: "auth",
    defaults: { token: null, refreshToken: null, companyId: null },
    encryptionKey: "vaysen-crm-desktop-auth-key",
  });

  /**
   * WhatsApp DOM events are captured before they reach the backend.  Keep a
   * separate durable queue so a renderer refresh, backend restart or desktop
   * app restart cannot silently discard a captured customer message.
   */
  private whatsappMessageOutboxStore = new Store<WhatsAppMessageOutboxStore>({
    name: "whatsapp-message-outbox",
    defaults: { items: [] },
    encryptionKey: "vaysen-crm-desktop-whatsapp-outbox-key",
  });
  private whatsappOutboxTimer: ReturnType<typeof setTimeout> | null = null;
  private whatsappOutboxTimerDueAt: number | null = null;
  private whatsappOutboxFlushing = false;

  private windowManager: WindowManager;
  private apiBaseUrl: string | null;
  private aiComms: AICommunications | null;
  private whatsappLoginState = new Map<
    string,
    { status: string; observedAt: string }
  >();
  private whatsappCurrentChat = new Map<
    string,
    {
      accountId: string;
      name: string;
      phone: string;
      isGroup: boolean;
      externalId?: string;
      observedAt: string;
      selectionProof: string;
    }
  >();
  private preparedQuoteFiles = new Map<string, PreparedQuoteFile>();
  private pendingWhatsappDraftFills = new Map<
    string,
    {
      accountId: string;
      resolve: (result: { success: boolean; error?: string }) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private pendingAuthorizedWhatsappSends = new Map<
    string,
    {
      accountId: string;
      actionId: string;
      resolve: (result: { sent: boolean; reason: string }) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(windowManager: WindowManager, apiBaseUrl: string | null) {
    this.windowManager = windowManager;
    this.apiBaseUrl = apiBaseUrl;
    this.aiComms = apiBaseUrl ? new AICommunications(apiBaseUrl) : null;
  }

  private requireApiBaseUrl(): string {
    if (!this.apiBaseUrl) {
      throw new Error(
        "运行时 API 尚未配置或配置非法；请求已被阻断，请先修正配置并重启",
      );
    }
    return this.apiBaseUrl;
  }

  private normalizeWhatsappPhone(value: string | undefined): string {
    const digits = (value || "").replace(/\D/g, "");
    return /^\d{7,15}$/.test(digits) ? digits : "";
  }

  private normalizeWhatsappName(value: string | undefined): string {
    return (value || "")
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase();
  }

  private validateQuoteActionProposal(
    value: any,
  ): ValidatedQuoteActionProposal | null {
    const quoteId =
      typeof value?.quote?.id === "string" ? value.quote.id.trim() : "";
    const referenceNo =
      typeof value?.quote?.referenceNo === "string"
        ? value.quote.referenceNo.trim()
        : "";
    const targetPhone = this.normalizeWhatsappPhone(value?.target?.phone);
    const expiresAt =
      typeof value?.expiresAt === "string" ? value.expiresAt : "";
    const expiryMs = Date.parse(expiresAt);
    if (
      value?.kind !== "PREPARE_QUOTE_DELIVERY" ||
      value?.status !== "REQUIRES_CONFIRMATION" ||
      !quoteId ||
      !referenceNo ||
      !targetPhone ||
      !Number.isFinite(expiryMs) ||
      expiryMs <= Date.now()
    ) {
      return null;
    }
    return {
      raw: value,
      quoteId,
      referenceNo,
      targetPhone,
      expiresAt,
      expiryMs,
    };
  }

  private quoteActionProposalsMatch(
    left: ValidatedQuoteActionProposal,
    right: ValidatedQuoteActionProposal,
  ): boolean {
    return (
      left.quoteId === right.quoteId &&
      left.referenceNo === right.referenceNo &&
      left.targetPhone === right.targetPhone &&
      left.expiresAt === right.expiresAt
    );
  }

  private validatePreparationConfirmedResponse(
    data: any,
    expected?: ValidatedQuoteActionProposal,
  ): ValidatedQuoteActionProposal | null {
    if (
      data?.status !== "PREPARATION_CONFIRMED" ||
      data?.accepted !== true ||
      data?.actionStatus !== "PREPARATION_CONFIRMED"
    ) {
      return null;
    }
    const proposal = this.validateQuoteActionProposal(data.actionProposal);
    if (
      !proposal ||
      (expected && !this.quoteActionProposalsMatch(proposal, expected))
    ) {
      return null;
    }
    return proposal;
  }

  private preparedQuoteResult(
    prepared: PreparedQuoteFile,
  ): AgentQuoteDeliveryResult {
    return {
      success: true,
      data: {
        preparedFileId: prepared.preparedFileId,
        quoteId: prepared.quoteId,
        filename: prepared.filename,
        size: prepared.size,
        sha256: prepared.sha256,
        targetPhone: prepared.targetPhone || "",
      },
    };
  }

  private recoverPreparedQuoteFile(
    proposalId: string,
    accountId: string,
    proposal: ValidatedQuoteActionProposal,
  ): AgentQuoteDeliveryResult | null {
    const matches: PreparedQuoteFile[] = [];
    for (const [id, prepared] of this.preparedQuoteFiles) {
      const expiryMs = Date.parse(prepared.expiresAt);
      if (!Number.isFinite(expiryMs) || expiryMs <= Date.now()) {
        this.preparedQuoteFiles.delete(id);
        continue;
      }
      if (
        prepared.proposalId === proposalId &&
        prepared.accountId === accountId &&
        prepared.quoteId === proposal.quoteId &&
        prepared.quoteReferenceNo === proposal.referenceNo &&
        prepared.targetPhone === proposal.targetPhone &&
        prepared.expiresAt === proposal.expiresAt &&
        fs.existsSync(prepared.filePath)
      ) {
        matches.push(prepared);
      }
    }
    // Ambiguous local state is never guessed. A unique, still-existing file is
    // required before a terminal server acknowledgement can be recovered.
    return matches.length === 1 ? this.preparedQuoteResult(matches[0]) : null;
  }

  private async prepareQuoteFile(
    data: { quoteId: string; filename: string },
    binding?: {
      targetPhone: string;
      accountId: string;
      proposalId: string;
      quoteReferenceNo?: string;
      expiresAt: string;
    },
  ): Promise<AgentQuoteDeliveryResult> {
    try {
      if (!data?.quoteId || typeof data.quoteId !== "string") {
        return { success: false, error: "报价编号无效" };
      }

      const token = await this.getTokenAsync();
      const companyId = await this.getCompanyIdAsync();
      const response = await axios.get(
        `${this.requireApiBaseUrl()}/quotes/${encodeURIComponent(data.quoteId)}/pdf`,
        {
          responseType: "arraybuffer",
          timeout: 60000,
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(companyId ? { "X-Company-Id": companyId } : {}),
          },
        },
      );

      const pdf = Buffer.from(response.data);
      if (pdf.length < 5 || pdf.subarray(0, 5).toString("ascii") !== "%PDF-") {
        return { success: false, error: "服务器返回的文件不是有效 PDF" };
      }

      const directory = path.resolve(
        app.getPath("documents"),
        "Vaysen 外贸系统",
        "待发送报价",
      );
      fs.mkdirSync(directory, { recursive: true });
      let filename = (data.filename || `${data.quoteId}.pdf`)
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
        .trim();
      if (!filename.toLowerCase().endsWith(".pdf")) filename += ".pdf";
      if (!filename || filename === ".pdf") filename = `${data.quoteId}.pdf`;

      const filePath = path.resolve(directory, filename);
      if (!filePath.startsWith(`${directory}${path.sep}`)) {
        return { success: false, error: "报价文件路径无效" };
      }

      const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tempPath, pdf);
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        fs.renameSync(tempPath, filePath);
      } finally {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      }

      const normalizedTargetPhone = binding?.targetPhone
        ? this.normalizeWhatsappPhone(binding.targetPhone)
        : undefined;
      const preparedFileId = randomUUID();
      const defaultExpiry = new Date(Date.now() + 15 * 60_000).toISOString();
      const prepared = {
        preparedFileId,
        quoteId: data.quoteId,
        filename,
        filePath,
        size: pdf.length,
        sha256: createHash("sha256").update(pdf).digest("hex"),
        targetPhone: normalizedTargetPhone,
        accountId: binding?.accountId,
        proposalId: binding?.proposalId,
        quoteReferenceNo: binding?.quoteReferenceNo,
        expiresAt: binding?.expiresAt || defaultExpiry,
      };
      for (const [id, existing] of this.preparedQuoteFiles) {
        if (
          new Date(existing.expiresAt).getTime() <= Date.now() ||
          (binding?.proposalId && existing.proposalId === binding.proposalId)
        ) {
          this.preparedQuoteFiles.delete(id);
        }
      }
      this.preparedQuoteFiles.set(preparedFileId, prepared);
      return {
        success: true,
        data: {
          preparedFileId,
          quoteId: prepared.quoteId,
          filename: prepared.filename,
          size: prepared.size,
          sha256: prepared.sha256,
          targetPhone: prepared.targetPhone || "",
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error:
          error?.response?.data?.message ||
          error?.message ||
          "准备报价文件失败",
      };
    }
  }

  /**
   * 注册所有 IPC 处理器
   */
  registerAll(): void {
    this.registerAuthHandlers();
    this.registerApiHandlers();
    this.registerWindowHandlers();
    this.registerWhatsAppHandlers();
    this.registerAppHandlers();
    this.registerAIHandlers();
    this.registerAgentBridgeHandlers();
    this.resumeWhatsappMessageOutbox();
  }

  /**
   * Only WhatsApp's isolated WebContentsView may update the state exposed to
   * the AI assistant.  The main renderer cannot forge a healthy/login/chat
   * snapshot by sending the same IPC channel.
   */
  private isActiveWhatsappSender(
    event: { sender?: unknown } | null | undefined,
  ): boolean {
    const senderAccountId = this.getWhatsappSenderAccountId(event);
    return (
      !!senderAccountId &&
      senderAccountId === this.windowManager.getActiveAccountId()
    );
  }

  private getWhatsappSenderAccountId(
    event: { sender?: unknown } | null | undefined,
  ): string | null {
    if (!event?.sender) return null;
    return this.windowManager.getWhatsappAccountIdForSender(event.sender);
  }

  /**
   * WhatsApp 的 React identity 存在页面主世界，隔离 preload 无法读取 expando。
   * 主进程只执行这一段固定、只读脚本，并在返回后再次校验姓名和号码格式。
   */
  private async readCurrentWhatsappIdentity(): Promise<{
    name: string;
    phone: string;
    isGroup: boolean;
    externalId: string;
  } | null> {
    const view = this.windowManager.getActiveWhatsappView();
    if (!view || typeof view.webContents.executeJavaScript !== "function")
      return null;

    const script = `(() => {
      const selected = document.querySelector('#pane-side [aria-selected="true"]');
      const title = document.querySelector('#main [data-testid="conversation-info-header-chat-title"]');
      const name = (title && title.textContent || '').trim();
      if (!selected || !name) return null;

      const reactRoots = Object.keys(selected)
        .filter((key) => key.startsWith('__reactFiber$') || key.startsWith('__reactProps$'))
        .map((key) => selected[key]);

      const firstLid = (root) => {
        const seen = new WeakSet();
        let visited = 0;
        const walk = (value, depth) => {
          if (typeof value === 'string') return /^\\d+@lid$/.test(value) ? value : null;
          if (!value || (typeof value !== 'object' && typeof value !== 'function') || depth > 8 || visited > 1000) return null;
          if (seen.has(value)) return null;
          seen.add(value); visited += 1;
          const keys = Object.keys(value).slice(0, 160).sort((a, b) => {
            const score = (key) => /^(id|props|children|child|stateNode)$|serialized/i.test(key) ? 0 : 1;
            return score(a) - score(b);
          });
          for (const key of keys) {
            let child; try { child = value[key]; } catch { continue; }
            const found = walk(child, depth + 1); if (found) return found;
          }
          return null;
        };
        return walk(root, 0);
      };

      let selectedLid = null;
      for (const root of reactRoots) {
        const stateNode = root && root.stateNode;
        if (stateNode) {
          const propsKey = Object.keys(stateNode).find((key) => key.startsWith('__reactProps$'));
          if (propsKey) selectedLid = firstLid(stateNode[propsKey]);
        }
        if (!selectedLid && root && !root.return) selectedLid = firstLid(root);
        if (selectedLid) break;
      }
      if (!selectedLid) return { name, phone: '', isGroup: false, externalId: '' };

      const findPhoneRecord = (root) => {
        const seen = new WeakSet();
        let visited = 0;
        const walk = (value, depth) => {
          if (!value || (typeof value !== 'object' && typeof value !== 'function') || depth > 7 || visited > 1800) return null;
          if (seen.has(value)) return null;
          seen.add(value); visited += 1;
          const id = value.__x_id || value.id;
          if (id && id._serialized === selectedLid && /^\\d{7,15}@(c\\.us|s\\.whatsapp\\.net)$/.test(value.__x_historyChatId || '')) {
            return value.__x_historyChatId;
          }
          const keys = Object.keys(value).slice(0, 180).sort((a, b) => {
            const score = (key) => /^(active|list|props|children)$/.test(key) ? 0 : 1;
            return score(a) - score(b);
          });
          for (const key of keys) {
            let child; try { child = value[key]; } catch { continue; }
            const found = walk(child, depth + 1); if (found) return found;
          }
          return null;
        };
        return walk(root, 0);
      };

      let phoneJid = null;
      for (const root of reactRoots) {
        let fiber = root && root.return ? root : null;
        for (let level = 0; fiber && level < 9 && !phoneJid; level += 1, fiber = fiber.return) {
          phoneJid = findPhoneRecord(fiber.stateNode && fiber.stateNode.props);
        }
        if (phoneJid) break;
      }
      return {
        name,
        phone: phoneJid ? phoneJid.replace(/@(?:c\\.us|s\\.whatsapp\\.net)$/, '') : '',
        isGroup: false,
        externalId: selectedLid,
      };
    })()`;

    try {
      const result = (await view.webContents.executeJavaScript(
        script,
        true,
      )) as any;
      if (!result || typeof result.name !== "string" || result.name.length > 99)
        return null;
      const phone =
        typeof result.phone === "string" && /^\d{7,15}$/.test(result.phone)
          ? result.phone
          : "";
      return {
        name: result.name.trim(),
        phone,
        isGroup: result.isGroup === true,
        externalId: typeof result.externalId === "string" && /^(?:\d+@lid|\d{7,15}@(?:c\.us|s\.whatsapp\.net))$/.test(result.externalId)
          ? result.externalId
          : "",
      };
    } catch (error) {
      console.warn("[IPC] WhatsApp 主世界身份读取失败:", error);
      return null;
    }
  }

  private buildAgentDesktopCapabilities(
    now = new Date(),
  ): AgentDesktopCapabilitySnapshot {
    const observedAt = now.toISOString();
    const activeAccountId = this.windowManager.getActiveAccountId();
    const view = this.windowManager.getActiveWhatsappView();
    const available =
      !!view &&
      (typeof view.webContents.isDestroyed !== "function" ||
        !view.webContents.isDestroyed());
    const account = activeAccountId
      ? this.windowManager
          .getAccountList()
          .find((item) => item.id === activeAccountId)
      : undefined;
    const login = activeAccountId
      ? this.whatsappLoginState.get(activeAccountId)
      : undefined;
    const currentChat = activeAccountId
      ? this.whatsappCurrentChat.get(activeAccountId)
      : undefined;

    return {
      schemaVersion: 2,
      observedAt,
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
      whatsapp: {
        available,
        activeAccount: activeAccountId
          ? { id: activeAccountId, label: account?.label || "" }
          : null,
        login: {
          status: login?.status || "unknown",
          observedAt: login?.observedAt || null,
        },
        currentChat: currentChat ? { ...currentChat } : null,
      },
    };
  }

  private registerAgentBridgeHandlers(): void {
    ipcMain.handle(IPC_CHANNELS.AGENT_DESKTOP_CAPABILITIES, () =>
      this.buildAgentDesktopCapabilities(),
    );
    ipcMain.handle(
      IPC_CHANNELS.AGENT_DESKTOP_HEARTBEAT,
      (): AgentDesktopHeartbeat => {
        const snapshot = this.buildAgentDesktopCapabilities();
        return {
          schemaVersion: 2,
          observedAt: snapshot.observedAt,
          mode: "human-confirmed",
          whatsappAvailable: snapshot.whatsapp.available,
          activeAccountId: snapshot.whatsapp.activeAccount?.id || null,
          loginStatus: snapshot.whatsapp.login.status,
          loginObservedAt: snapshot.whatsapp.login.observedAt,
          currentChatKnown: snapshot.whatsapp.currentChat !== null,
          currentChatObservedAt:
            snapshot.whatsapp.currentChat?.observedAt || null,
          executorSupported: true,
        };
      },
    );
    ipcMain.on(
      IPC_CHANNELS.WA_SEND_AUTHORIZED_RESULT,
      (
        event,
        result: { requestId?: string; actionId?: string; sent?: boolean; reason?: string },
      ) => {
        const requestId = typeof result?.requestId === "string" ? result.requestId : "";
        const pending = this.pendingAuthorizedWhatsappSends.get(requestId);
        const senderAccountId = this.getWhatsappSenderAccountId(event);
        if (
          !pending
          || !senderAccountId
          || senderAccountId !== pending.accountId
          || result.actionId !== pending.actionId
        ) return;
        clearTimeout(pending.timeout);
        this.pendingAuthorizedWhatsappSends.delete(requestId);
        pending.resolve({
          sent: result.sent === true,
          reason: typeof result.reason === "string" && /^[a-z0-9-]{1,80}$/.test(result.reason)
            ? result.reason
            : result.sent === true ? "click-dispatched" : "send-failed",
        });
      },
    );
    ipcMain.handle(
      IPC_CHANNELS.AGENT_SEND_WHATSAPP_TEXT,
      async (
        event,
        request: AgentWhatsappTextSendRequest,
      ): Promise<AgentWhatsappTextSendResult> => {
        const mainWindow = this.windowManager.getMainWindow();
        if (!mainWindow || event.sender !== mainWindow.webContents) {
          return { success: false, error: "仅主业务窗口可以确认发送 WhatsApp 消息" };
        }
        const conversationId = typeof request?.conversationId === "string"
          ? request.conversationId.trim()
          : "";
        const targetPhone = this.normalizeWhatsappPhone(request?.targetPhone);
        const targetName = this.normalizeWhatsappName(request?.targetName);
        const targetAccountId = typeof request?.targetAccountId === "string"
          ? request.targetAccountId.trim()
          : "";
        const selectionProof = typeof request?.selectionProof === "string"
          ? request.selectionProof.trim()
          : "";
        const text = typeof request?.text === "string" ? request.text.trim() : "";
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(conversationId)
          || !targetPhone
          || !targetName
          || !targetAccountId
          || !/^[0-9a-f-]{36}$/i.test(selectionProof)
          || !text
          || text.length > 4_000
          || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
        ) {
          return { success: false, error: "发送请求缺少可信会话、号码或有效文本" };
        }
        const accountId = this.windowManager.getActiveAccountId();
        const view = this.windowManager.getActiveWhatsappView();
        const login = accountId ? this.whatsappLoginState.get(accountId) : undefined;
        const identityMatches = async () => {
          if (!accountId) return false;
          const cached = this.whatsappCurrentChat.get(accountId);
          const live = await this.readCurrentWhatsappIdentity();
          const livePhone = this.normalizeWhatsappPhone(live?.phone);
          const liveName = this.normalizeWhatsappName(live?.name);
          return login?.status === "logged_in"
            && targetAccountId === accountId
            && !!cached
            && !cached.isGroup
            && cached.selectionProof === selectionProof
            && this.normalizeWhatsappPhone(cached.phone) === targetPhone
            && this.normalizeWhatsappName(cached.name) === targetName
            && !!live
            && !live.isGroup
            && (
              livePhone
                ? livePhone === targetPhone
                : liveName === targetName
            );
        };
        if (!accountId || !view || !(await identityMatches())) {
          return { success: false, error: "当前 WhatsApp 登录账号或联系人已变化，发送已停止" };
        }

        const token = await this.getTokenAsync();
        const companyId = await this.getCompanyIdAsync();
        if (!token || !companyId) {
          return { success: false, error: "登录凭据不完整，不能申请一次性发送授权" };
        }
        const requestId = randomUUID();
        const requestConfig = {
          timeout: 30_000,
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Company-Id": companyId,
          },
        };
        let actionId = "";
        const complete = async (
          outcome: "SUCCEEDED" | "FAILED" | "UNKNOWN",
          code: string,
        ) => {
          if (!actionId) return false;
          try {
            await axios.post(
              `${this.requireApiBaseUrl()}/agent-runs/assistant/external-actions/whatsapp-text/${encodeURIComponent(actionId)}/complete`,
              { outcome, code },
              requestConfig,
            );
            return true;
          } catch {
            return false;
          }
        };
        try {
          const authorization = await axios.post(
            `${this.requireApiBaseUrl()}/agent-runs/assistant/external-actions/whatsapp-text/authorize`,
            {
              companyId,
              conversationId,
              requestId,
              targetPhone,
              text,
              confirmed: true,
            },
            requestConfig,
          );
          actionId = typeof authorization.data?.actionId === "string"
            ? authorization.data.actionId
            : "";
          const expiryMs = Date.parse(authorization.data?.expiresAt || "");
          const textDigest = createHash("sha256")
            .update(JSON.stringify({ text }), "utf8")
            .digest("hex");
          if (
            authorization.data?.status !== "CLAIMED"
            || authorization.data?.requestId !== requestId
            || authorization.data?.conversationId !== conversationId
            || this.normalizeWhatsappPhone(authorization.data?.targetPhone) !== targetPhone
            || authorization.data?.textDigest !== textDigest
            || !/^[0-9a-f-]{36}$/i.test(actionId)
            || !Number.isFinite(expiryMs)
            || expiryMs <= Date.now()
            || expiryMs > Date.now() + 31_000
          ) {
            await complete("FAILED", "INVALID_AUTHORIZATION_RESPONSE");
            return { success: false, error: "服务端未返回有效的一次性发送授权" };
          }
          if (!(await identityMatches())) {
            await complete("FAILED", "WHATSAPP_CONTACT_CHANGED");
            return { success: false, actionId, error: "授权后联系人发生变化，发送已停止" };
          }
          const result = await new Promise<{ sent: boolean; reason: string }>((resolve) => {
            const timeout = setTimeout(() => {
              this.pendingAuthorizedWhatsappSends.delete(requestId);
              resolve({ sent: false, reason: "result-timeout" });
            }, 6_000);
            this.pendingAuthorizedWhatsappSends.set(requestId, {
              accountId,
              actionId,
              resolve,
              timeout,
            });
            view.webContents.send(IPC_CHANNELS.WA_SEND_AUTHORIZED, {
              requestId,
              actionId,
              text,
              targetPhone,
              targetName: request.targetName,
              expiresAt: authorization.data.expiresAt,
            });
          });
          const outcome = result.sent
            ? "SUCCEEDED"
            : result.reason === "result-timeout" ? "UNKNOWN" : "FAILED";
          const recorded = await complete(outcome, result.reason.toUpperCase().replace(/-/g, "_").slice(0, 80));
          if (result.sent) {
            return {
              success: true,
              actionId,
              ...(recorded ? {} : { warning: "消息已点击发送，但审计回执暂未写回；请勿重复发送" }),
            };
          }
          return {
            success: false,
            actionId,
            error: result.reason === "result-timeout"
              ? "发送结果未知，已禁止自动重试；请先在 WhatsApp 中确认是否已发出"
              : `WhatsApp 未完成发送：${result.reason}`,
          };
        } catch (error: any) {
          if (actionId) await complete("FAILED", "DESKTOP_SEND_EXCEPTION");
          return {
            success: false,
            actionId: actionId || undefined,
            error: error?.response?.data?.message || error?.message || "WhatsApp 发送授权失败",
          };
        }
      },
    );
    ipcMain.handle(
      IPC_CHANNELS.AGENT_PREPARE_QUOTE_DELIVERY,
      async (
        event,
        request: AgentQuoteDeliveryRequest,
      ): Promise<AgentQuoteDeliveryResult> => {
        const mainWindow = this.windowManager.getMainWindow();
        if (!mainWindow || event.sender !== mainWindow.webContents) {
          return { success: false, error: "仅主业务窗口可以确认报价文件准备" };
        }
        if (
          !request ||
          typeof request.proposalId !== "string" ||
          !request.proposalId.trim()
        ) {
          return { success: false, error: "报价动作提案无效" };
        }

        const activeAccountId = this.windowManager.getActiveAccountId();
        const currentChat = activeAccountId
          ? this.whatsappCurrentChat.get(activeAccountId)
          : undefined;
        const login = activeAccountId
          ? this.whatsappLoginState.get(activeAccountId)
          : undefined;
        if (!activeAccountId || login?.status !== "logged_in") {
          return {
            success: false,
            error: "WhatsApp 尚未确认登录，不能准备客户报价",
          };
        }
        if (!currentChat || currentChat.isGroup) {
          return {
            success: false,
            error: "当前 WhatsApp 聊天身份不可用于客户报价",
          };
        }

        let claimToken: string | null = null;
        let discardPreparedFileId: string | null = null;
        let releaseClaim: (
          failureCode: string,
        ) => Promise<boolean> = async () => false;
        try {
          const token = await this.getTokenAsync();
          const companyId = await this.getCompanyIdAsync();
          if (!token || !companyId) {
            return {
              success: false,
              error: "登录凭据不完整，不能确认报价动作",
            };
          }
          const requestConfig = {
            timeout: 30000,
            headers: {
              Authorization: `Bearer ${token}`,
              "X-Company-Id": companyId,
            },
          };
          // confirmed:true 不能作为权限边界；主进程使用当前加密登录态向后端
          // 原子领取提案。只有本地身份核验和 PDF 准备都成功后，才会 complete。
          const confirmation = await axios.post(
            `${this.requireApiBaseUrl()}/agent-runs/assistant/actions/${encodeURIComponent(request.proposalId)}/confirm`,
            {},
            requestConfig,
          );
          const proposal = this.validateQuoteActionProposal(
            confirmation.data?.actionProposal,
          );
          const confirmedProposal = this.validatePreparationConfirmedResponse(
            confirmation.data,
          );

          const currentIdentityMatches = async (targetPhone: string) => {
            const liveIdentity = await this.readCurrentWhatsappIdentity();
            return (
              !!liveIdentity &&
              !liveIdentity.isGroup &&
              this.normalizeWhatsappPhone(liveIdentity.phone) === targetPhone &&
              this.normalizeWhatsappPhone(currentChat.phone) === targetPhone
            );
          };

          // A retry after /complete succeeded but its response was lost reaches
          // this terminal branch. Never prepare a second PDF: recover only the
          // exact, unexpired local handle for the same proposal/account/phone.
          if (confirmedProposal) {
            if (
              !(await currentIdentityMatches(confirmedProposal.targetPhone))
            ) {
              return {
                success: false,
                error: "当前 WhatsApp 联系人已变化，不能恢复已准备的报价单",
              };
            }
            const recovered = this.recoverPreparedQuoteFile(
              request.proposalId,
              activeAccountId,
              confirmedProposal,
            );
            return (
              recovered || {
                success: false,
                error:
                  "服务端已确认报价准备，但本地安全句柄不存在或已过期，请重新生成报价提案",
              }
            );
          }

          const targetPhone = proposal?.targetPhone || "";
          const claimExpiryMs = new Date(
            confirmation.data?.claimExpiresAt || "",
          ).getTime();
          claimToken =
            typeof confirmation.data?.claimToken === "string" &&
            /^[A-Za-z0-9_-]{43}$/.test(confirmation.data.claimToken)
              ? confirmation.data.claimToken
              : null;
          releaseClaim = async (failureCode: string) => {
            if (!claimToken) return false;
            const tokenToRelease = claimToken;
            try {
              const released = await axios.post(
                `${this.requireApiBaseUrl()}/agent-runs/assistant/actions/${encodeURIComponent(request.proposalId)}/release`,
                { claimToken: tokenToRelease, failureCode },
                requestConfig,
              );
              if (
                released.data?.status !== "PREPARATION_RELEASED" ||
                released.data?.accepted !== false ||
                released.data?.actionStatus !== "REQUIRES_CONFIRMATION"
              ) {
                return false;
              }
              const releasedProposal = this.validateQuoteActionProposal(
                released.data?.actionProposal,
              );
              if (
                proposal &&
                (!releasedProposal ||
                  !this.quoteActionProposalsMatch(releasedProposal, proposal))
              ) {
                return false;
              }
              claimToken = null;
              return true;
            } catch {
              // Do not hide the original local failure. A two-minute claim
              // lease guarantees server-side recovery even if release cannot
              // reach the backend.
              return false;
            }
          };
          if (
            confirmation.data?.status !== "PREPARATION_CLAIMED" ||
            confirmation.data?.accepted !== false ||
            confirmation.data?.actionStatus !== "PREPARATION_IN_PROGRESS" ||
            !claimToken ||
            !proposal ||
            !Number.isFinite(claimExpiryMs) ||
            claimExpiryMs <= Date.now() ||
            claimExpiryMs > (proposal?.expiryMs || 0)
          ) {
            await releaseClaim("INVALID_CLAIM_RESPONSE");
            return { success: false, error: "服务端未返回有效的报价准备授权" };
          }

          if (!(await currentIdentityMatches(targetPhone))) {
            await releaseClaim("WHATSAPP_CONTACT_CHANGED");
            return {
              success: false,
              error: "当前 WhatsApp 联系人已变化，已阻止准备报价单",
            };
          }

          const prepared = await this.prepareQuoteFile(
            {
              quoteId: proposal.quoteId,
              filename: `${proposal.referenceNo}.pdf`,
            },
            {
              targetPhone,
              accountId: activeAccountId,
              proposalId: request.proposalId,
              quoteReferenceNo: proposal.referenceNo,
              expiresAt: proposal.expiresAt,
            },
          );
          if (!prepared.success || !prepared.data) {
            await releaseClaim("PDF_PREPARATION_FAILED");
            return prepared;
          }
          discardPreparedFileId = prepared.data.preparedFileId;
          try {
            const completion = await axios.post(
              `${this.requireApiBaseUrl()}/agent-runs/assistant/actions/${encodeURIComponent(request.proposalId)}/complete`,
              { claimToken },
              requestConfig,
            );
            if (
              !this.validatePreparationConfirmedResponse(
                completion.data,
                proposal,
              )
            ) {
              throw new Error("服务端未确认报价 PDF 已准备完成");
            }
            claimToken = null;
            discardPreparedFileId = null;
            return prepared;
          } catch (completionError: any) {
            // /complete may have committed while its HTTP response was lost.
            // Probe with the JWT-scoped confirm endpoint before releasing or
            // deleting anything. The probe never returns the consumed secret.
            try {
              const probe = await axios.post(
                `${this.requireApiBaseUrl()}/agent-runs/assistant/actions/${encodeURIComponent(request.proposalId)}/confirm`,
                {},
                requestConfig,
              );
              if (
                this.validatePreparationConfirmedResponse(probe.data, proposal)
              ) {
                claimToken = null;
                discardPreparedFileId = null;
                return prepared;
              }

              // In the very narrow case where the old lease expired before the
              // probe, confirm can issue a fresh claim. Adopt it only when the
              // proposal and lease are exact, then release it below.
              const probeProposal = this.validateQuoteActionProposal(
                probe.data?.actionProposal,
              );
              const probeClaimExpiryMs = Date.parse(
                probe.data?.claimExpiresAt || "",
              );
              const probeClaimToken =
                typeof probe.data?.claimToken === "string" &&
                /^[A-Za-z0-9_-]{43}$/.test(probe.data.claimToken)
                  ? probe.data.claimToken
                  : null;
              if (
                probe.data?.status === "PREPARATION_CLAIMED" &&
                probe.data?.accepted === false &&
                probe.data?.actionStatus === "PREPARATION_IN_PROGRESS" &&
                probeProposal &&
                this.quoteActionProposalsMatch(probeProposal, proposal) &&
                probeClaimToken &&
                Number.isFinite(probeClaimExpiryMs) &&
                probeClaimExpiryMs > Date.now() &&
                probeClaimExpiryMs <= proposal.expiryMs
              ) {
                claimToken = probeClaimToken;
              }
            } catch {
              // A failed probe leaves the original claim intact. Release is
              // still attempted, and the local handle is retained unless the
              // backend positively acknowledges that release.
            }

            const released = await releaseClaim("DESKTOP_PREPARATION_FAILED");
            if (released && discardPreparedFileId) {
              this.preparedQuoteFiles.delete(discardPreparedFileId);
              discardPreparedFileId = null;
            }
            return {
              success: false,
              error:
                completionError?.response?.data?.message ||
                completionError?.message ||
                "报价准备确认结果未知，请重试以恢复本地文件",
            };
          }
        } catch (error: any) {
          const released = await releaseClaim("DESKTOP_PREPARATION_FAILED");
          if (released && discardPreparedFileId) {
            this.preparedQuoteFiles.delete(discardPreparedFileId);
          }
          return {
            success: false,
            error:
              error?.response?.data?.message ||
              error?.message ||
              "报价动作确认失败",
          };
        }
      },
    );
  }

  // === 认证管理 ===

  private registerAuthHandlers(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      this.clearPersistedTokens();
    }
    // 获取 token（使用 safeStorage 解密）
    ipcMain.handle(IPC_CHANNELS.AUTH_GET_TOKEN, () => {
      const encrypted = this.authStore.get("token");
      if (!encrypted) return null;
      if (!safeStorage.isEncryptionAvailable()) {
        this.clearPersistedTokens();
        return null;
      }
      try {
        return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
      } catch {
        this.clearPersistedTokens();
        return null;
      }
    });

    // 存储 token（使用 safeStorage 加密）
    ipcMain.handle(
      IPC_CHANNELS.AUTH_SET_TOKEN,
      (_event, data: { token: string; refreshToken: string }) => {
        if (!safeStorage.isEncryptionAvailable()) {
          this.clearPersistedTokens();
          throw new Error("Secure credential storage is unavailable");
        }
        const encToken = safeStorage
          .encryptString(data.token)
          .toString("base64");
        const encRefresh = safeStorage
          .encryptString(data.refreshToken)
          .toString("base64");
        this.authStore.set("token", encToken);
        this.authStore.set("refreshToken", encRefresh);
      },
    );

    // 清除 token
    ipcMain.handle(IPC_CHANNELS.AUTH_CLEAR_TOKEN, () => {
      this.authStore.clear();
    });

    ipcMain.handle(IPC_CHANNELS.AUTH_REFRESH_SESSION, async () => {
      const refreshToken = this.getStoredRefreshToken();
      if (!refreshToken) throw new Error('Refresh session is unavailable');
      const response = await axios.post(
        `${this.requireApiBaseUrl()}/auth/refresh`,
        { refreshToken },
        { headers: { 'X-Refresh-Token-Mode': 'body' }, timeout: 30000 },
      );
      const accessToken = String(response.data?.accessToken || '');
      const rotatedRefreshToken = String(response.data?.refreshToken || '');
      if (!accessToken || !rotatedRefreshToken) {
        this.authStore.clear();
        throw new Error('Invalid refresh response');
      }
      this.storeAuthTokens(accessToken, rotatedRefreshToken);
      return { accessToken };
    });

    ipcMain.handle(IPC_CHANNELS.AUTH_LOGOUT_SESSION, async () => {
      const refreshToken = this.getStoredRefreshToken();
      const accessToken = this.getStoredToken();
      try {
        if (refreshToken && accessToken) {
          const companyId = this.authStore.get("companyId");
          await axios.post(
            `${this.requireApiBaseUrl()}/auth/logout`,
            { refreshToken },
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'X-Refresh-Token-Mode': 'body',
                ...(companyId ? { 'X-Company-Id': companyId } : {}),
              },
              timeout: 30000,
            },
          );
        }
      } finally {
        this.authStore.clear();
      }
    });

    // 获取 Company-Id
    ipcMain.handle(IPC_CHANNELS.AUTH_GET_COMPANY, () => {
      return this.authStore.get("companyId");
    });

    // 存储 Company-Id
    ipcMain.handle(
      IPC_CHANNELS.AUTH_SET_COMPANY,
      (_event, companyId: string) => {
        this.authStore.set("companyId", companyId);
      },
    );
  }

  // === API 请求代理 ===

  private registerApiHandlers(): void {
    ipcMain.handle(
      IPC_CHANNELS.API_REQUEST,
      async (_event, config: ApiRequestConfig) => {
        try {
          // 获取认证信息
          const token = this.getStoredToken();
          const companyId = this.authStore.get("companyId");

          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            ...config.headers,
          };

          if (token) {
            headers["Authorization"] = `Bearer ${token}`;
          }
          if (companyId) {
            headers["X-Company-Id"] = companyId;
          }

          const response = await axios({
            method: config.method || "GET",
            url: `${this.requireApiBaseUrl()}${config.url}`,
            data: config.data,
            params: config.params,
            headers,
            timeout: config.timeout || 30000,
          });

          return {
            success: true,
            data: response.data,
            status: response.status,
          };
        } catch (error: any) {
          const errorData = {
            success: false,
            status: error.response?.status || 0,
            message: error.response?.data?.message || error.message,
            data: error.response?.data || null,
          };

          // 401 时通知渲染进程刷新 token
          if (error.response?.status === 401) {
            this.windowManager.sendToRenderer(IPC_CHANNELS.API_ERROR, {
              type: "unauthorized",
              originalConfig: config,
            });
          }

          return errorData;
        }
      },
    );
  }

  private getStoredToken(): string | null {
    const encrypted = this.authStore.get("token");
    if (!encrypted) return null;
    if (!safeStorage.isEncryptionAvailable()) {
      this.clearPersistedTokens();
      return null;
    }
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
    } catch {
      this.clearPersistedTokens();
      return null;
    }
  }

  private getStoredRefreshToken(): string | null {
    const encrypted = this.authStore.get("refreshToken");
    if (!encrypted) return null;
    if (!safeStorage.isEncryptionAvailable()) {
      this.clearPersistedTokens();
      return null;
    }
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
    } catch {
      this.clearPersistedTokens();
      return null;
    }
  }

  private storeAuthTokens(token: string, refreshToken: string): void {
    if (!safeStorage.isEncryptionAvailable()) {
      this.clearPersistedTokens();
      throw new Error("Secure credential storage is unavailable");
    }
    this.authStore.set(
      "token",
      safeStorage.encryptString(token).toString("base64"),
    );
    this.authStore.set(
      "refreshToken",
      safeStorage.encryptString(refreshToken).toString("base64"),
    );
  }

  private clearPersistedTokens(): void {
    this.authStore.set("token", null);
    this.authStore.set("refreshToken", null);
  }

  /**
   * 前端可能在 Electron 运行期间刷新 token，因此优先读取渲染进程的当前值。
   * 加密存储仅作为主窗口尚未可用时的启动回退。
   */
  private async getTokenAsync(): Promise<string | null> {
    try {
      const mainWin = this.windowManager.getMainWindow();
      if (mainWin && !mainWin.isDestroyed()) {
        const lsToken = await mainWin.webContents.executeJavaScript(
          `localStorage.getItem('access_token')`,
        );
        if (lsToken) {
          // 同时存回 authStore，以便下次使用
          if (safeStorage.isEncryptionAvailable()) {
            this.authStore.set(
              "token",
              safeStorage.encryptString(lsToken).toString("base64"),
            );
          }
          return lsToken;
        }
      }
    } catch (e) {
      console.error("[IPC] 从mainWindow获取token失败:", e);
    }
    return this.getStoredToken();
  }

  /**
   * 异步获取 companyId
   */
  private async getCompanyIdAsync(): Promise<string | null> {
    try {
      const mainWin = this.windowManager.getMainWindow();
      if (mainWin && !mainWin.isDestroyed()) {
        const lsCompanyId = await mainWin.webContents.executeJavaScript(
          `localStorage.getItem('active_company_id')`,
        );
        if (lsCompanyId) {
          this.authStore.set("companyId", lsCompanyId);
          return lsCompanyId;
        }
      }
    } catch (e) {
      console.error("[IPC] 从mainWindow获取companyId失败:", e);
    }
    return this.authStore.get("companyId") || null;
  }

  /**
   * 推送数据到后端 Electron Webhook
   * 自动附加 JWT token 和 Company-Id header
   */
  private async pushToBackend(
    path: string,
    data: any,
    boundCompanyId?: string,
  ): Promise<void> {
    const token = await this.getTokenAsync();
    const companyId =
      boundCompanyId?.trim() || (await this.getCompanyIdAsync());

    if (!token) {
      throw new Error(
        "Electron webhook delivery requires an authenticated session",
      );
    }
    if (!companyId) {
      throw new Error(
        "Electron webhook delivery requires an observation-time company binding",
      );
    }
    if (
      typeof data?.selectedCompanyId === "string" &&
      data.selectedCompanyId !== companyId
    ) {
      throw new Error("Electron webhook payload company binding mismatch");
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    headers["Authorization"] = `Bearer ${token}`;
    headers["X-Company-Id"] = companyId;

    const response = await axios({
      method: "POST",
      url: `${this.requireApiBaseUrl()}${path}`,
      data,
      headers,
      timeout: 10000,
    });

    // Older backend builds returned HTTP 200 with an error envelope. Treat it
    // as a failed delivery as well; otherwise the durable outbox would delete
    // a message which the backend explicitly says it did not persist.
    if (response?.data?.status === "error") {
      throw new Error(
        response.data.message || "backend rejected webhook delivery",
      );
    }
  }

  private encodeWhatsappOutboxPayload(payload: Record<string, unknown>): {
    payloadCiphertext: string;
    payloadEncoding: WhatsAppMessageOutboxEntry["payloadEncoding"];
  } {
    const serialized = JSON.stringify(payload);
    if (safeStorage.isEncryptionAvailable()) {
      return {
        payloadCiphertext: safeStorage
          .encryptString(serialized)
          .toString("base64"),
        payloadEncoding: "safe-storage",
      };
    }
    return { payloadCiphertext: serialized, payloadEncoding: "plain-json" };
  }

  private decodeWhatsappOutboxPayload(
    entry: WhatsAppMessageOutboxEntry,
  ): Record<string, unknown> {
    const serialized =
      entry.payloadEncoding === "safe-storage"
        ? safeStorage.decryptString(
            Buffer.from(entry.payloadCiphertext, "base64"),
          )
        : entry.payloadCiphertext;
    const payload = JSON.parse(serialized);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("invalid WhatsApp outbox payload");
    }
    return payload as Record<string, unknown>;
  }

  private getWhatsappOutboxItems(): WhatsAppMessageOutboxEntry[] {
    const items = this.whatsappMessageOutboxStore.get("items");
    return Array.isArray(items) ? items : [];
  }

  private makeWhatsappOutboxId(payload: Record<string, unknown>): string {
    const selectedCompanyId =
      typeof payload.selectedCompanyId === "string"
        ? payload.selectedCompanyId
        : "unbound";
    const accountId =
      typeof payload.accountId === "string" ? payload.accountId : "default";
    const messageId = typeof payload.id === "string" ? payload.id.trim() : "";
    if (messageId) return `${selectedCompanyId}:${accountId}:${messageId}`;
    return `${selectedCompanyId}:${accountId}:sha256:${createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex")}`;
  }

  private enqueueWhatsappMessage(payload: Record<string, unknown>): void {
    const id = this.makeWhatsappOutboxId(payload);
    const current = this.getWhatsappOutboxItems();
    if (current.some((entry) => entry.id === id)) {
      this.scheduleWhatsappOutboxFlush(0);
      return;
    }

    const encoded = this.encodeWhatsappOutboxPayload(payload);
    const now = Date.now();
    this.whatsappMessageOutboxStore.set("items", [
      ...current,
      {
        id,
        ...encoded,
        createdAt: now,
        attemptCount: 0,
        nextAttemptAt: now,
      },
    ]);
    this.scheduleWhatsappOutboxFlush(0);
  }

  private removeWhatsappOutboxEntry(id: string): void {
    this.whatsappMessageOutboxStore.set(
      "items",
      this.getWhatsappOutboxItems().filter((entry) => entry.id !== id),
    );
  }

  private markWhatsappOutboxFailure(id: string, error: unknown): void {
    const now = Date.now();
    this.whatsappMessageOutboxStore.set(
      "items",
      this.getWhatsappOutboxItems().map((entry) => {
        if (entry.id !== id) return entry;
        const attemptCount = entry.attemptCount + 1;
        const retryDelay = Math.min(
          WHATSAPP_OUTBOX_RETRY_MAX_MS,
          WHATSAPP_OUTBOX_RETRY_BASE_MS * 2 ** Math.min(attemptCount - 1, 16),
        );
        const message = error instanceof Error ? error.message : String(error);
        return {
          ...entry,
          attemptCount,
          nextAttemptAt: now + retryDelay,
          lastError: message.slice(0, 500),
        };
      }),
    );
  }

  private scheduleWhatsappOutboxFlush(delayOverride?: number): void {
    const items = this.getWhatsappOutboxItems();
    if (items.length === 0) {
      if (this.whatsappOutboxTimer) clearTimeout(this.whatsappOutboxTimer);
      this.whatsappOutboxTimer = null;
      this.whatsappOutboxTimerDueAt = null;
      return;
    }

    const now = Date.now();
    const earliestDueAt =
      delayOverride === undefined
        ? Math.min(...items.map((entry) => entry.nextAttemptAt))
        : now + Math.max(0, delayOverride);
    if (
      this.whatsappOutboxTimer &&
      this.whatsappOutboxTimerDueAt !== null &&
      this.whatsappOutboxTimerDueAt <= earliestDueAt
    ) {
      return;
    }
    if (this.whatsappOutboxTimer) clearTimeout(this.whatsappOutboxTimer);

    this.whatsappOutboxTimerDueAt = earliestDueAt;
    this.whatsappOutboxTimer = setTimeout(
      () => {
        this.whatsappOutboxTimer = null;
        this.whatsappOutboxTimerDueAt = null;
        void this.flushWhatsappMessageOutbox();
      },
      Math.max(0, earliestDueAt - now),
    );
    this.whatsappOutboxTimer.unref?.();
  }

  private resumeWhatsappMessageOutbox(): void {
    if (this.getWhatsappOutboxItems().length > 0) {
      this.scheduleWhatsappOutboxFlush();
    }
  }

  private async flushWhatsappMessageOutbox(): Promise<void> {
    if (this.whatsappOutboxFlushing) return;
    this.whatsappOutboxFlushing = true;
    try {
      const now = Date.now();
      const dueEntries = this.getWhatsappOutboxItems()
        .filter((entry) => entry.nextAttemptAt <= now)
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, WHATSAPP_OUTBOX_BATCH_SIZE);

      for (const entry of dueEntries) {
        try {
          const payload = this.decodeWhatsappOutboxPayload(entry);
          const boundCompanyId =
            typeof payload.selectedCompanyId === "string"
              ? payload.selectedCompanyId.trim()
              : "";
          if (!boundCompanyId) {
            throw new Error(
              "WhatsApp message is quarantined because no company was selected when it was observed",
            );
          }
          await this.pushToBackend(
            "/whatsapp/electron-webhook/message",
            payload,
            boundCompanyId,
          );
          this.removeWhatsappOutboxEntry(entry.id);
        } catch (error) {
          this.markWhatsappOutboxFailure(entry.id, error);
          console.error(
            `[IPC] WhatsApp message outbox delivery failed (${entry.id}):`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    } finally {
      this.whatsappOutboxFlushing = false;
      this.scheduleWhatsappOutboxFlush();
    }
  }

  // === 窗口管理 ===

  private registerWindowHandlers(): void {
    ipcMain.on(IPC_CHANNELS.WINDOW_MINIMIZE, () => {
      this.windowManager.getMainWindow()?.minimize();
    });

    ipcMain.on(IPC_CHANNELS.WINDOW_MAXIMIZE, () => {
      const win = this.windowManager.getMainWindow();
      if (win) {
        if (win.isMaximized()) {
          win.unmaximize();
        } else {
          win.maximize();
        }
      }
    });

    ipcMain.on(IPC_CHANNELS.WINDOW_CLOSE, () => {
      this.windowManager.getMainWindow()?.close();
    });

    ipcMain.handle(IPC_CHANNELS.WINDOW_IS_MAXIMIZED, () => {
      return this.windowManager.getMainWindow()?.isMaximized() ?? false;
    });
  }

  // === WhatsApp 相关 ===

  private registerWhatsAppHandlers(): void {
    // 旧入口没有可信号码/账号绑定，chatId 也从未参与目标校验。若用户
    // 点击后切换聊天，它会把文本直接发给另一个联系人。永久 fail-closed；
    // 当前业务助理只生成可复制草稿，由操作员在 WhatsApp 内人工确认发送。
    ipcMain.handle(IPC_CHANNELS.WA_SEND_TEXT, async () => ({
      success: false,
      error:
        "自动文本发送已禁用；请复制或填入草稿，并在当前 WhatsApp 聊天中人工确认发送",
    }));

    ipcMain.handle(
      IPC_CHANNELS.WA_FILL_DRAFT,
      async (
        event,
        data: {
          text?: string;
          targetPhone?: string;
          targetName?: string;
          targetAccountId?: string;
          selectionProof?: string;
        },
      ) => {
        const mainWindow = this.windowManager.getMainWindow();
        if (!mainWindow || event.sender !== mainWindow.webContents) {
          return { success: false, error: "仅主业务窗口可以填入 WhatsApp 草稿" };
        }
        const text = typeof data?.text === "string" ? data.text.trim() : "";
        if (!text || text.length > 4_000 || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
          return { success: false, error: "待填入草稿为空、过长或包含非法控制字符" };
        }
        const targetPhone = this.normalizeWhatsappPhone(data?.targetPhone);
        const targetName = this.normalizeWhatsappName(data?.targetName);
        const selectionProof = typeof data?.selectionProof === "string"
          ? data.selectionProof.trim()
          : "";
        const accountId = this.windowManager.getActiveAccountId();
        const view = this.windowManager.getActiveWhatsappView();
        if (
          !targetPhone
          || !targetName
          || !accountId
          || !view
          || !/^[0-9a-f-]{36}$/i.test(selectionProof)
        ) {
          return { success: false, error: "当前 WhatsApp 账号或可信客户号码不可用" };
        }
        if (!data?.targetAccountId || data.targetAccountId !== accountId) {
          return { success: false, error: "WhatsApp 账号已变化，已停止填入草稿" };
        }
        const login = this.whatsappLoginState.get(accountId);
        const cachedChat = this.whatsappCurrentChat.get(accountId);
        const liveChat = await this.readCurrentWhatsappIdentity();
        const livePhone = this.normalizeWhatsappPhone(liveChat?.phone);
        const liveName = this.normalizeWhatsappName(liveChat?.name);
        if (
          login?.status !== "logged_in"
          || !cachedChat
          || cachedChat.isGroup
          || cachedChat.selectionProof !== selectionProof
          || this.normalizeWhatsappPhone(cachedChat.phone) !== targetPhone
          || this.normalizeWhatsappName(cachedChat.name) !== targetName
          || !liveChat
          || liveChat.isGroup
          || (livePhone ? livePhone !== targetPhone : liveName !== targetName)
        ) {
          return { success: false, error: "当前 WhatsApp 联系人已变化，已停止填入草稿" };
        }

        const requestId = randomUUID();
        return new Promise<{ success: boolean; error?: string }>((resolve) => {
          const timeout = setTimeout(() => {
            this.pendingWhatsappDraftFills.delete(requestId);
            resolve({ success: false, error: "WhatsApp 输入框未响应，请重新选择客户后再试" });
          }, 5_000);
          this.pendingWhatsappDraftFills.set(requestId, { accountId, resolve, timeout });
          view.webContents.send(IPC_CHANNELS.WA_FILL_DRAFT, {
            requestId,
            text,
            targetPhone,
            targetName: data.targetName,
          });
        });
      },
    );

    ipcMain.on(
      IPC_CHANNELS.WA_FILL_DRAFT_RESULT,
      (event, result: { requestId?: string; success?: boolean; error?: string }) => {
        const requestId = typeof result?.requestId === "string" ? result.requestId : "";
        const pending = this.pendingWhatsappDraftFills.get(requestId);
        const senderAccountId = this.getWhatsappSenderAccountId(event);
        if (!pending || !senderAccountId || senderAccountId !== pending.accountId) return;
        clearTimeout(pending.timeout);
        this.pendingWhatsappDraftFills.delete(requestId);
        pending.resolve(
          result.success === true
            ? { success: true }
            : {
                success: false,
                error: typeof result.error === "string" && result.error.length <= 200
                  ? result.error
                  : "WhatsApp 草稿填入失败",
              },
        );
      },
    );

    ipcMain.handle(
      IPC_CHANNELS.QUOTE_FILE_PREPARE,
      async (_event, data: { quoteId: string; filename: string }) =>
        this.prepareQuoteFile(data),
    );

    ipcMain.handle(
      IPC_CHANNELS.QUOTE_FILE_START_DRAG,
      async (event, data: { preparedFileId: string }) => {
        const mainWindow = this.windowManager.getMainWindow();
        if (!mainWindow || event.sender !== mainWindow.webContents) {
          return { success: false, error: "仅主业务窗口可以拖拽报价文件" };
        }
        const prepared = this.preparedQuoteFiles.get(data?.preparedFileId);
        if (!prepared || !fs.existsSync(prepared.filePath)) {
          return {
            success: false,
            error: "本地报价文件尚未准备好，请重新生成",
          };
        }
        const expiryMs = new Date(prepared.expiresAt).getTime();
        if (!Number.isFinite(expiryMs) || expiryMs <= Date.now()) {
          this.preparedQuoteFiles.delete(prepared.preparedFileId);
          return { success: false, error: "报价拖拽凭据已过期，请重新准备" };
        }
        if (prepared.targetPhone) {
          const activeAccountId = this.windowManager.getActiveAccountId();
          const currentChat = activeAccountId
            ? this.whatsappCurrentChat.get(activeAccountId)
            : undefined;
          const login = activeAccountId
            ? this.whatsappLoginState.get(activeAccountId)
            : undefined;
          const liveIdentity = await this.readCurrentWhatsappIdentity();
          if (
            login?.status !== "logged_in" ||
            activeAccountId !== prepared.accountId ||
            !currentChat ||
            currentChat.isGroup ||
            !liveIdentity ||
            liveIdentity.isGroup ||
            this.normalizeWhatsappPhone(liveIdentity.phone) !==
              prepared.targetPhone ||
            this.normalizeWhatsappPhone(currentChat.phone) !==
              prepared.targetPhone
          ) {
            return {
              success: false,
              error: "当前 WhatsApp 联系人已变化，已阻止拖拽报价单",
            };
          }
        }

        const documentsRoot = path.resolve(
          app.getPath("documents"),
          "Vaysen 外贸系统",
          "待发送报价",
        );
        const resolvedFile = path.resolve(prepared.filePath);
        if (!resolvedFile.startsWith(`${documentsRoot}${path.sep}`)) {
          return { success: false, error: "拒绝拖拽索引目录之外的文件" };
        }

        try {
          const packagedIcon = path.join(
            process.resourcesPath,
            "brand",
            "icon.ico",
          );
          const devIcon = path.resolve(
            __dirname,
            "..",
            "..",
            "build",
            "icon.ico",
          );
          const icon = nativeImage.createFromPath(
            fs.existsSync(packagedIcon) ? packagedIcon : devIcon,
          );
          event.sender.startDrag({ file: resolvedFile, icon });
          // 单次句柄：原生拖拽一旦启动即消费，取消或重试必须重新准备并重新核验。
          this.preparedQuoteFiles.delete(prepared.preparedFileId);
          return { success: true };
        } catch (error: any) {
          return {
            success: false,
            error: error?.message || "无法开始原生文件拖拽",
          };
        }
      },
    );

    ipcMain.handle(
      IPC_CHANNELS.QUOTE_FILE_OPEN_FOLDER,
      async (event, data: { preparedFileId: string }) => {
        const mainWindow = this.windowManager.getMainWindow();
        if (!mainWindow || event.sender !== mainWindow.webContents) {
          return { success: false, error: "仅主业务窗口可以打开报价文件目录" };
        }
        const prepared = this.preparedQuoteFiles.get(data?.preparedFileId);
        if (!prepared || !fs.existsSync(prepared.filePath)) {
          return { success: false, error: "本地报价文件不存在，请重新准备" };
        }
        shell.showItemInFolder(prepared.filePath);
        return { success: true };
      },
    );

    ipcMain.handle(IPC_CHANNELS.WA_SEND_DOCUMENT, async () => ({
      success: false,
      error:
        "自动发送报价单已永久禁用；请使用人工确认后的原生拖拽并在 WhatsApp 中手动发送",
    }));

    // WhatsApp 新消息到达（从 preload 接收）→ 推送到后端 + 转发给前端
    ipcMain.on(IPC_CHANNELS.WA_NEW_MESSAGE, (_event, message) => {
      const accountId = this.getWhatsappSenderAccountId(_event);
      const messageId =
        typeof message?.id === "string" ? message.id.trim() : "";
      if (!accountId || !messageId || message?.type === "unread-count") {
        return;
      }
      // Capture synchronously before any await/event-loop yield. AUTH_SET_COMPANY
      // is the main-process source of truth for the selected tenant.
      const selectedCompanyId = this.authStore.get("companyId") || null;

      // 1. 转发给前端渲染进程
      this.windowManager.sendToRenderer(IPC_CHANNELS.WA_NEW_MESSAGE, {
        ...message,
        accountId,
      });

      // 2. 先落盘再投递；只有后端明确确认成功后才从 outbox 删除。
      this.enqueueWhatsappMessage({
        ...message,
        accountId,
        fromPhone: message.chatPhone || message.sender || "",
        // Immutable observation-time tenant binding. A later company switch
        // must not retarget an already captured durable message.
        selectedCompanyId,
      });
    });

    // WhatsApp 登录状态变化 → 推送到后端 + 转发给前端
    ipcMain.on(IPC_CHANNELS.WA_LOGIN_STATUS, (_event, status) => {
      const accountId = this.getWhatsappSenderAccountId(_event);
      if (!accountId) return;
      const payload = { ...status, accountId };

      this.whatsappLoginState.set(accountId, {
        status: typeof status?.status === "string" ? status.status : "unknown",
        observedAt: new Date().toISOString(),
      });

      // 1. 转发给前端
      this.windowManager.sendToRenderer(IPC_CHANNELS.WA_LOGIN_STATUS, payload);

      // 2. 日志
      if (status.status === "selector_warning") {
        console.warn(
          `[WhatsApp] 选择器告警: ${status.group} - ${status.message}`,
        );
      }
      if (status.status === "reconnecting") {
        console.warn(`[WhatsApp] 账号 ${accountId} 断线，正在重连...`);
      }

      // 3. 推送到后端（仅关键状态）
      if (
        [
          "logged_in",
          "waiting_scan",
          "reconnecting",
          "selector_warning",
          "unread_update",
        ].includes(status.status)
      ) {
        this.pushToBackend("/whatsapp/electron-webhook/status", payload).catch(
          (err) => {
            console.error("[IPC] 推送状态到后端失败:", err.message);
          },
        );
      }
    });

    // WhatsApp 联系人同步 → 推送到后端 + 转发给前端
    ipcMain.on(IPC_CHANNELS.WA_CONTACTS_SYNC, (_event, contacts) => {
      const accountId = this.getWhatsappSenderAccountId(_event);
      if (!accountId) return;
      const payload = { ...contacts, accountId };

      // 1. 转发给前端
      this.windowManager.sendToRenderer(IPC_CHANNELS.WA_CONTACTS_SYNC, payload);

      // 2. 推送到后端
      this.pushToBackend("/whatsapp/electron-webhook/contacts", payload).catch(
        (err) => {
          console.error("[IPC] 推送联系人到后端失败:", err.message);
        },
      );
    });

    // 当前聊天变化
    ipcMain.on(IPC_CHANNELS.WA_CURRENT_CHAT, (_event, chatInfo) => {
      const accountId = this.getWhatsappSenderAccountId(_event);
      if (
        !accountId ||
        accountId !== this.windowManager.getActiveAccountId() ||
        !chatInfo ||
        typeof chatInfo !== "object"
      ) {
        return;
      }
      const previous = this.whatsappCurrentChat.get(accountId);
      const name = typeof chatInfo.name === "string" ? chatInfo.name : "";
      const phone = typeof chatInfo.phone === "string" ? chatInfo.phone : "";
      const isGroup = chatInfo.isGroup === true;
      const externalId = typeof chatInfo.externalId === "string" ? chatInfo.externalId : "";
      const sameSelection = !!previous
        && previous.name === name
        && previous.phone === phone
        && previous.isGroup === isGroup
        && (previous.externalId || "") === externalId;
      const snapshot = {
        accountId,
        name,
        phone,
        isGroup,
        ...(externalId ? { externalId } : {}),
        observedAt: new Date().toISOString(),
        selectionProof: sameSelection ? previous.selectionProof : randomUUID(),
      };
      this.whatsappCurrentChat.set(accountId, snapshot);
      this.windowManager.sendToRenderer(IPC_CHANNELS.WA_CURRENT_CHAT, snapshot);
      if (!snapshot.phone && snapshot.name) {
        void this.readCurrentWhatsappIdentity().then((identity) => {
          const current = this.whatsappCurrentChat.get(accountId);
          if (
            !identity?.phone ||
            !current ||
            current.name !== snapshot.name ||
            identity.name !== snapshot.name
          )
            return;
          const enriched = {
            ...current,
            phone: identity.phone,
            observedAt: new Date().toISOString(),
          };
          this.whatsappCurrentChat.set(accountId, enriched);
          this.windowManager.sendToRenderer(
            IPC_CHANNELS.WA_CURRENT_CHAT,
            enriched,
          );
        });
      }
    });

    // 主渲染页可能在 WhatsApp preload 首次广播之后才完成订阅。
    // 由渲染页在挂载后主动请求一次，避免当前聊天事件成为“只发一次即丢失”的瞬时事件。
    ipcMain.handle(IPC_CHANNELS.WA_REQUEST_CURRENT_CHAT, async () => {
      const accountId = this.windowManager.getActiveAccountId() || "default";
      const view = this.windowManager.getActiveWhatsappView();
      if (!view) return { requested: false, chat: null };

      const cached = this.whatsappCurrentChat.get(accountId) || null;
      if (cached) {
        // invoke 的返回值与事件双通道都带真实快照，订阅再晚也不会丢。
        this.windowManager.sendToRenderer(IPC_CHANNELS.WA_CURRENT_CHAT, cached);
      }
      view.webContents.send(IPC_CHANNELS.WA_REQUEST_CURRENT_CHAT);
      const identity = await this.readCurrentWhatsappIdentity();
      const current = this.whatsappCurrentChat.get(accountId) || cached;
      if (
        identity &&
        (identity.phone || identity.externalId) &&
        (!current || !current.name || current.name === identity.name)
      ) {
        const enriched = {
          accountId,
          name: identity.name,
          phone: identity.phone,
          isGroup: identity.isGroup,
          ...(identity.externalId ? { externalId: identity.externalId } : {}),
          observedAt: new Date().toISOString(),
          selectionProof: current?.selectionProof || randomUUID(),
        };
        this.whatsappCurrentChat.set(accountId, enriched);
        this.windowManager.sendToRenderer(
          IPC_CHANNELS.WA_CURRENT_CHAT,
          enriched,
        );
        return { requested: true, chat: { ...enriched } };
      }
      return { requested: true, chat: current ? { ...current } : null };
    });

    // === 多账号管理 ===

    // 创建新 WhatsApp 账号视图
    ipcMain.handle(
      IPC_CHANNELS.WA_CREATE_ACCOUNT,
      (_event, data: { accountId: string; label: string }) => {
        console.log(
          `[IPC] 创建 WhatsApp 账号: ${data.accountId}, label=${data.label}`,
        );
        // Reusing an account id must not inherit a previous view's status.
        this.whatsappLoginState.delete(data.accountId);
        this.whatsappCurrentChat.delete(data.accountId);
        const view = this.windowManager.createWhatsappView(
          data.accountId,
          data.label,
        );
        console.log(`[IPC] 账号创建结果: ${view ? "成功" : "失败"}`);
        return { success: !!view, accountId: data.accountId };
      },
    );

    // 切换活跃账号
    ipcMain.handle(
      IPC_CHANNELS.WA_SWITCH_ACCOUNT,
      (_event, data: { accountId: string }) => {
        console.log(`[IPC] 切换活跃账号: ${data.accountId}`);
        const success = this.windowManager.setActiveAccount(data.accountId);
        return { success };
      },
    );

    // 移除账号
    ipcMain.handle(
      IPC_CHANNELS.WA_REMOVE_ACCOUNT,
      (_event, data: { accountId: string }) => {
        this.windowManager.removeWhatsappAccount(data.accountId);
        this.whatsappLoginState.delete(data.accountId);
        this.whatsappCurrentChat.delete(data.accountId);
        return { success: true };
      },
    );

    // 获取账号列表
    ipcMain.handle(IPC_CHANNELS.WA_LIST_ACCOUNTS, () => {
      return this.windowManager.getAccountList();
    });

    // === 视图布局控制 ===

    // 显示 WhatsApp 视图（进入聊天页）
    ipcMain.on(IPC_CHANNELS.WA_SHOW_VIEW, (_event, layout?: any) => {
      console.log(`[IPC] 显示 WhatsApp 视图, layout=${JSON.stringify(layout)}`);
      if (layout) {
        this.windowManager.updateLayout(layout);
      }
      this.windowManager.showWhatsappView();
    });

    // 隐藏 WhatsApp 视图（离开聊天页）
    ipcMain.on(IPC_CHANNELS.WA_HIDE_VIEW, () => {
      this.windowManager.hideWhatsappView();
    });

    // 更新布局参数
    ipcMain.on(IPC_CHANNELS.WA_SET_LAYOUT, (_event, config: any) => {
      this.windowManager.updateLayout(config);
    });

    ipcMain.on(IPC_CHANNELS.WA_SET_OVERLAY_WIDTH, (_event, width: number) => {
      this.windowManager.setRendererOverlayWidth(width);
    });

    // 获取 WhatsApp 当前聊天的最近消息
    ipcMain.handle(
      "wa:get-recent-messages",
      async (_event, maxCount?: number) => {
        const view = this.windowManager.getActiveWhatsappView();
        if (!view) return [];

        return new Promise<any[]>((resolve) => {
          let resolved = false;
          const timeout = setTimeout(() => {
            if (!resolved) {
              resolved = true;
              resolve([]);
            }
          }, 3000);

          // 监听 WhatsApp preload 的回复
          const onReply = (_e: any, msgs: any[]) => {
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              ipcMain.removeListener("wa:recent-messages", onReply);
              resolve(msgs || []);
            }
          };
          ipcMain.on("wa:recent-messages", onReply);

          // 向 WhatsApp view 发送请求
          view.webContents.send("wa:get-recent-messages", maxCount || 10);
        });
      },
    );

    // wa-preload API 代理：让注入到 WhatsApp 页面的脚本也能调用后端 API
    ipcMain.handle(
      IPC_CHANNELS.WA_API_REQUEST,
      async (_event, config: ApiRequestConfig) => {
        try {
          const token = await this.getTokenAsync();
          const companyId = await this.getCompanyIdAsync();

          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            ...config.headers,
          };

          if (token) {
            headers["Authorization"] = `Bearer ${token}`;
          } else {
            console.warn("[IPC] WA_API_REQUEST: 无token，请求可能返回401");
          }
          if (companyId) {
            headers["X-Company-Id"] = companyId;
          }

          const response = await axios({
            method: config.method || "GET",
            url: `${this.requireApiBaseUrl()}${config.url}`,
            data: config.data,
            params: config.params,
            headers,
            timeout: config.timeout || 30000,
          });

          return {
            success: true,
            data: response.data,
            status: response.status,
          };
        } catch (error: any) {
          console.error(
            `[IPC] WA_API_REQUEST 失败: ${config.url}`,
            error.response?.status,
            error.response?.data?.message || error.message,
          );
          return {
            success: false,
            status: error.response?.status || 0,
            message: error.response?.data?.message || error.message,
            data: error.response?.data || null,
          };
        }
      },
    );
  }

  // === 应用信息 ===

  private registerAppHandlers(): void {
    ipcMain.handle(IPC_CHANNELS.APP_VERSION, () => {
      return app.getVersion();
    });

    // 运行时配置读取（API/更新地址由用户填写）
    // 供首次配置页（渲染进程，TASK-110/112 负责 UI）读取当前配置。
    ipcMain.handle(IPC_CHANNELS.APP_CONFIG_GET, () => {
      return tryLoadRuntimeConfig();
    });

    // 运行时配置写入（用户/运维在配置页填入正式 HTTPS 或 ZeroTier 内网地址）
    // 行为契约（TASK-111 v1.1 红线 2）：
    //   - saveRuntimeConfig 内部 validateApiOrUpdateUrl 校验；非法抛 Error
    //   - 这里 try/catch 把 error 转为 { success: false, error }
    //   - 校验通过返回 { success: true, config }；保存后由 app.ts 广播 APP_NEED_RESTART
    //     （axios 与 autoUpdater 在模块加载时固化，配置变更需重启才能作用于新实例）
    ipcMain.handle(
      IPC_CHANNELS.APP_CONFIG_SET,
      async (
        _event,
        config: { apiBaseUrl?: string; updateFeedUrl?: string },
      ) => {
        try {
          const next = saveRuntimeConfig({
            apiBaseUrl: config?.apiBaseUrl,
            updateFeedUrl: config?.updateFeedUrl,
          });
          console.log(
            `[IPC] 运行时配置已更新: api=${next.apiBaseUrl}, update=${next.updateFeedUrl}`,
          );
          // 通知所有渲染进程：需要重启（参见 app.ts 中对此通道的订阅）
          this.windowManager.sendToRenderer(IPC_CHANNELS.APP_NEED_RESTART, {
            reason: "config-changed",
            next,
          });
          return { success: true, config: next };
        } catch (error: any) {
          console.error(`[IPC] APP_CONFIG_SET 校验失败: ${error?.message}`);
          return { success: false, error: error?.message || "unknown" };
        }
      },
    );

    ipcMain.handle(
      IPC_CHANNELS.APP_CHECK_CONNECTION,
      async (_event, apiBaseUrl: string) => checkApiConnection(apiBaseUrl, app.getVersion()),
    );

    // 局域网状态检测：以实际业务后端 /health 为准，不依赖公网 DNS。
    const checkOnline = async () => {
      if (!this.apiBaseUrl) {
        this.windowManager.sendToRenderer(
          IPC_CHANNELS.APP_ONLINE_STATUS,
          false,
        );
        return;
      }
      try {
        const healthUrl = new URL("/health", this.apiBaseUrl).toString();
        const response = await axios({
          method: "GET",
          url: healthUrl,
          timeout: 5000,
          validateStatus: () => true,
        });
        this.windowManager.sendToRenderer(
          IPC_CHANNELS.APP_ONLINE_STATUS,
          response.status === 200,
        );
      } catch {
        this.windowManager.sendToRenderer(
          IPC_CHANNELS.APP_ONLINE_STATUS,
          false,
        );
      }
    };

    // 每 30 秒检测一次网络状态
    setInterval(checkOnline, 30000);
    checkOnline();
  }

  // === AI 功能 ===

  private registerAIHandlers(): void {
    // AI 回复建议
    ipcMain.handle(
      IPC_CHANNELS.AI_SUGGESTION,
      async (_event, data: { messageId: string; targetLanguage?: string }) => {
        if (!this.aiComms)
          throw new Error("运行时 API 未配置；AI 请求已被阻断");
        return this.aiComms.suggestReplies(data.messageId, data.targetLanguage);
      },
    );

    // AI 实时翻译
    ipcMain.handle(
      IPC_CHANNELS.AI_TRANSLATE,
      async (_event, data: { text: string; targetLanguage?: string }) => {
        if (!this.aiComms)
          throw new Error("运行时 API 未配置；AI 请求已被阻断");
        return this.aiComms.translateDraft(
          data.text,
          data.targetLanguage || "en",
        );
      },
    );
  }
}

interface ApiRequestConfig {
  method?: string;
  url: string;
  data?: any;
  params?: any;
  headers?: Record<string, string>;
  timeout?: number;
}
