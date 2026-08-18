import {
  computeBusinessSentReceiptDigest,
  computeOutcomeOperationDigest,
  computeProviderOutcomeDigest,
  planOutcomeReconciliation,
  type BusinessSentReceiptProjection,
  type OutcomeReconciliationInput,
  type ProviderOutcomeProjection,
} from './outcome-reconciliation-contract';
import {
  computeDraftApprovalOperationDigest,
  computeManualDraftApprovalDigest,
  planDraftArtifactProposal,
  type DraftApprovalActorRole,
} from './draft-approval-isolation-contract';
import {
  computeEnrollmentStopEventDigest,
  computeEnrollmentStopOperationDigest,
  planEnrollmentStopEvent,
  type EnrollmentStopEventReceiptProjection,
} from './enrollment-stop-event-contract';
import {
  computeDedupeEvidenceDigest,
  computeComplianceEvidenceDigest,
  computeSendingWindowEvidenceDigest,
  computeRateLimitEvidenceDigest,
  computeOutboxCasEvidenceDigest,
  planOutboxCompliance,
  type ApprovedDraftIdentityProjection,
  type OutboxComplianceReceiptProjection,
} from './outbox-compliance-plan-contract';
import { planEnrollmentTransition, planStepExecutionTransition } from './sales-sequence-contract';

const ref = (value: string) => `ref:${value}`;
const digest = (domain: string, fill = 'a') => `sha256:${domain}:${fill.repeat(64)}`;
const sourceRef = (prefix: string, value: string) => `${prefix}${value}`;

function resultCode(result: { ok: boolean; error?: { code: string } }): string {
  if (result.ok || !result.error) throw new Error('expected a rejected contract result');
  return result.error.code;
}

function safeSuffix(value: string): string {
  return value.slice(-32).replace(/[0-9]/g, (digit) => String.fromCharCode('g'.charCodeAt(0) + Number(digit)));
}

function approvedIdentity(channel: 'EMAIL' | 'WHATSAPP' = 'EMAIL'): ApprovedDraftIdentityProjection {
  const proposalResult = planDraftArtifactProposal({
    schemaVersion: 1,
    policyVersion: 1,
    tenantRef: ref('tenant-1'),
    sequenceRef: ref('sequence-1'),
    enrollmentRef: ref('enrollment-1'),
    executionRef: ref('execution-1'),
    stepRef: ref('step-1'),
    stepVersion: 3,
    templateSnapshotDigest: digest('template'),
    variableSnapshotDigest: digest('variables'),
    renderedArtifactRef: 'draft-artifact:artifact-1',
    contentDigest: digest('content'),
    channel,
    proposalVersion: 1,
    rendererKind: 'SYSTEM_RENDERER',
    rendererRef: 'draft-renderer:system-1',
    createdAt: '2026-08-04T00:00:00Z',
  });
  if (!proposalResult.ok) throw new Error(proposalResult.error.code);
  const proposal = proposalResult.value.proposal;
  const role: DraftApprovalActorRole = 'OWNER';
  const approvalActorRef = 'draft-actor:owner';
  const approvedAt = '2026-08-04T00:01:00.000Z';
  const approvalIntent = {
    schemaVersion: 1 as const, policyVersion: 1 as const,
    tenantRef: proposal.tenantRef, sequenceRef: proposal.sequenceRef, enrollmentRef: proposal.enrollmentRef,
    executionRef: proposal.executionRef, stepRef: proposal.stepRef, stepVersion: proposal.stepVersion,
    proposalVersion: proposal.proposalVersion, proposalDigest: proposal.proposalDigest,
    renderedArtifactRef: proposal.renderedArtifactRef, templateSnapshotDigest: proposal.templateSnapshotDigest,
    variableSnapshotDigest: proposal.variableSnapshotDigest, contentDigest: proposal.contentDigest,
    actorKind: 'HUMAN' as const, actorRole: role, actorRef: approvalActorRef, approvedAt,
  };
  const approvalDigest = computeManualDraftApprovalDigest(approvalIntent);
  const approvalReceiptRef = sourceRef('approval-receipt:', safeSuffix(approvalDigest));
  const authority = planStepExecutionTransition({
    executionRef: proposal.executionRef, tenantRef: proposal.tenantRef, sequenceRef: proposal.sequenceRef,
    enrollmentRef: proposal.enrollmentRef, stepRef: proposal.stepRef, stepVersion: proposal.stepVersion,
    from: 'approval_required', to: 'approved', expectedVersion: 7, currentVersion: 7,
    intent: 'REVIEW_DRAFT', approvalReceiptRef, actorKind: 'HUMAN', actorRole: role, actorRef: approvalActorRef,
  });
  if (!authority.ok) throw new Error(authority.error.code);
  const commandIdempotencyKey = 'draft-command:approve-1';
  const commandOperationDigest = computeDraftApprovalOperationDigest({
    schemaVersion: 1, policyVersion: 1, command: 'APPROVE_DRAFT', intent: 'REVIEW_DRAFT',
    idempotencyKey: commandIdempotencyKey, tenantRef: proposal.tenantRef, sequenceRef: proposal.sequenceRef,
    enrollmentRef: proposal.enrollmentRef, executionRef: proposal.executionRef, stepRef: proposal.stepRef,
    stepVersion: proposal.stepVersion, proposalVersion: proposal.proposalVersion, proposalDigest: proposal.proposalDigest,
    renderedArtifactRef: proposal.renderedArtifactRef, templateSnapshotDigest: proposal.templateSnapshotDigest,
    variableSnapshotDigest: proposal.variableSnapshotDigest, contentDigest: proposal.contentDigest,
    actorKind: 'HUMAN', actorRole: role, actorRef: approvalActorRef,
    preState: 'approval_required', preVersion: 7, postState: 'approved', postVersion: 8,
    authorityPlanDigest: authority.value.operationDigest, approvalDigest,
  });
  return {
    channel, proposalVersion: proposal.proposalVersion, proposalDigest: proposal.proposalDigest,
    renderedArtifactRef: proposal.renderedArtifactRef, templateSnapshotDigest: proposal.templateSnapshotDigest,
    variableSnapshotDigest: proposal.variableSnapshotDigest, contentDigest: proposal.contentDigest,
    approvalReceiptRef, approvalDigest, approvalActorRole: role, approvalActorRef, approvedAt,
    commandReceiptRef: sourceRef('draft-approval-receipt:', safeSuffix(commandOperationDigest)),
    commandOperationDigest, commandIdempotencyKey, commandPreState: 'approval_required', commandPreVersion: 7,
    commandPostState: 'approved', commandPostVersion: 8, authorityPlanDigest: authority.value.operationDigest,
  };
}

