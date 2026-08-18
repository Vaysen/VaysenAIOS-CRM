import {
  computeComplianceEvidenceDigest,
  computeDedupeEvidenceDigest,
  computeOutboxCasEvidenceDigest,
  computeOutboxComplianceOperationDigest,
  computeRateLimitEvidenceDigest,
  computeSendingWindowEvidenceDigest,
  planOutboxCompliance,
  type ApprovedDraftIdentityProjection,
  type OutboxComplianceInput,
} from './outbox-compliance-plan-contract';
import {
  computeDraftApprovalOperationDigest,
  computeDraftArtifactProposalDigest,
  computeManualDraftApprovalDigest,
  planDraftArtifactProposal,
  type DraftApprovalActorRole,
  type DraftArtifactProposal,
} from './draft-approval-isolation-contract';
import { planStepExecutionTransition } from './sales-sequence-contract';

const ref = (value: string) => `ref:${value}`;
const digest = (domain: string, fill = 'a') => `sha256:${domain}:${fill.repeat(64)}`;
const actorRef = (role: DraftApprovalActorRole) => `draft-actor:${role.toLowerCase()}`;
const sourceRef = (prefix: string, value: string) => `${prefix}${value}`;

function resultCode(result: { ok: boolean; error?: { code: string } }): string {
  if (result.ok || !result.error) throw new Error('expected a rejected contract result');
  return result.error.code;
}

function safeSuffix(value: string): string {
  return value.slice(-32).replace(/[0-9]/g, (digit) => String.fromCharCode('g'.charCodeAt(0) + Number(digit)));
}

function proposal(): DraftArtifactProposal {
  const result = planDraftArtifactProposal({
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
    channel: 'EMAIL',
    proposalVersion: 1,
    rendererKind: 'SYSTEM_RENDERER',
    rendererRef: 'draft-renderer:system-1',
    createdAt: '2026-08-04T00:00:00Z',
  });
  if (!result.ok) throw new Error(result.error.code);
  return result.value.proposal;
}

function approvedIdentity(channel: 'EMAIL' | 'WHATSAPP' = 'EMAIL'): ApprovedDraftIdentityProjection {
  const p = proposal();
  const role: DraftApprovalActorRole = 'OWNER';
  const approvalActorRef = actorRef(role);
  const approvedAt = '2026-08-04T00:01:00.000Z';
  const approvalIntent = {
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
    actorRef: approvalActorRef,
    approvedAt,
  };
  const approvalDigest = computeManualDraftApprovalDigest(approvalIntent);
  const approvalReceiptRef = sourceRef('approval-receipt:', safeSuffix(approvalDigest));
  const authority = planStepExecutionTransition({
    executionRef: p.executionRef,
    tenantRef: p.tenantRef,
    sequenceRef: p.sequenceRef,
    enrollmentRef: p.enrollmentRef,
    stepRef: p.stepRef,
    stepVersion: p.stepVersion,
    from: 'approval_required',
    to: 'approved',
    expectedVersion: 7,
    currentVersion: 7,
    intent: 'REVIEW_DRAFT',
    approvalReceiptRef,
    actorKind: 'HUMAN',
    actorRole: role,
    actorRef: approvalActorRef,
  });
  if (!authority.ok) throw new Error(authority.error.code);
  const commandIdempotencyKey = 'draft-command:approve-1';
  const commandOperationDigest = computeDraftApprovalOperationDigest({
    schemaVersion: 1,
    policyVersion: 1,
    command: 'APPROVE_DRAFT',
    intent: 'REVIEW_DRAFT',
    idempotencyKey: commandIdempotencyKey,
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
    actorKind: 'HUMAN',
    actorRole: role,
    actorRef: approvalActorRef,
    preState: 'approval_required',
    preVersion: 7,
    postState: 'approved',
    postVersion: 8,
    authorityPlanDigest: authority.value.operationDigest,
    approvalDigest,
  });
  return {
    channel,
    proposalVersion: p.proposalVersion,
    proposalDigest: p.proposalDigest,
    renderedArtifactRef: p.renderedArtifactRef,
    templateSnapshotDigest: p.templateSnapshotDigest,
    variableSnapshotDigest: p.variableSnapshotDigest,
    contentDigest: p.contentDigest,
    approvalReceiptRef,
    approvalDigest,
    approvalActorRole: role,
    approvalActorRef,
    approvedAt,
    commandReceiptRef: sourceRef('draft-approval-receipt:', safeSuffix(commandOperationDigest)),
    commandOperationDigest,
    commandIdempotencyKey,
    commandPreState: 'approval_required',
    commandPreVersion: 7,
    commandPostState: 'approved',
    commandPostVersion: 8,
    authorityPlanDigest: authority.value.operationDigest,
  };
}

