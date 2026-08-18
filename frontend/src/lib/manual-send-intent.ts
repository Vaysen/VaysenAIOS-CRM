import { createClientUuid } from './client-id';

const CANONICAL_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/;
const RETRYABLE_OR_AMBIGUOUS_CLIENT_STATUSES = new Set([408, 409, 425, 429]);
const IDEMPOTENCY_PAYLOAD_CONFLICT_CODE = 'EMAIL_IDEMPOTENCY_PAYLOAD_CONFLICT';
const IDEMPOTENCY_PAYLOAD_CONFLICT_MESSAGE =
  'Idempotency-Key was already used with a different email request';
const LEDGER_STORAGE_KEY = 'vaysen:manual-send-intents:v1';
const LEDGER_LOCK_KEY = `${LEDGER_STORAGE_KEY}:lease`;
const DEFAULT_INTENT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LEDGER_LOCK_TTL_MS = 2_000;
const DEFAULT_LEDGER_LOCK_WAIT_MS = 3_000;
const DEFAULT_LEDGER_LOCK_SETTLE_MS = 25;
const DEFAULT_DISPATCH_LEASE_MS = 2 * 60 * 1000;
const MAX_INTENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RECORD_LIFETIME_MS = 2 * MAX_INTENT_TTL_MS;
const MAX_LEDGER_RECORDS = 256;
const MAX_LEDGER_RECOVERY_RECORDS = 2 * MAX_LEDGER_RECORDS;
const MAX_LEDGER_SERIALIZED_CHARS = 512 * 1024;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const CANONICAL_SCOPE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const CANONICAL_OWNER = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ManualSendOutcome = 'success' | 'business-rejection' | 'unknown';
type ManualSendIntentState = 'ready' | 'inflight' | 'completed';

export type ManualSendContext = {
  userId: string | null | undefined;
  activeCompanyId: string | null | undefined;
};

type IntentRecord = {
  version: 1;
  scope: string;
  contextDigest: string;
  payloadDigest: string;
  key: string;
  state: ManualSendIntentState;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  completedAt?: number;
  dispatchOwner?: string;
  dispatchLeaseExpiresAt?: number;
};

type IntentLedger = {
  version: 1;
  intents: IntentRecord[];
};

export interface ManualSendIntentTracker {
  keyFor(payload: unknown): Promise<string>;
  claim(key: string): Promise<string>;
  withClaimLease?<T>(
    key: string,
    claimOwner: string,
    task: () => Promise<T>,
  ): Promise<T>;
  settle(key: string, outcome: ManualSendOutcome, claimOwner: string): Promise<void>;
}

export type ManualSendIntentOptions = {
  storage?: Storage;
  now?: () => number;
  createUuid?: () => string;
  ttlMs?: number;
  lockTtlMs?: number;
  lockWaitMs?: number;
  lockSettleMs?: number;
  dispatchLeaseMs?: number;
};

type LedgerLease = {
  owner: string;
  expiresAt: number;
};

export class ManualSendIntentBusyError extends Error {
  constructor() {
    super('This send intent is already being submitted in another window');
    this.name = 'ManualSendIntentBusyError';
  }
}

export class ManualSendSettlementUnknownError extends Error {
  readonly settlementCause: unknown;

  constructor(settlementCause: unknown) {
    super('The send result could not be durably settled; replay the same intent');
    this.name = 'ManualSendSettlementUnknownError';
    this.settlementCause = settlementCause;
  }
}

export class ManualSendOwnershipLostError extends Error {
  readonly ownershipCause?: unknown;

  constructor(message: string, ownershipCause?: unknown) {
    super(message);
    this.name = 'ManualSendOwnershipLostError';
    this.ownershipCause = ownershipCause;
  }
}

function canonicalJson(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.keys(item)
        .sort()
        .reduce<Record<string, unknown>>((sorted, key) => {
          const nested = (item as Record<string, unknown>)[key];
          if (nested !== undefined) sorted[key] = nested;
          return sorted;
        }, {});
    }
    return item;
  });
  if (canonical === undefined) {
    throw new Error('A manual send intent requires a JSON request payload');
  }
  return canonical;
}

