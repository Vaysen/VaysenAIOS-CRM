export interface PendingAssistantRequest {
  text: string;
  requestId: string;
  knownTurnIds: string[];
  historyBaselineReady: boolean;
  contextFingerprint: string;
  createdAt: number;
}

export interface CompletedAssistantRequest {
  requestId: string;
  textDigest: string;
  contextFingerprint: string;
  completedAt: number;
}

const RECENT_COMPLETION_TTL_MS = 30_000;
// A request id is durable on the backend, but a browser-side uncertainty lock
// must not strand the chat for an entire day after a renderer crash. Ten
// minutes is long enough for a slow tool call and short enough to recover a
// customer-facing chat without reinstalling the desktop app.
const PENDING_REQUEST_TTL_MS = 10 * 60 * 1_000;
const FALLBACK_LOCK_TTL_MS = 30_000;
const FALLBACK_LOCK_SETTLE_MS = 40;
const FALLBACK_LOCK_HEARTBEAT_MS = 5_000;

type AssistantTurnIdentity = {
  id: string;
  input: string;
};

export class PendingAssistantRequestConflictError extends Error {
  constructor() {
    super('上次消息的发送结果尚未确认，请先重试上次消息');
    this.name = 'PendingAssistantRequestConflictError';
  }
}

export class PendingAssistantContextChangedError extends Error {
  constructor() {
    super('当前客户或页面上下文已变化，请回到原会话后重试上次消息');
    this.name = 'PendingAssistantContextChangedError';
  }
}

export class AssistantCrossTabLockUnavailableError extends Error {
  constructor() {
    super('当前浏览器无法建立安全的跨窗口任务锁，已停止执行；请检查本地存储权限后重试');
    this.name = 'AssistantCrossTabLockUnavailableError';
  }
}

export class AssistantCrossTabLockBusyError extends Error {
  constructor() {
    super('另一个窗口正在提交业务助理任务，请等待完成后再试');
    this.name = 'AssistantCrossTabLockBusyError';
  }
}

export class AssistantOutboxStorageUnavailableError extends Error {
  constructor() {
    super('浏览器无法安全保存待发送消息，已停止执行；请检查本地存储权限后重试');
    this.name = 'AssistantOutboxStorageUnavailableError';
  }
}

export function assistantPendingStorageKey(
  surface: 'workbench' | 'orb',
  companyId: string,
  threadId: string,
) {
  // Both UI surfaces share one server-side thread. A surface-specific key
  // would allow the same uncertain business action to be sent twice with two
  // requestIds before either response is reconciled.
  void surface;
  return `vaysen_assistant_pending_v1:${companyId}:${threadId}`;
}

function assistantCompletedStorageKey(storageKey: string) {
  return `${storageKey}:completed`;
}

function assistantLockName(storageKey: string) {
  return `vaysen-assistant-submit:${assistantRequestContextFingerprint({
    companyId: storageKey,
    threadId: storageKey,
  })}`;
}

function assistantFallbackLockKey(storageKey: string) {
  return `${assistantLockName(storageKey)}:lease:v1`;
}

type AssistantFallbackLease = {
  owner: string;
  expiresAt: number;
};

function parseAssistantFallbackLease(raw: string | null): AssistantFallbackLease | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<AssistantFallbackLease>;
    if (
      typeof value.owner !== 'string' ||
      !value.owner ||
      typeof value.expiresAt !== 'number' ||
      !Number.isFinite(value.expiresAt)
    ) {
      return null;
    }
    return { owner: value.owner, expiresAt: value.expiresAt };
  } catch {
    return null;
  }
}

function createFallbackLockOwner() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function waitForFallbackLockSettlement() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, FALLBACK_LOCK_SETTLE_MS);
  });
}

