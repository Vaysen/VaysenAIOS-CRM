import { Injectable, Logger } from '@nestjs/common';
import QRCode from 'qrcode';
import type { OpenClawWechatStatus } from './openclaw.types';

const MAX_GATEWAY_RESPONSE_BYTES = 1024 * 1024;
const PROBE_CACHE_TTL_MS = 5_000;
// A CRM turn may perform a unique customer lookup and then invoke a second
// audited business tool. Twelve seconds was shorter than that real two-tool
// path on the LAN and caused a false fallback after both tools had executed.
const OPENCLAW_CHAT_TIMEOUT_MS = 45_000;
const WECHAT_OWNER_ACCOUNT_ID = 'vaysen-owner';
const WECHAT_STATUSES = new Set<OpenClawWechatStatus>([
  'NOT_INSTALLED',
  'UNBOUND',
  'PAIRING',
  'WAITING_SCAN',
  'AUTHENTICATING',
  'CONNECTED',
  'DISCONNECTED',
  'EXPIRED',
  'ERROR',
]);

class OpenClawGatewayHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly safeCode: string | null,
  ) {
    super(`gateway_http_${statusCode}`);
  }
}

export interface OpenClawGatewayProbe {
  enabled: boolean;
  gatewayReady: boolean;
  adapterReady: boolean;
  modelReady: boolean;
  starting: boolean;
  release: string;
  lastHeartbeatAt: string | null;
  errorCode: string | null;
  wechatOwnerChannel: {
    status: OpenClawWechatStatus;
    pluginReady: boolean;
    pairingExpiresAt: string | null;
    binding: {
      displayName: string;
      maskedAccount: string;
      boundAt: string;
      lastSeenAt: string | null;
    } | null;
    errorCode: string | null;
  };
}

export interface OpenClawChatResult {
  success: boolean;
  content?: string;
  model?: string;
  reason: 'success' | 'disabled' | 'not_ready' | 'timeout' | 'gateway_error' | 'invalid_response';
  responseSource?: 'openclaw_gateway';
}

export interface OpenClawWechatLoginResult {
  connected: boolean;
  qrDataUrl: string | null;
  message: string | null;
  sessionKey: string | null;
  /** SHA-256 of the paired owner peer, calculated inside the channel adapter. */
  ownerPeerDigest: string | null;
}

export interface OpenClawOwnerNotificationResult {
  success: boolean;
  messageId?: string;
  reason: 'success' | 'disabled' | 'invalid_request' | 'rebind_required' | 'gateway_error' | 'invalid_response';
}

@Injectable()
export class OpenClawGatewayClient {
  private readonly logger = new Logger(OpenClawGatewayClient.name);
  private probeCache: { expiresAt: number; value: OpenClawGatewayProbe } | null = null;
  private probeInFlight: Promise<OpenClawGatewayProbe> | null = null;

  isEnabled(): boolean {
    return process.env.OPENCLAW_ENABLED === 'true';
  }

  getConfiguredModel(): string {
    return 'openclaw/vaysen-crm';
  }

  async probe(): Promise<OpenClawGatewayProbe> {
    const disabled = this.emptyProbe(false, 'DISABLED');
    if (!this.isEnabled()) {
      this.probeCache = null;
      this.probeInFlight = null;
      return disabled;
    }
    const now = Date.now();
    if (this.probeCache && this.probeCache.expiresAt > now) return this.probeCache.value;
    if (this.probeInFlight) return this.probeInFlight;

    const pending = this.probeFresh();
    this.probeInFlight = pending;
    try {
      const value = await pending;
      // Both healthy and unhealthy snapshots get the same short TTL. This
      // suppresses page-level fan-out without turning an old success into a
      // permanent success or hammering an unavailable Gateway.
      this.probeCache = { expiresAt: Date.now() + PROBE_CACHE_TTL_MS, value };
      return value;
    } finally {
      if (this.probeInFlight === pending) this.probeInFlight = null;
    }
  }

