import {
  classifySalesSequenceIdempotency,
  computeSalesSequenceOperationDigest,
  normalizeEnrollment,
  normalizeSequence,
  planEnrollmentTransition,
  planNewStepExecution,
  planSequenceTransition,
  planStepExecutionTransition,
  planStepTransition,
  type OperationIntent,
} from './sales-sequence-contract';

const ref = (value: string) => `ref:${value}`;
const digest = (domain: string) => `sha256:${domain}:${'a'.repeat(64)}`;

function resultCode(result: { ok: boolean; error?: { code: string } }): string {
  if (result.ok || !result.error) throw new Error('expected a rejected contract result');
  return result.error.code;
}

function executionInput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    executionRef: ref('execution-1'),
    tenantRef: ref('tenant-1'),
    sequenceRef: ref('sequence-1'),
    enrollmentRef: ref('enrollment-1'),
    stepRef: ref('step-1'),
    stepVersion: 1,
    expectedVersion: 1,
    idempotencyKey: ref('idempotency-1'),
    intent: 'CREATE_DRAFT',
    ...overrides,
  };
}

function transitionInput(overrides: Record<string, unknown> = {}) {
  return {
    executionRef: ref('execution-1'),
    tenantRef: ref('tenant-1'),
    sequenceRef: ref('sequence-1'),
    enrollmentRef: ref('enrollment-1'),
    stepRef: ref('step-1'),
    stepVersion: 1,
    from: 'draft_pending',
    to: 'draft_ready',
    expectedVersion: 1,
    currentVersion: 1,
    intent: 'REVIEW_DRAFT',
    actorKind: 'HUMAN',
    actorRole: 'SALES',
    actorRef: ref('actor-1'),
    ...overrides,
  };
}