async function withAssistantFallbackLease<T>(
  storageKey: string,
  task: () => Promise<T>,
): Promise<T> {
  if (typeof window === 'undefined' || !window.localStorage) {
    throw new AssistantCrossTabLockUnavailableError();
  }

  const lockKey = assistantFallbackLockKey(storageKey);
  const owner = createFallbackLockOwner();
  const writeLease = () => {
    window.localStorage.setItem(
      lockKey,
      JSON.stringify({ owner, expiresAt: Date.now() + FALLBACK_LOCK_TTL_MS }),
    );
  };
  const readLease = () => parseAssistantFallbackLease(window.localStorage.getItem(lockKey));

  try {
    const existing = readLease();
    if (existing && existing.expiresAt > Date.now() && existing.owner !== owner) {
      throw new AssistantCrossTabLockBusyError();
    }
    writeLease();
    // localStorage has no compare-and-swap. Waiting one short turn and then
    // verifying ownership makes simultaneously competing tabs converge on a
    // single winner before any network request is reserved. The backend still
    // enforces requestId idempotency as the final duplicate-execution guard.
    await waitForFallbackLockSettlement();
    if (readLease()?.owner !== owner) throw new AssistantCrossTabLockBusyError();
  } catch (error) {
    if (error instanceof AssistantCrossTabLockBusyError) throw error;
    throw new AssistantCrossTabLockUnavailableError();
  }

  const heartbeat = window.setInterval(() => {
    try {
      if (readLease()?.owner === owner) writeLease();
    } catch (error) {
      void error;
      // The pending-request outbox plus backend requestId remains the final
      // safety boundary. A storage failure must not clear another tab's lock.
    }
  }, FALLBACK_LOCK_HEARTBEAT_MS);

  try {
    return await task();
  } finally {
    window.clearInterval(heartbeat);
    try {
      if (readLease()?.owner === owner) window.localStorage.removeItem(lockKey);
    } catch (error) {
      void error;
      // An expired lease is recoverable on the next attempt.
    }
  }
}

export function assistantThreadIdFor(companyId?: string, userId?: string) {
  const fingerprint = assistantRequestContextFingerprint({
    companyId: companyId || 'no-company',
    threadId: userId || 'default-user',
  });
  return `crm:${fingerprint}`;
}

/**
 * Non-secret browser fingerprint used only to detect accidental customer
 * switches without persisting the raw WhatsApp context. Cosmetic route/name
 * changes are deliberately excluded so a renamed customer cannot strand a
 * recoverable request. The backend
 * independently binds requestId to the authenticated company, operator,
 * thread, message and WhatsApp context.
 */
export function assistantRequestContextFingerprint(value: {
  companyId: string;
  threadId: string;
  pathname?: string;
  whatsapp?: {
    name: string;
    phone: string;
    conversationId?: string;
    leadId?: string;
    isGroup?: boolean;
  };
}) {
  const whatsapp = value.whatsapp;
  const canonical = JSON.stringify({
    companyId: value.companyId,
    threadId: value.threadId,
    whatsapp: whatsapp
      ? {
          phone: whatsapp.phone.replace(/\D/g, ''),
          conversationId: whatsapp.conversationId || '',
          leadId: whatsapp.leadId || '',
          isGroup: whatsapp.isGroup === true,
        }
      : null,
  });
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < canonical.length; index += 1) {
    const code = canonical.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

function isPendingAssistantRequest(value: unknown): value is PendingAssistantRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<PendingAssistantRequest>;
  return (
    typeof candidate.text === 'string' &&
    candidate.text.trim().length > 0 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      candidate.requestId || '',
    ) &&
    Array.isArray(candidate.knownTurnIds) &&
    candidate.knownTurnIds.every((id) => typeof id === 'string' && id.length > 0) &&
    typeof candidate.historyBaselineReady === 'boolean' &&
    /^[0-9a-f]{16}$/.test(candidate.contextFingerprint || '') &&
    Number.isFinite(candidate.createdAt) &&
    (candidate.createdAt || 0) > 0 &&
    Object.keys(candidate).every((key) =>
      [
        'text',
        'requestId',
        'knownTurnIds',
        'historyBaselineReady',
        'contextFingerprint',
        'createdAt',
      ].includes(key),
    )
  );
}

function isCompletedAssistantRequest(value: unknown): value is CompletedAssistantRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<CompletedAssistantRequest>;
  return (
    typeof candidate.requestId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      candidate.requestId,
    ) &&
    typeof candidate.textDigest === 'string' &&
    /^[0-9a-f]{16}$/.test(candidate.textDigest) &&
    typeof candidate.contextFingerprint === 'string' &&
    /^[0-9a-f]{16}$/.test(candidate.contextFingerprint) &&
    Number.isFinite(candidate.completedAt) &&
    (candidate.completedAt || 0) > 0 &&
    Object.keys(candidate).every((key) =>
      ['requestId', 'textDigest', 'contextFingerprint', 'completedAt'].includes(key),
    )
  );
}