function reservationEvidence(channel: 'EMAIL' | 'WHATSAPP' = 'EMAIL', idempotencyKey = 'outbox-key:1') {
  const decisionNow = '2026-08-04T00:05:00.000Z';
  const compliance = { kind: 'COMPLIANCE_EVALUATION' as const, policyVersion: 1 as const, tenantRef: ref('tenant-1'), enrollmentRef: ref('enrollment-1'), decision: 'CLEAR' as const, sourceKind: 'SYSTEM_COMPLIANCE_READER' as const, sourceReceiptRef: sourceRef('compliance-receipt:', '1'), evaluatedAt: decisionNow };
  const window = { kind: 'SENDING_WINDOW_EVALUATION' as const, policyVersion: 1 as const, tenantRef: ref('tenant-1'), channel, timezone: 'UTC', windowState: 'OPEN' as const, quietHoursState: 'CLEAR' as const, windowRef: ref('window-1'), quietHoursRef: ref('quiet-hours-1'), windowEndsAt: '2026-08-04T01:00:00.000Z', sourceKind: 'SYSTEM_WINDOW_READER' as const, sourceReceiptRef: sourceRef('window-receipt:', '1'), evaluatedAt: decisionNow };
  const rateLimit = { kind: 'RATE_LIMIT_EVALUATION' as const, policyVersion: 1 as const, tenantRef: ref('tenant-1'), channel, bucketRef: ref('rate-bucket-1'), decision: 'ALLOW' as const, limit: 10, used: 2, remaining: 8, windowStartAt: '2026-08-04T00:00:00.000Z', windowEndsAt: '2026-08-04T01:00:00.000Z', sourceKind: 'SYSTEM_RATE_LIMIT_READER' as const, sourceReceiptRef: sourceRef('rate-receipt:', '1'), evaluatedAt: decisionNow };
  const dedupe = { kind: 'OUTBOX_DEDUPE_EVALUATION' as const, policyVersion: 1 as const, tenantRef: ref('tenant-1'), channel, idempotencyKey, decision: 'NEW' as const, sourceKind: 'SYSTEM_DEDUPE_READER' as const, sourceReceiptRef: sourceRef('dedupe-receipt:', '1'), evaluatedAt: decisionNow };
  const outboxCas = { kind: 'OUTBOX_CAS_EVALUATION' as const, policyVersion: 1 as const, tenantRef: ref('tenant-1'), expectedVersion: 8, currentVersion: 8, decision: 'MATCHED' as const, sourceKind: 'SYSTEM_OUTBOX_READER' as const, sourceReceiptRef: sourceRef('cas-receipt:', '1'), evaluatedAt: decisionNow };
  return {
    decisionNow,
    compliance: { ...compliance, evidenceDigest: computeComplianceEvidenceDigest(compliance) },
    window: { ...window, evidenceDigest: computeSendingWindowEvidenceDigest(window) },
    rateLimit: { ...rateLimit, evidenceDigest: computeRateLimitEvidenceDigest(rateLimit) },
    dedupe: { ...dedupe, evidenceDigest: computeDedupeEvidenceDigest(dedupe) },
    outboxCas: { ...outboxCas, evidenceDigest: computeOutboxCasEvidenceDigest(outboxCas) },
  };
}

