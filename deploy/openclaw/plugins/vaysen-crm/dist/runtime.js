import { createHash, createHmac, randomUUID } from 'node:crypto';

const WEIXIN_CHANNEL = 'openclaw-weixin';
const CRM_CHANNEL = 'vaysen-crm';
const HTTP_INGRESS_CHANNEL = 'webchat';
const CRM_HTTP_SESSION_PATTERN = /^agent:vaysen-crm:(vaysen-crm:[a-f0-9]{64})$/;
const MAX_RESPONSE_BYTES = 256 * 1024;

export function resolveTrustedActor(toolContext = {}) {
  const channel = typeof toolContext.messageChannel === 'string'
    ? toolContext.messageChannel.trim()
    : '';
  const senderId = typeof toolContext.requesterSenderId === 'string'
    ? toolContext.requesterSenderId.trim()
    : '';
  const sessionKey = typeof toolContext.sessionKey === 'string'
    ? toolContext.sessionKey.trim()
    : '';
  const accountId = typeof toolContext.agentAccountId === 'string'
    ? toolContext.agentAccountId.trim()
    : '';
  const crmSessionKey = CRM_HTTP_SESSION_PATTERN.exec(sessionKey)?.[1] ?? '';

  const isWeixinOwner = channel === WEIXIN_CHANNEL
    && toolContext.senderIsOwner === true
    && Boolean(senderId)
    && Boolean(accountId)
    && /(?:^|:)direct(?::|$)/.test(sessionKey);
  const isCrmGatewayOwner = channel === HTTP_INGRESS_CHANNEL
    && toolContext.agentId === CRM_CHANNEL
    && toolContext.senderIsOwner === false
    && !senderId
    && !accountId
    && Boolean(crmSessionKey);

  if (!isWeixinOwner && !isCrmGatewayOwner) {
    throw new Error('CRM tools require a trusted owner channel and namespaced OpenClaw context');
  }

  if (isWeixinOwner) {
    return Object.freeze({
      channel: WEIXIN_CHANNEL,
      source: WEIXIN_CHANNEL,
      senderIsOwner: true,
      requesterSenderId: senderId,
      sessionKey,
      agentAccountId: accountId,
    });
  }

  return Object.freeze({
    channel: CRM_CHANNEL,
    source: CRM_CHANNEL,
    // OpenClaw 2026.7.1 exposes its OpenAI-compatible HTTP ingress to tool
    // factories as the registered internal `webchat` transport and fixes the
    // owner bit false. It also namespaces the external CRM session under the
    // selected agent. The exact transport/agent/false-owner/namespaced-session
    // tuple is the plugin-side gate; only the inner CRM session is sent to the
    // backend, which requires a live admin-created mapping before accepting it.
    senderIsOwner: true,
    agentId: CRM_CHANNEL,
    sessionKey: crmSessionKey,
  });
}

export function actorForToolCall(actor, toolCallId) {
  const id = typeof toolCallId === 'string' ? toolCallId.trim() : '';
  if (!id || id.length > 256) {
    throw new Error('OpenClaw tool call id is unavailable');
  }
  return Object.freeze({ ...actor, toolCallId: id });
}

export function normalizeSelectionToken(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error('A current unique customer-search selectionToken is required');
  }
  return token;
}

export function normalizeAcceptanceMarker(value) {
  if (value === undefined) return undefined;
  const marker = typeof value === 'string' ? value.trim() : '';
  if (!/^JYACC_OWNER_[a-f0-9]{16}$/.test(marker)) {
    throw new Error('Acceptance marker is invalid');
  }
  return marker;
}

export function canonicalRequest({ timestamp, nonce, method, path, rawBody }) {
  const bodyHash = createHash('sha256').update(rawBody, 'utf8').digest('hex');
  return `${timestamp}\n${nonce}\n${method}\n${path}\n${bodyHash}`;
}

export function signRequest({ secret, timestamp, nonce, method, path, rawBody }) {
  return createHmac('sha256', secret)
    .update(canonicalRequest({ timestamp, nonce, method, path, rawBody }), 'utf8')
    .digest('hex');
}

function assertConfig(config) {
  if (config.apiBaseUrl !== 'http://backend:4000') {
    throw new Error('CRM broker URL is outside the reviewed container boundary');
  }
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(config.keyId || '')) {
    throw new Error('CRM HMAC key id is invalid');
  }
  if (typeof config.hmacSecret !== 'string'
    || Buffer.byteLength(config.hmacSecret, 'utf8') < 48) {
    throw new Error('CRM HMAC secret is unavailable');
  }
}