async function sha256(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Durable idempotency hashing is unavailable');
  }
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function browserStorage(explicit?: Storage): Storage {
  if (explicit) return explicit;
  if (typeof window === 'undefined' || !window.localStorage) {
    throw new Error('Durable idempotency storage is unavailable');
  }
  return window.localStorage;
}

function corruptLedger(): never {
  throw new Error('Durable idempotency ledger is corrupt');
}

function parseLedger(raw: string | null, timestamp: number): IntentLedger {
  if (!raw) return { version: 1, intents: [] };
  if (raw.length > MAX_LEDGER_SERIALIZED_CHARS) return corruptLedger();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return corruptLedger();
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || (parsed as any).version !== 1
    || !Array.isArray((parsed as any).intents)
    || Object.keys(parsed as Record<string, unknown>)
      .some((key) => !['version', 'intents'].includes(key))
  ) {
    return corruptLedger();
  }
  const intents = (parsed as any).intents as unknown[];
  // A bounded overflow is accepted only so keyFor can validate every record
  // and recover a ledger produced by the prior off-by-one bug by removing
  // expired rows. Arbitrarily large storage remains fail-closed.
  if (intents.length > MAX_LEDGER_RECOVERY_RECORDS) return corruptLedger();

  const identities = new Set<string>();
  const keys = new Set<string>();
  for (const value of intents) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return corruptLedger();
    const intent = value as Partial<IntentRecord>;
    const allowedFields = [
      'version',
      'scope',
      'contextDigest',
      'payloadDigest',
      'key',
      'state',
      'createdAt',
      'updatedAt',
      'expiresAt',
      'completedAt',
      'dispatchOwner',
      'dispatchLeaseExpiresAt',
    ];
    if (Object.keys(intent).some((key) => !allowedFields.includes(key))) {
      return corruptLedger();
    }
    if (
      intent.version !== 1
      || typeof intent.scope !== 'string'
      || !CANONICAL_SCOPE.test(intent.scope)
      || typeof intent.contextDigest !== 'string'
      || !SHA256_HEX.test(intent.contextDigest)
      || typeof intent.payloadDigest !== 'string'
      || !SHA256_HEX.test(intent.payloadDigest)
      || typeof intent.key !== 'string'
      || !CANONICAL_IDEMPOTENCY_KEY.test(intent.key)
      || !intent.key.startsWith(`${intent.scope}:`)
      || !['ready', 'inflight', 'completed'].includes(intent.state || '')
      || typeof intent.createdAt !== 'number'
      || !Number.isSafeInteger(intent.createdAt)
      || intent.createdAt <= 0
      || typeof intent.updatedAt !== 'number'
      || !Number.isSafeInteger(intent.updatedAt)
      || typeof intent.expiresAt !== 'number'
      || !Number.isSafeInteger(intent.expiresAt)
      || intent.createdAt > intent.updatedAt
      || intent.updatedAt > intent.expiresAt
      || intent.expiresAt - intent.createdAt > MAX_RECORD_LIFETIME_MS
      || intent.createdAt > timestamp + MAX_FUTURE_CLOCK_SKEW_MS
      || intent.updatedAt > timestamp + MAX_FUTURE_CLOCK_SKEW_MS
    ) {
      return corruptLedger();
    }
    const hasDispatchOwner = intent.dispatchOwner !== undefined;
    const hasDispatchExpiry = intent.dispatchLeaseExpiresAt !== undefined;
    const hasCompletedAt = intent.completedAt !== undefined;
    if (
      hasDispatchOwner !== hasDispatchExpiry
      || (
        hasDispatchOwner
        && (
          typeof intent.dispatchOwner !== 'string'
          || !CANONICAL_OWNER.test(intent.dispatchOwner)
          || typeof intent.dispatchLeaseExpiresAt !== 'number'
          || !Number.isSafeInteger(intent.dispatchLeaseExpiresAt)
          || intent.dispatchLeaseExpiresAt < intent.updatedAt
          || intent.dispatchLeaseExpiresAt > intent.expiresAt
        )
      )
      || (
        intent.state === 'ready'
        && (
          hasDispatchOwner
          || hasCompletedAt
          || intent.expiresAt - intent.createdAt > MAX_INTENT_TTL_MS
        )
      )
      || (
        intent.state === 'inflight'
        && (
          !hasDispatchOwner
          || hasCompletedAt
          || intent.expiresAt - intent.createdAt > MAX_INTENT_TTL_MS
        )
      )
      || (
        intent.state === 'completed'
        && (
          !hasCompletedAt
          || typeof intent.completedAt !== 'number'
          || !Number.isSafeInteger(intent.completedAt)
          || intent.completedAt < intent.createdAt
          || intent.completedAt > intent.updatedAt
          || (!hasDispatchOwner && intent.completedAt !== intent.updatedAt)
          || intent.expiresAt - intent.completedAt > MAX_INTENT_TTL_MS
        )
      )
    ) {
      return corruptLedger();
    }
    const identity = `${intent.scope}:${intent.contextDigest}:${intent.payloadDigest}`;
    if (identities.has(identity) || keys.has(intent.key)) return corruptLedger();
    identities.add(identity);
    keys.add(intent.key);
  }
  return { version: 1, intents: intents as IntentRecord[] };
}