function reservation(channel: 'EMAIL' | 'WHATSAPP' = 'EMAIL', idempotencyKey = 'outbox-key:1'): OutboxComplianceReceiptProjection {
  const e = reservationEvidence(channel, idempotencyKey);
  const result = planOutboxCompliance({
    schemaVersion: 1, policyVersion: 1, intent: 'SEND_AFTER_APPROVAL', tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'), executionRef: ref('execution-1'), stepRef: ref('step-1'), stepVersion: 3, channel, expectedVersion: 8, idempotencyKey, decisionNow: e.decisionNow,
    readerSnapshot: { tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'), executionRef: ref('execution-1'), stepRef: ref('step-1'), stepVersion: 3, state: 'approved', version: 8 },
    draftIdentity: approvedIdentity(channel), compliance: e.compliance, window: e.window, rateLimit: e.rateLimit, dedupe: e.dedupe, outboxCas: e.outboxCas,
  });
  if (!result.ok || !result.value.receiptToPersist) throw new Error(result.ok ? 'reservation receipt missing' : result.error.code);
  return result.value.receiptToPersist;
}

function provider(overrides: Partial<ProviderOutcomeProjection> = {}, channel: 'EMAIL' | 'WHATSAPP' = 'EMAIL', reservationReceipt = reservation(channel)): ProviderOutcomeProjection {
  const base = { kind: 'PROVIDER_OUTCOME_PROJECTION' as const, policyVersion: 1 as const, tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'), executionRef: ref('execution-1'), stepRef: ref('step-1'), stepVersion: 3, channel, reservationReceiptRef: reservationReceipt.receiptRef, reservationOperationDigest: reservationReceipt.operationDigest, outboxReceiptRef: reservationReceipt.outboxReceiptRef, reservationRef: reservationReceipt.reservationRef, reservationIdempotencyKey: reservationReceipt.idempotencyKey, sendingVersion: reservationReceipt.postVersion, providerOutcome: 'ACCEPTED' as const, providerReceiptRef: 'provider-receipt:provider-1', sourceKind: 'SYSTEM_PROVIDER_OUTCOME_READER' as const, sourceReceiptRef: 'provider-outcome-receipt:1', observedAt: '2026-08-04T00:05:00.000Z' };
  const normalized = { ...base, ...overrides };
  const { evidenceDigest: _ignored, ...withoutDigest } = normalized;
  return { ...normalized, evidenceDigest: computeProviderOutcomeDigest(withoutDigest) };
}

function business(overrides: Partial<BusinessSentReceiptProjection> = {}, channel: 'EMAIL' | 'WHATSAPP' = 'EMAIL', reservationReceipt = reservation(channel), providerProjection = provider({}, channel, reservationReceipt)): BusinessSentReceiptProjection {
  const base = { kind: 'BUSINESS_SENT_RECEIPT' as const, policyVersion: 1 as const, tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'), executionRef: ref('execution-1'), stepRef: ref('step-1'), stepVersion: 3, channel, reservationReceiptRef: reservationReceipt.receiptRef, reservationOperationDigest: reservationReceipt.operationDigest, outboxReceiptRef: reservationReceipt.outboxReceiptRef, reservationRef: reservationReceipt.reservationRef, reservationIdempotencyKey: reservationReceipt.idempotencyKey, sendingVersion: reservationReceipt.postVersion, businessReceiptRef: 'business-receipt:business-1', providerReceiptRef: providerProjection.providerReceiptRef, providerEvidenceDigest: providerProjection.evidenceDigest, providerOutcome: providerProjection.providerOutcome as 'ACCEPTED' | 'DELIVERED', sourceKind: 'SYSTEM_BUSINESS_OUTCOME_READER' as const, sourceReceiptRef: 'business-outcome-receipt:1', observedAt: '2026-08-04T00:05:00.000Z' };
  const normalized = { ...base, ...overrides };
  const { evidenceDigest: _ignored, ...withoutDigest } = normalized;
  return { ...normalized, evidenceDigest: computeBusinessSentReceiptDigest(withoutDigest) };
}

function stopDecision(): EnrollmentStopEventReceiptProjection {
  const occurredAt = '2026-08-04T00:04:00.000Z';
  const eventIntent = { schemaVersion: 1 as const, policyVersion: 1 as const, eventKey: 'stop-event:reply-1', eventKind: 'REPLY_RECEIVED' as const, sourceKind: 'EMAIL_INBOUND' as const, tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'), leadRef: ref('lead-1'), contactRef: null, sourceReceiptRef: 'source-receipt:reply-1', occurredAt };
  const eventDigest = computeEnrollmentStopEventDigest(eventIntent);
  const stopPlan = planEnrollmentTransition({ tenantRef: ref('tenant-1'), resourceTenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'), from: 'active', to: 'exited', expectedVersion: 7, currentVersion: 7, intent: 'ENROLLMENT_STOP', stopReason: 'reply', actorKind: 'SYSTEM', actorRole: 'SYSTEM', actorRef: 'system:enrollment-stop-event-reader-v1' });
  if (!stopPlan.ok) throw new Error(stopPlan.error.code);
  const operationDigest = computeEnrollmentStopOperationDigest({ ...eventIntent, eventDigest, preState: 'active', preVersion: 7, postState: 'exited', postVersion: 8, stopReason: 'reply', stopPlanOperationDigest: stopPlan.value.operationDigest });
  const result = planEnrollmentStopEvent({ ...eventIntent, decisionNow: '2026-08-04T00:05:00.000Z', eventDigest, operationDigest, readerSnapshot: { tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'), leadRef: ref('lead-1'), contactRef: null, status: 'active', version: 7 } });
  if (!result.ok || !result.value.receiptToPersist) throw new Error(result.ok ? 'stop receipt missing' : result.error.code);
  return result.value.receiptToPersist;
}

function baseInput(overrides: Record<string, unknown> = {}): OutcomeReconciliationInput {
  const receipt = reservation();
  return {
    schemaVersion: 1, policyVersion: 1, intent: 'RECONCILE_OUTCOME', tenantRef: receipt.tenantRef, sequenceRef: receipt.sequenceRef, enrollmentRef: receipt.enrollmentRef, executionRef: receipt.executionRef, stepRef: receipt.stepRef, stepVersion: receipt.stepVersion, channel: receipt.channel, expectedVersion: receipt.postVersion, outcomeIdempotencyKey: 'outcome-key:1', decisionNow: receipt.decisionNow,
    readerSnapshot: { tenantRef: receipt.tenantRef, sequenceRef: receipt.sequenceRef, enrollmentRef: receipt.enrollmentRef, executionRef: receipt.executionRef, stepRef: receipt.stepRef, stepVersion: receipt.stepVersion, state: 'sending', version: receipt.postVersion },
    reservationReceipt: receipt,
    ...overrides,
  } as OutcomeReconciliationInput;
}

describe('CRM-03E-1 outcome reconciliation contract', () => {
  it.each(['ACCEPTED', 'DELIVERED'] as const)('keeps provider %s as provider evidence without business SENT', (providerOutcome) => {
    const result = planOutcomeReconciliation(baseInput({ providerOutcome: provider({ providerOutcome }) }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decision).toBe('PROVIDER_EVIDENCE_ONLY');
    expect(result.value.transitionPlan).toBeNull();
    expect(result.value.receiptToPersist?.postState).toBe('sending');
    expect(result.value.sendCommand).toBeNull();
    expect(result.value.providerCommand).toBeNull();
    expect(result.value.queueCommand).toBeNull();
    expect(result.value.retryCommand).toBeNull();
  });

  it.each(['EMAIL', 'WHATSAPP'] as const)('plans %s sending to sent only with both fixed receipt kinds', (channel) => {
    const result = planOutcomeReconciliation(baseInput({ channel, reservationReceipt: reservation(channel), providerOutcome: provider({}, channel), businessReceipt: business({}, channel) }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decision).toBe('BUSINESS_SENT');
    expect(result.value.transitionPlan?.from).toBe('sending');
    expect(result.value.transitionPlan?.to).toBe('sent');
    expect(result.value.receiptToPersist?.postVersion).toBe(10);
    expect(result.value.receiptToPersist?.authorityPlanDigest).toBe(result.value.transitionPlan?.operationDigest);
    expect(result.value.receiptToPersist?.reservationIdempotencyKey).toBe(reservation(channel).idempotencyKey);
    expect(result.value.receiptToPersist?.outcomeIdempotencyKey).not.toBe(result.value.receiptToPersist?.reservationIdempotencyKey);
  });

  it.each(['FAILED', 'UNKNOWN'] as const)('routes provider %s to manual reconciliation without a transition or retry', (providerOutcome) => {
    const result = planOutcomeReconciliation(baseInput({ providerOutcome: provider({ providerOutcome }) }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decision).toBe('MANUAL_RECONCILIATION_REQUIRED');
    expect(result.value.reconciliationAction).toBe('MANUAL_RECONCILIATION_REQUIRED');
    expect(result.value.transitionPlan).toBeNull();
    expect(result.value.receiptToPersist?.postState).toBe('sending');
    expect(result.value.retryCommand).toBeNull();
  });

  it('gives a 03B stop decision priority and never creates a resend or fake StepExecution stop', () => {
    const result = planOutcomeReconciliation(baseInput({ providerOutcome: provider(), stopDecision: stopDecision() }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decision).toBe('STOP_RECONCILIATION_REQUIRED');
    expect(result.value.reconciliationAction).toBe('STOP_ENROLLMENT_READER');
    expect(result.value.transitionPlan).toBeNull();
    expect(result.value.receiptToPersist?.postState).toBe('sending');
  });

  it('replays BUSINESS_SENT only from the persisted post-state and exact outcome identity', () => {
    const first = planOutcomeReconciliation(baseInput({ providerOutcome: provider(), businessReceipt: business() }));
    expect(first.ok).toBe(true);
    if (!first.ok || !first.value.receiptToPersist) return;
    const receipt = first.value.receiptToPersist;
    const replay = planOutcomeReconciliation(baseInput({ expectedVersion: receipt.preVersion, readerSnapshot: { ...baseInput().readerSnapshot, state: 'sent', version: receipt.postVersion }, providerOutcome: provider(), businessReceipt: business(), persistedOutcomeReceipt: receipt }));
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.decision).toBe('REPLAY');
      expect(replay.value.transitionPlan).toBeNull();
      expect(replay.value.receiptToPersist).toBeNull();
    }
    expect(resultCode(planOutcomeReconciliation(baseInput({ expectedVersion: receipt.preVersion, readerSnapshot: { ...baseInput().readerSnapshot, state: 'sending', version: receipt.preVersion }, providerOutcome: provider(), businessReceipt: business(), persistedOutcomeReceipt: receipt })))).toBe('REPLAY_STATE_MISMATCH');
  });

  it('replays provider-only and manual outcomes from their persisted sending post-state', () => {
    for (const providerOutcome of ['ACCEPTED', 'UNKNOWN'] as const) {
      const first = planOutcomeReconciliation(baseInput({ providerOutcome: provider({ providerOutcome }) }));
      expect(first.ok).toBe(true);
      if (!first.ok || !first.value.receiptToPersist) continue;
      const receipt = first.value.receiptToPersist;
      const replay = planOutcomeReconciliation(baseInput({ expectedVersion: receipt.preVersion, providerOutcome: provider({ providerOutcome }), readerSnapshot: { ...baseInput().readerSnapshot, state: 'sending', version: receipt.postVersion }, persistedOutcomeReceipt: receipt }));
      expect(replay.ok).toBe(true);
      if (replay.ok) expect(replay.value.decision).toBe('REPLAY');
    }
  });

  it('supports provider-only then business-sent with a new outcome key and predecessor receipt', () => {
    const providerOnly = planOutcomeReconciliation(baseInput({ outcomeIdempotencyKey: 'outcome-key:provider-only', providerOutcome: provider() }));
    expect(providerOnly.ok).toBe(true);
    if (!providerOnly.ok || !providerOnly.value.receiptToPersist) return;
    const predecessor = providerOnly.value.receiptToPersist;
    const businessSent = planOutcomeReconciliation(baseInput({ outcomeIdempotencyKey: 'outcome-key:business-sent', businessReceipt: business(), predecessorOutcomeReceipt: predecessor }));
    expect(businessSent.ok).toBe(true);
    if (!businessSent.ok) return;
    expect(businessSent.value.decision).toBe('BUSINESS_SENT');
    expect(businessSent.value.evidence.providerOutcome).toBeUndefined();
    expect(businessSent.value.receiptToPersist?.predecessorOutcomeReceipt?.receiptRef).toBe(predecessor.receiptRef);
    expect(businessSent.value.receiptToPersist?.providerOutcome).toBeUndefined();
    expect(businessSent.value.receiptToPersist?.outcomeIdempotencyKey).toBe('outcome-key:business-sent');
    expect(businessSent.value.receiptToPersist?.reservationIdempotencyKey).toBe('outbox-key:1');
    expect(businessSent.value.receiptToPersist?.operationDigest).not.toBe(predecessor.operationDigest);
    expect(businessSent.value.receiptToPersist?.businessReceipt?.providerEvidenceDigest).toBe(predecessor.providerOutcome?.evidenceDigest);
  });

  it('replays a delayed two-phase outcome using predecessor freshness and current business freshness', () => {
    const providerOnly = planOutcomeReconciliation(baseInput({ outcomeIdempotencyKey: 'outcome-key:delayed-provider', providerOutcome: provider() }));
    expect(providerOnly.ok).toBe(true);
    if (!providerOnly.ok || !providerOnly.value.receiptToPersist) return;
    const predecessor = providerOnly.value.receiptToPersist;
    const delayedBusiness = business({ observedAt: '2026-08-04T00:11:00.000Z' });
    const delayedInput = { decisionNow: '2026-08-04T00:11:00.000Z', outcomeIdempotencyKey: 'outcome-key:delayed-business', businessReceipt: delayedBusiness, predecessorOutcomeReceipt: predecessor };
    const planned = planOutcomeReconciliation(baseInput(delayedInput));
    expect(planned.ok).toBe(true);
    if (!planned.ok || !planned.value.receiptToPersist) return;
    expect(planned.value.receiptToPersist.providerOutcome).toBeUndefined();
    expect(planned.value.receiptToPersist.predecessorOutcomeReceipt?.receiptRef).toBe(predecessor.receiptRef);
    const receipt = planned.value.receiptToPersist;
    const replay = planOutcomeReconciliation(baseInput({ ...delayedInput, expectedVersion: receipt.preVersion, readerSnapshot: { ...baseInput().readerSnapshot, state: 'sent', version: receipt.postVersion }, persistedOutcomeReceipt: receipt }));
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.decision).toBe('REPLAY');
      expect(replay.value.transitionPlan).toBeNull();
      expect(replay.value.receiptToPersist).toBeNull();
    }
  });

  it('rejects missing, replayed, or tampered predecessor evidence', () => {
    const providerOnly = planOutcomeReconciliation(baseInput({ outcomeIdempotencyKey: 'outcome-key:predecessor', providerOutcome: provider() }));
    expect(providerOnly.ok).toBe(true);
    if (!providerOnly.ok || !providerOnly.value.receiptToPersist) return;
    const predecessor = providerOnly.value.receiptToPersist;
    expect(resultCode(planOutcomeReconciliation(baseInput({ outcomeIdempotencyKey: 'outcome-key:business-missing-predecessor', businessReceipt: business() })))).toBe('INVALID_OUTCOME');
    expect(resultCode(planOutcomeReconciliation(baseInput({ outcomeIdempotencyKey: 'outcome-key:predecessor', businessReceipt: business(), predecessorOutcomeReceipt: predecessor })))).toBe('OUTCOME_CONFLICT');
    expect(resultCode(planOutcomeReconciliation(baseInput({ outcomeIdempotencyKey: 'outcome-key:business-tampered-predecessor', businessReceipt: business(), predecessorOutcomeReceipt: { ...predecessor, operationDigest: digest('tampered-predecessor') } })))).toBe('INVALID_PERSISTED_RECEIPT');
    expect(resultCode(planOutcomeReconciliation(baseInput({ outcomeIdempotencyKey: 'outcome-key:business-tampered-binding', businessReceipt: business({ providerReceiptRef: 'provider-receipt:other' }), predecessorOutcomeReceipt: predecessor })))).toBe('BUSINESS_RECEIPT_INVALID');
  });

  it('rejects a self-consistent persisted BUSINESS_SENT receipt that mixes current and predecessor providers', () => {
    const atomic = planOutcomeReconciliation(baseInput({ providerOutcome: provider(), businessReceipt: business() }));
    const providerOnly = planOutcomeReconciliation(baseInput({ outcomeIdempotencyKey: 'outcome-key:mixed-predecessor', providerOutcome: provider() }));
    expect(atomic.ok && providerOnly.ok).toBe(true);
    if (!atomic.ok || !atomic.value.receiptToPersist || !providerOnly.ok || !providerOnly.value.receiptToPersist) return;
    const atomicReceipt = atomic.value.receiptToPersist;
    const predecessor = providerOnly.value.receiptToPersist;
    const mixedIntent = {
      schemaVersion: 1 as const, policyVersion: 1 as const, intent: 'RECONCILE_OUTCOME' as const, decision: 'BUSINESS_SENT' as const,
      tenantRef: atomicReceipt.tenantRef, sequenceRef: atomicReceipt.sequenceRef, enrollmentRef: atomicReceipt.enrollmentRef,
      executionRef: atomicReceipt.executionRef, stepRef: atomicReceipt.stepRef, stepVersion: atomicReceipt.stepVersion, channel: atomicReceipt.channel,
      outcomeIdempotencyKey: atomicReceipt.outcomeIdempotencyKey, reservationIdempotencyKey: atomicReceipt.reservationIdempotencyKey, decisionNow: atomicReceipt.decisionNow,
      reservationReceiptRef: atomicReceipt.reservationReceiptRef, reservationOperationDigest: atomicReceipt.reservationOperationDigest,
      outboxReceiptRef: atomicReceipt.outboxReceiptRef, reservationRef: atomicReceipt.reservationRef, preState: 'sending' as const,
      preVersion: atomicReceipt.preVersion, postState: 'sent' as const, postVersion: atomicReceipt.postVersion,
      authorityPlanDigest: atomicReceipt.authorityPlanDigest, providerOutcome: atomicReceipt.providerOutcome,
      businessReceipt: atomicReceipt.businessReceipt, predecessorOutcomeReceipt: predecessor,
    };
    const mixedOperationDigest = computeOutcomeOperationDigest(mixedIntent);
    const mixedReceipt = { ...atomicReceipt, operationDigest: mixedOperationDigest, receiptRef: `outcome-receipt:${mixedOperationDigest.slice(-32)}`, predecessorOutcomeReceipt: predecessor };
    expect(resultCode(planOutcomeReconciliation(baseInput({ readerSnapshot: { ...baseInput().readerSnapshot, state: 'sent', version: mixedReceipt.postVersion }, persistedOutcomeReceipt: mixedReceipt })))).toBe('INVALID_PERSISTED_RECEIPT');
  });

  it('rejects provider/business composition across reservation attempts and receipt identities', () => {
    const reservationA = reservation('EMAIL', 'outbox-key:1');
    const reservationB = reservation('EMAIL', 'outbox-key:2');
    expect(resultCode(planOutcomeReconciliation(baseInput({ reservationReceipt: reservationA, providerOutcome: provider({}, 'EMAIL', reservationB) })))).toBe('SCOPE_MISMATCH');
    expect(resultCode(planOutcomeReconciliation(baseInput({ reservationReceipt: reservationA, providerOutcome: provider({}, 'EMAIL', reservationA), businessReceipt: business({}, 'EMAIL', reservationB, provider({}, 'EMAIL', reservationB)) })))).toBe('SCOPE_MISMATCH');
    const providerA = provider({}, 'EMAIL', reservationA);
    const providerB = provider({ providerReceiptRef: 'provider-receipt:provider-b' }, 'EMAIL', reservationA);
    expect(resultCode(planOutcomeReconciliation(baseInput({ reservationReceipt: reservationA, providerOutcome: providerA, businessReceipt: business({}, 'EMAIL', reservationA, providerB) })))).toBe('BUSINESS_RECEIPT_INVALID');
  });

  it('rejects outcome, receipt, scope, version, and evidence conflicts before replay', () => {
    const first = planOutcomeReconciliation(baseInput({ providerOutcome: provider(), businessReceipt: business() }));
    expect(first.ok).toBe(true);
    if (!first.ok || !first.value.receiptToPersist) return;
    const receipt = first.value.receiptToPersist;
    const replayBase = { expectedVersion: receipt.preVersion, readerSnapshot: { ...baseInput().readerSnapshot, state: 'sent', version: receipt.postVersion }, providerOutcome: provider(), businessReceipt: business(), persistedOutcomeReceipt: receipt };
    expect(resultCode(planOutcomeReconciliation(baseInput({ ...replayBase, outcomeIdempotencyKey: 'outcome-key:changed' })))).toBe('OUTCOME_CONFLICT');
    expect(resultCode(planOutcomeReconciliation(baseInput({ ...replayBase, tenantRef: ref('tenant-2') })))).toBe('SCOPE_MISMATCH');
    expect(resultCode(planOutcomeReconciliation(baseInput({ ...replayBase, persistedOutcomeReceipt: { ...receipt, operationDigest: digest('tampered') } })))).toBe('INVALID_PERSISTED_RECEIPT');
    expect(resultCode(planOutcomeReconciliation(baseInput({ ...replayBase, persistedOutcomeReceipt: { ...receipt, providerOutcome: provider({ providerReceiptRef: 'provider-receipt:tampered' }) } })))).toBe('INVALID_PERSISTED_RECEIPT');
  });

  it('rejects provider-only business claims and mismatched provider/business receipt kinds', () => {
    expect(resultCode(planOutcomeReconciliation(baseInput({ businessReceipt: business() })))).toBe('INVALID_OUTCOME');
    expect(resultCode(planOutcomeReconciliation(baseInput({ providerOutcome: provider({ providerOutcome: 'FAILED' }), businessReceipt: business() })))).toBe('BUSINESS_RECEIPT_INVALID');
    expect(resultCode(planOutcomeReconciliation(baseInput({ providerOutcome: provider({ providerReceiptRef: 'business-receipt:wrong-kind' }), businessReceipt: business() })))).toBe('PROVIDER_EVIDENCE_INVALID');
  });

  it('rejects tampered 03B stop mapping and receipt identity', () => {
    const stop = stopDecision();
    expect(resultCode(planOutcomeReconciliation(baseInput({ stopDecision: { ...stop, postState: 'blocked' } })))).toBe('STOP_MAPPING_MISMATCH');
    expect(resultCode(planOutcomeReconciliation(baseInput({ stopDecision: { ...stop, tenantRef: ref('tenant-2') } })))).toBe('SCOPE_MISMATCH');
  });

  it('rejects unknown, undefined, PII, raw provider, URL, client status, and retry fields', () => {
    const cases = [
      { extra: true },
      { providerOutcome: { ...provider(), providerPayload: 'raw' } },
      { providerOutcome: { ...provider(), providerError: 'raw' } },
      { providerOutcome: { ...provider(), url: 'https://provider.invalid' } },
      { providerOutcome: { ...provider(), clientSuccess: true } },
      { retryCommand: null },
      { providerOutcome: { ...provider(), providerReceiptRef: 'provider-receipt:test@example.com' } },
      { businessReceipt: { ...business(), sourceReceiptRef: undefined } },
    ];
    for (const current of cases) expect(planOutcomeReconciliation({ ...baseInput(), ...current } as unknown)).toMatchObject({ ok: false });
  });

  it('fails closed for cycles, non-JSON graphs, excessive depth, and nested predecessor candidates', () => {
    const self = baseInput() as unknown as Record<string, unknown>;
    self.predecessorOutcomeReceipt = self;
    expect(resultCode(planOutcomeReconciliation(self))).toBe('UNSAFE_INPUT_GRAPH');

    const left = baseInput() as unknown as Record<string, unknown>;
    const right = baseInput() as unknown as Record<string, unknown>;
    left.predecessorOutcomeReceipt = right;
    right.predecessorOutcomeReceipt = left;
    expect(resultCode(planOutcomeReconciliation(left))).toBe('UNSAFE_INPUT_GRAPH');

    expect(resultCode(planOutcomeReconciliation(baseInput({ extra: new Date('2026-08-04T00:00:00.000Z') })))).toBe('UNSAFE_INPUT_GRAPH');
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 20; index += 1) deep = { child: deep };
    expect(resultCode(planOutcomeReconciliation(baseInput({ extra: deep })))).toBe('UNSAFE_INPUT_GRAPH');

    const providerOnly = planOutcomeReconciliation(baseInput({ outcomeIdempotencyKey: 'outcome-key:nested-candidate', providerOutcome: provider() }));
    expect(providerOnly.ok).toBe(true);
    if (providerOnly.ok && providerOnly.value.receiptToPersist) {
      const cleanReceipt = JSON.parse(JSON.stringify(providerOnly.value.receiptToPersist)) as Record<string, unknown>;
      const nested = { ...cleanReceipt, predecessorOutcomeReceipt: JSON.parse(JSON.stringify(cleanReceipt)) };
      expect(resultCode(planOutcomeReconciliation(baseInput({ predecessorOutcomeReceipt: nested })))).toBe('INVALID_PERSISTED_RECEIPT');
    }
  });

  it('rejects invalid/future timestamps, cross-scope reservation, and non-post-state readers', () => {
    expect(resultCode(planOutcomeReconciliation(baseInput({ providerOutcome: provider({ observedAt: '2026-02-31T00:00:00Z' }) })))).toBe('PROVIDER_EVIDENCE_INVALID');
    expect(resultCode(planOutcomeReconciliation(baseInput({ providerOutcome: provider({ observedAt: '2026-08-04T00:00:00Z' }) })))).toBe('PROVIDER_EVIDENCE_INVALID');
    expect(resultCode(planOutcomeReconciliation(baseInput({ providerOutcome: provider({ observedAt: '2026-08-04T00:06:00Z' }) })))).toBe('PROVIDER_EVIDENCE_INVALID');
    expect(resultCode(planOutcomeReconciliation(baseInput({ readerSnapshot: { ...baseInput().readerSnapshot, state: 'sent', version: 10 } })))).toBe('REPLAY_STATE_MISMATCH');
    expect(resultCode(planOutcomeReconciliation(baseInput({ reservationReceipt: { ...reservation(), tenantRef: ref('tenant-2') } })))).toBe('RESERVATION_RECEIPT_INVALID');
  });

  it('binds every reservation and provider identity dimension into evidence digests', () => {
    const providerBase = provider();
    const providerDimensions: Array<[keyof ProviderOutcomeProjection, ProviderOutcomeProjection[keyof ProviderOutcomeProjection]]> = [
      ['reservationReceiptRef', 'outbox-plan-receipt:changed'],
      ['reservationOperationDigest', digest('reservation-changed')],
      ['outboxReceiptRef', 'outbox-receipt:changed'],
      ['reservationRef', 'outbox-reservation:changed'],
      ['reservationIdempotencyKey', 'outbox-key:changed'],
      ['sendingVersion', 10],
      ['providerReceiptRef', 'provider-receipt:changed'],
      ['providerOutcome', 'DELIVERED'],
    ];
    for (const [key, value] of providerDimensions) {
      const changed = provider({ [key]: value } as Partial<ProviderOutcomeProjection>);
      expect(changed.evidenceDigest).not.toBe(providerBase.evidenceDigest);
    }
    const businessBase = business();
    const businessDimensions: Array<[keyof BusinessSentReceiptProjection, BusinessSentReceiptProjection[keyof BusinessSentReceiptProjection]]> = [
      ['reservationReceiptRef', 'outbox-plan-receipt:changed'],
      ['reservationOperationDigest', digest('reservation-changed')],
      ['outboxReceiptRef', 'outbox-receipt:changed'],
      ['reservationRef', 'outbox-reservation:changed'],
      ['reservationIdempotencyKey', 'outbox-key:changed'],
      ['sendingVersion', 10],
      ['providerReceiptRef', 'provider-receipt:changed'],
      ['providerEvidenceDigest', digest('provider-evidence-changed')],
      ['providerOutcome', 'DELIVERED'],
    ];
    for (const [key, value] of businessDimensions) {
      const changed = business({ [key]: value } as Partial<BusinessSentReceiptProjection>);
      expect(changed.evidenceDigest).not.toBe(businessBase.evidenceDigest);
    }
  });

  it('is deterministic, JSON-safe, and recursively freezes success and failure', () => {
    const first = planOutcomeReconciliation(baseInput({ providerOutcome: provider(), businessReceipt: business() }));
    const second = planOutcomeReconciliation(baseInput({ providerOutcome: provider(), businessReceipt: business() }));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(Object.isFrozen(first)).toBe(true);
    if (first.ok) {
      expect(Object.isFrozen(first.value)).toBe(true);
      expect(Object.isFrozen(first.value.receiptToPersist)).toBe(true);
      expect(Object.isFrozen(first.value.receiptToPersist?.providerOutcome)).toBe(true);
      expect(first.value.sendCommand).toBeNull();
    }
    const failed = planOutcomeReconciliation({ ...baseInput(), providerOutcome: undefined } as unknown);
    expect(Object.isFrozen(failed)).toBe(true);
    if (!failed.ok) expect(Object.isFrozen(failed.error)).toBe(true);
  });

  it('changes the operation digest for provider, business, stop, and outcome dimensions', () => {
    const accepted = planOutcomeReconciliation(baseInput({ providerOutcome: provider() }));
    const delivered = planOutcomeReconciliation(baseInput({ providerOutcome: provider({ providerOutcome: 'DELIVERED' }) }));
    const sent = planOutcomeReconciliation(baseInput({ providerOutcome: provider(), businessReceipt: business() }));
    const stopped = planOutcomeReconciliation(baseInput({ stopDecision: stopDecision() }));
    expect(accepted.ok && delivered.ok && sent.ok && stopped.ok).toBe(true);
    if (accepted.ok && delivered.ok && sent.ok && stopped.ok) {
      expect(delivered.value.operationDigest).not.toBe(accepted.value.operationDigest);
      expect(sent.value.operationDigest).not.toBe(accepted.value.operationDigest);
      expect(stopped.value.operationDigest).not.toBe(accepted.value.operationDigest);
    }
  });

  it('documents the current 03A dependency by refusing to fabricate failed/unknown authority', () => {
    const failed = planOutcomeReconciliation(baseInput({ providerOutcome: provider({ providerOutcome: 'FAILED' }) }));
    expect(failed.ok).toBe(true);
    if (failed.ok) expect(failed.value.transitionPlan).toBeNull();
  });
});
