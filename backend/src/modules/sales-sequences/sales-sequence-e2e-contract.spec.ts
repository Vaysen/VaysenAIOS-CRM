import {
  computeDraftApprovalOperationDigest,
  computeManualDraftApprovalDigest,
  planDraftApprovalCommand,
  planDraftArtifactProposal,
  type DraftApprovalActorRole,
  type DraftApprovalCommand,
  type DraftApprovalCommandReceipt,
  type ManualApprovalReceipt,
  type DraftArtifactProposal,
} from './draft-approval-isolation-contract';
import {
  computeComplianceEvidenceDigest,
  computeDedupeEvidenceDigest,
  computeOutboxCasEvidenceDigest,
  computeRateLimitEvidenceDigest,
  computeSendingWindowEvidenceDigest,
  planOutboxCompliance,
  type ApprovedDraftIdentityProjection,
  type OutboxComplianceInput,
  type OutboxComplianceReceiptProjection,
} from './outbox-compliance-plan-contract';
import {
  computeBusinessSentReceiptDigest,
  computeProviderOutcomeDigest,
  planOutcomeReconciliation,
  type BusinessSentReceiptProjection,
  type OutcomeReconciliationInput,
  type ProviderOutcomeProjection,
} from './outcome-reconciliation-contract';
import {
  computeEnrollmentStopEventDigest,
  computeEnrollmentStopOperationDigest,
  planEnrollmentStopEvent,
  type EnrollmentStopEventReceiptProjection,
} from './enrollment-stop-event-contract';
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

function proposalInput(overrides: Record<string, unknown> = {}) {
  return {
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
    channel: 'EMAIL' as const,
    proposalVersion: 1,
    rendererKind: 'SYSTEM_RENDERER' as const,
    rendererRef: 'draft-renderer:system-1',
    createdAt: '2026-08-04T00:00:00Z',
    ...overrides,
  };
}

function proposal(overrides: Record<string, unknown> = {}): DraftArtifactProposal {
  const result = planDraftArtifactProposal(proposalInput(overrides));
  if (!result.ok) throw new Error(result.error.code);
  return result.value.proposal;
}

const draftTransitions: Record<DraftApprovalCommand, { from: 'draft_pending' | 'draft_ready' | 'approval_required'; to: 'draft_ready' | 'approval_required' | 'approved' }> = {
  ACCEPT_PROPOSAL: { from: 'draft_pending', to: 'draft_ready' },
  REQUEST_APPROVAL: { from: 'draft_ready', to: 'approval_required' },
  APPROVE_DRAFT: { from: 'approval_required', to: 'approved' },
};

function approvalReceipt(p: DraftArtifactProposal, role: DraftApprovalActorRole = 'OWNER', approvedAt = '2026-08-04T00:01:00.000Z') {
  const intent = {
    schemaVersion: 1 as const,
    policyVersion: 1 as const,
    tenantRef: p.tenantRef,
    sequenceRef: p.sequenceRef,
    enrollmentRef: p.enrollmentRef,
    executionRef: p.executionRef,
    stepRef: p.stepRef,
    stepVersion: p.stepVersion,
    proposalVersion: p.proposalVersion,
    proposalDigest: p.proposalDigest,
    renderedArtifactRef: p.renderedArtifactRef,
    templateSnapshotDigest: p.templateSnapshotDigest,
    variableSnapshotDigest: p.variableSnapshotDigest,
    contentDigest: p.contentDigest,
    actorKind: 'HUMAN' as const,
    actorRole: role,
    actorRef: `draft-actor:${role.toLowerCase()}`,
    approvedAt,
  };
  const approvalDigest = computeManualDraftApprovalDigest(intent);
  return {
    kind: 'MANUAL_DRAFT_APPROVAL' as const,
    ...intent,
    receiptRef: `approval-receipt:${safeSuffix(approvalDigest)}`,
    approvalDigest,
  };
}