export async function callBroker({ config, path, body, signal }) {
  assertConfig(config);
  if (!/^\/api\/internal\/openclaw\/tools\/(?:work-brief|customer-search|customer-get|customer-add-note|customer-update|customer-set-stage|task-create|order-list|order-create-draft|order-update-stage|quote-list|quote-create-draft|product-search|start-background-research|prepare-quote-delivery|whatsapp-messages-read|whatsapp-send-text|whatsapp-send-quote|email-messages-read|email-send|email-reply)$/.test(path)) {
    throw new Error('CRM broker path is not allowlisted');
  }

  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID();
  const method = 'POST';
  const signature = signRequest({
    secret: config.hmacSecret,
    timestamp,
    nonce,
    method,
    path,
    rawBody,
  });
  const timeoutMs = Number.isInteger(config.requestTimeoutMs)
    ? config.requestTimeoutMs
    : 15000;
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
  const abort = () => timeoutController.abort();
  signal?.addEventListener('abort', abort, { once: true });

  try {
    const response = await fetch(`${config.apiBaseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-openclaw-key-id': config.keyId,
        'x-openclaw-timestamp': timestamp,
        'x-openclaw-nonce': nonce,
        'x-openclaw-signature': signature,
      },
      body: rawBody,
      signal: timeoutController.signal,
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) {
      throw new Error('CRM broker response exceeded the reviewed size limit');
    }
    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error('CRM broker returned invalid JSON');
    }
    if (!response.ok) {
      const requestId = typeof payload?.requestId === 'string' ? ` (${payload.requestId})` : '';
      throw new Error(`CRM broker rejected the operation with HTTP ${response.status}${requestId}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export function createToolResult(details) {
  return {
    content: [{ type: 'text', text: JSON.stringify(details) }],
    details,
  };
}

export function mapResearchReceipt(payload = {}) {
  const result = payload && typeof payload.result === 'object' && payload.result !== null
    ? payload.result
    : {};
  const receiptCompleted = payload.status === 'COMPLETED';
  const reportReady = receiptCompleted && result.reportReady === true;
  return {
    status: receiptCompleted ? (result.status ?? 'UNKNOWN') : (payload.status ?? 'FAILED'),
    completed: reportReady,
    requestId: payload.requestId ?? null,
    reportReady,
    errorCode: payload.errorCode ?? null,
    instruction: reportReady
      ? 'The research report is ready and may be summarized from the returned evidence.'
      : 'The research is not complete. Track the returned requestId and status; do not claim a finished report.',
  };
}

const SELECTION_TOKEN_TOOL_NAMES = Object.freeze({
  'customer-get': 'crm_customer_get',
  'customer-add-note': 'crm_customer_add_note',
  'customer-update': 'crm_customer_update',
  'customer-set-stage': 'crm_customer_set_stage',
  'task-create': 'crm_task_create',
  'order-list': 'crm_order_list',
  'order-create-draft': 'crm_order_create_draft',
  'order-update-stage': 'crm_order_update_stage',
  'quote-list': 'crm_quote_list',
  'quote-create-draft': 'crm_quote_create_draft',
  'whatsapp-messages-read': 'crm_whatsapp_messages_read',
  'whatsapp-send-text': 'crm_whatsapp_send_text',
  'whatsapp-send-quote': 'crm_whatsapp_send_quote',
  'email-messages-read': 'crm_email_messages_read',
  'email-send': 'crm_email_send',
  'email-reply': 'crm_email_reply',
  'start-background-research': 'crm_start_background_research',
  'prepare-quote-delivery': 'crm_prepare_quote_delivery',
});
const TOOL_SELECTION_NAMES = Object.freeze(Object.fromEntries(
  Object.entries(SELECTION_TOKEN_TOOL_NAMES).map(([selectionName, toolName]) => [toolName, selectionName]),
));
const SESSION_SELECTION_CACHE_LIMIT = 128;
const sessionSelectionCache = new Map();

function trustedSelectionCacheKey(actor) {
  const channel = typeof actor?.channel === 'string' ? actor.channel : '';
  const sessionKey = typeof actor?.sessionKey === 'string' ? actor.sessionKey : '';
  if (!['vaysen-crm', 'openclaw-weixin'].includes(channel) || !sessionKey) return '';
  return `${channel}:${sessionKey}`;
}

function pruneSelectionCache(now) {
  for (const [key, entry] of sessionSelectionCache) {
    if (!entry || entry.expiresAt <= now) sessionSelectionCache.delete(key);
  }
  while (sessionSelectionCache.size > SESSION_SELECTION_CACHE_LIMIT) {
    sessionSelectionCache.delete(sessionSelectionCache.keys().next().value);
  }
}

export function rememberCustomerSelection(actor, payload, now = Date.now()) {
  const key = trustedSelectionCacheKey(actor);
  if (!key) return false;
  pruneSelectionCache(now);
  const result = payload && typeof payload.result === 'object' && payload.result !== null
    ? payload.result
    : {};
  const selection = result.selection && typeof result.selection === 'object'
    ? result.selection
    : null;
  const tokens = selection?.tokens && typeof selection.tokens === 'object'
    ? selection.tokens
    : {};
  const expiresAt = Date.parse(String(selection?.expiresAt || ''));
  const safeTokens = Object.fromEntries(
    Object.keys(SELECTION_TOKEN_TOOL_NAMES).flatMap((selectionName) => {
      const token = tokens[selectionName];
      return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)
        ? [[selectionName, token]]
        : [];
    }),
  );
  if (!Number.isFinite(expiresAt) || expiresAt <= now || Object.keys(safeTokens).length === 0) {
    sessionSelectionCache.delete(key);
    return false;
  }
  sessionSelectionCache.set(key, Object.freeze({ expiresAt, tokens: Object.freeze(safeTokens) }));
  pruneSelectionCache(now);
  return true;
}

export function useExactSelectionToken(actor, toolName, input, now = Date.now()) {
  const key = trustedSelectionCacheKey(actor);
  const selectionName = TOOL_SELECTION_NAMES[toolName];
  if (!key || !selectionName) return input;
  pruneSelectionCache(now);
  const entry = sessionSelectionCache.get(key);
  const exactToken = entry?.tokens?.[selectionName];
  if (typeof exactToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(exactToken)) return input;
  return { ...input, selectionToken: exactToken };
}

/**
 * OpenClaw models must not guess which opaque capability belongs to an action.
 * The broker intentionally issues one scoped token per action. Expose the
 * transient bundle under the exact published tool names so a model can copy
 * `selectionTokenByTool.<toolName>` without relying on array order or on a
 * lossy hyphen/underscore conversion.
 */
export function mapCustomerSearchReceipt(payload = {}) {
  const result = payload && typeof payload.result === 'object' && payload.result !== null
    ? payload.result
    : {};
  const selection = result.selection && typeof result.selection === 'object'
    ? result.selection
    : null;
  const tokens = selection?.tokens && typeof selection.tokens === 'object'
    ? selection.tokens
    : {};
  const selectionTokenByTool = Object.fromEntries(
    Object.entries(SELECTION_TOKEN_TOOL_NAMES).flatMap(([actionName, toolName]) => {
      const token = tokens[actionName];
      return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)
        ? [[toolName, token]]
        : [];
    }),
  );
  const mappedSelection = selection
    ? {
        expiresAt: selection.expiresAt ?? null,
        selectionTokenByTool,
      }
    : null;
  return {
    ...payload,
    result: {
      ...result,
      selection: mappedSelection,
      instruction: mappedSelection
        ? 'The unique customer selection is bound to this trusted session. Call the next action tool without inventing or copying a selectionToken; the plugin injects the exact tool-scoped token.'
        : 'No unique customer was selected. Do not call a customer action tool.',
    },
  };
}

export function mapQuoteReceipt(payload = {}) {
  const result = payload && typeof payload.result === 'object' && payload.result !== null
    ? payload.result
    : {};
  const prepared = payload.status === 'COMPLETED'
    && result.status === 'REQUIRES_CONFIRMATION';
  if (!prepared) {
    return {
      status: payload.status === 'FAILED'
        ? 'FAILED'
        : (result.status ?? payload.status ?? 'BLOCKED'),
      prepared: false,
      requiresHumanConfirmation: false,
      requestId: payload.requestId ?? null,
      quote: null,
      errorCode: payload.errorCode ?? null,
      instruction: 'The quote proposal was not prepared. Resolve the reported CRM status before any delivery claim.',
    };
  }
  return {
    status: 'PREPARED_NOT_SENT',
    prepared: true,
    requiresHumanConfirmation: true,
    requiresManualWhatsappSend: true,
    requestId: payload.requestId ?? null,
    quote: result.quote ?? null,
    targetName: result.targetName ?? null,
    automaticSend: false,
    instruction: 'The quote proposal is prepared but not sent. Review it in CRM, then confirm and send manually.',
  };
}
