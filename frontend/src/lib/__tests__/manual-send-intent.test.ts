import { webcrypto } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createManualSendIntentTracker,
  manualSendFailureOutcome,
  ManualSendIntentBusyError,
  ManualSendOwnershipLostError,
  ManualSendSettlementUnknownError,
  runManualSendIntent,
} from '../manual-send-intent';

const context = {
  userId: 'user-sensitive-id',
  activeCompanyId: 'company-sensitive-id',
};

function sequenceUuid() {
  let next = 0;
  return vi.fn(() => {
    next += 1;
    return `00000000-0000-4000-8000-${String(next).padStart(12, '0')}`;
  });
}

function sharedStorageRealms() {
  const values = new Map<string, string>();
  const createRealm = (): Storage => ({
    get length() {
      return values.size;
    },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, String(value));
    }),
  });
  return { values, createRealm };
}

function controlledIntervals() {
  type IntervalHandler = Parameters<typeof globalThis.setInterval>[0];
  let nextHandle = 0;
  const active = new Map<number, () => void>();
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: IntervalHandler) => {
    if (typeof handler !== 'function') throw new Error('Expected an interval callback');
    nextHandle += 1;
    active.set(nextHandle, () => handler());
    return nextHandle as unknown as ReturnType<typeof globalThis.setInterval>;
  }) as typeof globalThis.setInterval);
  vi.spyOn(globalThis, 'clearInterval').mockImplementation(((handle) => {
    active.delete(handle as unknown as number);
  }) as typeof globalThis.clearInterval);
  return {
    activeCount: () => active.size,
    fireOnly() {
      expect(active.size).toBe(1);
      Array.from(active.values())[0]();
    },
  };
}

function leaseReleaseBarrier(storage: Storage) {
  const originalRemove = storage.removeItem.bind(storage);
  let pending: (() => void) | undefined;
  storage.removeItem = vi.fn((key: string) => {
    originalRemove(key);
    if (key.endsWith(':lease') && pending) {
      const resolve = pending;
      pending = undefined;
      resolve();
    }
  });
  return {
    arm() {
      if (pending) throw new Error('A lease release barrier is already armed');
      return new Promise<void>((resolve) => {
        pending = resolve;
      });
    },
  };
}

async function flushMicrotasks() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

const fastLease = {
  lockTtlMs: 100,
  lockWaitMs: 250,
  lockSettleMs: 1,
};

function completedRecord(
  index: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    version: 1,
    scope: 'email-single-ui',
    contextDigest: index.toString(16).padStart(64, '0'),
    payloadDigest: 'b'.repeat(64),
    key: `email-single-ui:capacity-${index.toString(16).padStart(8, '0')}`,
    state: 'completed',
    createdAt: 1_000,
    updatedAt: 1_000,
    completedAt: 1_000,
    expiresAt: 2_000,
    ...overrides,
  };
}