function evidence(overrides: Record<string, unknown> = {}) {
  const decisionNow = '2026-08-04T00:05:00.000Z';
  const complianceBase = {
    kind: 'COMPLIANCE_EVALUATION' as const,
    policyVersion: 1 as const,
    tenantRef: ref('tenant-1'),
    enrollmentRef: ref('enrollment-1'),
    decision: 'CLEAR' as const,
    sourceKind: 'SYSTEM_COMPLIANCE_READER' as const,
    sourceReceiptRef: sourceRef('compliance-receipt:', '1'),
    evaluatedAt: decisionNow,
  };
  const windowBase = {
    kind: 'SENDING_WINDOW_EVALUATION' as const,
    policyVersion: 1 as const,
    tenantRef: ref('tenant-1'),
    channel: 'EMAIL' as const,
    timezone: 'UTC',
    windowState: 'OPEN' as const,
    quietHoursState: 'CLEAR' as const,
    windowRef: ref('window-1'),
    quietHoursRef: ref('quiet-hours-1'),
    windowEndsAt: '2026-08-04T01:00:00.000Z',
    sourceKind: 'SYSTEM_WINDOW_READER' as const,
    sourceReceiptRef: sourceRef('window-receipt:', '1'),
    evaluatedAt: decisionNow,
  };
  const rateBase = {
    kind: 'RATE_LIMIT_EVALUATION' as const,
    policyVersion: 1 as const,
    tenantRef: ref('tenant-1'),
    channel: 'EMAIL' as const,
    bucketRef: ref('rate-bucket-1'),
    decision: 'ALLOW' as const,
    limit: 10,
    used: 2,
    remaining: 8,
    windowStartAt: '2026-08-04T00:00:00.000Z',
    windowEndsAt: '2026-08-04T01:00:00.000Z',
    sourceKind: 'SYSTEM_RATE_LIMIT_READER' as const,
    sourceReceiptRef: sourceRef('rate-receipt:', '1'),
    evaluatedAt: decisionNow,
  };
  const dedupeBase = {
    kind: 'OUTBOX_DEDUPE_EVALUATION' as const,
    policyVersion: 1 as const,
    tenantRef: ref('tenant-1'),
    channel: 'EMAIL' as const,
    idempotencyKey: 'outbox-key:1',
    decision: 'NEW' as const,
    sourceKind: 'SYSTEM_DEDUPE_READER' as const,
    sourceReceiptRef: sourceRef('dedupe-receipt:', '1'),
    evaluatedAt: decisionNow,
  };
  const casBase = {
    kind: 'OUTBOX_CAS_EVALUATION' as const,
    policyVersion: 1 as const,
    tenantRef: ref('tenant-1'),
    expectedVersion: 8,
    currentVersion: 8,
    decision: 'MATCHED' as const,
    sourceKind: 'SYSTEM_OUTBOX_READER' as const,
    sourceReceiptRef: sourceRef('cas-receipt:', '1'),
    evaluatedAt: decisionNow,
  };
  const merged = {
    compliance: { ...complianceBase, ...(overrides.compliance as object | undefined) },
    window: { ...windowBase, ...(overrides.window as object | undefined) },
    rateLimit: { ...rateBase, ...(overrides.rateLimit as object | undefined) },
    dedupe: { ...dedupeBase, ...(overrides.dedupe as object | undefined) },
    outboxCas: { ...casBase, ...(overrides.outboxCas as object | undefined) },
  };
  return {
    decisionNow,
    compliance: { ...merged.compliance, evidenceDigest: computeComplianceEvidenceDigest(merged.compliance) },
    window: { ...merged.window, evidenceDigest: computeSendingWindowEvidenceDigest(merged.window) },
    rateLimit: { ...merged.rateLimit, evidenceDigest: computeRateLimitEvidenceDigest(merged.rateLimit) },
    dedupe: { ...merged.dedupe, evidenceDigest: computeDedupeEvidenceDigest(merged.dedupe) },
    outboxCas: { ...merged.outboxCas, evidenceDigest: computeOutboxCasEvidenceDigest(merged.outboxCas) },
  };
}

