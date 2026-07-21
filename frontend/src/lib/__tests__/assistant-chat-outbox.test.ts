import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AssistantCrossTabLockBusyError,
  AssistantCrossTabLockUnavailableError,
  AssistantOutboxStorageUnavailableError,
  PendingAssistantContextChangedError,
  PendingAssistantRequestConflictError,
  assistantPendingStorageKey,
  assistantRequestContextFingerprint,
  assistantThreadIdFor,
  clearPendingAssistantRequest,
  markAssistantRequestCompleted,
  readPendingAssistantRequest,
  reconcilePendingAssistantRequest,
  readRecentlyCompletedAssistantRequest,
  reserveAssistantRequest,
  reserveStoredAssistantRequest,
  subscribePendingAssistantRequest,
  withAssistantRequestLock,
  writePendingAssistantRequest,
} from '@/lib/assistant-chat-outbox';

describe('assistant chat idempotent outbox', () => {
  const contextFingerprint = assistantRequestContextFingerprint({
    companyId: 'company-1',
    threadId: 'thread-1',
    pathname: '/ai-workbench',
  });

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: undefined,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('reuses the same requestId after a transport failure', () => {
    const first = reserveAssistantRequest(
      '  查看今日工作简报  ',
      [{ id: 'turn-old', input: '旧消息' }],
      true,
      contextFingerprint,
      null,
    );
    const retry = reserveAssistantRequest('  查看今日工作简报  ', [], false, contextFingerprint, first);

    expect(retry).toBe(first);
    expect(retry.requestId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    expect(retry.knownTurnIds).toEqual(['turn-old']);
    expect(retry.text).toBe('  查看今日工作简报  ');
  });

  it('does not replace an uncertain request with different text', () => {
    const pending = reserveAssistantRequest('发送消息 A', [], true, contextFingerprint, null);
    expect(() =>
      reserveAssistantRequest('发送消息 B', [], true, contextFingerprint, pending),
    ).toThrow(PendingAssistantRequestConflictError);
  });

  it('rejects retrying the same request in a different customer context', () => {
    const originalContext = assistantRequestContextFingerprint({
      companyId: 'company-1',
      threadId: 'thread-1',
      pathname: '/whatsapp/chat',
      whatsapp: {
        name: 'Buyer A',
        phone: '+8613812340001',
        conversationId: 'conversation-a',
      },
    });
    const changedContext = assistantRequestContextFingerprint({
      companyId: 'company-1',
      threadId: 'thread-1',
      pathname: '/whatsapp/chat',
      whatsapp: {
        name: 'Buyer B',
        phone: '+8613812340002',
        conversationId: 'conversation-b',
      },
    });
    const pending = reserveAssistantRequest('准备报价', [], true, originalContext, null);

    expect(() => reserveAssistantRequest('准备报价', [], true, changedContext, pending)).toThrow(
      PendingAssistantContextChangedError,
    );
  });

  it('uses a stable thread id for the same company and operator', () => {
    const first = assistantThreadIdFor('company-1', 'user-1');
    const second = assistantThreadIdFor('company-1', 'user-1');

    expect(second).toBe(first);
    expect(first).toMatch(/^crm:[0-9a-f]{16}$/);
    expect(assistantThreadIdFor('company-1', 'user-2')).not.toBe(first);
    expect(assistantThreadIdFor('company-2', 'user-1')).not.toBe(first);
  });

  it('shares one unresolved request across workbench and orb without raw context', () => {
    const pending = reserveAssistantRequest('恢复后重试', [], true, contextFingerprint, null);
    const workbenchKey = assistantPendingStorageKey('workbench', 'company-1', 'thread-1');
    const orbKey = assistantPendingStorageKey('orb', 'company-1', 'thread-1');
    writePendingAssistantRequest(workbenchKey, pending);

    expect(readPendingAssistantRequest(workbenchKey)).toEqual(pending);
    expect(orbKey).toBe(workbenchKey);
    expect(readPendingAssistantRequest(orbKey)).toEqual(pending);
    const raw = window.localStorage.getItem(workbenchKey) || '';
    expect(raw).not.toContain('phone');
    expect(raw).not.toContain('conversation-a');
    expect(raw.toLowerCase()).not.toContain('token');

    clearPendingAssistantRequest(orbKey, pending.requestId);
    expect(readPendingAssistantRequest(workbenchKey)).toBeNull();
  });

  it('does not clear a newer request when an older completion arrives late', () => {
    const key = assistantPendingStorageKey('orb', 'company-1', 'thread-1');
    const older = reserveAssistantRequest('旧请求', [], true, contextFingerprint, null);
    const newer = reserveAssistantRequest('新请求', [], true, contextFingerprint, null);
    writePendingAssistantRequest(key, newer);

    clearPendingAssistantRequest(key, older.requestId);

    expect(readPendingAssistantRequest(key)).toEqual(newer);
  });

  it('fails closed and removes a tampered session payload', () => {
    const key = assistantPendingStorageKey('orb', 'company-1', 'thread-1');
    window.localStorage.setItem(
      key,
      JSON.stringify({
        text: 'tampered',
        requestId: '11111111-1111-4111-8111-111111111111',
        knownTurnIds: [],
        historyBaselineReady: true,
        contextFingerprint,
        token: 'must-not-be-accepted',
      }),
    );

    expect(readPendingAssistantRequest(key)).toBeNull();
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it('derives the same requestId in independent windows with the same baseline', () => {
    const first = reserveAssistantRequest(
      '准备报价',
      [
        { id: 'turn-b', input: 'B' },
        { id: 'turn-a', input: 'A' },
      ],
      true,
      contextFingerprint,
      null,
    );
    const second = reserveAssistantRequest(
      '准备报价',
      [
        { id: 'turn-a', input: 'A' },
        { id: 'turn-b', input: 'B' },
      ],
      true,
      contextFingerprint,
      null,
    );
    const afterHistoryChanges = reserveAssistantRequest(
      '准备报价',
      [
        { id: 'turn-a', input: 'A' },
        { id: 'turn-b', input: 'B' },
        { id: 'turn-new', input: '完成' },
      ],
      true,
      contextFingerprint,
      null,
    );

    expect(first.requestId).toBe(second.requestId);
    expect(afterHistoryChanges.requestId).not.toBe(first.requestId);
  });

  it('reuses a recently completed request across tabs even when their history baselines differ', () => {
    const key = assistantPendingStorageKey('orb', 'company-1', 'thread-1');
    const first = reserveStoredAssistantRequest(
      key,
      '启动客户背调',
      [{ id: 'turn-old', input: '旧消息' }],
      true,
      contextFingerprint,
    );
    markAssistantRequestCompleted(key, first);

    const staleTabRetry = reserveStoredAssistantRequest(
      key,
      '启动客户背调',
      [],
      false,
      contextFingerprint,
    );

    expect(staleTabRetry.requestId).toBe(first.requestId);
    expect(readPendingAssistantRequest(key)).toEqual(staleTabRetry);
    expect(readRecentlyCompletedAssistantRequest(key)).toEqual({
      requestId: first.requestId,
      textDigest: expect.stringMatching(/^[0-9a-f]{16}$/),
      contextFingerprint,
      completedAt: expect.any(Number),
    });
  });

  it('stores only a digest after completion and never the full command text', () => {
    const key = assistantPendingStorageKey('orb', 'company-1', 'thread-1');
    const sensitiveText = '给客户 Alice 准备报价 8613800138000';
    const request = reserveStoredAssistantRequest(key, sensitiveText, [], true, contextFingerprint);

    markAssistantRequestCompleted(key, request);

    const raw = window.localStorage.getItem(`${key}:completed`) || '';
    expect(raw).not.toContain(sensitiveText);
    expect(raw).not.toContain('Alice');
    expect(raw).not.toContain('8613800138000');
    expect(raw).toContain('textDigest');
  });

  it('expires an abandoned pending request after the short recovery TTL', () => {
    const key = assistantPendingStorageKey('orb', 'company-1', 'thread-1');
    const request = reserveAssistantRequest('过期请求', [], true, contextFingerprint, null);
    writePendingAssistantRequest(key, {
      ...request,
      createdAt: Date.now() - 10 * 60 * 1_000 - 1,
    });

    expect(readPendingAssistantRequest(key)).toBeNull();
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it('automatically clears a pending request once server history contains its durable turn', () => {
    const key = assistantPendingStorageKey('orb', 'company-1', 'thread-1');
    const request = reserveStoredAssistantRequest(
      key,
      '查询客户最新状态',
      [{ id: 'turn-old', input: '旧消息' }],
      true,
      contextFingerprint,
    );

    expect(reconcilePendingAssistantRequest(key, [
      { id: 'turn-old', input: '旧消息' },
      { id: 'turn-new', input: '查询客户最新状态' },
    ])).toBeNull();
    expect(readPendingAssistantRequest(key)).toBeNull();
    expect(readRecentlyCompletedAssistantRequest(key)?.requestId).toBe(request.requestId);
  });

  it('keeps a pending request when matching text only exists in its original baseline', () => {
    const key = assistantPendingStorageKey('orb', 'company-1', 'thread-1');
    const request = reserveStoredAssistantRequest(
      key,
      '重复文字',
      [{ id: 'turn-old', input: '重复文字' }],
      true,
      contextFingerprint,
    );

    expect(reconcilePendingAssistantRequest(key, [
      { id: 'turn-old', input: '重复文字' },
    ])).toEqual(request);
  });

  it('fails closed before sending when pending storage is unavailable', () => {
    const key = assistantPendingStorageKey('orb', 'company-1', 'thread-1');
    const storageTarget = Object.prototype.hasOwnProperty.call(window.localStorage, 'setItem')
      ? window.localStorage
      : Object.getPrototypeOf(window.localStorage) as Storage;
    vi.spyOn(storageTarget, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });

    expect(() =>
      reserveStoredAssistantRequest(key, '不能丢失幂等键', [], true, contextFingerprint),
    ).toThrow(AssistantOutboxStorageUnavailableError);
  });

  it('blocks a recently completed command from being replayed against another customer', () => {
    const key = assistantPendingStorageKey('orb', 'company-1', 'thread-1');
    const first = reserveStoredAssistantRequest(key, '准备报价', [], true, contextFingerprint);
    markAssistantRequestCompleted(key, first);
    const changedContext = assistantRequestContextFingerprint({
      companyId: 'company-1',
      threadId: 'thread-1',
      pathname: '/whatsapp/chat',
      whatsapp: { name: 'Buyer B', phone: '+8613812340002' },
    });

    expect(() => reserveStoredAssistantRequest(key, '准备报价', [], false, changedContext)).toThrow(
      PendingAssistantContextChangedError,
    );
  });

  it('uses a verified storage lease when LAN HTTP does not provide Web Locks', async () => {
    await expect(
      withAssistantRequestLock('thread-key', async () => 'safe-on-lan'),
    ).resolves.toBe('safe-on-lan');
    expect(
      Object.keys(window.localStorage).filter((key) => key.includes('vaysen-assistant-submit')),
    ).toEqual([]);
  });

  it('fails closed when another LAN tab owns the fallback lease', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withAssistantRequestLock('thread-key', async () => {
      await firstGate;
      return 'first';
    });
    await new Promise((resolve) => window.setTimeout(resolve, 60));

    await expect(
      withAssistantRequestLock('thread-key', async () => 'duplicate'),
    ).rejects.toBeInstanceOf(AssistantCrossTabLockBusyError);
    releaseFirst();
    await expect(first).resolves.toBe('first');
  });

  it('fails closed when fallback lease storage is unavailable', async () => {
    const storageTarget = Object.prototype.hasOwnProperty.call(window.localStorage, 'getItem')
      ? window.localStorage
      : Object.getPrototypeOf(window.localStorage) as Storage;
    vi.spyOn(storageTarget, 'getItem').mockImplementation(() => {
      throw new Error('storage denied');
    });
    await expect(
      withAssistantRequestLock('thread-key', async () => 'unsafe'),
    ).rejects.toBeInstanceOf(AssistantCrossTabLockUnavailableError);
  });

  it('uses a Web Lock to serialize concurrent submissions in order', async () => {
    let tail: Promise<unknown> = Promise.resolve();
    const request = vi.fn(
      (_name: string, _options: { mode: string }, task: () => Promise<string>) => {
        const result = tail.then(task);
        tail = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    );
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request },
    });
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withAssistantRequestLock('thread-key', async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
      return 'first';
    });
    const second = withAssistantRequestLock('thread-key', async () => {
      events.push('second:start');
      events.push('second:end');
      return 'second';
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[1]).toEqual({ mode: 'exclusive' });
  });

  it('synchronizes an active pending request from another tab through the storage event', () => {
    const key = assistantPendingStorageKey('workbench', 'company-1', 'thread-1');
    const pending = reserveAssistantRequest('跨窗口任务', [], true, contextFingerprint, null);
    const listener = vi.fn();
    const unsubscribe = subscribePendingAssistantRequest(key, listener);
    writePendingAssistantRequest(key, pending);
    window.dispatchEvent(
      new StorageEvent('storage', {
        key,
        newValue: JSON.stringify(pending),
      }),
    );

    expect(listener).toHaveBeenCalledWith(pending, null);
    unsubscribe();
  });
});