function parsePendingAssistantRequest(
  raw: string | null,
  now = Date.now(),
): PendingAssistantRequest | null {
  if (!raw) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!isPendingAssistantRequest(parsed)) return null;
  if (now < parsed.createdAt - 5 * 60_000 || now - parsed.createdAt > PENDING_REQUEST_TTL_MS) {
    return null;
  }
  return parsed;
}

export function readPendingAssistantRequest(storageKey: string): PendingAssistantRequest | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = parsePendingAssistantRequest(raw);
    if (parsed) return parsed;
    window.localStorage.removeItem(storageKey);
    return null;
  } catch (storageError: unknown) {
    void storageError;
    try {
      window.localStorage.removeItem(storageKey);
    } catch (cleanupError: unknown) {
      // Ignore a completely unavailable storage implementation.
      void cleanupError;
    }
    return null;
  }
}

/**
 * Reconcile a browser outbox entry with the authoritative server history.
 * A matching turn that was not part of the request's original baseline is the
 * durable response for that request, so the local uncertainty lock can be
 * completed automatically. This also repairs the common Electron case where
 * the HTTP response committed on the server but the renderer closed before it
 * could clear localStorage.
 */
export function reconcilePendingAssistantRequest(
  storageKey: string,
  turns: readonly AssistantTurnIdentity[],
): PendingAssistantRequest | null {
  const pending = readPendingAssistantRequest(storageKey);
  if (!pending) return null;
  const knownTurnIds = new Set(pending.knownTurnIds);
  const durableTurn = turns.find(
    (turn) => !knownTurnIds.has(turn.id) && turn.input === pending.text,
  );
  if (!durableTurn) return pending;
  markAssistantRequestCompleted(storageKey, pending);
  return null;
}

export function writePendingAssistantRequest(storageKey: string, pending: PendingAssistantRequest) {
  if (typeof window === 'undefined') throw new AssistantOutboxStorageUnavailableError();
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(pending));
  } catch (storageError: unknown) {
    void storageError;
    throw new AssistantOutboxStorageUnavailableError();
  }
}

export function clearPendingAssistantRequest(storageKey: string, expectedRequestId?: string) {
  if (typeof window === 'undefined') return;
  try {
    if (expectedRequestId) {
      const active = readPendingAssistantRequest(storageKey);
      if (active && active.requestId !== expectedRequestId) return;
    }
    window.localStorage.removeItem(storageKey);
  } catch (storageError: unknown) {
    // A blocked storage API must not turn a successful request into an error.
    void storageError;
  }
}

export function readRecentlyCompletedAssistantRequest(
  storageKey: string,
  now = Date.now(),
): CompletedAssistantRequest | null {
  if (typeof window === 'undefined') return null;
  const completedKey = assistantCompletedStorageKey(storageKey);
  try {
    const raw = window.localStorage.getItem(completedKey);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      !isCompletedAssistantRequest(parsed) ||
      now - parsed.completedAt > RECENT_COMPLETION_TTL_MS
    ) {
      window.localStorage.removeItem(completedKey);
      return null;
    }
    return parsed;
  } catch (storageError: unknown) {
    void storageError;
    try {
      window.localStorage.removeItem(completedKey);
    } catch (cleanupError: unknown) {
      void cleanupError;
    }
    return null;
  }
}

export function markAssistantRequestCompleted(
  storageKey: string,
  request: PendingAssistantRequest,
  completedAt = Date.now(),
) {
  if (typeof window === 'undefined') throw new AssistantOutboxStorageUnavailableError();
  try {
    window.localStorage.setItem(
      assistantCompletedStorageKey(storageKey),
      JSON.stringify({
        requestId: request.requestId,
        textDigest: assistantTextDigest(request.text),
        contextFingerprint: request.contextFingerprint,
        completedAt,
      }),
    );
  } catch (storageError: unknown) {
    void storageError;
    // Keep the pending request intact. A retry will reuse the same requestId
    // and is safer than losing the idempotency key after a server response.
    throw new AssistantOutboxStorageUnavailableError();
  }
  clearPendingAssistantRequest(storageKey, request.requestId);
}