function draftCommandInput(command: DraftApprovalCommand, overrides: Record<string, unknown> = {}) {
  const p = (overrides.proposal as DraftArtifactProposal | undefined) ?? proposal();
  const mapping = draftTransitions[command];
  const expectedVersion = (overrides.expectedVersion as number | undefined) ?? 7;
  const role = (overrides.actorRole as DraftApprovalActorRole | undefined) ?? 'OWNER';
  const actorRef = `draft-actor:${role.toLowerCase()}`;
  const readerSnapshot = (overrides.readerSnapshot as Record<string, unknown> | undefined) ?? {
    tenantRef: p.tenantRef, sequenceRef: p.sequenceRef, enrollmentRef: p.enrollmentRef,
    executionRef: p.executionRef, stepRef: p.stepRef, stepVersion: p.stepVersion,
    state: mapping.from, version: expectedVersion,
  };
  const approvalAt = command === 'APPROVE_DRAFT' ? ((overrides.approvalAt as string | undefined) ?? '2026-08-04T00:01:00.000Z') : undefined;
  const approval = command === 'APPROVE_DRAFT' ? approvalReceipt(p, role, approvalAt) : undefined;
  const authority = planStepExecutionTransition({
    executionRef: p.executionRef, tenantRef: p.tenantRef, sequenceRef: p.sequenceRef,
    enrollmentRef: p.enrollmentRef, stepRef: p.stepRef, stepVersion: p.stepVersion,
    from: mapping.from, to: mapping.to, expectedVersion, currentVersion: expectedVersion,
    intent: 'REVIEW_DRAFT', actorKind: 'HUMAN', actorRole: role, actorRef,
    ...(approval ? { approvalReceiptRef: approval.receiptRef } : {}),
  });
  if (!authority.ok) throw new Error(authority.error.code);
  const idempotencyKey = (overrides.idempotencyKey as string | undefined) ?? `draft-command:${command.toLowerCase()}-1`;
  const operationDigest = computeDraftApprovalOperationDigest({
    schemaVersion: 1, policyVersion: 1, command, intent: 'REVIEW_DRAFT', idempotencyKey,
    tenantRef: p.tenantRef, sequenceRef: p.sequenceRef, enrollmentRef: p.enrollmentRef,
    executionRef: p.executionRef, stepRef: p.stepRef, stepVersion: p.stepVersion,
    proposalVersion: p.proposalVersion, proposalDigest: p.proposalDigest,
    renderedArtifactRef: p.renderedArtifactRef, templateSnapshotDigest: p.templateSnapshotDigest,
    variableSnapshotDigest: p.variableSnapshotDigest, contentDigest: p.contentDigest,
    actorKind: 'HUMAN', actorRole: role, actorRef, preState: mapping.from, preVersion: expectedVersion,
    postState: mapping.to, postVersion: authority.value.nextVersion,
    authorityPlanDigest: authority.value.operationDigest,
    ...(approval ? { approvalDigest: approval.approvalDigest } : {}),
  });
  return {
    schemaVersion: 1, policyVersion: 1, command,
    tenantRef: p.tenantRef, sequenceRef: p.sequenceRef, enrollmentRef: p.enrollmentRef,
    executionRef: p.executionRef, stepRef: p.stepRef, stepVersion: p.stepVersion,
    expectedVersion, idempotencyKey, intent: 'REVIEW_DRAFT' as const,
    actorKind: 'HUMAN' as const, actorRole: role, actorRef, proposal: p, readerSnapshot, operationDigest,
    ...(approvalAt ? { approvalAt } : {}),
    ...overrides,
  };
}

function approvedIdentityFromReceipts(
  proposalValue: DraftArtifactProposal,
  commandReceipt: DraftApprovalCommandReceipt,
  approvalReceiptValue: ManualApprovalReceipt,
): ApprovedDraftIdentityProjection {
  return {
    channel: proposalValue.channel,
    proposalVersion: commandReceipt.proposalVersion,
    proposalDigest: commandReceipt.proposalDigest,
    renderedArtifactRef: commandReceipt.renderedArtifactRef,
    templateSnapshotDigest: commandReceipt.templateSnapshotDigest,
    variableSnapshotDigest: commandReceipt.variableSnapshotDigest,
    contentDigest: commandReceipt.contentDigest,
    approvalReceiptRef: approvalReceiptValue.receiptRef,
    approvalDigest: approvalReceiptValue.approvalDigest,
    approvalActorRole: approvalReceiptValue.actorRole as 'OWNER' | 'ADMIN' | 'SALES',
    approvalActorRef: approvalReceiptValue.actorRef,
    approvedAt: approvalReceiptValue.approvedAt,
    commandReceiptRef: commandReceipt.receiptRef,
    commandOperationDigest: commandReceipt.operationDigest,
    commandIdempotencyKey: commandReceipt.idempotencyKey,
    commandPreState: commandReceipt.preState as 'approval_required',
    commandPreVersion: commandReceipt.preVersion,
    commandPostState: commandReceipt.postState as 'approved',
    commandPostVersion: commandReceipt.postVersion,
    authorityPlanDigest: commandReceipt.authorityPlanDigest,
  };
}