beforeAll(() => {
  if (!globalThis.crypto?.subtle || typeof globalThis.crypto.randomUUID !== 'function') {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: webcrypto,
    });
  }
});

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('durable manual send intents', () => {
  it('survives tracker recreation and stores no request or identity PII', async () => {
    const createUuid = sequenceUuid();
    const payload = {
      leadId: 'lead-1',
      recipient: 'buyer@example.com',
      subject: 'Private subject',
      body: 'Private customer message',
    };
    const first = createManualSendIntentTracker(
      'email-single-ui',
      context,
      { createUuid },
    );
    const key = await first.keyFor(payload);
    const rebuilt = createManualSendIntentTracker(
      'email-single-ui',
      context,
      { createUuid },
    );

    await expect(rebuilt.keyFor({
      body: 'Private customer message',
      subject: 'Private subject',
      recipient: 'buyer@example.com',
      leadId: 'lead-1',
    })).resolves.toBe(key);
    expect(createUuid).toHaveBeenCalledTimes(3);

    const persisted = window.localStorage.getItem(
      'vaysen:manual-send-intents:v1',
    ) || '';
    expect(persisted).toContain(key);
    for (const secret of [
      context.userId,
      context.activeCompanyId,
      payload.recipient,
      payload.subject,
      payload.body,
      payload.leadId,
    ]) {
      expect(persisted).not.toContain(secret);
    }
  });

  it('binds intents to the exact user and active company', async () => {
    const createUuid = sequenceUuid();
    const payload = { leadId: 'lead-1' };
    const original = createManualSendIntentTracker(
      'email-batch-ui',
      context,
      { createUuid },
    );
    const peerUser = createManualSendIntentTracker(
      'email-batch-ui',
      { ...context, userId: 'peer-user' },
      { createUuid },
    );
    const otherTenant = createManualSendIntentTracker(
      'email-batch-ui',
      { ...context, activeCompanyId: 'other-company' },
      { createUuid },
    );

    const keys = await Promise.all([
      original.keyFor(payload),
      peerUser.keyFor(payload),
      otherTenant.keyFor(payload),
    ]);
    expect(new Set(keys).size).toBe(3);
  });

  it('expires stale intents and creates a new key', async () => {
    let now = 1000;
    const createUuid = sequenceUuid();
    const options = { createUuid, now: () => now, ttlMs: 500 };
    const tracker = createManualSendIntentTracker(
      'email-single-ui',
      context,
      options,
    );
    const first = await tracker.keyFor({ leadId: 'lead-1' });
    now = 1600;

    await expect(tracker.keyFor({ leadId: 'lead-1' }))
      .resolves.not.toBe(first);
  });

  it('rejects a 257th active intent without modifying a full valid ledger', async () => {
    const shared = sharedStorageRealms();
    const records = Array.from({ length: 256 }, (_, index) =>
      completedRecord(index + 1));
    const serialized = JSON.stringify({ version: 1, intents: records });
    shared.values.set('vaysen:manual-send-intents:v1', serialized);
    const createUuid = sequenceUuid();
    const tracker = createManualSendIntentTracker('email-single-ui', context, {
      ...fastLease,
      storage: shared.createRealm(),
      createUuid,
      now: () => 1_500,
    });

    await expect(tracker.keyFor({ leadId: 'new-lead' }))
      .rejects.toThrow(/capacity is exhausted/i);
    expect(shared.values.get('vaysen:manual-send-intents:v1')).toBe(serialized);
    expect(createUuid).toHaveBeenCalledTimes(1);
  });

  it('recovers bounded overflow by pruning expired completed rows before adding', async () => {
    const shared = sharedStorageRealms();
    const active = Array.from({ length: 255 }, (_, index) =>
      completedRecord(index + 1));
    const expired = [
      completedRecord(300, { expiresAt: 1_400 }),
      completedRecord(301, { expiresAt: 1_400 }),
    ];
    shared.values.set('vaysen:manual-send-intents:v1', JSON.stringify({
      version: 1,
      intents: [...active, ...expired],
    }));
    const tracker = createManualSendIntentTracker('email-single-ui', context, {
      ...fastLease,
      storage: shared.createRealm(),
      createUuid: sequenceUuid(),
      now: () => 1_500,
    });

    const key = await tracker.keyFor({ leadId: 'new-lead' });
    const repaired = JSON.parse(
      shared.values.get('vaysen:manual-send-intents:v1') || '',
    );
    expect(repaired.intents).toHaveLength(256);
    expect(repaired.intents.every((intent: { expiresAt: number }) =>
      intent.expiresAt > 1_500)).toBe(true);
    await expect(tracker.keyFor({ leadId: 'new-lead' })).resolves.toBe(key);
  });

  it('fails closed without rewriting an unbounded ledger overflow', async () => {
    const shared = sharedStorageRealms();
    const serialized = JSON.stringify({
      version: 1,
      intents: Array.from({ length: 513 }, (_, index) =>
        completedRecord(index + 1)),
    });
    shared.values.set('vaysen:manual-send-intents:v1', serialized);
    const tracker = createManualSendIntentTracker('email-single-ui', context, {
      ...fastLease,
      storage: shared.createRealm(),
      now: () => 1_500,
    });
    const send = vi.fn();

    await expect(runManualSendIntent(tracker, { leadId: 'new-lead' }, send))
      .rejects.toThrow(/ledger is corrupt/i);
    expect(send).not.toHaveBeenCalled();
    expect(shared.values.get('vaysen:manual-send-intents:v1')).toBe(serialized);
  });

  it('converges concurrent component instances on one persisted key', async () => {
    const createUuid = sequenceUuid();
    const trackers = Array.from({ length: 8 }, () =>
      createManualSendIntentTracker(
        'leads-batch-email-ui',
        context,
        { createUuid },
      ));

    const keys = await Promise.all(
      trackers.map((tracker) => tracker.keyFor({ leadIds: ['lead-1'] })),
    );
    expect(new Set(keys)).toEqual(new Set([keys[0]]));
    expect(createUuid).toHaveBeenCalledTimes(9);
  });

  it('converges two independent no-Web-Locks realms on one canonical key', async () => {
    expect(navigator.locks).toBeUndefined();
    const shared = sharedStorageRealms();
    const createUuid = sequenceUuid();
    const first = createManualSendIntentTracker('email-single-ui', context, {
      ...fastLease,
      storage: shared.createRealm(),
      createUuid,
    });
    const second = createManualSendIntentTracker('email-single-ui', context, {
      ...fastLease,
      storage: shared.createRealm(),
      createUuid,
    });

    const keys = await Promise.all([
      first.keyFor({ leadId: 'lead-1' }),
      second.keyFor({ leadId: 'lead-1' }),
    ]);

    expect(new Set(keys)).toEqual(new Set([keys[0]]));
    expect(keys[0]).toMatch(/^email-single-ui:[0-9a-f-]{36}$/i);
    expect(createUuid).toHaveBeenCalledTimes(3);
  });

  it('allows only one no-Web-Locks realm to reach HTTP for a concurrent intent', async () => {
    expect(navigator.locks).toBeUndefined();
    const shared = sharedStorageRealms();
    const createUuid = sequenceUuid();
    const first = createManualSendIntentTracker('email-single-ui', context, {
      ...fastLease,
      storage: shared.createRealm(),
      createUuid,
    });
    const second = createManualSendIntentTracker('email-single-ui', context, {
      ...fastLease,
      storage: shared.createRealm(),
      createUuid,
    });
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const send = vi.fn(async () => {
      await sendGate;
      return 'queued';
    });

    const firstRequest = runManualSendIntent(first, { leadId: 'lead-1' }, send);
    while (send.mock.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const secondRequest = runManualSendIntent(second, { leadId: 'lead-1' }, send);
    await expect(secondRequest).rejects.toBeInstanceOf(ManualSendIntentBusyError);
    expect(send).toHaveBeenCalledTimes(1);
    releaseSend();
    await expect(firstRequest).resolves.toBe('queued');
  });

  it('honors fallback lease ownership and takes over only after TTL expiry', async () => {
    const shared = sharedStorageRealms();
    const storage = shared.createRealm();
    shared.values.set('vaysen:manual-send-intents:v1:lease', JSON.stringify({
      owner: '00000000-0000-4000-8000-000000000099',
      expiresAt: Date.now() + 10_000,
    }));
    const blocked = createManualSendIntentTracker('email-single-ui', context, {
      storage,
      createUuid: sequenceUuid(),
      lockTtlMs: 20,
      lockWaitMs: 5,
      lockSettleMs: 1,
    });
    await expect(blocked.keyFor({ leadId: 'lead-1' }))
      .rejects.toBeInstanceOf(ManualSendIntentBusyError);

    shared.values.set('vaysen:manual-send-intents:v1:lease', JSON.stringify({
      owner: '00000000-0000-4000-8000-000000000099',
      expiresAt: Date.now() - 1,
    }));
    const recovered = createManualSendIntentTracker('email-single-ui', context, {
      ...fastLease,
      storage,
      createUuid: sequenceUuid(),
    });
    await expect(recovered.keyFor({ leadId: 'lead-1' }))
      .resolves.toMatch(/^email-single-ui:/);
    expect(shared.values.has('vaysen:manual-send-intents:v1:lease')).toBe(false);
  });

  it('renews a verified fallback lease when its settle delay consumed the 100ms TTL', async () => {
    let wallClock = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => wallClock);
    const shared = sharedStorageRealms();
    const storage = shared.createRealm();
    const originalGet = storage.getItem.bind(storage);
    let persistedLeaseReads = 0;
    storage.getItem = vi.fn((key: string) => {
      const value = originalGet(key);
      if (key.endsWith(':lease') && value !== null) {
        persistedLeaseReads += 1;
        if (persistedLeaseReads === 2) wallClock = 1_101;
      }
      return value;
    });
    const tracker = createManualSendIntentTracker('email-single-ui', context, {
      ...fastLease,
      storage,
      createUuid: sequenceUuid(),
      now: () => 1_500,
    });

    await expect(tracker.keyFor({ leadId: 'lease-refresh' }))
      .resolves.toMatch(/^email-single-ui:/);
    expect(persistedLeaseReads).toBeGreaterThanOrEqual(4);
    expect(shared.values.has('vaysen:manual-send-intents:v1:lease')).toBe(false);
  });

  it('maintains a bounded dispatch heartbeat so a 100ms lease cannot admit concurrent HTTP', async () => {
    let now = 1_000;
    const intervals = controlledIntervals();
    const shared = sharedStorageRealms();
    const createUuid = sequenceUuid();
    const firstStorage = shared.createRealm();
    const releases = leaseReleaseBarrier(firstStorage);
    const first = createManualSendIntentTracker('email-single-ui', context, {
      ...fastLease,
      storage: firstStorage,
      createUuid,
      now: () => now,
      ttlMs: 2_000,
      dispatchLeaseMs: 100,
    });
    const second = createManualSendIntentTracker('email-single-ui', context, {
      ...fastLease,
      storage: shared.createRealm(),
      createUuid,
      now: () => now,
      ttlMs: 2_000,
      dispatchLeaseMs: 100,
    });
    let releaseSend!: () => void;
    let markSendStarted!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    const firstSend = vi.fn(async () => {
      markSendStarted();
      await sendGate;
      return 'queued';
    });
    const secondSend = vi.fn(async () => 'duplicate');

    const firstRequest = runManualSendIntent(first, { leadId: 'slow-send' }, firstSend);
    await sendStarted;
    for (const heartbeatTime of [1_050, 1_120, 1_190, 1_260]) {
      now = heartbeatTime;
      const renewed = releases.arm();
      intervals.fireOnly();
      await renewed;
      await flushMicrotasks();
      expect(intervals.activeCount()).toBe(1);
    }
    const secondRequest = runManualSendIntent(second, { leadId: 'slow-send' }, secondSend);
    await expect(secondRequest).rejects.toBeInstanceOf(ManualSendIntentBusyError);
    expect(firstSend).toHaveBeenCalledTimes(1);
    expect(secondSend).not.toHaveBeenCalled();
    releaseSend();
    await expect(firstRequest).resolves.toBe('queued');
    expect(intervals.activeCount()).toBe(0);
  });

  it('surfaces dispatch heartbeat ownership loss without starting another HTTP request', async () => {
    let now = 1_000;
    const intervals = controlledIntervals();
    const shared = sharedStorageRealms();
    const storage = shared.createRealm();
    const releases = leaseReleaseBarrier(storage);
    const tracker = createManualSendIntentTracker('email-single-ui', context, {
      ...fastLease,
      storage,
      createUuid: sequenceUuid(),
      now: () => now,
      ttlMs: 2_000,
      dispatchLeaseMs: 100,
    });
    let releaseSend!: () => void;
    let markSendStarted!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    const send = vi.fn(async () => {
      markSendStarted();
      await sendGate;
      return 'queued';
    });

    const request = runManualSendIntent(tracker, { leadId: 'ownership-loss' }, send);
    await sendStarted;
    const ledger = JSON.parse(shared.values.get('vaysen:manual-send-intents:v1') || '');
    ledger.intents[0].dispatchOwner = '00000000-0000-4000-8000-000000000099';
    ledger.intents[0].dispatchLeaseExpiresAt = 2_000;
    shared.values.set('vaysen:manual-send-intents:v1', JSON.stringify(ledger));
    now = 1_050;
    const heartbeatStopped = releases.arm();
    intervals.fireOnly();
    await heartbeatStopped;
    await flushMicrotasks();
    releaseSend();

    await expect(request).rejects.toBeInstanceOf(ManualSendOwnershipLostError);
    expect(send).toHaveBeenCalledTimes(1);
    expect(intervals.activeCount()).toBe(0);
  });

  it.each(['success', 'failure'] as const)(
    'waits for an in-flight heartbeat and clears all timers after task %s',
    async (outcome) => {
      let now = 1_000;
      const intervals = controlledIntervals();
      const shared = sharedStorageRealms();
      const storage = shared.createRealm();
      const releases = leaseReleaseBarrier(storage);
      const tracker = createManualSendIntentTracker('email-single-ui', context, {
        ...fastLease,
        storage,
        createUuid: sequenceUuid(),
        now: () => now,
        ttlMs: 2_000,
        dispatchLeaseMs: 100,
      });
      let resolveSend!: () => void;
      let rejectSend!: (error: Error) => void;
      let markSendStarted!: () => void;
      const sendGate = new Promise<void>((resolve, reject) => {
        resolveSend = resolve;
        rejectSend = reject;
      });
      const sendStarted = new Promise<void>((resolve) => {
        markSendStarted = resolve;
      });
      const send = vi.fn(async () => {
        markSendStarted();
        await sendGate;
        return 'queued';
      });

      const request = runManualSendIntent(tracker, { leadId: `cleanup-${outcome}` }, send);
      await sendStarted;
      now = 1_050;
      const heartbeatFinished = releases.arm();
      intervals.fireOnly();
      if (outcome === 'success') resolveSend();
      else rejectSend(new Error('network stopped'));
      await heartbeatFinished;

      if (outcome === 'success') await expect(request).resolves.toBe('queued');
      else await expect(request).rejects.toThrow('network stopped');
      expect(intervals.activeCount()).toBe(0);
      expect(shared.values.has('vaysen:manual-send-intents:v1:lease')).toBe(false);
    },
  );

  it('uses the injected UUID factory for lease and dispatch owners without global randomUUID', async () => {
    vi.stubGlobal('crypto', {
      subtle: webcrypto.subtle,
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    });
    expect(globalThis.crypto.randomUUID).toBeUndefined();

    const shared = sharedStorageRealms();
    const createUuid = sequenceUuid();
    const tracker = createManualSendIntentTracker('email-single-ui', context, {
      ...fastLease,
      storage: shared.createRealm(),
      createUuid,
    });
    const key = await tracker.keyFor({ leadId: 'lead-1' });
    expect(key).toBe('email-single-ui:00000000-0000-4000-8000-000000000002');

    const owner = await tracker.claim(key);
    expect(owner).toBe('00000000-0000-4000-8000-000000000004');
    const persisted = JSON.parse(shared.values.get('vaysen:manual-send-intents:v1') || '');
    expect(persisted.intents[0].dispatchOwner).toBe(owner);

    await tracker.settle(key, 'unknown', owner);
    expect(createUuid).toHaveBeenCalledTimes(5);
  });

  it('fails closed when the injected UUID factory throws before storage or HTTP', async () => {
    const createUuid = vi.fn(() => {
      throw new Error('injected UUID failure');
    });
    const tracker = createManualSendIntentTracker('email-single-ui', context, {
      ...fastLease,
      storage: sharedStorageRealms().createRealm(),
      createUuid,
    });
    const send = vi.fn();

    await expect(runManualSendIntent(tracker, { leadId: 'lead-1' }, send))
      .rejects.toThrow('injected UUID failure');
    expect(send).not.toHaveBeenCalled();
    expect(createUuid).toHaveBeenCalledTimes(1);
  });

  it('rejects a fallback lease that cannot be verified after writing', async () => {
    const shared = sharedStorageRealms();
    const storage = shared.createRealm();
    const originalGet = storage.getItem.bind(storage);
    const originalSet = storage.setItem.bind(storage);
    storage.setItem = vi.fn((key: string, value: string) => {
      originalSet(key, value);
      if (key.endsWith(':lease')) {
        shared.values.set(key, JSON.stringify({
          owner: '00000000-0000-4000-8000-000000000099',
          expiresAt: Date.now() + 10_000,
        }));
      }
    });
    storage.getItem = vi.fn((key: string) => originalGet(key));
    const tracker = createManualSendIntentTracker('email-single-ui', context, {
      ...fastLease,
      storage,
    });
    const send = vi.fn();

    await expect(runManualSendIntent(tracker, { leadId: 'lead-1' }, send))
      .rejects.toThrow(/lock could not be verified/i);
    expect(send).not.toHaveBeenCalled();
  });

  it('fails closed when fallback lease storage read or release fails', async () => {
    const readFailure = {
      getItem: vi.fn(() => {
        throw new Error('storage read failed');
      }),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(),
      length: 0,
    } as unknown as Storage;
    const readTracker = createManualSendIntentTracker('email-single-ui', context, {
      ...fastLease,
      storage: readFailure,
    });
    const readSend = vi.fn();
    await expect(runManualSendIntent(readTracker, { leadId: 'lead-1' }, readSend))
      .rejects.toThrow('storage read failed');
    expect(readSend).not.toHaveBeenCalled();

    const shared = sharedStorageRealms();
    const releaseFailure = shared.createRealm();
    releaseFailure.removeItem = vi.fn(() => {
      throw new Error('storage release failed');
    });
    const releaseTracker = createManualSendIntentTracker('email-single-ui', context, {
      ...fastLease,
      storage: releaseFailure,
    });
    const releaseSend = vi.fn();
    await expect(runManualSendIntent(releaseTracker, { leadId: 'lead-1' }, releaseSend))
      .rejects.toThrow('storage release failed');
    expect(releaseSend).not.toHaveBeenCalled();
  });

  it('fences dispatch by owner and permits takeover only after its lease expires', async () => {
    let now = 1_000;
    const shared = sharedStorageRealms();
    const createUuid = sequenceUuid();
    const options = {
      ...fastLease,
      storage: shared.createRealm(),
      createUuid,
      now: () => now,
      ttlMs: 10_000,
      dispatchLeaseMs: 100,
    };
    const first = createManualSendIntentTracker('email-single-ui', context, options);
    const second = createManualSendIntentTracker('email-single-ui', context, {
      ...options,
      storage: shared.createRealm(),
    });
    const key = await first.keyFor({ leadId: 'lead-1' });
    const firstOwner = await first.claim(key);
    await expect(second.claim(key)).rejects.toBeInstanceOf(ManualSendIntentBusyError);

    now = 1_101;
    const secondOwner = await second.claim(key);
    expect(secondOwner).not.toBe(firstOwner);
    await expect(first.settle(key, 'success', firstOwner))
      .rejects.toBeInstanceOf(ManualSendIntentBusyError);
    await expect(second.settle(key, 'unknown', secondOwner)).resolves.toBeUndefined();
    await expect(first.keyFor({ leadId: 'lead-1' })).resolves.toBe(key);
  });

  it('retains a completed tombstone and key after success', async () => {
    const createUuid = sequenceUuid();
    const tracker = createManualSendIntentTracker(
      'email-single-ui',
      context,
      { createUuid },
    );
    const payload = { leadId: 'lead-1' };
    const first = await tracker.keyFor(payload);
    const owner = await tracker.claim(first);
    await tracker.settle(first, 'success', owner);

    await expect(tracker.keyFor(payload)).resolves.toBe(first);
    expect(window.localStorage.getItem('vaysen:manual-send-intents:v1'))
      .toContain('"state":"completed"');
  });

  it('never downgrades a completed tombstone after an uncertain or rejected replay', async () => {
    const createUuid = sequenceUuid();
    const tracker = createManualSendIntentTracker(
      'email-single-ui',
      context,
      { createUuid },
    );
    const payload = { leadId: 'lead-1' };
    const key = await tracker.keyFor(payload);
    const firstOwner = await tracker.claim(key);
    await tracker.settle(key, 'success', firstOwner);

    const uncertainReplayOwner = await tracker.claim(key);
    await tracker.settle(key, 'unknown', uncertainReplayOwner);
    await expect(tracker.keyFor(payload)).resolves.toBe(key);

    const rejectedReplayOwner = await tracker.claim(key);
    await tracker.settle(key, 'business-rejection', rejectedReplayOwner);
    await expect(tracker.keyFor(payload)).resolves.toBe(key);
    expect(createUuid).toHaveBeenCalledTimes(13);
  });

  it('removes only a definitely rejected intent so a later action gets a new key', async () => {
    const createUuid = sequenceUuid();
    const tracker = createManualSendIntentTracker(
      'email-single-ui',
      context,
      { createUuid },
    );
    const payload = { leadId: 'lead-1' };
    const first = await tracker.keyFor(payload);
    const owner = await tracker.claim(first);
    await tracker.settle(first, 'business-rejection', owner);

    await expect(tracker.keyFor(payload)).resolves.not.toBe(first);
  });

  it('retains the same persisted key after an unknown result', async () => {
    const createUuid = sequenceUuid();
    const payload = { leadId: 'lead-1' };
    const firstTracker = createManualSendIntentTracker(
      'email-single-ui',
      context,
      { createUuid },
    );
    const first = await firstTracker.keyFor(payload);
    const owner = await firstTracker.claim(first);
    await firstTracker.settle(first, 'unknown', owner);

    const restarted = createManualSendIntentTracker(
      'email-single-ui',
      context,
      { createUuid },
    );
    await expect(restarted.keyFor(payload)).resolves.toBe(first);
  });

  it('fails closed before HTTP when durable storage cannot be written', async () => {
    const storage = {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(() => {
        throw new Error('renderer storage unavailable');
      }),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(),
      length: 0,
    } as unknown as Storage;
    const tracker = createManualSendIntentTracker(
      'email-single-ui',
      context,
      { storage },
    );
    const send = vi.fn();

    await expect(runManualSendIntent(tracker, { leadId: 'lead-1' }, send))
      .rejects.toThrow('renderer storage unavailable');
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['short key', (record: any) => ({ ...record, key: 'short' })],
    ['bad context digest', (record: any) => ({ ...record, contextDigest: 'bad' })],
    ['bad payload digest', (record: any) => ({ ...record, payloadDigest: 'f'.repeat(63) })],
    ['invalid scope', (record: any) => ({ ...record, scope: 'Email Single' })],
    ['future timestamp', (record: any) => ({ ...record, createdAt: 999_999_999 })],
    ['fractional timestamp', (record: any) => ({ ...record, updatedAt: 1_000.5 })],
    ['reversed timestamps', (record: any) => ({ ...record, updatedAt: 1_501, expiresAt: 1_500 })],
    ['dispatch owner without expiry', (record: any) => ({
      ...record,
      dispatchOwner: '00000000-0000-4000-8000-000000000099',
    })],
    ['noncanonical dispatch owner', (record: any) => ({
      ...record,
      dispatchOwner: 'short',
      dispatchLeaseExpiresAt: 1_100,
    })],
    ['dispatch lease beyond intent expiry', (record: any) => ({
      ...record,
      state: 'inflight',
      dispatchOwner: '00000000-0000-4000-8000-000000000099',
      dispatchLeaseExpiresAt: 2_001,
    })],
    ['completed state without terminal timestamp', (record: any) => ({
      ...record,
      state: 'completed',
    })],
    ['completed state with mismatched terminal timestamp', (record: any) => ({
      ...record,
      state: 'completed',
      completedAt: 1_100,
    })],
    ['unknown field', (record: any) => ({ ...record, recipient: 'hidden@example.com' })],
  ])('fails closed before HTTP for a corrupt ledger with %s', async (_name, mutate) => {
    const valid = {
      version: 1,
      scope: 'email-single-ui',
      contextDigest: 'a'.repeat(64),
      payloadDigest: 'b'.repeat(64),
      key: 'email-single-ui:00000000-0000-4000-8000-000000000001',
      state: 'ready',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 2_000,
    };
    const shared = sharedStorageRealms();
    shared.values.set('vaysen:manual-send-intents:v1', JSON.stringify({
      version: 1,
      intents: [mutate(valid)],
    }));
    const tracker = createManualSendIntentTracker('email-single-ui', context, {
      ...fastLease,
      storage: shared.createRealm(),
      now: () => 1_500,
    });
    const send = vi.fn();

    await expect(runManualSendIntent(tracker, { leadId: 'lead-1' }, send))
      .rejects.toThrow(/ledger is corrupt/i);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['duplicate intent identity', {
      payloadDigest: 'b'.repeat(64),
      key: 'email-single-ui:00000000-0000-4000-8000-000000000002',
    }],
    ['one key bound to conflicting payload', {
      payloadDigest: 'c'.repeat(64),
      key: 'email-single-ui:00000000-0000-4000-8000-000000000001',
    }],
  ])('fails closed before HTTP for %s records', async (_name, secondFields) => {
    const first = {
      version: 1,
      scope: 'email-single-ui',
      contextDigest: 'a'.repeat(64),
      payloadDigest: 'b'.repeat(64),
      key: 'email-single-ui:00000000-0000-4000-8000-000000000001',
      state: 'ready',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 2_000,
    };
    const shared = sharedStorageRealms();
    shared.values.set('vaysen:manual-send-intents:v1', JSON.stringify({
      version: 1,
      intents: [first, { ...first, ...secondFields }],
    }));
    const tracker = createManualSendIntentTracker('email-single-ui', context, {
      ...fastLease,
      storage: shared.createRealm(),
      now: () => 1_500,
    });
    const send = vi.fn();

    await expect(runManualSendIntent(tracker, { leadId: 'lead-1' }, send))
      .rejects.toThrow(/ledger is corrupt/i);
    expect(send).not.toHaveBeenCalled();
  });

  it('reuses the same key after both network failure and successful replay', async () => {
    const createUuid = sequenceUuid();
    const tracker = createManualSendIntentTracker(
      'email-single-ui',
      context,
      { createUuid },
    );
    const payload = { leadId: 'lead-1' };
    const seenKeys: string[] = [];
    const send = vi
      .fn<(key: string) => Promise<string>>()
      .mockImplementationOnce(async (key) => {
        seenKeys.push(key);
        throw new Error('network');
      })
      .mockImplementation(async (key) => {
        seenKeys.push(key);
        return 'queued';
      });

    await expect(runManualSendIntent(tracker, payload, send))
      .rejects.toThrow('network');
    await expect(runManualSendIntent(tracker, payload, send))
      .resolves.toBe('queued');
    expect(seenKeys[1]).toBe(seenKeys[0]);
    await expect(tracker.keyFor(payload)).resolves.toBe(seenKeys[0]);
  });

  it('keeps the completed key when lock release fails after HTTP success', async () => {
    const shared = sharedStorageRealms();
    const storage = shared.createRealm();
    const originalRemove = storage.removeItem.bind(storage);
    let injectedReleaseFailure = false;
    storage.removeItem = vi.fn((key: string) => {
      const persistedLedger = shared.values.get(
        'vaysen:manual-send-intents:v1',
      );
      if (
        key.endsWith(':lease')
        && !injectedReleaseFailure
        && persistedLedger?.includes('"state":"completed"')
      ) {
        injectedReleaseFailure = true;
        throw new Error('injected post-success lock release failure');
      }
      originalRemove(key);
    });
    const createUuid = sequenceUuid();
    const tracker = createManualSendIntentTracker('email-single-ui', context, {
      storage,
      createUuid,
      lockTtlMs: 100,
      lockWaitMs: 300,
      lockSettleMs: 1,
    });
    const payload = { leadId: 'lead-1' };
    const httpKeys: string[] = [];
    const providerAcceptedKeys = new Set<string>();
    const send = vi.fn(async (key: string) => {
      httpKeys.push(key);
      providerAcceptedKeys.add(key);
      return 'queued';
    });

    await expect(runManualSendIntent(tracker, payload, send))
      .rejects.toBeInstanceOf(ManualSendSettlementUnknownError);
    expect(shared.values.get('vaysen:manual-send-intents:v1'))
      .toContain('"state":"completed"');

    await expect(runManualSendIntent(tracker, payload, send)).resolves.toBe('queued');
    expect(httpKeys).toHaveLength(2);
    expect(new Set(httpKeys).size).toBe(1);
    expect(providerAcceptedKeys.size).toBe(1);
    expect(createUuid).toHaveBeenCalledTimes(9);
  });

  it('does not classify or settle twice when post-success settlement fails', async () => {
    const settlementError = new Error('terminal write acknowledgement lost');
    const tracker = {
      keyFor: vi.fn().mockResolvedValue('email-single-ui:stable-key-0001'),
      claim: vi.fn().mockResolvedValue('00000000-0000-4000-8000-000000000099'),
      settle: vi.fn().mockRejectedValue(settlementError),
    };
    const send = vi.fn().mockResolvedValue('queued');

    await expect(runManualSendIntent(tracker, { leadId: 'lead-1' }, send))
      .rejects.toMatchObject({
        name: 'ManualSendSettlementUnknownError',
        settlementCause: settlementError,
      });
    expect(send).toHaveBeenCalledTimes(1);
    expect(tracker.settle).toHaveBeenCalledTimes(1);
    expect(tracker.settle).toHaveBeenCalledWith(
      'email-single-ui:stable-key-0001',
      'success',
      '00000000-0000-4000-8000-000000000099',
    );
  });

  it('recovers the completed key after a terminal write crash and expires it by TTL', async () => {
    let now = 1_000;
    const shared = sharedStorageRealms();
    const createUuid = sequenceUuid();
    const options = {
      ...fastLease,
      storage: shared.createRealm(),
      createUuid,
      now: () => now,
      ttlMs: 500,
      dispatchLeaseMs: 100,
    };
    const tracker = createManualSendIntentTracker('email-single-ui', context, options);
    const payload = { leadId: 'lead-1' };
    const key = await tracker.keyFor(payload);
    const owner = await tracker.claim(key);
    now = 1_100;
    await tracker.settle(key, 'success', owner);

    // A new tracker represents a renderer restart immediately after the
    // durable terminal write but before the UI observed completion.
    const restarted = createManualSendIntentTracker('email-single-ui', context, {
      ...options,
      storage: shared.createRealm(),
    });
    now = 1_599;
    await expect(restarted.keyFor(payload)).resolves.toBe(key);

    now = 1_601;
    await expect(restarted.keyFor(payload)).resolves.not.toBe(key);
    expect(createUuid).toHaveBeenCalledTimes(8);
  });

  it('keeps completed replay lifetime fixed across repeated same-key success', async () => {
    let now = 1_000;
    const shared = sharedStorageRealms();
    const createUuid = sequenceUuid();
    const tracker = createManualSendIntentTracker('email-single-ui', context, {
      ...fastLease,
      storage: shared.createRealm(),
      createUuid,
      now: () => now,
      ttlMs: 500,
      dispatchLeaseMs: 100,
    });
    const payload = { leadId: 'lead-1' };
    const replayKeys: string[] = [];
    const send = vi.fn(async (key: string) => {
      replayKeys.push(key);
      return 'queued';
    });

    await runManualSendIntent(tracker, payload, send);
    for (const replayAt of [1_100, 1_200, 1_300, 1_400]) {
      now = replayAt;
      await runManualSendIntent(tracker, payload, send);
    }

    expect(new Set(replayKeys).size).toBe(1);
    expect(createUuid).toHaveBeenCalledTimes(21);
    const terminal = JSON.parse(
      shared.values.get('vaysen:manual-send-intents:v1') || '',
    ).intents[0];
    expect(terminal).toMatchObject({
      state: 'completed',
      completedAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 1_500,
    });

    now = 1_499;
    await expect(tracker.keyFor(payload)).resolves.toBe(replayKeys[0]);
    now = 1_501;
    await expect(tracker.keyFor(payload)).resolves.not.toBe(replayKeys[0]);
    expect(createUuid).toHaveBeenCalledTimes(24);
  });

  it.each([
    [undefined, 'unknown'],
    [500, 'unknown'],
    [408, 'unknown'],
    [409, 'unknown'],
    [425, 'unknown'],
    [429, 'unknown'],
    [400, 'business-rejection'],
    [401, 'business-rejection'],
    [403, 'business-rejection'],
    [404, 'business-rejection'],
    [422, 'business-rejection'],
  ] as const)('classifies status %s as %s', (status, outcome) => {
    const error = status === undefined
      ? new Error('network')
      : { response: { status } };
    expect(manualSendFailureOutcome(error)).toBe(outcome);
  });

  it('treats only the stable payload-conflict response as terminal 409', () => {
    expect(manualSendFailureOutcome({
      response: {
        status: 409,
        data: { code: 'EMAIL_IDEMPOTENCY_PAYLOAD_CONFLICT' },
      },
    })).toBe('business-rejection');
    expect(manualSendFailureOutcome({
      response: {
        status: 409,
        data: { code: 'OTHER_CONFLICT' },
      },
    })).toBe('unknown');
  });

  it('fails closed without an exact authenticated context', async () => {
    const send = vi.fn();
    const tracker = createManualSendIntentTracker(
      'email-single-ui',
      { userId: 'user-1', activeCompanyId: null },
    );

    await expect(runManualSendIntent(tracker, {}, send))
      .rejects.toThrow(/authenticated user and active company/i);
    expect(send).not.toHaveBeenCalled();
  });
});