/**
 * Serialize one assistant thread across browser tabs and the two UI entry
 * points. Chromium/Electron secure contexts use Web Locks. LAN HTTP pages do
 * not expose that API, so they use a verified, expiring localStorage lease;
 * the pending outbox and backend requestId idempotency remain the final guard.
 */
export async function withAssistantRequestLock<T>(
  storageKey: string,
  task: () => Promise<T>,
): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request(assistantLockName(storageKey), { mode: 'exclusive' }, task);
  }
  return withAssistantFallbackLease(storageKey, task);
}

export function subscribePendingAssistantRequest(
  storageKey: string,
  listener: (
    request: PendingAssistantRequest | null,
    previous: PendingAssistantRequest | null,
  ) => void,
) {
  if (typeof window === 'undefined') return () => undefined;
  const onStorage = (event: StorageEvent) => {
    // Some hardened/embedded browsers omit storageArea while still emitting a
    // standards-compatible storage event. The key remains the authoritative
    // namespace boundary; reject only an explicitly different storage area.
    if ((event.storageArea && event.storageArea !== window.localStorage) || event.key !== storageKey) return;
    let previous: PendingAssistantRequest | null = null;
    try {
      previous = parsePendingAssistantRequest(event.oldValue);
    } catch {
      previous = null;
    }
    listener(readPendingAssistantRequest(storageKey), previous);
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}

export function reserveStoredAssistantRequest(
  storageKey: string,
  text: string,
  turns: readonly AssistantTurnIdentity[],
  historyBaselineReady: boolean,
  contextFingerprint: string,
): PendingAssistantRequest {
  const normalizedText = text;
  const active = readPendingAssistantRequest(storageKey);
  const recent = readRecentlyCompletedAssistantRequest(storageKey);
  if (!active && recent?.textDigest === assistantTextDigest(normalizedText)) {
    if (recent.contextFingerprint !== contextFingerprint) {
      throw new PendingAssistantContextChangedError();
    }
    const recovered = {
      text: normalizedText,
      requestId: recent.requestId,
      knownTurnIds: turns.map((turn) => turn.id),
      historyBaselineReady,
      contextFingerprint,
      createdAt: Date.now(),
    };
    writePendingAssistantRequest(storageKey, recovered);
    return recovered;
  }
  const request = reserveAssistantRequest(
    normalizedText,
    turns,
    historyBaselineReady,
    contextFingerprint,
    active,
  );
  writePendingAssistantRequest(storageKey, request);
  return request;
}

/**
 * Reserve one idempotency key for a user message. A transport failure must
 * reuse this exact request instead of creating a second server-side action.
 */
export function reserveAssistantRequest(
  text: string,
  turns: readonly AssistantTurnIdentity[],
  historyBaselineReady: boolean,
  contextFingerprint: string,
  pending: PendingAssistantRequest | null,
): PendingAssistantRequest {
  const normalizedText = text;
  if (!normalizedText.trim()) throw new Error('消息不能为空');
  if (pending) {
    if (pending.text !== normalizedText) throw new PendingAssistantRequestConflictError();
    if (pending.contextFingerprint !== contextFingerprint) {
      throw new PendingAssistantContextChangedError();
    }
    return pending;
  }
  return {
    text: normalizedText,
    // Derive the UUID from the exact pre-send baseline. Two tabs/windows that
    // race with the same company, thread, message and history therefore reach
    // the same backend idempotency key. Once a new history turn is visible,
    // the baseline changes and the user can intentionally repeat the command.
    requestId: deterministicRequestUuid(
      JSON.stringify({
        text: normalizedText,
        knownTurnIds: turns.map((turn) => turn.id).sort(),
        historyBaselineReady,
        contextFingerprint,
      }),
    ),
    knownTurnIds: turns.map((turn) => turn.id),
    historyBaselineReady,
    contextFingerprint,
    createdAt: Date.now(),
  };
}

function assistantTextDigest(value: string) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

function deterministicRequestUuid(value: string): string {
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  const words = seeds.map((seed, wordIndex) => {
    let hash = seed >>> 0;
    for (let index = 0; index < value.length; index += 1) {
      hash = Math.imul(hash ^ (value.charCodeAt(index) + wordIndex * 131), 0x01000193) >>> 0;
      hash = (hash ^ (hash >>> 13)) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  });
  const hex = words.join('').split('');
  hex[12] = '4';
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const normalized = hex.join('');
  return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20)}`;
}