  private async probeFresh(): Promise<OpenClawGatewayProbe> {

    try {
      const gatewayData = await this.requestJson('GET', this.healthPath(), undefined, 1500);
      const gateway = this.asRecord(gatewayData);
      const statusText = String(gateway.status || '').toLowerCase();
      const gatewayReady = gateway.ok === true
        || gateway.gatewayReady === true
        || statusText === 'ok'
        || statusText === 'ready';
      if (!gatewayReady) {
        return {
          ...this.emptyProbe(true, this.safeCode(gateway.errorCode) || 'GATEWAY_NOT_READY'),
          starting: statusText === 'starting',
          release: this.safeText(gateway.release, 80)
            || this.safeText(process.env.OPENCLAW_RELEASE_VERSION, 80)
            || 'unknown',
        };
      }

      // General /healthz only proves that the Gateway process responds. CRM
      // adapter, WeChat channel and model authentication are independently
      // attested by fixed, authenticated endpoints and fail closed.
      const [adapterCall, channelsCall, modelAuthCall, modelsCall] = await Promise.allSettled([
        this.requestJson('GET', '/api/v1/vaysen/health', undefined, 1800),
        this.adminRpc('channels.status'),
        this.adminRpc('models.authStatus'),
        this.adminRpc('models.list'),
      ]);
      const adapter = this.asRecord(adapterCall.status === 'fulfilled' ? adapterCall.value : null);
      // This endpoint is our versioned CRM adapter attestation, not another
      // generic process health check. Unknown/legacy shapes must fail closed.
      const adapterReady = adapter.schemaVersion === 1
        && adapter.pluginId === 'vaysen-crm'
        && adapter.adapterReady === true
        && adapter.brokerConfigured === true;
      const channelsPayload = channelsCall.status === 'fulfilled'
        ? this.unwrapRpc(channelsCall.value)
        : {};
      const rpcChannel = this.findWeixinChannel(channelsPayload);
      const adapterChannel = this.asRecord(adapter.wechatOwnerChannel);
      const rawWechatStatus = String(rpcChannel.status || '').toUpperCase() as OpenClawWechatStatus;
      const wechatStatus = WECHAT_STATUSES.has(rawWechatStatus) ? rawWechatStatus : 'NOT_INSTALLED';
      const binding = this.safeBinding(adapterChannel.binding);
      const modelAuth = modelAuthCall.status === 'fulfilled'
        ? this.unwrapRpc(modelAuthCall.value)
        : {};
      const models = modelsCall.status === 'fulfilled' ? this.unwrapRpc(modelsCall.value) : {};
      const modelReady = this.hasAuthenticatedModel(modelAuth, models);
      return {
        enabled: true,
        gatewayReady: true,
        adapterReady,
        modelReady,
        starting: statusText === 'starting',
        release: this.safeText(gateway.release, 80)
          || this.safeText(process.env.OPENCLAW_RELEASE_VERSION, 80)
          || 'unknown',
        lastHeartbeatAt: this.safeIso(adapter.lastHeartbeatAt) || this.safeIso(gateway.lastHeartbeatAt),
        errorCode: adapterReady && modelReady ? null : 'OPENCLAW_COMPONENT_DEGRADED',
        wechatOwnerChannel: {
          status: wechatStatus,
          pluginReady: rpcChannel.pluginReady === true,
          pairingExpiresAt: this.safeIso(adapterChannel.pairingExpiresAt),
          binding,
          errorCode: this.safeCode(rpcChannel.errorCode) || this.safeCode(adapterChannel.errorCode),
        },
      };
    } catch (error) {
      const reason = error instanceof Error && error.name === 'AbortError'
        ? 'GATEWAY_TIMEOUT'
        : 'GATEWAY_UNAVAILABLE';
      this.logger.warn(`OpenClaw health probe failed: ${reason}`);
      return this.emptyProbe(true, reason);
    }
  }

  async chat(
    systemPrompt: string,
    userMessage: string,
    sessionDigest: string,
    maxTokens = 900,
  ): Promise<OpenClawChatResult> {
    if (!this.isEnabled()) return { success: false, reason: 'disabled' };
    if (!/^[a-f0-9]{64}$/.test(sessionDigest)) return { success: false, reason: 'invalid_response' };
    const probe = await this.probe();
    if (!probe.gatewayReady || !probe.adapterReady || !probe.modelReady) {
      return { success: false, reason: 'not_ready' };
    }

    try {
      const data = await this.requestJson('POST', '/v1/chat/completions', {
        model: this.getConfiguredModel(),
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        max_tokens: Math.max(1, Math.min(1600, Math.trunc(maxTokens))),
        // CRM tool routing must be repeatable. Creative drafting still happens
        // inside the selected tool/workflow; the ingress decision itself uses
        // deterministic sampling so an identical operational request does not
        // randomly degrade into a prose-only answer.
        temperature: 0,
        stream: false,
      }, OPENCLAW_CHAT_TIMEOUT_MS, {
        'x-openclaw-agent-id': 'vaysen-crm',
        'x-openclaw-session-key': `vaysen-crm:${sessionDigest}`,
        'x-openclaw-message-channel': 'webchat',
      });
      const record = this.asRecord(data);
      const choices = Array.isArray(record.choices) ? record.choices : [];
      const first = this.asRecord(choices[0]);
      const message = this.asRecord(first.message);
      const content = typeof message.content === 'string' ? message.content.trim() : '';
      if (!content || content.length > 20_000) {
        return { success: false, reason: 'invalid_response' };
      }
      return {
        success: true,
        content,
        model: this.safeText(record.model, 120) || this.getConfiguredModel(),
        reason: 'success',
        responseSource: 'openclaw_gateway',
      };
    } catch (error) {
      const timeout = error instanceof Error && error.name === 'AbortError';
      this.logger.warn(`OpenClaw chat failed: ${timeout ? 'GATEWAY_TIMEOUT' : 'GATEWAY_ERROR'}`);
      return { success: false, reason: timeout ? 'timeout' : 'gateway_error' };
    }
  }

