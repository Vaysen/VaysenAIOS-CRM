import {
  computeEnrollmentStopEventDigest,
  computeEnrollmentStopOperationDigest,
  planEnrollmentStopEvent,
  type StopEventKind,
  type StopEventSourceKind,
} from './enrollment-stop-event-contract';
import { planEnrollmentTransition } from './sales-sequence-contract';

const ref = (value: string) => `ref:${value}`;
const digest = (domain: string) => `sha256:${domain}:${'a'.repeat(64)}`;

function canonicalTimestamp(value: string): string {
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/);
  return match ? `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z` : value;
}

const rules: Record<StopEventKind, { sourceKind: StopEventSourceKind; stopReason: string; to: 'exited' | 'blocked' }> = {
  REPLY_RECEIVED: { sourceKind: 'EMAIL_INBOUND', stopReason: 'reply', to: 'exited' },
  OPT_OUT_RECEIVED: { sourceKind: 'WHATSAPP_INBOUND', stopReason: 'optout', to: 'exited' },
  BLACKLIST_MATCHED: { sourceKind: 'BLACKLIST_REGISTRY', stopReason: 'blacklist', to: 'exited' },
  PERMISSION_REVOKED: { sourceKind: 'PERMISSION_REGISTRY', stopReason: 'permission_revoked', to: 'blocked' },
  CONTACT_UNTRUSTED: { sourceKind: 'CONTACT_TRUST_READER', stopReason: 'contact_untrusted', to: 'blocked' },
};

function resultCode(result: { ok: boolean; error?: { code: string } }): string {
  if (result.ok || !result.error) throw new Error('expected a rejected contract result');
  return result.error.code;
}

function snapshot(status: 'pending' | 'active' | 'paused' | 'blocked' | 'exited' | 'completed' = 'active', version = 7, contactRef: string | null = null) {
  return {
    tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'),
    leadRef: ref('lead-1'), contactRef, status, version,
  };
}

function eventInput(options: {
  eventKind?: StopEventKind;
  sourceKind?: StopEventSourceKind;
  status?: 'pending' | 'active' | 'paused';
  version?: number;
  contactRef?: string | null;
  occurredAt?: string;
  decisionNow?: string;
  eventKey?: string;
  sourceReceiptRef?: string;
  readerSnapshot?: Record<string, unknown>;
  digestPreState?: 'pending' | 'active' | 'paused';
  digestPreVersion?: number;
  operationDigestOverride?: string;
  [key: string]: unknown;
} = {}) {
  const eventKind = options.eventKind ?? 'REPLY_RECEIVED';
  const rule = rules[eventKind] ?? { sourceKind: 'EMAIL_INBOUND' as StopEventSourceKind, stopReason: 'reply', to: 'exited' as const };
  const sourceKind = options.sourceKind ?? rule.sourceKind;
  const contactRef = options.contactRef ?? null;
  const readerSnapshot = options.readerSnapshot ?? snapshot(options.status, options.version, contactRef);
  const occurredAt = options.occurredAt ?? '2026-08-03T23:59:59.999Z';
  const decisionNow = options.decisionNow ?? '2026-08-04T00:00:00.000Z';
  const eventKey = options.eventKey ?? 'stop-event:event-1';
  const sourceReceiptRef = options.sourceReceiptRef ?? 'source-receipt:receipt-1';
  const eventIntent = {
    schemaVersion: 1 as const, policyVersion: 1 as const, eventKey, eventKind, sourceKind,
    tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'),
    leadRef: ref('lead-1'), contactRef, sourceReceiptRef, occurredAt: canonicalTimestamp(occurredAt),
  };
  const eventDigest = computeEnrollmentStopEventDigest(eventIntent);
  const preState = options.digestPreState ?? ((readerSnapshot.status ?? 'active') as 'pending' | 'active' | 'paused');
  const preVersion = options.digestPreVersion ?? (readerSnapshot.version as number);
  const stopPlan = planEnrollmentTransition({
    tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'), resourceTenantRef: ref('tenant-1'),
    from: preState, to: rule.to, expectedVersion: preVersion, currentVersion: preVersion,
    intent: 'ENROLLMENT_STOP', stopReason: rule.stopReason, actorKind: 'SYSTEM', actorRole: 'SYSTEM',
    actorRef: 'system:enrollment-stop-event-reader-v1',
  });
  if (!stopPlan.ok) throw new Error('test helper could not create stop plan');
  const operationDigest = computeEnrollmentStopOperationDigest({
    ...eventIntent, eventDigest,
    preState, preVersion, postState: rule.to, postVersion: stopPlan.value.nextVersion,
    stopReason: rule.stopReason as 'reply' | 'optout' | 'blacklist' | 'permission_revoked' | 'contact_untrusted',
    stopPlanOperationDigest: stopPlan.value.operationDigest,
  });
  return {
    schemaVersion: 1,
    policyVersion: 1,
    eventKey,
    eventKind,
    sourceKind,
    tenantRef: ref('tenant-1'),
    sequenceRef: ref('sequence-1'),
    enrollmentRef: ref('enrollment-1'),
    leadRef: ref('lead-1'),
    ...(options.contactRef === undefined ? {} : { contactRef }),
    sourceReceiptRef,
    occurredAt,
    decisionNow,
    eventDigest,
    operationDigest: options.operationDigestOverride ?? operationDigest,
    readerSnapshot,
    ...Object.fromEntries(Object.entries(options).filter(([key]) => ![
      'eventKind', 'sourceKind', 'status', 'version', 'contactRef', 'occurredAt', 'decisionNow',
      'eventKey', 'sourceReceiptRef', 'readerSnapshot', 'digestPreState', 'digestPreVersion', 'operationDigestOverride',
    ].includes(key))),
  };
}

