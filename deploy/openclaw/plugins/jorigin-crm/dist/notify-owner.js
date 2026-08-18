import { createHash } from 'node:crypto';

const MAX_NOTIFY_BODY_BYTES = 16 * 1024;
const NOTIFY_RECEIPT_TTL_MS = 10 * 60_000;
const REVIEWED_OWNER_ACCOUNT_ID = 'jorigin-owner';

class NotifyOwnerError extends Error {
  constructor(statusCode, code) {
    super(code);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function readJsonBody(req) {
  const contentType = String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new NotifyOwnerError(415, 'JSON_REQUIRED');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_NOTIFY_BODY_BYTES) throw new NotifyOwnerError(413, 'BODY_TOO_LARGE');
    chunks.push(bytes);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new NotifyOwnerError(400, 'INVALID_JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NotifyOwnerError(400, 'INVALID_REQUEST');
  }
  if (Object.keys(value).sort().join(',') !== 'eventKey,ownerDigest,text') {
    throw new NotifyOwnerError(400, 'INVALID_REQUEST');
  }
  const ownerDigest = typeof value.ownerDigest === 'string' ? value.ownerDigest.trim() : '';
  const eventKey = typeof value.eventKey === 'string' ? value.eventKey.trim() : '';
  const text = typeof value.text === 'string' ? value.text.trim() : '';
  if (!/^[a-f0-9]{64}$/.test(ownerDigest)
    || !/^[A-Za-z0-9._:-]{1,160}$/.test(eventKey)
    || !text
    || text.length > 4000) {
    throw new NotifyOwnerError(400, 'INVALID_REQUEST');
  }
  return { ownerDigest, eventKey, text };
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

function classifyOwnerNotificationFailure(error) {
  const message = String(error instanceof Error ? error.message : error || '').toLowerCase();
  // Tencent Weixin returns this stable adapter-level response when the
  // previously enrolled bot session can no longer prepare an outbound send.
  // Treat it as an explicit rebind/refresh requirement instead of a generic
  // gateway failure so operators know that retrying the same stale session is
  // not useful.
  if (/sendmessage\s+ret=-2\b.*prepare failed/.test(message)) return 'OWNER_CHANNEL_REBIND_REQUIRED';
  if (/session.*(?:inactive|not active)|no active session/.test(message)) return 'OWNER_CHANNEL_SESSION_INACTIVE';
  if (/not configured|missing configuration/.test(message)) return 'OWNER_CHANNEL_NOT_CONFIGURED';
  if (/context.?token/.test(message)) return 'OWNER_CHANNEL_CONTEXT_REJECTED';
  if (/\b401\b|unauthori[sz]ed|invalid token/.test(message)) return 'OWNER_CHANNEL_AUTH_REJECTED';
  if (/\b403\b|forbidden|permission denied/.test(message)) return 'OWNER_CHANNEL_FORBIDDEN';
  if (/fetch|network|econn|timed?\s*out|socket/.test(message)) return 'OWNER_CHANNEL_NETWORK_FAILED';
  if (/cannot read properties|is not a function|undefined/.test(message)) return 'OWNER_CHANNEL_ADAPTER_CONTRACT';
  return 'OWNER_NOTIFICATION_FAILED';
}

function sessionEntries(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray(value.entries)) return value.entries;
  return [];
}

function unwrapSessionEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  // OpenClaw 2026.7.1 returns { sessionKey, entry } from
  // listSessionEntries(). Keep accepting a bare entry for the plugin SDK test
  // harness and for forward-compatible adapters.
  const nested = value.entry;
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested
    : value;
}

export function ownerNotificationRuntimeReady(api) {
  return typeof api.runtime?.agent?.session?.listSessionEntries === 'function'
    && typeof api.runtime?.channel?.outbound?.loadAdapter === 'function'
    && typeof api.runtime?.config?.current === 'function';
}