  async notifyOwner(input: {
    ownerDigest: string;
    eventKey: string;
    text: string;
  }): Promise<OpenClawOwnerNotificationResult> {
    if (!this.isEnabled()) return { success: false, reason: 'disabled' };
    const ownerDigest = input.ownerDigest.trim();
    const eventKey = input.eventKey.trim();
    const text = input.text.trim();
    if (!/^[a-f0-9]{64}$/.test(ownerDigest)
      || !/^[A-Za-z0-9._:-]{1,160}$/.test(eventKey)
      || !text
      || text.length > 4000) {
      return { success: false, reason: 'invalid_request' };
    }
    try {
      const value = this.asRecord(await this.requestJson(
        'POST',
        '/api/v1/vaysen/notify-owner',
        { ownerDigest, eventKey, text },
        12_000,
      ));
      const messageId = typeof value.messageId === 'string' ? value.messageId.trim() : '';
      if (value.schemaVersion !== 1
        || value.status !== 'SUCCEEDED'
        || !messageId
        || messageId.length > 512) {
        return { success: false, reason: 'invalid_response' };
      }
      return { success: true, messageId, reason: 'success' };
    } catch (error) {
      if (error instanceof OpenClawGatewayHttpError
        && error.safeCode === 'OWNER_CHANNEL_REBIND_REQUIRED') {
        return { success: false, reason: 'rebind_required' };
      }
      this.logger.warn('OpenClaw owner notification failed: GATEWAY_ERROR');
      return { success: false, reason: 'gateway_error' };
    }
  }

  async startWechatPairing(): Promise<OpenClawWechatLoginResult> {
    const payload = this.unwrapRpc(await this.adminRpc('web.login.start', {
      accountId: WECHAT_OWNER_ACCOUNT_ID,
      force: true,
      timeoutMs: 15_000,
      verbose: false,
    }, 18_000));
    return this.parseWechatLoginResult(payload);
  }

  async waitWechatPairing(_sessionKey: string): Promise<OpenClawWechatLoginResult> {
    // OpenClaw 2026.7.1 validates the public web.login.wait envelope and only
    // forwards accountId/currentQrDataUrl/timeoutMs to channel plugins.  The
    // Tencent plugin keeps its active login under the fixed account alias, so
    // forwarding its private sessionKey here makes the core RPC reject the
    // entire request with HTTP 400.  Keep the key only as server-side pairing
    // evidence and resume the login through the reviewed account alias.
    const payload = this.unwrapRpc(await this.adminRpc('web.login.wait', {
      accountId: WECHAT_OWNER_ACCOUNT_ID,
      timeoutMs: 90_000,
    }, 95_000));
    return this.parseWechatLoginResult(payload);
  }