describe('CRM-03B-1 enrollment stop-event reader projection contract', () => {
  it.each(Object.keys(rules) as StopEventKind[])('maps %s only through the fixed event policy', (eventKind) => {
    const result = planEnrollmentStopEvent(eventInput({ eventKind }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rule = rules[eventKind];
    expect(result.value.stopPlan?.from).toBe('active');
    expect(result.value.stopPlan?.to).toBe(rule.to);
    expect(result.value.stopPlan?.stopReason).toBe(rule.stopReason);
    expect(result.value.stopPlan?.actorKind).toBe('SYSTEM');
    expect(result.value.stopPlan?.actorRole).toBe('SYSTEM');
    expect(result.value.stopPlan?.decision).toBe('PLAN_ONLY');
    expect(result.value.stopPlan?.sendCommand).toBeNull();
    expect(result.value.receiptToPersist?.eventKind).toBe(eventKind);
  });

  it.each(['pending', 'active', 'paused'] as const)('stops every non-terminal reader state: %s', (status) => {
    const result = planEnrollmentStopEvent(eventInput({ status }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.stopPlan?.from).toBe(status);
  });

  it.each(['blocked', 'exited', 'completed'] as const)('rejects terminal reader state %s before replay', (status) => {
    const base = eventInput();
    const result = planEnrollmentStopEvent({ ...base, readerSnapshot: { ...snapshot(), status } });
    expect(resultCode(result)).toBe('TERMINAL_ENROLLMENT');
  });

  it('accepts a null contact scope only when the reader snapshot is also null', () => {
    const result = planEnrollmentStopEvent(eventInput({ contactRef: null }));
    expect(result.ok).toBe(true);
    const mismatch = planEnrollmentStopEvent(eventInput({ contactRef: null, readerSnapshot: snapshot('active', 7, ref('contact-1')) }));
    expect(resultCode(mismatch)).toBe('SCOPE_MISMATCH');
  });

  it('rejects event/source confusion and client-supplied stop authority', () => {
    const wrongSource = planEnrollmentStopEvent(eventInput({ eventKind: 'BLACKLIST_MATCHED', sourceKind: 'EMAIL_INBOUND' }));
    const unknownEvent = planEnrollmentStopEvent(eventInput({ eventKind: 'UNKNOWN_EVENT' as StopEventKind }));
    const clientReason = planEnrollmentStopEvent({ ...eventInput(), stopReason: 'optout' });
    const clientTarget = planEnrollmentStopEvent({ ...eventInput(), to: 'blocked' });
    expect(resultCode(wrongSource)).toBe('EVENT_SOURCE_MISMATCH');
    expect(resultCode(unknownEvent)).toBe('INVALID_EVENT_KIND');
    expect(resultCode(clientReason)).toBe('UNKNOWN_FIELD');
    expect(resultCode(clientTarget)).toBe('UNKNOWN_FIELD');
  });

  it('rejects cross tenant/sequence/enrollment/lead/contact scopes', () => {
    const scopeCases: Array<[string, Record<string, unknown>]> = [
      ['tenantRef', { tenantRef: ref('tenant-2') }],
      ['sequenceRef', { sequenceRef: ref('sequence-2') }],
      ['enrollmentRef', { enrollmentRef: ref('enrollment-2') }],
      ['leadRef', { leadRef: ref('lead-2') }],
      ['contactRef', { contactRef: ref('contact-2') }],
    ];
    for (const [key, change] of scopeCases) {
      const input = eventInput({ contactRef: ref('contact-1'), readerSnapshot: snapshot('active', 7, ref('contact-1')) });
      const result = planEnrollmentStopEvent({ ...input, ...change });
      expect(resultCode(result)).toBe('SCOPE_MISMATCH');
    }
  });

  it('rejects invalid, rolled-back, and future UTC timestamps while accepting the exact boundary', () => {
    const invalidCalendar = planEnrollmentStopEvent({ ...eventInput(), occurredAt: '2026-02-31T00:00:00Z' });
    const invalidLeap = planEnrollmentStopEvent({ ...eventInput(), occurredAt: '2025-02-29T00:00:00Z' });
    const future = planEnrollmentStopEvent(eventInput({ occurredAt: '2026-08-04T00:00:00.001Z', decisionNow: '2026-08-04T00:00:00.000Z' }));
    const boundary = planEnrollmentStopEvent(eventInput({ occurredAt: '2026-08-04T00:00:00Z', decisionNow: '2026-08-04T00:00:00Z' }));
    expect(resultCode(invalidCalendar)).toBe('INVALID_TIMESTAMP');
    expect(resultCode(invalidLeap)).toBe('INVALID_TIMESTAMP');
    expect(resultCode(future)).toBe('FUTURE_EVENT');
    expect(boundary.ok).toBe(true);
  });

  it('recomputes event and operation digests and excludes decisionNow', () => {
    const base = eventInput();
    const basePlan = planEnrollmentStopEvent(base);
    const laterDecision = planEnrollmentStopEvent({ ...base, decisionNow: '2026-08-05T00:00:00.000Z' });
    expect(basePlan.ok && laterDecision.ok && basePlan.value.operationDigest).toBe(laterDecision.ok ? laterDecision.value.operationDigest : undefined);
    expect(computeEnrollmentStopEventDigest({
      schemaVersion: 1, policyVersion: 1, eventKey: base.eventKey, eventKind: 'REPLY_RECEIVED', sourceKind: 'EMAIL_INBOUND',
      tenantRef: base.tenantRef, sequenceRef: base.sequenceRef, enrollmentRef: base.enrollmentRef, leadRef: base.leadRef,
      contactRef: null, sourceReceiptRef: base.sourceReceiptRef, occurredAt: '2026-08-03T23:59:59.999Z',
    })).not.toBe(computeEnrollmentStopEventDigest({
      schemaVersion: 1, policyVersion: 1, eventKey: base.eventKey, eventKind: 'REPLY_RECEIVED', sourceKind: 'EMAIL_INBOUND',
      tenantRef: base.tenantRef, sequenceRef: base.sequenceRef, enrollmentRef: base.enrollmentRef, leadRef: base.leadRef,
      contactRef: null, sourceReceiptRef: 'source-receipt:receipt-2', occurredAt: '2026-08-03T23:59:59.999Z',
    }));
    expect(computeEnrollmentStopOperationDigest({
      schemaVersion: 1, policyVersion: 1, eventDigest: base.eventDigest, eventKey: base.eventKey, eventKind: 'REPLY_RECEIVED', sourceKind: 'EMAIL_INBOUND',
      tenantRef: base.tenantRef, sequenceRef: base.sequenceRef, enrollmentRef: base.enrollmentRef, leadRef: base.leadRef, contactRef: null,
      sourceReceiptRef: base.sourceReceiptRef, occurredAt: '2026-08-03T23:59:59.999Z', preState: 'active', preVersion: 7, postState: 'exited', postVersion: 8, stopReason: 'reply',
      stopPlanOperationDigest: (basePlan.ok ? basePlan.value.stopPlan?.operationDigest : undefined) as string,
    })).not.toBe(computeEnrollmentStopOperationDigest({
      schemaVersion: 1, policyVersion: 1, eventDigest: base.eventDigest, eventKey: base.eventKey, eventKind: 'REPLY_RECEIVED', sourceKind: 'EMAIL_INBOUND',
      tenantRef: base.tenantRef, sequenceRef: base.sequenceRef, enrollmentRef: base.enrollmentRef, leadRef: base.leadRef, contactRef: null,
      sourceReceiptRef: base.sourceReceiptRef, occurredAt: '2026-08-03T23:59:59.999Z', preState: 'active', preVersion: 8, postState: 'exited', postVersion: 9, stopReason: 'reply',
      stopPlanOperationDigest: (basePlan.ok ? basePlan.value.stopPlan?.operationDigest : undefined) as string,
    }));
  });

  it('rejects digest tampering and malformed opaque/raw inputs', () => {
    const eventTampered = planEnrollmentStopEvent({ ...eventInput(), eventDigest: digest('tampered') });
    const operationTampered = planEnrollmentStopEvent({ ...eventInput(), operationDigest: digest('tampered') });
    const badReceipt = planEnrollmentStopEvent({ ...eventInput(), sourceReceiptRef: 'https://provider.invalid/message/1' });
    const piiReceipt = planEnrollmentStopEvent({ ...eventInput(), sourceReceiptRef: 'source-receipt:8613812345678' });
    const rawPayload = planEnrollmentStopEvent({ ...eventInput(), providerPayload: { body: 'raw' } });
    const aiMetadata = planEnrollmentStopEvent({ ...eventInput(), aiConfidence: 0.99, aiStatus: 'CONFIRMED' });
    expect(resultCode(eventTampered)).toBe('EVENT_DIGEST_MISMATCH');
    expect(resultCode(operationTampered)).toBe('OPERATION_DIGEST_MISMATCH');
    expect(resultCode(badReceipt)).toBe('INVALID_REF');
    expect(resultCode(piiReceipt)).toBe('INVALID_REF');
    expect(resultCode(rawPayload)).toBe('UNKNOWN_FIELD');
    expect(resultCode(aiMetadata)).toBe('UNKNOWN_FIELD');
  });

  it('replays only from the exact persisted post-state and rejects receipt conflicts', () => {
    const first = planEnrollmentStopEvent(eventInput());
    expect(first.ok).toBe(true);
    if (!first.ok || !first.value.receiptToPersist) return;
    const base = eventInput();
    const replay = planEnrollmentStopEvent({
      ...base,
      readerSnapshot: { ...base.readerSnapshot, status: 'exited', version: 8 },
      persistedReceipt: first.value.receiptToPersist,
    });
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.decision).toBe('REPLAY');
      expect(replay.value.stopPlan).toBeNull();
      expect(replay.value.receiptToPersist).toBeNull();
    }
    const sameKeyDifferentDigest = planEnrollmentStopEvent({ ...base, readerSnapshot: { ...base.readerSnapshot, status: 'exited', version: 8 }, persistedReceipt: { ...first.value.receiptToPersist, operationDigest: digest('other') } });
    const sameDigestDifferentKey = planEnrollmentStopEvent({ ...base, readerSnapshot: { ...base.readerSnapshot, status: 'exited', version: 8 }, persistedReceipt: { ...first.value.receiptToPersist, eventKey: 'stop-event:event-2' } });
    const preStateWithReceipt = planEnrollmentStopEvent({ ...base, persistedReceipt: first.value.receiptToPersist });
    const wrongTerminal = planEnrollmentStopEvent({ ...base, readerSnapshot: { ...base.readerSnapshot, status: 'completed', version: 8 }, persistedReceipt: first.value.receiptToPersist });
    const changedSnapshot = planEnrollmentStopEvent({ ...base, readerSnapshot: { ...base.readerSnapshot, status: 'exited', version: 9 }, persistedReceipt: first.value.receiptToPersist });
    expect(resultCode(sameKeyDifferentDigest)).toBe('INVALID_RECEIPT');
    expect(resultCode(sameDigestDifferentKey)).toBe('INVALID_RECEIPT');
    expect(resultCode(preStateWithReceipt)).toBe('REPLAY_STATE_MISMATCH');
    expect(resultCode(wrongTerminal)).toBe('REPLAY_STATE_MISMATCH');
    expect(resultCode(changedSnapshot)).toBe('REPLAY_STATE_MISMATCH');
  });

  it('replays a blocked post-state and rejects every receipt integrity mutation', () => {
    const first = planEnrollmentStopEvent(eventInput({ eventKind: 'PERMISSION_REVOKED' }));
    expect(first.ok).toBe(true);
    if (!first.ok || !first.value.receiptToPersist) return;
    const base = eventInput({ eventKind: 'PERMISSION_REVOKED' });
    const replay = planEnrollmentStopEvent({
      ...base,
      readerSnapshot: { ...base.readerSnapshot, status: 'blocked', version: 8 },
      persistedReceipt: first.value.receiptToPersist,
    });
    expect(replay.ok && replay.value.decision).toBe('REPLAY');
    const receipt = first.value.receiptToPersist;
    const mutations = [
      { preState: 'pending' as const },
      { preVersion: 6 },
      { postState: 'exited' as const },
      { postVersion: 9 },
      { stopPlanOperationDigest: digest('tampered-plan') },
      { receiptRef: 'stop-event-receipt:' + 'b'.repeat(32) },
      { eventKind: 'OPT_OUT_RECEIVED' as const },
    ];
    for (const mutation of mutations) {
      const result = planEnrollmentStopEvent({
        ...base,
        readerSnapshot: { ...base.readerSnapshot, status: 'blocked', version: 8 },
        persistedReceipt: { ...receipt, ...mutation },
      });
      expect(resultCode(result)).toBe('INVALID_RECEIPT');
    }
  });

  it('validates scope/event/terminal rules before allowing a persisted replay', () => {
    const first = planEnrollmentStopEvent(eventInput());
    expect(first.ok).toBe(true);
    if (!first.ok || !first.value.receiptToPersist) return;
    const crossScope = planEnrollmentStopEvent({ ...eventInput({ tenantRef: ref('not-used') }), tenantRef: ref('tenant-2'), persistedReceipt: first.value.receiptToPersist });
    const invalidEvent = planEnrollmentStopEvent({ ...eventInput({ eventKind: 'UNKNOWN_EVENT' as StopEventKind }), persistedReceipt: first.value.receiptToPersist });
    const terminalBase = eventInput();
    const terminal = planEnrollmentStopEvent({ ...terminalBase, readerSnapshot: { ...terminalBase.readerSnapshot, status: 'exited' }, persistedReceipt: first.value.receiptToPersist });
    expect(resultCode(crossScope)).toBe('SCOPE_MISMATCH');
    expect(resultCode(invalidEvent)).toBe('INVALID_EVENT_KIND');
    expect(resultCode(terminal)).toBe('REPLAY_STATE_MISMATCH');
  });

  it('is deterministic, JSON-safe, and recursively freezes success and failure output', () => {
    const first = planEnrollmentStopEvent(eventInput());
    const reordered = planEnrollmentStopEvent({ ...eventInput(), readerSnapshot: { version: 7, status: 'active', contactRef: null, leadRef: ref('lead-1'), enrollmentRef: ref('enrollment-1'), sequenceRef: ref('sequence-1'), tenantRef: ref('tenant-1') } });
    expect(first.ok && reordered.ok && first.value.operationDigest).toBe(reordered.ok ? reordered.value.operationDigest : undefined);
    expect(Object.isFrozen(first)).toBe(true);
    if (first.ok) {
      expect(Object.isFrozen(first.value)).toBe(true);
      expect(Object.isFrozen(first.value.stopPlan)).toBe(true);
      expect(Object.isFrozen(first.value.stopPlan?.actorRef)).toBe(true);
      expect(Object.isFrozen(first.value.receiptToPersist)).toBe(true);
    }
    const failure = planEnrollmentStopEvent({ ...eventInput(), eventKind: undefined });
    expect(Object.isFrozen(failure)).toBe(true);
    if (!failure.ok) expect(Object.isFrozen(failure.error)).toBe(true);
  });
});