function persistLedger(storage: Storage, ledger: IntentLedger) {
  if (ledger.intents.length > MAX_LEDGER_RECORDS) {
    throw new Error('Durable idempotency ledger capacity is exhausted');
  }
  const serialized = JSON.stringify(ledger);
  storage.setItem(LEDGER_STORAGE_KEY, serialized);
  if (storage.getItem(LEDGER_STORAGE_KEY) !== serialized) {
    throw new Error('Durable idempotency ledger could not be verified');
  }
}

function parseLedgerLease(raw: string | null): LedgerLease | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Durable idempotency lock is corrupt');
  }
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || typeof (value as any).owner !== 'string'
    || !CANONICAL_OWNER.test((value as any).owner)
    || typeof (value as any).expiresAt !== 'number'
    || !Number.isSafeInteger((value as any).expiresAt)
    || Object.keys(value as Record<string, unknown>)
      .some((key) => !['owner', 'expiresAt'].includes(key))
  ) {
    throw new Error('Durable idempotency lock is corrupt');
  }
  return value as LedgerLease;
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, milliseconds);
  });
}

function ledgerOwnershipLost(): ManualSendOwnershipLostError {
  return new ManualSendOwnershipLostError(
    'Durable idempotency lock ownership was lost',
  );
}

function writeVerifiedLedgerLease(
  storage: Storage,
  lease: LedgerLease,
): void {
  const serialized = JSON.stringify(lease);
  storage.setItem(LEDGER_LOCK_KEY, serialized);
  if (storage.getItem(LEDGER_LOCK_KEY) !== serialized) {
    throw new Error('Durable idempotency lock could not be verified');
  }
}