  private async requestJson(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    timeoutMs: number,
    fixedHeaders: Readonly<Record<string, string>> = {},
  ): Promise<unknown> {
    const { baseUrl, token } = this.configuration();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(new URL(path, baseUrl), {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...fixedHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: controller.signal,
      });
      const declaredLength = Number(response.headers.get('content-length') || '0');
      if (declaredLength > MAX_GATEWAY_RESPONSE_BYTES) throw new Error('gateway_response_too_large');
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_GATEWAY_RESPONSE_BYTES) throw new Error('gateway_response_too_large');
      const text = buffer.toString('utf8').trim();
      if (!response.ok) {
        let code: string | null = null;
        try {
          const value = JSON.parse(text);
          const candidate = typeof value?.code === 'string' ? value.code.trim().toUpperCase() : '';
          code = /^[A-Z0-9_.-]{1,64}$/.test(candidate) ? candidate : null;
        } catch {
          // Error bodies are optional and never forwarded verbatim.
        }
        throw new OpenClawGatewayHttpError(response.status, code);
      }
      if (!text) return {};
      if (text === 'ok' || text === 'ready') return { status: text };
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  }

  private adminRpc(
    method: 'channels.status' | 'models.authStatus' | 'models.list' | 'web.login.start' | 'web.login.wait',
    params: Record<string, unknown> = {},
    timeoutMs = 1800,
  ): Promise<unknown> {
    return this.requestJson('POST', '/api/v1/admin/rpc', { method, params }, timeoutMs);
  }

  private async parseWechatLoginResult(value: Record<string, any>): Promise<OpenClawWechatLoginResult> {
    const rawQr = typeof value.qrDataUrl === 'string' ? value.qrDataUrl.trim() : '';
    const rawOwnerPeerDigest = typeof value.ownerPeerDigest === 'string'
      ? value.ownerPeerDigest.trim()
      : '';
    const ownerPeerDigest = /^[a-f0-9]{64}$/.test(rawOwnerPeerDigest)
      ? rawOwnerPeerDigest
      : null;
    let qrDataUrl = /^data:image\/(?:png|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(rawQr)
      && rawQr.length <= 900_000
      ? rawQr
      : null;
    if (!qrDataUrl && this.isAllowedTencentWechatQrUrl(rawQr)) {
      qrDataUrl = await QRCode.toDataURL(rawQr, {
        width: 320,
        margin: 2,
        errorCorrectionLevel: 'M',
      });
    }
    return {
      connected: value.connected === true,
      qrDataUrl,
      message: this.safeText(value.message, 240) || null,
      sessionKey: this.safeText(value.sessionKey, 512) || null,
      ownerPeerDigest: value.connected === true ? ownerPeerDigest : null,
    };
  }

  private isAllowedTencentWechatQrUrl(value: string): boolean {
    if (!value || value.length > 2_048) return false;
    try {
      const url = new URL(value);
      return url.protocol === 'https:'
        && url.hostname === 'liteapp.weixin.qq.com'
        && !url.username
        && !url.password
        && !url.hash;
    } catch {
      return false;
    }
  }

  private unwrapRpc(value: unknown): Record<string, any> {
    const record = this.asRecord(value);
    // OpenClaw 2026.7.1 bundled admin-http-rpc returns the fixed envelope
    // { id, ok: true, payload }. Accepting fabricated result/data/bare shapes
    // makes an incompatible or failed Gateway look healthy, so fail closed.
    if (record.ok !== true) return {};
    return this.asRecord(record.payload);
  }

  private findWeixinChannel(value: Record<string, any>): Record<string, any> {
    const channelId = 'openclaw-weixin';
    const channelMap = this.asRecord(value.channels);
    const accountMap = this.asRecord(value.channelAccounts);
    const defaults = this.asRecord(value.channelDefaultAccountId);
    const order = Array.isArray(value.channelOrder) ? value.channelOrder : [];
    const meta = Array.isArray(value.channelMeta) ? value.channelMeta : [];
    const pluginReady = order.includes(channelId)
      || meta.some((entry) => this.asRecord(entry).id === channelId)
      || Object.prototype.hasOwnProperty.call(channelMap, channelId)
      || Object.prototype.hasOwnProperty.call(accountMap, channelId);
    if (!pluginReady) return { status: 'NOT_INSTALLED', pluginReady: false };

    const summary = this.asRecord(channelMap[channelId]);
    const accounts = Array.isArray(accountMap[channelId])
      ? accountMap[channelId].map((entry: unknown) => this.asRecord(entry))
      : [];
    const defaultAccountId = typeof defaults[channelId] === 'string' ? defaults[channelId] : '';
    const selected = (defaultAccountId
      ? accounts.find((entry: Record<string, any>) => entry.accountId === defaultAccountId)
      : undefined) || accounts[0] || {};
    const runtime = this.asRecord(selected.runtime);
    const configured = selected.configured === true;
    const running = selected.running === true || runtime.running === true;
    const lastError = this.safeText(
      selected.lastError || runtime.lastError || summary.lastError,
      240,
    );
    if (lastError) {
      return { status: 'ERROR', pluginReady: true, errorCode: 'CHANNEL_RUNTIME_ERROR' };
    }
    if (!configured) return { status: 'UNBOUND', pluginReady: true };
    return { status: running ? 'CONNECTED' : 'DISCONNECTED', pluginReady: true };
  }

  private hasAuthenticatedModel(authValue: Record<string, any>, modelsValue: Record<string, any>): boolean {
    const expectedProvider = 'zhipu-cn';
    const expectedModel = (process.env.ZHIPU_MODEL || 'glm-4-flash-250414').trim();
    if (!expectedModel || expectedModel.length > 160) return false;
    const models = Array.isArray(modelsValue.models) ? modelsValue.models : [];
    const targetAvailable = models.some((entry) => {
      const item = this.asRecord(entry);
      return item.provider === expectedProvider
        && item.id === expectedModel
        && item.available === true;
    });
    if (!targetAvailable) return false;

    // OpenClaw 2026.7.1 returns { ts, providers: [...] }; API-key providers
    // may legitimately be absent from this OAuth-oriented view. If our exact
    // provider is present and explicitly unusable, however, fail closed. A
    // healthy unrelated provider never proves the configured Zhipu model.
    const authProviders = Array.isArray(authValue.providers) ? authValue.providers : [];
    const targetAuth = authProviders
      .map((entry) => this.asRecord(entry))
      .find((entry) => entry.provider === expectedProvider);
    return !targetAuth || !['missing', 'expired'].includes(String(targetAuth.status || '').toLowerCase());
  }

  private configuration(): { baseUrl: URL; token: string } {
    const rawUrl = (process.env.OPENCLAW_GATEWAY_URL || '').trim();
    const token = process.env.OPENCLAW_GATEWAY_TOKEN || '';
    if (!rawUrl || Buffer.byteLength(token, 'utf8') < 32) {
      throw new Error('openclaw_gateway_not_configured');
    }
    const baseUrl = new URL(rawUrl);
    if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.hash) {
      throw new Error('openclaw_gateway_url_invalid');
    }
    if (baseUrl.protocol === 'http:' && !this.isPrivateGatewayHost(baseUrl.hostname)) {
      throw new Error('openclaw_gateway_http_must_be_private');
    }
    baseUrl.pathname = baseUrl.pathname.endsWith('/') ? baseUrl.pathname : `${baseUrl.pathname}/`;
    return { baseUrl, token };
  }

  private healthPath(): string {
    const value = (process.env.OPENCLAW_GATEWAY_HEALTH_PATH || '/healthz').trim();
    if (!/^\/[A-Za-z0-9/_-]{1,120}$/.test(value)) throw new Error('openclaw_health_path_invalid');
    return value;
  }

  private isPrivateGatewayHost(hostname: string): boolean {
    const host = hostname.toLowerCase();
    if (host === 'localhost' || host === '::1' || host.endsWith('.internal')) return true;
    if (!host.includes('.')) return /^[a-z0-9][a-z0-9-]{0,62}$/.test(host);
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
    const match = /^172\.(\d{1,3})\./.exec(host);
    return !!match && Number(match[1]) >= 16 && Number(match[1]) <= 31;
  }

  private emptyProbe(enabled: boolean, errorCode: string): OpenClawGatewayProbe {
    return {
      enabled,
      gatewayReady: false,
      adapterReady: false,
      modelReady: false,
      starting: false,
      release: this.safeText(process.env.OPENCLAW_RELEASE_VERSION, 80) || 'unknown',
      lastHeartbeatAt: null,
      errorCode,
      wechatOwnerChannel: {
        status: enabled ? 'DISCONNECTED' : 'NOT_INSTALLED',
        pluginReady: false,
        pairingExpiresAt: null,
        binding: null,
        errorCode: enabled ? errorCode : null,
      },
    };
  }

  private safeBinding(value: unknown): OpenClawGatewayProbe['wechatOwnerChannel']['binding'] {
    const record = this.asRecord(value);
    const displayName = this.safeText(record.displayName, 80);
    const maskedAccount = this.safeText(record.maskedAccount, 64);
    const boundAt = this.safeIso(record.boundAt);
    if (!displayName || !maskedAccount || !maskedAccount.includes('*') || !boundAt) return null;
    return {
      displayName,
      maskedAccount,
      boundAt,
      lastSeenAt: this.safeIso(record.lastSeenAt),
    };
  }

  private safeText(value: unknown, maxLength: number): string {
    if (typeof value !== 'string') return '';
    return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
  }

  private safeCode(value: unknown): string | null {
    const text = this.safeText(value, 64).toUpperCase();
    return /^[A-Z0-9_.-]{1,64}$/.test(text) ? text : null;
  }

  private safeIso(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  }

  private asRecord(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, any>
      : {};
  }
}