function baseInput(overrides: Record<string, unknown> = {}): OutboxComplianceInput {
  const identity = approvedIdentity();
  const e = evidence();
  return {
    schemaVersion: 1,
    policyVersion: 1,
    intent: 'SEND_AFTER_APPROVAL',
    tenantRef: ref('tenant-1'),
    sequenceRef: ref('sequence-1'),
    enrollmentRef: ref('enrollment-1'),
    executionRef: ref('execution-1'),
    stepRef: ref('step-1'),
    stepVersion: 3,
    channel: 'EMAIL',
    expectedVersion: 8,
    idempotencyKey: 'outbox-key:1',
    decisionNow: e.decisionNow,
    readerSnapshot: {
      tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'),
      executionRef: ref('execution-1'), stepRef: ref('step-1'), stepVersion: 3, state: 'approved', version: 8,
    },
    draftIdentity: identity,
    compliance: e.compliance,
    window: e.window,
    rateLimit: e.rateLimit,
    dedupe: e.dedupe,
    outboxCas: e.outboxCas,
    ...overrides,
  } as OutboxComplianceInput;
}

describe('CRM-03D-1 outbox compliance plan contract', () => {
  it.each(['EMAIL', 'WHATSAPP'] as const)('plans %s only after exact approval and all verified checks', (channel) => {
    const input = baseInput({ channel, draftIdentity: approvedIdentity(channel), window: evidence({ window: { channel } }).window, rateLimit: evidence({ rateLimit: { channel } }).rateLimit, dedupe: evidence({ dedupe: { channel } }).dedupe });
    const result = planOutboxCompliance(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decision).toBe('NEW');
    expect(result.value.transitionPlan?.from).toBe('approved');
    expect(result.value.transitionPlan?.to).toBe('sending');
    expect(result.value.transitionPlan?.intent).toBe('SEND_AFTER_APPROVAL');
    expect(result.value.transitionPlan?.actorKind).toBe('FUTURE_EXTERNAL_EXECUTOR');
    expect(result.value.reservationPlan?.channel).toBe(channel);
    expect(result.value.receiptToPersist?.preVersion).toBe(8);
    expect(result.value.receiptToPersist?.postVersion).toBe(9);
    expect(result.value.sendCommand).toBeNull();
    expect(result.value.providerCommand).toBeNull();
    expect(result.value.queueCommand).toBeNull();
  });

  it('returns STOP/BLOCK with no reservation when compliance reports a mapped stop', () => {
    const stop = evidence({ compliance: { decision: 'STOP', stopReason: 'optout' } });
    const block = evidence({ compliance: { decision: 'BLOCK', stopReason: 'permission_revoked' } });
    for (const current of [stop, block]) {
      const withEvidence = baseInput({ compliance: current.compliance });
      const { window: _window, rateLimit: _rateLimit, dedupe: _dedupe, outboxCas: _outboxCas, ...stopInput } = withEvidence;
      const result = planOutboxCompliance(stopInput);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(['STOP', 'BLOCK']).toContain(result.value.decision);
      expect(result.value.reservationPlan).toBeNull();
      expect(result.value.transitionPlan).toBeNull();
      expect(result.value.receiptToPersist).toBeNull();
      expect(result.value.sendCommand).toBeNull();
    }
  });

  it.each([
    ['closed window', { windowState: 'CLOSED' }, 'WINDOW_CLOSED'],
    ['quiet hours', { quietHoursState: 'QUIET' }, 'QUIET_HOURS'],
    ['rate limited', { decision: 'LIMITED', used: 10, remaining: 0 }, 'RATE_LIMITED'],
    ['dedupe conflict', { decision: 'CONFLICT' }, 'DEDUPE_CONFLICT'],
  ])('fails closed for %s', (_label, change, expected) => {
    const current = evidence({
      window: _label === 'closed window' || _label === 'quiet hours' ? change : undefined,
      rateLimit: _label === 'rate limited' ? change : undefined,
      dedupe: _label === 'dedupe conflict' ? change : undefined,
    });
    const result = planOutboxCompliance(baseInput({ window: current.window, rateLimit: current.rateLimit, dedupe: current.dedupe }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.decision).toBe(expected);
  });

  it('replays only from the persisted sending post-state and binds receipt evidence', () => {
    const first = planOutboxCompliance(baseInput());
    expect(first.ok).toBe(true);
    if (!first.ok || !first.value.receiptToPersist) return;
    const replayEvidence = evidence({ dedupe: { decision: 'REPLAY', existingReceiptRef: first.value.receiptToPersist.receiptRef } });
    const replayBase = baseInput({
      readerSnapshot: { ...baseInput().readerSnapshot, state: 'sending', version: 9 },
      dedupe: replayEvidence.dedupe,
      persistedReceipt: first.value.receiptToPersist,
    });
    const { window: _window, rateLimit: _rateLimit, outboxCas: _outboxCas, ...input } = replayBase;
    const replay = planOutboxCompliance(input);
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.decision).toBe('REPLAY');
      expect(replay.value.transitionPlan).toBeNull();
      expect(replay.value.receiptToPersist).toBeNull();
    }
    const preState = planOutboxCompliance({ ...input, readerSnapshot: { ...input.readerSnapshot, state: 'approved', version: 8 } });
    expect(resultCode(preState)).toBe('REPLAY_STATE_MISMATCH');
    const versionDrift = planOutboxCompliance({ ...input, expectedVersion: 7 });
    expect(resultCode(versionDrift)).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('separates persisted replay dedupe from NEW reservation evidence', () => {
    const first = planOutboxCompliance(baseInput());
    expect(first.ok).toBe(true);
    if (!first.ok || !first.value.receiptToPersist) return;
    const replayEvidence = evidence({ dedupe: { decision: 'REPLAY', existingReceiptRef: first.value.receiptToPersist.receiptRef } });
    const replayBase = baseInput({ readerSnapshot: { ...baseInput().readerSnapshot, state: 'sending', version: 9 }, dedupe: replayEvidence.dedupe, persistedReceipt: first.value.receiptToPersist });
    const { window: _window, rateLimit: _rateLimit, outboxCas: _outboxCas, ...replayInput } = replayBase;
    expect(resultCode(planOutboxCompliance({ ...replayInput, dedupe: evidence().dedupe }))).toBe('IDEMPOTENCY_CONFLICT');
    expect(resultCode(planOutboxCompliance({ ...replayInput, dedupe: evidence({ dedupe: { decision: 'REPLAY', existingReceiptRef: 'outbox-plan-receipt:wrong' } }).dedupe }))).toBe('IDEMPOTENCY_CONFLICT');
    expect(resultCode(planOutboxCompliance({ ...replayInput, persistedReceipt: undefined }))).toBe('EXPLICIT_UNDEFINED');
    expect(resultCode(planOutboxCompliance({ ...baseInput(), dedupe: replayEvidence.dedupe }))).toBe('INVALID_DEDUPE_EVIDENCE');
    expect(resultCode(planOutboxCompliance({ ...replayInput, window: evidence().window }))).toBe('INVALID_RECEIPT');
    expect(resultCode(planOutboxCompliance({ ...replayInput, outboxCas: evidence({ outboxCas: { expectedVersion: 7, currentVersion: 7 } }).outboxCas }))).toBe('INVALID_RECEIPT');
  });

  it('rejects tampered receipt, cross-scope identity, and stale reader state', () => {
    const first = planOutboxCompliance(baseInput());
    expect(first.ok).toBe(true);
    if (!first.ok || !first.value.receiptToPersist) return;
    const persistedReceipt = first.value.receiptToPersist;
    const replayEvidence = evidence({ dedupe: { decision: 'REPLAY', existingReceiptRef: first.value.receiptToPersist.receiptRef } });
    const postBase = baseInput({ readerSnapshot: { ...baseInput().readerSnapshot, state: 'sending', version: 9 }, dedupe: replayEvidence.dedupe, persistedReceipt: first.value.receiptToPersist });
    const { window: _window, rateLimit: _rateLimit, outboxCas: _outboxCas, ...post } = postBase;
    expect(resultCode(planOutboxCompliance({ ...post, persistedReceipt: { ...persistedReceipt, operationDigest: digest('tampered') } }))).toBe('INVALID_RECEIPT');
    expect(resultCode(planOutboxCompliance({ ...post, persistedReceipt: { ...persistedReceipt, evidence: { ...persistedReceipt.evidence, rateLimit: { ...persistedReceipt.evidence.rateLimit, used: 3 } } } }))).toBe('INVALID_RECEIPT');
    const closedWindow = evidence({ window: { windowState: 'CLOSED' } }).window;
    expect(resultCode(planOutboxCompliance({ ...post, persistedReceipt: { ...persistedReceipt, evidence: { ...persistedReceipt.evidence, window: closedWindow } } }))).toBe('INVALID_RECEIPT');
    expect(resultCode(planOutboxCompliance({ ...post, tenantRef: ref('tenant-2') }))).toMatch(/SCOPE_MISMATCH|INVALID_DRAFT_IDENTITY/);
    expect(resultCode(planOutboxCompliance({ ...baseInput(), readerSnapshot: { ...baseInput().readerSnapshot, state: 'sending', version: 9 } }))).toBe('REPLAY_STATE_MISMATCH');
  });

  it('binds replay to expectedVersion, idempotency key, decisionNow, and draft identity', () => {
    const first = planOutboxCompliance(baseInput());
    expect(first.ok).toBe(true);
    if (!first.ok || !first.value.receiptToPersist) return;
    const replayEvidence = evidence({ dedupe: { decision: 'REPLAY', existingReceiptRef: first.value.receiptToPersist.receiptRef } });
    const replayBase = baseInput({ readerSnapshot: { ...baseInput().readerSnapshot, state: 'sending', version: 9 }, dedupe: replayEvidence.dedupe, persistedReceipt: first.value.receiptToPersist });
    const { window: _window, rateLimit: _rateLimit, outboxCas: _outboxCas, ...replayInput } = replayBase;
    expect(resultCode(planOutboxCompliance({ ...replayInput, expectedVersion: 7 }))).toBe('IDEMPOTENCY_CONFLICT');
    const changedKeyEvidence = evidence({ dedupe: { idempotencyKey: 'outbox-key:2', decision: 'REPLAY', existingReceiptRef: first.value.receiptToPersist.receiptRef } });
    expect(resultCode(planOutboxCompliance({ ...replayInput, idempotencyKey: 'outbox-key:2', dedupe: changedKeyEvidence.dedupe }))).toBe('IDEMPOTENCY_CONFLICT');
    const changedNow = '2026-08-04T00:06:00.000Z';
    const changedNowEvidence = evidence({
      compliance: { evaluatedAt: changedNow },
      dedupe: { evaluatedAt: changedNow, decision: 'REPLAY', existingReceiptRef: first.value.receiptToPersist.receiptRef },
    });
    expect(resultCode(planOutboxCompliance({ ...replayInput, decisionNow: changedNow, compliance: changedNowEvidence.compliance, dedupe: changedNowEvidence.dedupe }))).toBe('IDEMPOTENCY_CONFLICT');
    expect(resultCode(planOutboxCompliance({ ...replayInput, draftIdentity: { ...replayInput.draftIdentity, contentDigest: digest('changed-content') } }))).toBe('INVALID_DRAFT_IDENTITY');
  });

  it('changes the operation digest for every evidence dimension', () => {
    const first = planOutboxCompliance(baseInput());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const cases = [
      { compliance: { sourceReceiptRef: sourceRef('compliance-receipt:', '2') } },
      { window: { sourceReceiptRef: sourceRef('window-receipt:', '2') } },
      { rateLimit: { sourceReceiptRef: sourceRef('rate-receipt:', '2') } },
      { dedupe: { sourceReceiptRef: sourceRef('dedupe-receipt:', '2') } },
      { outboxCas: { sourceReceiptRef: sourceRef('cas-receipt:', '2') } },
    ];
    for (const change of cases) {
      const current = evidence(change);
      const next = planOutboxCompliance(baseInput({ compliance: current.compliance, window: current.window, rateLimit: current.rateLimit, dedupe: current.dedupe, outboxCas: current.outboxCas }));
      expect(next.ok).toBe(true);
      if (next.ok) expect(next.value.operationDigest).not.toBe(first.value.operationDigest);
    }
  });

  it('rejects unknown, explicit undefined, PII, URL, provider and client-confirmation fields', () => {
    const cases = [
      { extra: true },
      { window: { ...evidence().window, confirmed: true } },
      { window: { ...evidence().window, url: 'https://example.invalid' } },
      { window: { ...evidence().window, providerPayload: 'raw' } },
      { window: { ...evidence().window, status: 'pass' } },
      { compliance: { ...evidence().compliance, sourceReceiptRef: 'compliance-receipt:test@example.com' } },
      { dedupe: { ...evidence().dedupe, idempotencyKey: undefined } },
    ];
    for (const current of cases) expect(planOutboxCompliance({ ...baseInput(), ...current } as unknown)).toMatchObject({ ok: false });
  });

  it('rejects invalid/future timestamps, stale evidence, missing CAS and changed intent', () => {
    const future = evidence({ window: { evaluatedAt: '2026-08-04T00:06:00Z' } });
    expect(resultCode(planOutboxCompliance(baseInput({ window: future.window })))).toBe('FUTURE_EVIDENCE');
    const stale = evidence({ window: { evaluatedAt: '2026-08-04T00:04:00Z' } });
    expect(resultCode(planOutboxCompliance(baseInput({ window: stale.window })))).toBe('FUTURE_EVIDENCE');
    expect(resultCode(planOutboxCompliance(baseInput({ decisionNow: '2026-02-31T00:00:00Z' })))).toBe('INVALID_TIMESTAMP');
    expect(resultCode(planOutboxCompliance(baseInput({ outboxCas: undefined })))).toBe('EXPLICIT_UNDEFINED');
    expect(resultCode(planOutboxCompliance({ ...baseInput(), intent: 'CREATE_DRAFT' }))).toBe('TYPE_MISMATCH');
    expect(resultCode(planOutboxCompliance({ ...baseInput(), readerSnapshot: { ...baseInput().readerSnapshot, version: 7 } }))).toBe('CAS_CONFLICT');
  });

  it('enforces all rate-limit arithmetic and decision invariants', () => {
    const limited = evidence({ rateLimit: { decision: 'LIMITED', used: 10, remaining: 0 } });
    expect(planOutboxCompliance(baseInput({ rateLimit: limited.rateLimit })).ok).toBe(true);
    const invalidCases = [
      evidence({ rateLimit: { decision: 'LIMITED', used: 9, remaining: 1 } }).rateLimit,
      evidence({ rateLimit: { decision: 'ALLOW', used: 10, remaining: 0 } }).rateLimit,
      evidence({ rateLimit: { decision: 'ALLOW', used: 2, remaining: 7 } }).rateLimit,
    ];
    for (const rateLimit of invalidCases) expect(resultCode(planOutboxCompliance(baseInput({ rateLimit })))).toBe('INVALID_RATE_LIMIT_EVIDENCE');
  });

  it('is deterministic and recursively freezes success, failure, evidence, reservation, and receipt', () => {
    const first = planOutboxCompliance(baseInput());
    const second = planOutboxCompliance(baseInput());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(Object.isFrozen(first)).toBe(true);
    if (first.ok) {
      expect(Object.isFrozen(first.value)).toBe(true);
      expect(Object.isFrozen(first.value.evidence)).toBe(true);
      expect(Object.isFrozen(first.value.receiptToPersist)).toBe(true);
      expect(Object.isFrozen(first.value.receiptToPersist?.evidence)).toBe(true);
    }
    const failed = planOutboxCompliance({ ...baseInput(), expectedVersion: 7 });
    expect(Object.isFrozen(failed)).toBe(true);
    if (!failed.ok) expect(Object.isFrozen(failed.error)).toBe(true);
  });

  it('does not accept provider accepted, UNKNOWN retry, or direct-send metadata', () => {
    const result = planOutboxCompliance({ ...baseInput(), providerReceiptRef: 'provider-receipt:1' });
    expect(resultCode(result)).toBe('UNKNOWN_FIELD');
    const unknown = planOutboxCompliance({ ...baseInput(), outboxCas: { ...evidence().outboxCas, decision: 'UNKNOWN' } });
    expect(resultCode(unknown)).toBe('INVALID_OUTBOX_CAS');
    const accepted = planOutboxCompliance({ ...baseInput(), providerCommand: null });
    expect(resultCode(accepted)).toBe('UNKNOWN_FIELD');
  });

  it('exports a domain-separated operation digest that binds scope, intent, CAS, authority, and evidence', () => {
    const planned = planOutboxCompliance(baseInput());
    expect(planned.ok).toBe(true);
    if (!planned.ok || !planned.value.receiptToPersist) return;
    const receipt = planned.value.receiptToPersist;
    const recomputed = computeOutboxComplianceOperationDigest({
      schemaVersion: 1,
      policyVersion: 1,
      intent: 'SEND_AFTER_APPROVAL',
      tenantRef: receipt.tenantRef,
      sequenceRef: receipt.sequenceRef,
      enrollmentRef: receipt.enrollmentRef,
      executionRef: receipt.executionRef,
      stepRef: receipt.stepRef,
      stepVersion: receipt.stepVersion,
      channel: receipt.channel,
      idempotencyKey: receipt.idempotencyKey,
      decisionNow: receipt.decisionNow,
      preState: receipt.preState,
      preVersion: receipt.preVersion,
      postState: receipt.postState,
      postVersion: receipt.postVersion,
      outboxReceiptRef: receipt.outboxReceiptRef,
      reservationRef: receipt.reservationRef,
      authorityPlanDigest: receipt.authorityPlanDigest,
      draftIdentity: receipt.draftIdentity,
      evidence: receipt.evidence,
    });
    expect(recomputed).toBe(receipt.operationDigest);
  });
});