async function withFallbackLedgerLease<T>(
  storage: Storage,
  task: () => Promise<T>,
  createOwner: () => string,
  options: {
    lockTtlMs: number;
    lockWaitMs: number;
    lockSettleMs: number;
  },
): Promise<T> {
  const owner = createOwner();
  const deadline = Date.now() + options.lockWaitMs;

  for (;;) {
    let acquired = false;
    try {
      const current = parseLedgerLease(storage.getItem(LEDGER_LOCK_KEY));
      const currentTime = Date.now();
      if (!current || current.expiresAt <= currentTime) {
        const lease: LedgerLease = {
          owner,
          expiresAt: currentTime + options.lockTtlMs,
        };
        writeVerifiedLedgerLease(storage, lease);
        await wait(options.lockSettleMs);
        const verified = parseLedgerLease(storage.getItem(LEDGER_LOCK_KEY));
        acquired = verified?.owner === owner && verified.expiresAt === lease.expiresAt;
      }
    } catch (error) {
      throw error instanceof Error
        ? error
        : new Error('Durable idempotency lock is unavailable');
    }

    if (acquired) break;
    if (Date.now() >= deadline) {
      throw new ManualSendIntentBusyError();
    }
    await wait(Math.max(1, options.lockSettleMs));
  }

  const renewLease = (allowExpired: boolean) => {
    const currentTime = Date.now();
    const current = parseLedgerLease(storage.getItem(LEDGER_LOCK_KEY));
    if (
      current?.owner !== owner
      || (!allowExpired && current.expiresAt <= currentTime)
    ) {
      throw ledgerOwnershipLost();
    }
    const renewed: LedgerLease = {
      owner,
      expiresAt: currentTime + options.lockTtlMs,
    };
    // localStorage has no compare-and-swap primitive. Rewriting and immediately
    // reading the exact owner/expiry is the narrowest verified renewal boundary.
    writeVerifiedLedgerLease(storage, renewed);
  };

  // The acquisition settle delay consumes lease time. Refresh immediately at
  // the execution boundary, while the verified owner is still the stored owner.
  renewLease(true);

  let heartbeatError: unknown;
  const heartbeatIntervalMs = Math.max(
    1,
    Math.min(1_000, Math.floor(options.lockTtlMs / 3)),
  );
  const heartbeatDeadline = Date.now() + options.lockWaitMs;
  const heartbeat = globalThis.setInterval(() => {
    if (heartbeatError !== undefined) return;
    try {
      if (Date.now() >= heartbeatDeadline) throw ledgerOwnershipLost();
      renewLease(false);
    } catch (error) {
      heartbeatError = error;
      globalThis.clearInterval(heartbeat);
    }
  }, heartbeatIntervalMs);

  let result: T;
  let taskError: unknown;
  try {
    result = await task();
  } catch (error) {
    taskError = error;
  } finally {
    globalThis.clearInterval(heartbeat);
  }

  try {
    if (heartbeatError !== undefined) throw heartbeatError;
    const finalLease = parseLedgerLease(storage.getItem(LEDGER_LOCK_KEY));
    if (finalLease?.owner !== owner || finalLease.expiresAt <= Date.now()) {
      throw ledgerOwnershipLost();
    }
    storage.removeItem(LEDGER_LOCK_KEY);
    if (storage.getItem(LEDGER_LOCK_KEY) !== null) {
      throw new Error('Durable idempotency lock release could not be verified');
    }
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error('Durable idempotency lock is unavailable');
  }
  if (taskError) throw taskError;
  return result!;
}

async function withLedgerMutation<T>(
  storage: Storage,
  task: () => Promise<T>,
  createOwner: () => string,
  options: {
    lockTtlMs: number;
    lockWaitMs: number;
    lockSettleMs: number;
  },
): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks?.request) {
    return locks.request(LEDGER_STORAGE_KEY, { mode: 'exclusive' }, task);
  }
  return withFallbackLedgerLease(storage, task, createOwner, options);
}

function validContext(context: ManualSendContext) {
  const userId = String(context.userId || '').trim();
  const activeCompanyId = String(context.activeCompanyId || '').trim();
  if (!userId || !activeCompanyId) {
    throw new Error('An authenticated user and active company are required for durable sending');
  }
  return { userId, activeCompanyId };
}

/**
 * Stores only opaque hashes, a random idempotency key, scope and timestamps.
 * The request payload, recipient, subject/body and raw user/company identifiers
 * are never persisted in renderer storage.
 */