describe('CRM-03A-1 sales sequence pure contract', () => {
  it('normalizes a complete sequence deterministically and forces manual approval', () => {
    const result = normalizeSequence({
      schemaVersion: 1,
      sequenceRef: ref('sequence-1'),
      tenantRef: ref('tenant-1'),
      name: 'Outbound pilot',
      version: 1,
      timezone: 'Asia/Shanghai',
      steps: [
        { stepRef: ref('step-2'), position: 2, channel: 'WHATSAPP', delaySeconds: 3600, templateRef: ref('template-2') },
        { stepRef: ref('step-1'), position: 1, channel: 'EMAIL', delaySeconds: 0, templateRef: ref('template-1'), requiresApproval: true },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.steps.map((step) => step.position)).toEqual([1, 2]);
    expect(result.value.executionMode).toBe('DRAFT_ONLY');
    expect(result.value.approvalPolicy).toBe('MANUAL_PER_STEP');
    expect(result.value.steps.every((step) => step.requiresApproval)).toBe(true);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.steps[0])).toBe(true);
  });

  it.each([
    ['draft', 'paused'], ['active', 'draft'], ['archived', 'active'], ['archived', 'paused'],
  ])('rejects illegal sequence transition %s -> %s', (from, to) => {
    const result = planSequenceTransition({
      tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), resourceTenantRef: ref('tenant-1'),
      from, to, expectedVersion: 1, currentVersion: 1, intent: 'LIFECYCLE',
    });
    expect(resultCode(result)).toBe('ILLEGAL_TRANSITION');
  });

  it('rejects cross-tenant and CAS-conflicting lifecycle plans', () => {
    const crossTenant = planSequenceTransition({
      tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), resourceTenantRef: ref('tenant-2'),
      from: 'draft', to: 'active', expectedVersion: 1, currentVersion: 1, intent: 'LIFECYCLE',
    });
    const casConflict = planStepTransition({
      tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), resourceTenantRef: ref('tenant-1'), stepRef: ref('step-1'),
      from: 'draft', to: 'active', expectedVersion: 2, currentVersion: 1, intent: 'STEP_ACTIVATE', actorKind: 'HUMAN', actorRole: 'SALES', actorRef: ref('actor-1'),
    });
    expect(resultCode(crossTenant)).toBe('INVALID_REF');
    expect(resultCode(casConflict)).toBe('VERSION_MISMATCH');
  });

  it('normalizes basic enrollment without evidence and marks it non-personalized', () => {
    const result = normalizeEnrollment({
      schemaVersion: 1, enrollmentRef: ref('enrollment-1'), tenantRef: ref('tenant-1'),
      sequenceRef: ref('sequence-1'), leadRef: ref('lead-1'), version: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.evidencePersonalized).toBe(false);
  });

  it('accepts only a verified CustomerFact digest snapshot for evidence personalization', () => {
    const result = normalizeEnrollment({
      schemaVersion: 1, enrollmentRef: ref('enrollment-1'), tenantRef: ref('tenant-1'),
      sequenceRef: ref('sequence-1'), leadRef: ref('lead-1'), version: 1,
      factSnapshot: {
        factRef: ref('fact-1'), snapshotRef: ref('snapshot-1'),
        normalizedValueDigest: digest('fact-value-v1'), version: 2, status: 'CONFIRMED',
        verifiedAt: '2026-08-04T00:00:00Z',
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.evidencePersonalized).toBe(true);
    const untrusted = normalizeEnrollment({
      schemaVersion: 1, enrollmentRef: ref('enrollment-1'), tenantRef: ref('tenant-1'),
      sequenceRef: ref('sequence-1'), leadRef: ref('lead-1'), version: 1,
      factSnapshot: { factRef: ref('fact-1'), snapshotRef: ref('snapshot-1'), normalizedValueDigest: digest('fact-value-v1'), version: 2, status: 'PROPOSED', verifiedAt: '2026-08-04T00:00:00Z' },
    });
    expect(resultCode(untrusted)).toBe('INVALID_FACT_SNAPSHOT');
  });

  it.each([
    ['reply', 'exited'], ['optout', 'exited'], ['blacklist', 'exited'],
    ['permission_revoked', 'blocked'], ['contact_untrusted', 'blocked'],
  ])('atomically stops enrollment for %s', (stopReason, to) => {
    const result = planEnrollmentTransition({
      tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'), resourceTenantRef: ref('tenant-1'),
      from: 'active', to, expectedVersion: 1, currentVersion: 1, intent: 'ENROLLMENT_STOP', stopReason, actorKind: 'HUMAN', actorRole: 'SALES', actorRef: ref('actor-1'),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.sendCommand).toBeNull();
  });

  it('rejects a terminal enrollment continuation and mismatched stop state', () => {
    const terminal = planEnrollmentTransition({
      tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'), resourceTenantRef: ref('tenant-1'),
      from: 'exited', to: 'active', expectedVersion: 1, currentVersion: 1, intent: 'ENROLLMENT_RESUME', actorKind: 'HUMAN', actorRole: 'SALES', actorRef: ref('actor-1'),
    });
    const mismatch = planEnrollmentTransition({
      tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'), resourceTenantRef: ref('tenant-1'),
      from: 'active', to: 'blocked', expectedVersion: 1, currentVersion: 1, intent: 'ENROLLMENT_STOP', stopReason: 'reply', actorKind: 'HUMAN', actorRole: 'SALES', actorRef: ref('actor-1'),
    });
    expect(resultCode(terminal)).toBe('ILLEGAL_TRANSITION');
    expect(resultCode(mismatch)).toBe('STOP_REASON_MISMATCH');
  });

  it('creates a draft-only execution plan with a bound operation digest and next version', () => {
    const result = planNewStepExecution(executionInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('draft_pending');
    expect(result.value.expectedVersion).toBe(1);
    expect(result.value.nextVersion).toBe(2);
    expect(result.value.operationDigest).toMatch(/^sha256:sales-sequence-v1:[0-9a-f]{64}$/);
    expect(result.value.sendCommand).toBeNull();
    expect(Object.isFrozen(result.value.receiptToPersist)).toBe(true);
  });

  it('rejects non-create intent for NEW and rejects every mismatched execution action intent', () => {
    const newReview = planNewStepExecution(executionInput({ intent: 'REVIEW_DRAFT' }));
    const wrongReview = planStepExecutionTransition(transitionInput({ from: 'draft_pending', to: 'draft_ready', intent: 'CREATE_DRAFT' }));
    const wrongSend = planStepExecutionTransition(transitionInput({ from: 'approved', to: 'sending', intent: 'REVIEW_DRAFT', actorKind: 'FUTURE_EXTERNAL_EXECUTOR', actorRole: 'SYSTEM', outboxCas: 'MATCHED', approvalReceiptRef: 'approval-receipt:approval-1', outboxReceiptRef: 'outbox-receipt:outbox-1' }));
    expect(resultCode(newReview)).toBe('INVALID_INTENT');
    expect(resultCode(wrongReview)).toBe('INVALID_INTENT');
    expect(resultCode(wrongSend)).toBe('INVALID_INTENT');
  });

  it('walks draft -> approval -> approved without producing a send command', () => {
    const states: Array<[string, string, number, Record<string, unknown>]> = [
      ['draft_pending', 'draft_ready', 1, {}],
      ['draft_ready', 'approval_required', 2, {}],
      ['approval_required', 'approved', 3, { actorKind: 'HUMAN', actorRole: 'SALES', approvalReceiptRef: 'approval-receipt:approval-1' }],
    ];
    for (const [from, to, version, extra] of states) {
      const result = planStepExecutionTransition(transitionInput({ from, to, expectedVersion: version, currentVersion: version, ...extra }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.sendCommand).toBeNull();
    }
  });

  it('rejects AI/viewer approval, pre-approval sending, and provider acceptance as SENT', () => {
    const ai = planStepExecutionTransition(transitionInput({ from: 'approval_required', to: 'approved', expectedVersion: 3, currentVersion: 3, actorKind: 'AI', actorRole: 'ADMIN', approvalReceiptRef: 'approval-receipt:approval-1' }));
    const viewer = planStepExecutionTransition(transitionInput({ from: 'approval_required', to: 'approved', expectedVersion: 3, currentVersion: 3, actorKind: 'HUMAN', actorRole: 'VIEWER', approvalReceiptRef: 'approval-receipt:approval-1' }));
    const beforeApproval = planStepExecutionTransition(transitionInput({ from: 'approval_required', to: 'sending', expectedVersion: 3, currentVersion: 3, intent: 'SEND_AFTER_APPROVAL', actorKind: 'FUTURE_EXTERNAL_EXECUTOR', actorRole: 'SYSTEM', outboxCas: 'MATCHED', approvalReceiptRef: 'approval-receipt:approval-1', outboxReceiptRef: 'outbox-receipt:outbox-1' }));
    const providerOnly = planStepExecutionTransition(transitionInput({ from: 'sending', to: 'sent', expectedVersion: 5, currentVersion: 5, intent: 'SEND_AFTER_APPROVAL', actorKind: 'FUTURE_EXTERNAL_EXECUTOR', actorRole: 'SYSTEM', providerReceiptRef: 'provider-receipt:provider-1' }));
    expect(resultCode(ai)).toBe('AI_PROPOSAL_NOT_AUTHORITATIVE');
    expect(resultCode(viewer)).toBe('AI_PROPOSAL_NOT_AUTHORITATIVE');
    expect(resultCode(beforeApproval)).toBe('ILLEGAL_TRANSITION');
    expect(resultCode(providerOnly)).toBe('PROVIDER_RECEIPT_NOT_BUSINESS_SENT');
  });

  it('requires outbox CAS and permits SENT only with business projection receipt', () => {
    const noCas = planStepExecutionTransition(transitionInput({ from: 'approved', to: 'sending', expectedVersion: 4, currentVersion: 4, intent: 'SEND_AFTER_APPROVAL', actorKind: 'FUTURE_EXTERNAL_EXECUTOR', actorRole: 'SYSTEM', approvalReceiptRef: 'approval-receipt:approval-1', outboxReceiptRef: 'outbox-receipt:outbox-1' }));
    const sent = planStepExecutionTransition(transitionInput({ from: 'sending', to: 'sent', expectedVersion: 5, currentVersion: 5, intent: 'SEND_AFTER_APPROVAL', actorKind: 'FUTURE_EXTERNAL_EXECUTOR', actorRole: 'SYSTEM', providerReceiptRef: 'provider-receipt:provider-1', businessReceiptRef: 'business-receipt:business-1' }));
    expect(resultCode(noCas)).toBe('OUTBOX_CAS_REQUIRED');
    expect(sent.ok).toBe(true);
    if (sent.ok) {
      expect(sent.value.decision).toBe('PLAN_ONLY');
      expect(sent.value.evidence).toEqual({ providerReceiptRef: 'provider-receipt:provider-1', businessReceiptRef: 'business-receipt:business-1' });
      expect(Object.isFrozen(sent.value.evidence)).toBe(true);
    }
  });

  it('returns only action-relevant verified evidence and binds every receipt dimension', () => {
    const approvedA = planStepExecutionTransition(transitionInput({ from: 'approval_required', to: 'approved', expectedVersion: 3, currentVersion: 3, approvalReceiptRef: 'approval-receipt:approval-1' }));
    const approvedB = planStepExecutionTransition(transitionInput({ from: 'approval_required', to: 'approved', expectedVersion: 3, currentVersion: 3, approvalReceiptRef: 'approval-receipt:approval-2' }));
    const sendingA = planStepExecutionTransition(transitionInput({ from: 'approved', to: 'sending', expectedVersion: 4, currentVersion: 4, intent: 'SEND_AFTER_APPROVAL', actorKind: 'FUTURE_EXTERNAL_EXECUTOR', actorRole: 'SYSTEM', approvalReceiptRef: 'approval-receipt:approval-1', outboxReceiptRef: 'outbox-receipt:outbox-1', outboxCas: 'MATCHED' }));
    const sendingApprovalB = planStepExecutionTransition(transitionInput({ from: 'approved', to: 'sending', expectedVersion: 4, currentVersion: 4, intent: 'SEND_AFTER_APPROVAL', actorKind: 'FUTURE_EXTERNAL_EXECUTOR', actorRole: 'SYSTEM', approvalReceiptRef: 'approval-receipt:approval-2', outboxReceiptRef: 'outbox-receipt:outbox-1', outboxCas: 'MATCHED' }));
    const sendingOutboxB = planStepExecutionTransition(transitionInput({ from: 'approved', to: 'sending', expectedVersion: 4, currentVersion: 4, intent: 'SEND_AFTER_APPROVAL', actorKind: 'FUTURE_EXTERNAL_EXECUTOR', actorRole: 'SYSTEM', approvalReceiptRef: 'approval-receipt:approval-1', outboxReceiptRef: 'outbox-receipt:outbox-2', outboxCas: 'MATCHED' }));
    const sentA = planStepExecutionTransition(transitionInput({ from: 'sending', to: 'sent', expectedVersion: 5, currentVersion: 5, intent: 'SEND_AFTER_APPROVAL', actorKind: 'FUTURE_EXTERNAL_EXECUTOR', actorRole: 'SYSTEM', providerReceiptRef: 'provider-receipt:provider-1', businessReceiptRef: 'business-receipt:business-1' }));
    const sentProviderB = planStepExecutionTransition(transitionInput({ from: 'sending', to: 'sent', expectedVersion: 5, currentVersion: 5, intent: 'SEND_AFTER_APPROVAL', actorKind: 'FUTURE_EXTERNAL_EXECUTOR', actorRole: 'SYSTEM', providerReceiptRef: 'provider-receipt:provider-2', businessReceiptRef: 'business-receipt:business-1' }));
    const sentBusinessB = planStepExecutionTransition(transitionInput({ from: 'sending', to: 'sent', expectedVersion: 5, currentVersion: 5, intent: 'SEND_AFTER_APPROVAL', actorKind: 'FUTURE_EXTERNAL_EXECUTOR', actorRole: 'SYSTEM', providerReceiptRef: 'provider-receipt:provider-1', businessReceiptRef: 'business-receipt:business-2' }));
    const badCas = planStepExecutionTransition(transitionInput({ from: 'approved', to: 'sending', expectedVersion: 4, currentVersion: 4, intent: 'SEND_AFTER_APPROVAL', actorKind: 'FUTURE_EXTERNAL_EXECUTOR', actorRole: 'SYSTEM', approvalReceiptRef: 'approval-receipt:approval-1', outboxReceiptRef: 'outbox-receipt:outbox-1', outboxCas: 'MISMATCHED' }));
    const unrelatedEvidence = planStepExecutionTransition(transitionInput({ providerReceiptRef: 'provider-receipt:provider-1' }));

    expect(approvedA.ok && approvedB.ok && approvedA.value.operationDigest).not.toBe(approvedB.ok ? approvedB.value.operationDigest : undefined);
    expect(sendingA.ok && sendingApprovalB.ok && sendingA.value.operationDigest).not.toBe(sendingApprovalB.ok ? sendingApprovalB.value.operationDigest : undefined);
    expect(sendingA.ok && sendingOutboxB.ok && sendingA.value.operationDigest).not.toBe(sendingOutboxB.ok ? sendingOutboxB.value.operationDigest : undefined);
    expect(sentA.ok && sentProviderB.ok && sentA.value.operationDigest).not.toBe(sentProviderB.ok ? sentProviderB.value.operationDigest : undefined);
    expect(sentA.ok && sentBusinessB.ok && sentA.value.operationDigest).not.toBe(sentBusinessB.ok ? sentBusinessB.value.operationDigest : undefined);
    expect(approvedA.ok && approvedA.value.evidence).toEqual({ approvalReceiptRef: 'approval-receipt:approval-1' });
    expect(sendingA.ok && sendingA.value.evidence).toEqual({ approvalReceiptRef: 'approval-receipt:approval-1', outboxReceiptRef: 'outbox-receipt:outbox-1', outboxCas: 'MATCHED' });
    expect(sentA.ok && sentA.value.evidence).toEqual({ providerReceiptRef: 'provider-receipt:provider-1', businessReceiptRef: 'business-receipt:business-1' });
    expect(approvedA.ok && Object.isFrozen(approvedA.value.evidence)).toBe(true);
    expect(sendingA.ok && Object.isFrozen(sendingA.value.evidence)).toBe(true);
    expect(sentA.ok && Object.isFrozen(sentA.value.evidence)).toBe(true);
    const nonEvidence = planStepExecutionTransition(transitionInput());
    expect(nonEvidence.ok && Object.prototype.hasOwnProperty.call(nonEvidence.value, 'evidence')).toBe(false);
    expect(resultCode(badCas)).toBe('OUTBOX_CAS_REQUIRED');
    expect(resultCode(unrelatedEvidence)).toBe('CLIENT_RECEIPT_FORBIDDEN');
  });

  it('refuses failed or unknown automatic retry', () => {
    const failed = planStepExecutionTransition(transitionInput({ from: 'failed', to: 'sending', expectedVersion: 6, currentVersion: 6, actorKind: 'FUTURE_EXTERNAL_EXECUTOR', actorRole: 'SYSTEM', outboxCas: 'MATCHED', approvalReceiptRef: 'approval-receipt:approval-1', outboxReceiptRef: 'outbox-receipt:outbox-1' }));
    const unknown = planStepExecutionTransition(transitionInput({ from: 'unknown', to: 'sent', expectedVersion: 6, currentVersion: 6, actorKind: 'FUTURE_EXTERNAL_EXECUTOR', actorRole: 'SYSTEM', providerReceiptRef: 'provider-receipt:provider-1', businessReceiptRef: 'business-receipt:business-1' }));
    expect(['ILLEGAL_TRANSITION', 'UNKNOWN_RETRY_FORBIDDEN']).toContain(resultCode(failed));
    expect(['ILLEGAL_TRANSITION', 'UNKNOWN_RETRY_FORBIDDEN']).toContain(resultCode(unknown));
  });

  it('distinguishes exact replay from intent conflict and binds all operation dimensions', () => {
    const intent: OperationIntent = { schemaVersion: 1, tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'), stepRef: ref('step-1'), stepVersion: 1, expectedVersion: 1, intent: 'CREATE_DRAFT' };
    const operationDigest = computeSalesSequenceOperationDigest(intent);
    const replay = classifySalesSequenceIdempotency({ idempotencyKey: ref('idempotency-1'), operationDigest, persisted: { idempotencyKey: ref('idempotency-1'), operationDigest } });
    const conflict = classifySalesSequenceIdempotency({ idempotencyKey: ref('idempotency-1'), operationDigest, persisted: { idempotencyKey: ref('idempotency-1'), operationDigest: digest('other') } });
    const crossTenant = computeSalesSequenceOperationDigest({ ...intent, tenantRef: ref('tenant-2') });
    expect(replay.ok && replay.value.decision).toBe('EXACT_REPLAY');
    expect(conflict.ok && conflict.value.decision).toBe('INTENT_CONFLICT');
    expect(crossTenant).not.toBe(operationDigest);
  });

  it('fails closed for unknown fields, undefined, PII-like inputs, duplicate positions, bad timezone and negative delay', () => {
    const unknown = normalizeSequence({
      schemaVersion: 1, sequenceRef: ref('sequence-1'), tenantRef: ref('tenant-1'), name: 'x', version: 1, timezone: 'UTC',
      steps: [{ stepRef: ref('step-1'), position: 1, channel: 'EMAIL', delaySeconds: 0, templateRef: ref('template-1'), subject: 'hidden' }],
    });
    const explicitUndefined = normalizeSequence({
      schemaVersion: 1, sequenceRef: ref('sequence-1'), tenantRef: ref('tenant-1'), name: 'x', version: 1, timezone: 'UTC',
      steps: [{ stepRef: ref('step-1'), position: 1, channel: 'EMAIL', delaySeconds: 0, templateRef: ref('template-1') }], state: undefined,
    });
    const pii = normalizeEnrollment({ schemaVersion: 1, enrollmentRef: ref('enrollment-1'), tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), leadRef: 'person@example.com', version: 1 });
    const duplicate = normalizeSequence({ schemaVersion: 1, sequenceRef: ref('sequence-1'), tenantRef: ref('tenant-1'), name: 'x', version: 1, timezone: 'UTC', steps: [{ stepRef: ref('step-1'), position: 1, channel: 'EMAIL', delaySeconds: 0, templateRef: ref('template-1') }, { stepRef: ref('step-2'), position: 1, channel: 'WHATSAPP', delaySeconds: 1, templateRef: ref('template-2') }] });
    const badTimezone = normalizeSequence({ schemaVersion: 1, sequenceRef: ref('sequence-1'), tenantRef: ref('tenant-1'), name: 'x', version: 1, timezone: '+08:00', steps: [{ stepRef: ref('step-1'), position: 1, channel: 'EMAIL', delaySeconds: 0, templateRef: ref('template-1') }] });
    const negativeDelay = normalizeSequence({ schemaVersion: 1, sequenceRef: ref('sequence-1'), tenantRef: ref('tenant-1'), name: 'x', version: 1, timezone: 'UTC', steps: [{ stepRef: ref('step-1'), position: 1, channel: 'EMAIL', delaySeconds: -1, templateRef: ref('template-1') }] });
    expect(resultCode(unknown)).toBe('PII_OR_SECRET_INPUT');
    expect(resultCode(explicitUndefined)).toBe('EXPLICIT_UNDEFINED');
    expect(resultCode(pii)).toBe('PII_OR_SECRET_INPUT');
    expect(resultCode(duplicate)).toBe('DUPLICATE_POSITION');
    expect(resultCode(badTimezone)).toBe('INVALID_TIMEZONE');
    expect(resultCode(negativeDelay)).toBe('INVALID_DELAY');
  });

  it('rejects UTC calendar rollovers and accepts leap/day/millisecond boundaries canonically', () => {
    const make = (nextActionAt: string) => normalizeEnrollment({
      schemaVersion: 1, enrollmentRef: ref('enrollment-1'), tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), leadRef: ref('lead-1'), version: 1, nextActionAt,
    });
    expect(resultCode(make('2026-02-29T00:00:00Z'))).toBe('INVALID_TIMESTAMP');
    expect(resultCode(make('2026-02-02T24:00:00Z'))).toBe('INVALID_TIMESTAMP');
    expect(resultCode(make('2026-04-31T00:00:00Z'))).toBe('INVALID_TIMESTAMP');
    expect(resultCode(make('2024-02-30T00:00:00Z'))).toBe('INVALID_TIMESTAMP');
    const leap = make('2024-02-29T23:59:59.999Z');
    const secondPrecision = make('2024-02-29T23:59:59Z');
    const fourDigitMillis = make('2024-02-29T23:59:59.0000Z');
    expect(leap.ok && leap.value.nextActionAt).toBe('2024-02-29T23:59:59.999Z');
    expect(secondPrecision.ok && secondPrecision.value.nextActionAt).toBe('2024-02-29T23:59:59.000Z');
    expect(resultCode(fourDigitMillis)).toBe('INVALID_TIMESTAMP');
  });

  it('deep-freezes success and failure wrappers for validators, planners, and idempotency', () => {
    const sequence = normalizeSequence({
      schemaVersion: 1, sequenceRef: ref('sequence-1'), tenantRef: ref('tenant-1'), name: 'x', version: 1, timezone: 'UTC',
      steps: [{ stepRef: ref('step-1'), position: 1, channel: 'EMAIL', delaySeconds: 0, templateRef: ref('template-1') }],
    });
    const sequenceFailure = normalizeSequence({ nope: true });
    const lifecycle = planSequenceTransition({
      tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), resourceTenantRef: ref('tenant-1'), from: 'draft', to: 'active', expectedVersion: 1, currentVersion: 1,
      intent: 'SEQUENCE_ACTIVATE', actorKind: 'HUMAN', actorRole: 'SALES', actorRef: ref('actor-1'),
    });
    const lifecycleFailure = planSequenceTransition({
      tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), resourceTenantRef: ref('tenant-1'), from: 'archived', to: 'active', expectedVersion: 1, currentVersion: 1,
      intent: 'SEQUENCE_ACTIVATE', actorKind: 'HUMAN', actorRole: 'SALES', actorRef: ref('actor-1'),
    });
    const idempotency = classifySalesSequenceIdempotency({ idempotencyKey: ref('idempotency-1'), operationDigest: digest('sales-sequence-v1') });
    const idempotencyFailure = classifySalesSequenceIdempotency({ nope: true });
    for (const result of [sequence, sequenceFailure, lifecycle, lifecycleFailure, idempotency, idempotencyFailure]) {
      expect(Object.isFrozen(result)).toBe(true);
      if (result.ok) expect(Object.isFrozen(result.value)).toBe(true);
      else expect(Object.isFrozen(result.error)).toBe(true);
    }
  });

  it('binds lifecycle action intent, actor context, resource, and stop reason into the digest', () => {
    const base = { tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), resourceTenantRef: ref('tenant-1'), from: 'draft', to: 'active', expectedVersion: 1, currentVersion: 1, intent: 'SEQUENCE_ACTIVATE', actorKind: 'HUMAN', actorRole: 'SALES', actorRef: ref('actor-1') };
    const first = planSequenceTransition(base);
    const changedActor = planSequenceTransition({ ...base, actorRef: ref('actor-2') });
    const wrongIntent = planSequenceTransition({ ...base, intent: 'SEQUENCE_PAUSE' });
    expect(first.ok && changedActor.ok && first.value.operationDigest).not.toBe(changedActor.ok && changedActor.value.operationDigest);
    expect(resultCode(wrongIntent)).toBe('INVALID_INTENT');
    expect(first.ok && first.value.actorRef).toBe(ref('actor-1'));
  });

  it('requires stopReason for every exited/blocked transition and forbids it on normal transitions', () => {
    const noReason = planEnrollmentTransition({
      tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'), resourceTenantRef: ref('tenant-1'), from: 'active', to: 'exited', expectedVersion: 1, currentVersion: 1,
      intent: 'ENROLLMENT_STOP', actorKind: 'HUMAN', actorRole: 'SALES', actorRef: ref('actor-1'),
    });
    const extraReason = planEnrollmentTransition({
      tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'), resourceTenantRef: ref('tenant-1'), from: 'active', to: 'paused', expectedVersion: 1, currentVersion: 1,
      intent: 'ENROLLMENT_PAUSE', stopReason: 'reply', actorKind: 'HUMAN', actorRole: 'SALES', actorRef: ref('actor-1'),
    });
    expect(resultCode(noReason)).toBe('STOP_REASON_REQUIRED');
    expect(resultCode(extraReason)).toBe('STOP_REASON_MISMATCH');
  });

  it('enforces the lifecycle actor matrix and permits SYSTEM only for a fixed enrollment stop', () => {
    const ai = planSequenceTransition({ tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), resourceTenantRef: ref('tenant-1'), from: 'draft', to: 'active', expectedVersion: 1, currentVersion: 1, intent: 'SEQUENCE_ACTIVATE', actorKind: 'AI_WORKER', actorRole: 'ADMIN', actorRef: ref('actor-ai') });
    const viewer = planSequenceTransition({ tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), resourceTenantRef: ref('tenant-1'), from: 'draft', to: 'active', expectedVersion: 1, currentVersion: 1, intent: 'SEQUENCE_ACTIVATE', actorKind: 'HUMAN', actorRole: 'VIEWER', actorRef: ref('actor-viewer') });
    const systemLifecycle = planSequenceTransition({ tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), resourceTenantRef: ref('tenant-1'), from: 'draft', to: 'active', expectedVersion: 1, currentVersion: 1, intent: 'SEQUENCE_ACTIVATE', actorKind: 'SYSTEM', actorRole: 'SYSTEM', actorRef: ref('actor-system') });
    const systemStop = planEnrollmentTransition({ tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'), resourceTenantRef: ref('tenant-1'), from: 'active', to: 'exited', expectedVersion: 1, currentVersion: 1, intent: 'ENROLLMENT_STOP', stopReason: 'optout', actorKind: 'SYSTEM', actorRole: 'SYSTEM', actorRef: ref('actor-system') });
    expect(resultCode(ai)).toBe('AI_PROPOSAL_NOT_AUTHORITATIVE');
    expect(resultCode(viewer)).toBe('AI_PROPOSAL_NOT_AUTHORITATIVE');
    expect(resultCode(systemLifecycle)).toBe('ACTOR_NOT_AUTHORIZED');
    expect(systemStop.ok).toBe(true);
  });

  it('requires explicitly different provider and business receipt kinds', () => {
    const sameKind = planStepExecutionTransition(transitionInput({ from: 'sending', to: 'sent', expectedVersion: 5, currentVersion: 5, intent: 'SEND_AFTER_APPROVAL', actorKind: 'FUTURE_EXTERNAL_EXECUTOR', actorRole: 'SYSTEM', providerReceiptRef: 'provider-receipt:same-1', businessReceiptRef: 'business-receipt:same-1' }));
    const providerOnly = planStepExecutionTransition(transitionInput({ from: 'sending', to: 'sent', expectedVersion: 5, currentVersion: 5, intent: 'SEND_AFTER_APPROVAL', actorKind: 'FUTURE_EXTERNAL_EXECUTOR', actorRole: 'SYSTEM', providerReceiptRef: 'provider-receipt:provider-1' }));
    const wrongKind = planStepExecutionTransition(transitionInput({ from: 'sending', to: 'sent', expectedVersion: 5, currentVersion: 5, intent: 'SEND_AFTER_APPROVAL', actorKind: 'FUTURE_EXTERNAL_EXECUTOR', actorRole: 'SYSTEM', providerReceiptRef: 'provider-receipt:provider-1', businessReceiptRef: 'provider-receipt:provider-1' }));
    expect(resultCode(sameKind)).toBe('RECEIPT_KIND_CONFLICT');
    expect(resultCode(providerOnly)).toBe('PROVIDER_RECEIPT_NOT_BUSINESS_SENT');
    expect(resultCode(wrongKind)).toBe('PROVIDER_RECEIPT_NOT_BUSINESS_SENT');
  });
});