function approvalJourney(proposalValue: DraftArtifactProposal) {
  const accepted = planDraftApprovalCommand(draftCommandInput('ACCEPT_PROPOSAL', {
    proposal: proposalValue,
    idempotencyKey: 'draft-command:accept-proposal-1',
  }));
  if (!accepted.ok || !accepted.value.transitionPlan) throw new Error(accepted.ok ? 'accept transition missing' : accepted.error.code);
  const acceptTransition = accepted.value.transitionPlan;

  const requested = planDraftApprovalCommand(draftCommandInput('REQUEST_APPROVAL', {
    proposal: proposalValue,
    expectedVersion: acceptTransition.nextVersion,
    readerSnapshot: {
      tenantRef: proposalValue.tenantRef, sequenceRef: proposalValue.sequenceRef, enrollmentRef: proposalValue.enrollmentRef,
      executionRef: proposalValue.executionRef, stepRef: proposalValue.stepRef, stepVersion: proposalValue.stepVersion,
      state: acceptTransition.to, version: acceptTransition.nextVersion,
    },
    idempotencyKey: 'draft-command:request-approval-1',
  }));
  if (!requested.ok || !requested.value.transitionPlan) throw new Error(requested.ok ? 'request transition missing' : requested.error.code);
  const requestTransition = requested.value.transitionPlan;

  const approved = planDraftApprovalCommand(draftCommandInput('APPROVE_DRAFT', {
    proposal: proposalValue,
    expectedVersion: requestTransition.nextVersion,
    readerSnapshot: {
      tenantRef: proposalValue.tenantRef, sequenceRef: proposalValue.sequenceRef, enrollmentRef: proposalValue.enrollmentRef,
      executionRef: proposalValue.executionRef, stepRef: proposalValue.stepRef, stepVersion: proposalValue.stepVersion,
      state: requestTransition.to, version: requestTransition.nextVersion,
    },
    idempotencyKey: 'draft-command:approve-draft-1',
  }));
  if (!approved.ok || !approved.value.receiptToPersist || !approved.value.approvalReceiptToPersist) {
    throw new Error(approved.ok ? 'approval receipts missing' : approved.error.code);
  }
  return {
    accepted,
    requested,
    approved,
    identity: approvedIdentityFromReceipts(proposalValue, approved.value.receiptToPersist, approved.value.approvalReceiptToPersist),
  };
}

function approvedIdentity(channel: 'EMAIL' | 'WHATSAPP' = 'EMAIL'): ApprovedDraftIdentityProjection {
  return approvalJourney(proposal({ channel })).identity;
}

function reservationEvidence(channel: 'EMAIL' | 'WHATSAPP' = 'EMAIL', idempotencyKey = 'outbox-key:1', expectedVersion = 8) {
  const decisionNow = '2026-08-04T00:05:00.000Z';
  const compliance = { kind: 'COMPLIANCE_EVALUATION' as const, policyVersion: 1 as const, tenantRef: ref('tenant-1'), enrollmentRef: ref('enrollment-1'), decision: 'CLEAR' as const, sourceKind: 'SYSTEM_COMPLIANCE_READER' as const, sourceReceiptRef: sourceRef('compliance-receipt:', '1'), evaluatedAt: decisionNow };
  const window = { kind: 'SENDING_WINDOW_EVALUATION' as const, policyVersion: 1 as const, tenantRef: ref('tenant-1'), channel, timezone: 'UTC', windowState: 'OPEN' as const, quietHoursState: 'CLEAR' as const, windowRef: ref('window-1'), quietHoursRef: ref('quiet-hours-1'), windowEndsAt: '2026-08-04T01:00:00.000Z', sourceKind: 'SYSTEM_WINDOW_READER' as const, sourceReceiptRef: sourceRef('window-receipt:', '1'), evaluatedAt: decisionNow };
  const rateLimit = { kind: 'RATE_LIMIT_EVALUATION' as const, policyVersion: 1 as const, tenantRef: ref('tenant-1'), channel, bucketRef: ref('rate-bucket-1'), decision: 'ALLOW' as const, limit: 10, used: 2, remaining: 8, windowStartAt: '2026-08-04T00:00:00.000Z', windowEndsAt: '2026-08-04T01:00:00.000Z', sourceKind: 'SYSTEM_RATE_LIMIT_READER' as const, sourceReceiptRef: sourceRef('rate-receipt:', '1'), evaluatedAt: decisionNow };
  const dedupe = { kind: 'OUTBOX_DEDUPE_EVALUATION' as const, policyVersion: 1 as const, tenantRef: ref('tenant-1'), channel, idempotencyKey, decision: 'NEW' as const, sourceKind: 'SYSTEM_DEDUPE_READER' as const, sourceReceiptRef: sourceRef('dedupe-receipt:', '1'), evaluatedAt: decisionNow };
  const outboxCas = { kind: 'OUTBOX_CAS_EVALUATION' as const, policyVersion: 1 as const, tenantRef: ref('tenant-1'), expectedVersion, currentVersion: expectedVersion, decision: 'MATCHED' as const, sourceKind: 'SYSTEM_OUTBOX_READER' as const, sourceReceiptRef: sourceRef('cas-receipt:', '1'), evaluatedAt: decisionNow };
  return {
    decisionNow,
    compliance: { ...compliance, evidenceDigest: computeComplianceEvidenceDigest(compliance) },
    window: { ...window, evidenceDigest: computeSendingWindowEvidenceDigest(window) },
    rateLimit: { ...rateLimit, evidenceDigest: computeRateLimitEvidenceDigest(rateLimit) },
    dedupe: { ...dedupe, evidenceDigest: computeDedupeEvidenceDigest(dedupe) },
    outboxCas: { ...outboxCas, evidenceDigest: computeOutboxCasEvidenceDigest(outboxCas) },
  };
}