export function createManualSendIntentTracker(
  scope: string,
  context: ManualSendContext,
  options: ManualSendIntentOptions = {},
): ManualSendIntentTracker {
  const now = options.now || Date.now;
  const createUuid = options.createUuid || createClientUuid;
  const ttlMs = options.ttlMs ?? DEFAULT_INTENT_TTL_MS;
  const lockOptions = {
    lockTtlMs: options.lockTtlMs ?? DEFAULT_LEDGER_LOCK_TTL_MS,
    lockWaitMs: options.lockWaitMs ?? DEFAULT_LEDGER_LOCK_WAIT_MS,
    lockSettleMs: options.lockSettleMs ?? DEFAULT_LEDGER_LOCK_SETTLE_MS,
  };
  const dispatchLeaseMs = options.dispatchLeaseMs
    ?? Math.min(DEFAULT_DISPATCH_LEASE_MS, ttlMs);
  const dispatchHeartbeatMs = Math.max(
    1,
    Math.min(1_000, Math.floor(dispatchLeaseMs / 3)),
  );
  if (
    !CANONICAL_SCOPE.test(scope)
    || !Number.isSafeInteger(ttlMs)
    || ttlMs <= 0
    || ttlMs > MAX_INTENT_TTL_MS
    || !Number.isSafeInteger(dispatchLeaseMs)
    || dispatchLeaseMs <= 0
    || dispatchLeaseMs > ttlMs
    || Object.values(lockOptions).some((value) => !Number.isSafeInteger(value) || value <= 0)
    || lockOptions.lockWaitMs < lockOptions.lockSettleMs
  ) {
    throw new Error('Manual send intent configuration is invalid');
  }

  return {
    async keyFor(payload) {
      const identity = validContext(context);
      const storage = browserStorage(options.storage);
      const [contextDigest, payloadDigest] = await Promise.all([
        sha256(canonicalJson(identity)),
        sha256(canonicalJson(payload)),
      ]);
      // Validate the persisted ledger before entering the fallback lease. A
      // corrupt ledger must win over a lease timeout/ownership error and must
      // fail closed before any caller can reach HTTP.
      parseLedger(storage.getItem(LEDGER_STORAGE_KEY), now());
      return withLedgerMutation(storage, async () => {
        const timestamp = now();
        const ledger = parseLedger(storage.getItem(LEDGER_STORAGE_KEY), timestamp);
        const active = ledger.intents.filter((intent) => intent.expiresAt > timestamp);
        const existing = active.find((intent) => (
          intent.scope === scope
          && intent.contextDigest === contextDigest
          && intent.payloadDigest === payloadDigest
        ));
        if (active.length > MAX_LEDGER_RECORDS) {
          throw new Error('Durable idempotency ledger capacity is exhausted');
        }
        if (existing) {
          if (active.length !== ledger.intents.length) {
            persistLedger(storage, { version: 1, intents: active });
          }
          return existing.key;
        }
        if (active.length === MAX_LEDGER_RECORDS) {
          // Do not rewrite even expired cleanup when the active ledger remains
          // full; capacity rejection must be side-effect free.
          throw new Error('Durable idempotency ledger capacity is exhausted');
        }

        const key = `${scope}:${createUuid()}`;
        if (!CANONICAL_IDEMPOTENCY_KEY.test(key)) {
          throw new Error('Unable to create a canonical Idempotency-Key');
        }
        if (active.some((intent) => intent.key === key)) {
          throw new Error('Idempotency-Key generator returned a duplicate key');
        }
        const created: IntentRecord = {
          version: 1,
          scope,
          contextDigest,
          payloadDigest,
          key,
          state: 'ready',
          createdAt: timestamp,
          updatedAt: timestamp,
          expiresAt: timestamp + ttlMs,
        };
        persistLedger(storage, { version: 1, intents: [...active, created] });
        return key;
      }, createUuid, lockOptions);
    },

    async claim(key) {
      const storage = browserStorage(options.storage);
      return withLedgerMutation(storage, async () => {
        const timestamp = now();
        const ledger = parseLedger(storage.getItem(LEDGER_STORAGE_KEY), timestamp);
        const intent = ledger.intents.find((candidate) => candidate.key === key);
        if (!intent || intent.expiresAt <= timestamp) {
          throw new Error('The durable send intent is missing or expired');
        }
        if (
          intent.dispatchOwner
          && intent.dispatchLeaseExpiresAt
          && intent.dispatchLeaseExpiresAt > timestamp
        ) {
          throw new ManualSendIntentBusyError();
        }
        const owner = createUuid();
        if (intent.state === 'ready') intent.state = 'inflight';
        intent.dispatchOwner = owner;
        intent.updatedAt = timestamp;
        intent.dispatchLeaseExpiresAt = Math.min(
          timestamp + dispatchLeaseMs,
          intent.expiresAt,
        );
        if (intent.dispatchLeaseExpiresAt <= timestamp) {
          throw new Error('The durable send intent is too close to expiry');
        }
        persistLedger(storage, ledger);
        const verified = parseLedger(storage.getItem(LEDGER_STORAGE_KEY), timestamp)
          .intents.find((candidate) => candidate.key === key);
        if (
          verified?.dispatchOwner !== owner
          || verified.dispatchLeaseExpiresAt !== intent.dispatchLeaseExpiresAt
        ) {
          throw new Error('Durable dispatch ownership could not be verified');
        }
        return owner;
      }, createUuid, lockOptions);
    },

    async withClaimLease<T>(key: string, claimOwner: string, task: () => Promise<T>) {
      const storage = browserStorage(options.storage);
      const assertOwnership = () => {
        const timestamp = now();
        const intent = parseLedger(storage.getItem(LEDGER_STORAGE_KEY), timestamp)
          .intents.find((candidate) => candidate.key === key);
        if (
          !intent
          || intent.dispatchOwner !== claimOwner
          || !intent.dispatchLeaseExpiresAt
          || intent.dispatchLeaseExpiresAt <= timestamp
        ) {
          throw new ManualSendOwnershipLostError(
            'Durable dispatch ownership was lost',
          );
        }
      };
      const renewOwnership = async () => {
        try {
          await withLedgerMutation(storage, async () => {
            const timestamp = now();
            const ledger = parseLedger(storage.getItem(LEDGER_STORAGE_KEY), timestamp);
            const intent = ledger.intents.find((candidate) => candidate.key === key);
            if (
              !intent
              || intent.dispatchOwner !== claimOwner
              || !intent.dispatchLeaseExpiresAt
              || intent.dispatchLeaseExpiresAt <= timestamp
              || intent.expiresAt <= timestamp
            ) {
              throw new ManualSendOwnershipLostError(
                'Durable dispatch ownership was lost',
              );
            }
            intent.updatedAt = timestamp;
            intent.dispatchLeaseExpiresAt = Math.min(
              timestamp + dispatchLeaseMs,
              intent.expiresAt,
            );
            persistLedger(storage, ledger);
            const verified = parseLedger(storage.getItem(LEDGER_STORAGE_KEY), timestamp)
              .intents.find((candidate) => candidate.key === key);
            if (
              verified?.dispatchOwner !== claimOwner
              || verified.dispatchLeaseExpiresAt !== intent.dispatchLeaseExpiresAt
            ) {
              throw new ManualSendOwnershipLostError(
                'Durable dispatch ownership could not be verified',
              );
            }
          }, createUuid, lockOptions);
        } catch (error) {
          if (error instanceof ManualSendOwnershipLostError) throw error;
          throw new ManualSendOwnershipLostError(
            'Durable dispatch ownership could not be maintained',
            error,
          );
        }
      };

      // Reconfirm synchronously at the HTTP boundary so an expired or replaced
      // claim fails before the callback can perform any external I/O.
      assertOwnership();

      let stopped = false;
      let heartbeatError: unknown;
      let heartbeatInFlight: Promise<void> | undefined;
      const heartbeat = globalThis.setInterval(() => {
        if (stopped || heartbeatError !== undefined || heartbeatInFlight) return;
        heartbeatInFlight = renewOwnership()
          .catch((error) => {
            heartbeatError = error;
            globalThis.clearInterval(heartbeat);
          })
          .finally(() => {
            heartbeatInFlight = undefined;
          });
      }, dispatchHeartbeatMs);

      let result: T;
      let taskError: unknown;
      try {
        result = await task();
      } catch (error) {
        taskError = error;
      } finally {
        stopped = true;
        globalThis.clearInterval(heartbeat);
        if (heartbeatInFlight) await heartbeatInFlight;
      }

      if (heartbeatError !== undefined) throw heartbeatError;
      assertOwnership();
      if (taskError !== undefined) throw taskError;
      return result!;
    },

    async settle(key, outcome, claimOwner) {
      const storage = browserStorage(options.storage);
      await withLedgerMutation(storage, async () => {
        const timestamp = now();
        const ledger = parseLedger(storage.getItem(LEDGER_STORAGE_KEY), timestamp);
        const intent = ledger.intents.find((candidate) => candidate.key === key);
        if (!intent) {
          throw new Error('The durable send intent disappeared before settlement');
        }
        if (
          !intent.dispatchOwner
          || intent.dispatchOwner !== claimOwner
        ) {
          throw new ManualSendIntentBusyError();
        }
        if (outcome === 'unknown') {
          delete intent.dispatchOwner;
          delete intent.dispatchLeaseExpiresAt;
          if (intent.state === 'completed' && intent.completedAt !== undefined) {
            intent.updatedAt = intent.completedAt;
          } else {
            intent.state = 'ready';
            intent.updatedAt = Math.min(timestamp, intent.expiresAt);
          }
          persistLedger(storage, ledger);
          return;
        }
        if (outcome === 'success') {
          if (intent.state === 'completed' && intent.completedAt !== undefined) {
            // A safe backend replay confirms the same action but must never
            // renew the original terminal tombstone lifetime.
            delete intent.dispatchOwner;
            delete intent.dispatchLeaseExpiresAt;
            intent.updatedAt = intent.completedAt;
            persistLedger(storage, ledger);
            return;
          }
          intent.state = 'completed';
          delete intent.dispatchOwner;
          delete intent.dispatchLeaseExpiresAt;
          intent.completedAt = timestamp;
          intent.updatedAt = timestamp;
          intent.expiresAt = timestamp + ttlMs;
          persistLedger(storage, ledger);
          return;
        }
        if (intent.state === 'completed' && intent.completedAt !== undefined) {
          // A later idempotent replay rejection cannot erase an already
          // durable success tombstone or permit a different-key resend.
          delete intent.dispatchOwner;
          delete intent.dispatchLeaseExpiresAt;
          intent.updatedAt = intent.completedAt;
          persistLedger(storage, ledger);
          return;
        }
        // A definite, non-retryable business rejection proves that no external
        // action was accepted. It is the only terminal outcome that removes
        // the mapping and permits an explicit later user action to get a new key.
        const intents = ledger.intents.filter((candidate) => candidate.key !== key);
        if (intents.length !== ledger.intents.length) {
          persistLedger(storage, { version: 1, intents });
        }
      }, createUuid, lockOptions);
    },
  };
}

function responseStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== 'object') return undefined;
  const status = (response as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function responseHasMessage(error: unknown, expected: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== 'object') return false;
  const data = (response as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return false;
  const message = (data as { message?: unknown }).message;
  if (typeof message === 'string') return message.trim() === expected;
  return Array.isArray(message) && message.some((item) => item === expected);
}

function responseCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== 'object') return undefined;
  const data = (response as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return undefined;
  const code = (data as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function manualSendFailureOutcome(error: unknown): ManualSendOutcome {
  const status = responseStatus(error);
  if (status === 409) {
    const code = responseCode(error);
    if (code === IDEMPOTENCY_PAYLOAD_CONFLICT_CODE) {
      return 'business-rejection';
    }
    if (code === undefined && responseHasMessage(error, IDEMPOTENCY_PAYLOAD_CONFLICT_MESSAGE)) {
      return 'business-rejection';
    }
  }
  if (
    status !== undefined
    && status >= 400
    && status < 500
    && !RETRYABLE_OR_AMBIGUOUS_CLIENT_STATUSES.has(status)
  ) {
    return 'business-rejection';
  }
  return 'unknown';
}

export async function runManualSendIntent<T>(
  tracker: ManualSendIntentTracker,
  payload: unknown,
  send: (idempotencyKey: string) => Promise<T>,
): Promise<T> {
  // Durable storage and hashing are completed before the caller can perform
  // HTTP/provider I/O. Any storage failure therefore fails closed.
  const key = await tracker.keyFor(payload);
  const claimOwner = await tracker.claim(key);
  let result: T;
  try {
    result = tracker.withClaimLease
      ? await tracker.withClaimLease(key, claimOwner, () => send(key))
      : await send(key);
  } catch (sendError) {
    if (sendError instanceof ManualSendOwnershipLostError) throw sendError;
    try {
      await tracker.settle(key, manualSendFailureOutcome(sendError), claimOwner);
    } catch (settlementError) {
      throw new ManualSendSettlementUnknownError(settlementError);
    }
    throw sendError;
  }

  try {
    await tracker.settle(key, 'success', claimOwner);
  } catch (settlementError) {
    // The HTTP request already succeeded. Never route a local persistence or
    // lock-release failure through send-error classification or settle twice.
    throw new ManualSendSettlementUnknownError(settlementError);
  }
  return result;
}