export async function notifyBoundOwner(api, request) {
  if (!ownerNotificationRuntimeReady(api)) {
    throw new NotifyOwnerError(503, 'OWNER_CHANNEL_UNAVAILABLE');
  }
  const entries = sessionEntries(await api.runtime.agent.session.listSessionEntries({
    agentId: 'jorigin-crm',
  }));
  const matches = entries.flatMap((entry) => {
    const sessionEntry = unwrapSessionEntry(entry);
    const delivery = sessionEntry?.deliveryContext
      && typeof sessionEntry.deliveryContext === 'object'
      ? sessionEntry.deliveryContext
      : null;
    const to = typeof delivery?.to === 'string' ? delivery.to.trim() : '';
    const accountId = typeof delivery?.accountId === 'string' ? delivery.accountId.trim() : '';
    return delivery?.channel === 'openclaw-weixin'
      && to
      && accountId
      && sha256(to) === request.ownerDigest
      ? [{ to, accountId }]
      : [];
  });
  // OpenClaw can retain several CRM sessions for the same owner peer (for
  // example after a reconnect or when the owner starts a fresh /new chat).
  // Session multiplicity is not owner multiplicity. Deduplicate the exact
  // account + peer target while still rejecting genuinely different accounts
  // or peers that match the reviewed digest.
  const uniqueMatches = [...new Map(
    matches.map((match) => [`${match.accountId}\u0000${match.to}`, match]),
  ).values()];
  const currentAccountMatches = uniqueMatches.filter(
    (match) => match.accountId === REVIEWED_OWNER_ACCOUNT_ID,
  );
  const selectedMatch = currentAccountMatches.length === 1
    ? currentAccountMatches[0]
    : uniqueMatches.length === 1
      ? uniqueMatches[0]
      : null;
  if (!selectedMatch) throw new NotifyOwnerError(409, 'OWNER_CHANNEL_NOT_UNIQUE');
  const adapter = await api.runtime.channel.outbound.loadAdapter('openclaw-weixin');
  if (!adapter || typeof adapter.sendText !== 'function') {
    throw new NotifyOwnerError(503, 'OWNER_CHANNEL_UNAVAILABLE');
  }
  const receipt = await adapter.sendText({
    cfg: await api.runtime.config.current(),
    to: selectedMatch.to,
    accountId: selectedMatch.accountId,
    text: request.text,
  });
  const messageId = typeof receipt?.messageId === 'string' ? receipt.messageId.trim() : '';
  if (!messageId || messageId.length > 512) {
    throw new NotifyOwnerError(503, 'OWNER_NOTIFICATION_NO_RECEIPT');
  }
  return { schemaVersion: 1, status: 'SUCCEEDED', messageId };
}

export function createNotifyOwnerRoute(api) {
  const receipts = new Map();
  const execute = async (request) => {
    const now = Date.now();
    for (const [key, value] of receipts) {
      if (value.expiresAt <= now) receipts.delete(key);
    }
    while (receipts.size >= 512) receipts.delete(receipts.keys().next().value);
    const key = sha256(`${request.ownerDigest}\n${request.eventKey}`);
    const textDigest = sha256(request.text);
    const existing = receipts.get(key);
    if (existing) {
      if (existing.textDigest !== textDigest) throw new NotifyOwnerError(409, 'EVENT_KEY_REUSED');
      return existing.promise;
    }
    const promise = notifyBoundOwner(api, request);
    receipts.set(key, { expiresAt: now + NOTIFY_RECEIPT_TTL_MS, textDigest, promise });
    try {
      return await promise;
    } catch (error) {
      receipts.delete(key);
      throw error;
    }
  };
  return {
    path: '/api/v1/jorigin/notify-owner',
    auth: 'gateway',
    match: 'exact',
    async handler(req, res) {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('allow', 'POST');
        res.end();
        return true;
      }
      try {
        sendJson(res, 200, await execute(await readJsonBody(req)));
      } catch (error) {
        const statusCode = error instanceof NotifyOwnerError ? error.statusCode : 503;
        const code = error instanceof NotifyOwnerError
          ? error.code
          : classifyOwnerNotificationFailure(error);
        sendJson(res, statusCode, { schemaVersion: 1, status: 'FAILED', code });
      }
      return true;
    },
  };
}