function outboxInput(overrides: Record<string, unknown> = {}): OutboxComplianceInput {
  const channel = (overrides.channel as 'EMAIL' | 'WHATSAPP' | undefined) ?? 'EMAIL';
  const idempotencyKey = (overrides.idempotencyKey as string | undefined) ?? 'outbox-key:1';
  const draftIdentity = (overrides.draftIdentity as ApprovedDraftIdentityProjection | undefined) ?? approvedIdentity(channel);
  const expectedVersion = (overrides.expectedVersion as number | undefined) ?? draftIdentity.commandPostVersion;
  const e = reservationEvidence(channel, idempotencyKey, expectedVersion);
  return {
    schemaVersion: 1, policyVersion: 1, intent: 'SEND_AFTER_APPROVAL',
    tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'),
    executionRef: ref('execution-1'), stepRef: ref('step-1'), stepVersion: 3, channel,
    expectedVersion, idempotencyKey, decisionNow: e.decisionNow,
    readerSnapshot: { tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'), executionRef: ref('execution-1'), stepRef: ref('step-1'), stepVersion: 3, state: 'approved', version: expectedVersion },
    draftIdentity, compliance: e.compliance, window: e.window, rateLimit: e.rateLimit,
    dedupe: e.dedupe, outboxCas: e.outboxCas, ...overrides,
  } as OutboxComplianceInput;
}

function reservation(channel: 'EMAIL' | 'WHATSAPP' = 'EMAIL', idempotencyKey = 'outbox-key:1', draftIdentity = approvedIdentity(channel)): OutboxComplianceReceiptProjection {
  const e = reservationEvidence(channel, idempotencyKey, draftIdentity.commandPostVersion);
  const result = planOutboxCompliance({
    ...outboxInput({ channel, idempotencyKey, draftIdentity, window: e.window, rateLimit: e.rateLimit, dedupe: e.dedupe, outboxCas: e.outboxCas }),
    compliance: e.compliance,
  });
  if (!result.ok || !result.value.receiptToPersist) throw new Error(result.ok ? 'reservation receipt missing' : result.error.code);
  return result.value.receiptToPersist;
}

function provider(reservationReceipt: OutboxComplianceReceiptProjection, outcome: 'ACCEPTED' | 'DELIVERED' | 'FAILED' | 'UNKNOWN' = 'ACCEPTED', overrides: Record<string, unknown> = {}): ProviderOutcomeProjection {
  const base = {
    kind: 'PROVIDER_OUTCOME_PROJECTION' as const, policyVersion: 1 as const,
    tenantRef: reservationReceipt.tenantRef, sequenceRef: reservationReceipt.sequenceRef, enrollmentRef: reservationReceipt.enrollmentRef,
    executionRef: reservationReceipt.executionRef, stepRef: reservationReceipt.stepRef, stepVersion: reservationReceipt.stepVersion,
    channel: reservationReceipt.channel, reservationReceiptRef: reservationReceipt.receiptRef,
    reservationOperationDigest: reservationReceipt.operationDigest, outboxReceiptRef: reservationReceipt.outboxReceiptRef,
    reservationRef: reservationReceipt.reservationRef, reservationIdempotencyKey: reservationReceipt.idempotencyKey,
    sendingVersion: reservationReceipt.postVersion, providerOutcome: outcome,
    providerReceiptRef: 'provider-receipt:provider-1', sourceKind: 'SYSTEM_PROVIDER_OUTCOME_READER' as const,
    sourceReceiptRef: 'provider-outcome-receipt:1', observedAt: '2026-08-04T00:05:00.000Z',
  };
  const normalized = { ...base, ...overrides };
  const { evidenceDigest: _ignored, ...withoutDigest } = normalized as ProviderOutcomeProjection;
  return { ...normalized, evidenceDigest: computeProviderOutcomeDigest(withoutDigest) };
}

function business(reservationReceipt: OutboxComplianceReceiptProjection, providerProjection: ProviderOutcomeProjection, overrides: Record<string, unknown> = {}): BusinessSentReceiptProjection {
  const base = {
    kind: 'BUSINESS_SENT_RECEIPT' as const, policyVersion: 1 as const,
    tenantRef: reservationReceipt.tenantRef, sequenceRef: reservationReceipt.sequenceRef, enrollmentRef: reservationReceipt.enrollmentRef,
    executionRef: reservationReceipt.executionRef, stepRef: reservationReceipt.stepRef, stepVersion: reservationReceipt.stepVersion,
    channel: reservationReceipt.channel, reservationReceiptRef: reservationReceipt.receiptRef,
    reservationOperationDigest: reservationReceipt.operationDigest, outboxReceiptRef: reservationReceipt.outboxReceiptRef,
    reservationRef: reservationReceipt.reservationRef, reservationIdempotencyKey: reservationReceipt.idempotencyKey,
    sendingVersion: reservationReceipt.postVersion, businessReceiptRef: 'business-receipt:business-1',
    providerReceiptRef: providerProjection.providerReceiptRef, providerEvidenceDigest: providerProjection.evidenceDigest,
    providerOutcome: providerProjection.providerOutcome as 'ACCEPTED' | 'DELIVERED',
    sourceKind: 'SYSTEM_BUSINESS_OUTCOME_READER' as const, sourceReceiptRef: 'business-outcome-receipt:1', observedAt: '2026-08-04T00:05:00.000Z',
  };
  const normalized = { ...base, ...overrides };
  const { evidenceDigest: _ignored, ...withoutDigest } = normalized as BusinessSentReceiptProjection;
  return { ...normalized, evidenceDigest: computeBusinessSentReceiptDigest(withoutDigest) };
}

function outcomeInput(reservationReceipt: OutboxComplianceReceiptProjection, overrides: Record<string, unknown> = {}): OutcomeReconciliationInput {
  return {
    schemaVersion: 1, policyVersion: 1, intent: 'RECONCILE_OUTCOME',
    tenantRef: reservationReceipt.tenantRef, sequenceRef: reservationReceipt.sequenceRef, enrollmentRef: reservationReceipt.enrollmentRef,
    executionRef: reservationReceipt.executionRef, stepRef: reservationReceipt.stepRef, stepVersion: reservationReceipt.stepVersion,
    channel: reservationReceipt.channel, expectedVersion: reservationReceipt.postVersion, outcomeIdempotencyKey: 'outcome-key:1',
    decisionNow: reservationReceipt.decisionNow,
    readerSnapshot: { tenantRef: reservationReceipt.tenantRef, sequenceRef: reservationReceipt.sequenceRef, enrollmentRef: reservationReceipt.enrollmentRef, executionRef: reservationReceipt.executionRef, stepRef: reservationReceipt.stepRef, stepVersion: reservationReceipt.stepVersion, state: 'sending', version: reservationReceipt.postVersion },
    reservationReceipt, ...overrides,
  } as OutcomeReconciliationInput;
}

function stopDecision(eventKind: 'REPLY_RECEIVED' | 'OPT_OUT_RECEIVED'): EnrollmentStopEventReceiptProjection {
  const reason = eventKind === 'REPLY_RECEIVED' ? 'reply' : 'optout';
  const occurredAt = '2026-08-04T00:04:00.000Z';
  const eventIntent = {
    schemaVersion: 1 as const, policyVersion: 1 as const, eventKey: `stop-event:${reason}-1`, eventKind,
    sourceKind: eventKind === 'REPLY_RECEIVED' ? 'EMAIL_INBOUND' as const : 'EMAIL_INBOUND' as const,
    tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'), leadRef: ref('lead-1'), contactRef: null,
    sourceReceiptRef: `source-receipt:${reason}-1`, occurredAt,
  };
  const eventDigest = computeEnrollmentStopEventDigest(eventIntent);
  const stopPlan = planEnrollmentTransition({
    tenantRef: ref('tenant-1'), resourceTenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'),
    from: 'active', to: 'exited', expectedVersion: 7, currentVersion: 7, intent: 'ENROLLMENT_STOP', stopReason: reason,
    actorKind: 'SYSTEM', actorRole: 'SYSTEM', actorRef: 'system:enrollment-stop-event-reader-v1',
  });
  if (!stopPlan.ok) throw new Error(stopPlan.error.code);
  const operationDigest = computeEnrollmentStopOperationDigest({ ...eventIntent, eventDigest, preState: 'active', preVersion: 7, postState: 'exited', postVersion: 8, stopReason: reason, stopPlanOperationDigest: stopPlan.value.operationDigest });
  const result = planEnrollmentStopEvent({ ...eventIntent, decisionNow: '2026-08-04T00:05:00.000Z', eventDigest, operationDigest, readerSnapshot: { tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'), leadRef: ref('lead-1'), contactRef: null, status: 'active', version: 7 } });
  if (!result.ok || !result.value.receiptToPersist) throw new Error(result.ok ? 'stop receipt missing' : result.error.code);
  return result.value.receiptToPersist;
}

function expectNoCommands(value: Record<string, unknown>): void {
  expect(value.sendCommand).toBeNull();
  expect(value.providerCommand).toBeNull();
  expect(value.queueCommand).toBeNull();
  if ('retryCommand' in value) expect(value.retryCommand).toBeNull();
}

describe('CRM-03F sales-sequence pure contract journey', () => {
  it('connects proposal/manual approval -> reservation -> provider-only -> business sent -> exact replay', () => {
    const proposed = planDraftArtifactProposal(proposalInput());
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    const proposalValue = proposed.value.proposal;
    expect(proposed.value.decision).toBe('PROPOSAL_ONLY');
    expect(proposed.value.sendCommand).toBeNull();

    const approval = approvalJourney(proposalValue);
    expect(approval.accepted.value.transitionPlan?.from).toBe('draft_pending');
    expect(approval.accepted.value.transitionPlan?.to).toBe('draft_ready');
    expect(approval.requested.value.transitionPlan?.from).toBe(approval.accepted.value.transitionPlan?.to);
    expect(approval.requested.value.transitionPlan?.expectedVersion).toBe(approval.accepted.value.transitionPlan?.nextVersion);
    expect(approval.approved.value.transitionPlan?.from).toBe(approval.requested.value.transitionPlan?.to);
    expect(approval.approved.value.transitionPlan?.expectedVersion).toBe(approval.requested.value.transitionPlan?.nextVersion);
    expect(approval.approved.value.receiptToPersist).toEqual(expect.objectContaining({
      operationDigest: approval.identity.commandOperationDigest,
      receiptRef: approval.identity.commandReceiptRef,
      preVersion: approval.identity.commandPreVersion,
      postVersion: approval.identity.commandPostVersion,
    }));
    expect(approval.approved.value.approvalReceiptToPersist).toEqual(expect.objectContaining({
      receiptRef: approval.identity.approvalReceiptRef,
      approvalDigest: approval.identity.approvalDigest,
    }));
    expect(approval.approved.value.sendCommand).toBeNull();

    const reserved = reservation('EMAIL', 'outbox-key:1', approval.identity);
    expect(reserved.preState).toBe('approved');
    expect(reserved.postState).toBe('sending');
    const providerOnly = planOutcomeReconciliation(outcomeInput(reserved, {
      outcomeIdempotencyKey: 'outcome-key:provider-only', providerOutcome: provider(reserved),
    }));
    expect(providerOnly.ok).toBe(true);
    if (!providerOnly.ok || !providerOnly.value.receiptToPersist) return;
    expect(providerOnly.value.decision).toBe('PROVIDER_EVIDENCE_ONLY');
    expect(providerOnly.value.transitionPlan).toBeNull();
    expectNoCommands(providerOnly.value as unknown as Record<string, unknown>);

    const predecessor = providerOnly.value.receiptToPersist;
    const providerProjection = provider(reserved);
    const businessSent = planOutcomeReconciliation(outcomeInput(reserved, {
      outcomeIdempotencyKey: 'outcome-key:business-sent',
      businessReceipt: business(reserved, providerProjection), predecessorOutcomeReceipt: predecessor,
    }));
    expect(businessSent.ok).toBe(true);
    if (!businessSent.ok || !businessSent.value.receiptToPersist) return;
    expect(businessSent.value.decision).toBe('BUSINESS_SENT');
    expect(businessSent.value.transitionPlan?.from).toBe('sending');
    expect(businessSent.value.transitionPlan?.to).toBe('sent');
    expect(businessSent.value.receiptToPersist.providerOutcome).toBeUndefined();
    expect(businessSent.value.receiptToPersist.predecessorOutcomeReceipt?.receiptRef).toBe(predecessor.receiptRef);
    expectNoCommands(businessSent.value as unknown as Record<string, unknown>);

    const finalReceipt = businessSent.value.receiptToPersist;
    const replay = planOutcomeReconciliation(outcomeInput(reserved, {
      expectedVersion: finalReceipt.preVersion,
      outcomeIdempotencyKey: finalReceipt.outcomeIdempotencyKey,
      readerSnapshot: { ...outcomeInput(reserved).readerSnapshot, state: 'sent', version: finalReceipt.postVersion },
      businessReceipt: business(reserved, providerProjection), predecessorOutcomeReceipt: predecessor,
      persistedOutcomeReceipt: finalReceipt,
    }));
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.decision).toBe('REPLAY');
      expect(replay.value.transitionPlan).toBeNull();
      expect(replay.value.receiptToPersist).toBeNull();
      expectNoCommands(replay.value as unknown as Record<string, unknown>);
    }
  });

  it('keeps atomic provider plus business evidence distinct and channel-safe', () => {
    for (const channel of ['EMAIL', 'WHATSAPP'] as const) {
      const reserved = reservation(channel, `outbox-key:${channel.toLowerCase()}`);
      const providerProjection = provider(reserved);
      const result = planOutcomeReconciliation(outcomeInput(reserved, {
        channel, outcomeIdempotencyKey: `outcome-key:atomic-${channel.toLowerCase()}`,
        providerOutcome: providerProjection, businessReceipt: business(reserved, providerProjection),
      }));
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.decision).toBe('BUSINESS_SENT');
      expect(result.value.receiptToPersist?.providerOutcome?.providerReceiptRef).toBe(providerProjection.providerReceiptRef);
      expect(result.value.receiptToPersist?.predecessorOutcomeReceipt).toBeUndefined();
      expectNoCommands(result.value as unknown as Record<string, unknown>);
    }
  });

  it('rejects a tampered upstream approval receipt identity before creating a reservation', () => {
    const proposalValue = proposal();
    const approval = approvalJourney(proposalValue);
    const identity = approval.identity;
    const mutations = [
      { approvalReceiptRef: 'approval-receipt:tampered' },
      { commandReceiptRef: 'draft-approval-receipt:tampered' },
      { commandOperationDigest: digest('tampered-command') },
      { commandPreVersion: identity.commandPreVersion - 1, commandPostVersion: identity.commandPostVersion - 1 },
    ];
    for (const mutation of mutations) {
      const result = planOutboxCompliance(outboxInput({ draftIdentity: { ...identity, ...mutation } }));
      expect(resultCode(result)).toBe('INVALID_DRAFT_IDENTITY');
    }
  });

  it.each(['REPLY_RECEIVED', 'OPT_OUT_RECEIVED'] as const)('gives %s stop precedence over outcome reconciliation', (eventKind) => {
    const reserved = reservation();
    const result = planOutcomeReconciliation(outcomeInput(reserved, {
      providerOutcome: provider(reserved), stopDecision: stopDecision(eventKind),
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decision).toBe('STOP_RECONCILIATION_REQUIRED');
    expect(result.value.transitionPlan).toBeNull();
    expect(result.value.receiptToPersist?.postState).toBe('sending');
    expectNoCommands(result.value as unknown as Record<string, unknown>);
  });

  it('creates no reservation in quiet hours or when rate limited', () => {
    const quietEvidence = reservationEvidence();
    const { evidenceDigest: _quietDigest, ...quietWindowWithoutDigest } = quietEvidence.window;
    const quietWindow = { ...quietWindowWithoutDigest, quietHoursState: 'QUIET' as const };
    const quiet = planOutboxCompliance(outboxInput({
      window: { ...quietWindow, evidenceDigest: computeSendingWindowEvidenceDigest(quietWindow) },
    }));
    const limitedEvidence = reservationEvidence();
    const { evidenceDigest: _limitedDigest, ...limitedRateWithoutDigest } = limitedEvidence.rateLimit;
    const limitedRate = { ...limitedRateWithoutDigest, decision: 'LIMITED' as const, used: 10, remaining: 0 };
    const limited = planOutboxCompliance(outboxInput({ rateLimit: { ...limitedRate, evidenceDigest: computeRateLimitEvidenceDigest(limitedRate) } }));
    for (const result of [quiet, limited]) {
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.reservationPlan).toBeNull();
      expect(result.value.receiptToPersist).toBeNull();
      expect(result.value.transitionPlan).toBeNull();
      expectNoCommands(result.value as unknown as Record<string, unknown>);
    }
  });

  it.each(['FAILED', 'UNKNOWN'] as const)('routes provider %s to manual reconciliation only', (outcome) => {
    const reserved = reservation();
    const result = planOutcomeReconciliation(outcomeInput(reserved, { providerOutcome: provider(reserved, outcome) }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decision).toBe('MANUAL_RECONCILIATION_REQUIRED');
    expect(result.value.transitionPlan).toBeNull();
    expect(result.value.retryCommand).toBeNull();
    expectNoCommands(result.value as unknown as Record<string, unknown>);
  });

  it('fails closed for cross-reservation, version, and persisted receipt tampering', () => {
    const reservationA = reservation('EMAIL', 'outbox-key:a');
    const reservationB = reservation('EMAIL', 'outbox-key:b');
    expect(resultCode(planOutcomeReconciliation(outcomeInput(reservationA, { providerOutcome: provider(reservationB) })))).toBe('SCOPE_MISMATCH');

    const atomic = planOutcomeReconciliation(outcomeInput(reservationA, {
      providerOutcome: provider(reservationA), businessReceipt: business(reservationA, provider(reservationA)),
    }));
    expect(atomic.ok).toBe(true);
    if (!atomic.ok || !atomic.value.receiptToPersist) return;
    const receipt = atomic.value.receiptToPersist;
    const postReader = { ...outcomeInput(reservationA).readerSnapshot, state: 'sent' as const, version: receipt.postVersion };
    expect(resultCode(planOutcomeReconciliation(outcomeInput(reservationA, {
      expectedVersion: receipt.preVersion + 1, readerSnapshot: postReader, providerOutcome: provider(reservationA),
      businessReceipt: business(reservationA, provider(reservationA)), persistedOutcomeReceipt: receipt,
    })))).toMatch(/OUTCOME_CONFLICT|REPLAY_STATE_MISMATCH/);
    expect(resultCode(planOutcomeReconciliation(outcomeInput(reservationA, {
      expectedVersion: receipt.preVersion, readerSnapshot: postReader, providerOutcome: provider(reservationA),
      businessReceipt: business(reservationA, provider(reservationA)), persistedOutcomeReceipt: { ...receipt, operationDigest: digest('tampered') },
    })))).toBe('INVALID_PERSISTED_RECEIPT');
    expect(resultCode(planOutcomeReconciliation(outcomeInput(reservationA, {
      expectedVersion: receipt.preVersion, readerSnapshot: postReader, providerOutcome: provider(reservationA),
      businessReceipt: business(reservationA, provider(reservationA)), persistedOutcomeReceipt: { ...receipt, reservationReceiptRef: reservationB.receiptRef },
    })))).toMatch(/INVALID_PERSISTED_RECEIPT|OUTCOME_CONFLICT/);
  });

  it('keeps every public plan deterministic, recursively frozen, metadata-only, and command-free', () => {
    const reserved = reservation();
    const input = outcomeInput(reserved, { providerOutcome: provider(reserved) });
    const first = planOutcomeReconciliation(input);
    const second = planOutcomeReconciliation(input);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(Object.isFrozen(first)).toBe(true);
    if (first.ok) {
      expect(Object.isFrozen(first.value)).toBe(true);
      expect(Object.isFrozen(first.value.receiptToPersist)).toBe(true);
      expect(Object.isFrozen(first.value.receiptToPersist?.providerOutcome)).toBe(true);
      expectNoCommands(first.value as unknown as Record<string, unknown>);
      expect(JSON.stringify(first.value)).not.toMatch(/body|providerPayload|providerError|subject|phone|jid/);
    }
    const failed = planOutcomeReconciliation({ ...input, providerOutcome: undefined });
    expect(Object.isFrozen(failed)).toBe(true);
    if (!failed.ok) expect(Object.isFrozen(failed.error)).toBe(true);
  });
});
