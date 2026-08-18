import {
  computeDraftApprovalOperationDigest,
  computeDraftArtifactProposalDigest,
  computeManualDraftApprovalDigest,
  planDraftApprovalCommand,
  planDraftArtifactProposal,
  type DraftApprovalCommand,
  type DraftApprovalActorRole,
  type DraftArtifactProposal,
} from './draft-approval-isolation-contract';
import { planStepExecutionTransition } from './sales-sequence-contract';

const ref = (value: string) => `ref:${value}`;
const digest = (domain: string, fill = 'a') => `sha256:${domain}:${fill.repeat(64)}`;
const actorRef = (role: DraftApprovalActorRole) => `draft-actor:${role.toLowerCase()}`;

const transitions: Record<DraftApprovalCommand, { from: 'draft_pending' | 'draft_ready' | 'approval_required'; to: 'draft_ready' | 'approval_required' | 'approved' }> = {
  ACCEPT_PROPOSAL: { from: 'draft_pending', to: 'draft_ready' },
  REQUEST_APPROVAL: { from: 'draft_ready', to: 'approval_required' },
  APPROVE_DRAFT: { from: 'approval_required', to: 'approved' },
};

function resultCode(result: { ok: boolean; error?: { code: string } }): string {
  if (result.ok || !result.error) throw new Error('expected a rejected contract result');
  return result.error.code;
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
  if (!result.ok) throw new Error(`proposal helper failed: ${result.error.code}`);
  return result.value.proposal;
}

function approvalFor(proposalValue: DraftArtifactProposal, role: DraftApprovalActorRole, approvedAt = '2026-08-04T00:01:00.000Z') {
  const intent = {
    schemaVersion: 1 as const,
    policyVersion: 1 as const,
    tenantRef: proposalValue.tenantRef,
    sequenceRef: proposalValue.sequenceRef,
    enrollmentRef: proposalValue.enrollmentRef,
    executionRef: proposalValue.executionRef,
    stepRef: proposalValue.stepRef,
    stepVersion: proposalValue.stepVersion,
    proposalVersion: proposalValue.proposalVersion,
    proposalDigest: proposalValue.proposalDigest,
    renderedArtifactRef: proposalValue.renderedArtifactRef,
    templateSnapshotDigest: proposalValue.templateSnapshotDigest,
    variableSnapshotDigest: proposalValue.variableSnapshotDigest,
    contentDigest: proposalValue.contentDigest,
    actorKind: 'HUMAN' as const,
    actorRole: role,
    actorRef: actorRef(role),
    approvedAt,
  };
  const approvalDigest = computeManualDraftApprovalDigest(intent);
  const safeSuffix = approvalDigest.slice(-32).replace(/[0-9]/g, (digit: string) => String.fromCharCode('g'.charCodeAt(0) + Number(digit)));
  return {
    kind: 'MANUAL_DRAFT_APPROVAL' as const,
    ...intent,
    receiptRef: `approval-receipt:${safeSuffix}`,
    approvalDigest,
  };
}

function commandInput(command: DraftApprovalCommand, overrides: Record<string, unknown> = {}) {
  const p = (overrides.proposal as DraftArtifactProposal | undefined) ?? proposal();
  const mapping = transitions[command];
  const preVersion = (overrides.expectedVersion as number | undefined) ?? 7;
  const role = (overrides.actorRole as DraftApprovalActorRole | undefined) ?? 'OWNER';
  const currentSnapshot = (overrides.readerSnapshot as Record<string, unknown> | undefined) ?? {
    tenantRef: p.tenantRef, sequenceRef: p.sequenceRef, enrollmentRef: p.enrollmentRef, executionRef: p.executionRef,
    stepRef: p.stepRef, stepVersion: p.stepVersion, state: mapping.from, version: preVersion,
  };
  const approvalAt = command === 'APPROVE_DRAFT' ? ((overrides.approvalAt as string | undefined) ?? '2026-08-04T00:01:00.000Z') : undefined;
  const approval = command === 'APPROVE_DRAFT' ? approvalFor(p, role, approvalAt) : undefined;
  const authority = planStepExecutionTransition({
    executionRef: p.executionRef, tenantRef: p.tenantRef, sequenceRef: p.sequenceRef, enrollmentRef: p.enrollmentRef, stepRef: p.stepRef,
    stepVersion: p.stepVersion, from: mapping.from, to: mapping.to, expectedVersion: preVersion, currentVersion: preVersion,
    intent: 'REVIEW_DRAFT', actorKind: 'HUMAN', actorRole: role, actorRef: actorRef(role),
    ...(approval === undefined ? {} : { approvalReceiptRef: approval.receiptRef }),
  });
  if (!authority.ok) throw new Error(`authority helper failed: ${authority.error.code}`);
  const receiptIdentity = {
    kind: 'DRAFT_APPROVAL_COMMAND' as const,
    schemaVersion: 1 as const,
    policyVersion: 1 as const,
    receiptRef: 'draft-approval-receipt:placeholder',
    operationDigest: digest('placeholder', '0'),
    idempotencyKey: (overrides.idempotencyKey as string | undefined) ?? `draft-command:${command.toLowerCase()}-1`,
    command,
    intent: 'REVIEW_DRAFT' as const,
    tenantRef: p.tenantRef, sequenceRef: p.sequenceRef, enrollmentRef: p.enrollmentRef, executionRef: p.executionRef, stepRef: p.stepRef,
    stepVersion: p.stepVersion, proposalVersion: p.proposalVersion, proposalDigest: p.proposalDigest, renderedArtifactRef: p.renderedArtifactRef,
    templateSnapshotDigest: p.templateSnapshotDigest, variableSnapshotDigest: p.variableSnapshotDigest, contentDigest: p.contentDigest,
    actorKind: 'HUMAN' as const, actorRole: role, actorRef: actorRef(role), preState: mapping.from, preVersion,
    postState: mapping.to, postVersion: authority.value.nextVersion, authorityPlanDigest: authority.value.operationDigest,
    ...(approval === undefined ? {} : { approvalReceipt: approval }),
  };
  const operationDigest = computeDraftApprovalOperationDigest({
    schemaVersion: 1, policyVersion: 1, command, intent: 'REVIEW_DRAFT', idempotencyKey: receiptIdentity.idempotencyKey,
    tenantRef: p.tenantRef, sequenceRef: p.sequenceRef, enrollmentRef: p.enrollmentRef, executionRef: p.executionRef, stepRef: p.stepRef,
    stepVersion: p.stepVersion, proposalVersion: p.proposalVersion, proposalDigest: p.proposalDigest, renderedArtifactRef: p.renderedArtifactRef,
    templateSnapshotDigest: p.templateSnapshotDigest, variableSnapshotDigest: p.variableSnapshotDigest, contentDigest: p.contentDigest,
    actorKind: 'HUMAN', actorRole: role, actorRef: actorRef(role), preState: mapping.from, preVersion,
    postState: mapping.to, postVersion: authority.value.nextVersion, authorityPlanDigest: authority.value.operationDigest,
    ...(approval === undefined ? {} : { approvalDigest: approval.approvalDigest }),
  });
  return {
    schemaVersion: 1, policyVersion: 1, command, tenantRef: p.tenantRef, sequenceRef: p.sequenceRef, enrollmentRef: p.enrollmentRef,
    executionRef: p.executionRef, stepRef: p.stepRef, stepVersion: p.stepVersion, expectedVersion: preVersion,
    idempotencyKey: receiptIdentity.idempotencyKey, intent: 'REVIEW_DRAFT', actorKind: 'HUMAN', actorRole: role, actorRef: actorRef(role),
    proposal: p, readerSnapshot: currentSnapshot, operationDigest,
    ...(command === 'APPROVE_DRAFT' ? { approvalAt } : {}),
    ...overrides,
  };
}

describe('CRM-03C-1 draft artifact proposal and manual approval isolation contract', () => {
  it.each([
    ['EMAIL', 'SYSTEM_RENDERER'], ['WHATSAPP', 'AI_WORKER'],
  ] as const)('normalizes %s %s metadata as proposal-only', (channel, rendererKind) => {
    const result = planDraftArtifactProposal(proposalInput({ channel, rendererKind }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decision).toBe('PROPOSAL_ONLY');
    expect(result.value.executionMode).toBe('DRAFT_ONLY');
    expect(result.value.approvalPolicy).toBe('MANUAL_PER_STEP');
    expect(result.value.sendCommand).toBeNull();
    expect(Object.keys(result.value.proposal)).not.toContain('body');
    expect(Object.keys(result.value.proposal)).not.toContain('recipient');
  });

  it('rejects human renderer authority and never treats renderer output as a transition', () => {
    const renderer = planDraftArtifactProposal(proposalInput({ rendererKind: 'HUMAN' }));
    const approvalBase = commandInput('APPROVE_DRAFT');
    const aiApproval = planDraftApprovalCommand({ ...approvalBase, actorKind: 'AI' });
    const workerApproval = planDraftApprovalCommand({ ...approvalBase, actorKind: 'AI_WORKER' });
    const viewerApproval = planDraftApprovalCommand({ ...approvalBase, actorRole: 'VIEWER' });
    expect(resultCode(renderer)).toBe('INVALID_RENDERER');
    expect(resultCode(aiApproval)).toBe('ACTOR_NOT_AUTHORIZED');
    expect(resultCode(workerApproval)).toBe('ACTOR_NOT_AUTHORIZED');
    expect(resultCode(viewerApproval)).toBe('ACTOR_NOT_AUTHORIZED');
  });

  it.each(['OWNER', 'ADMIN', 'SALES'] as const)('permits human %s to accept a proposal through 03A', (role) => {
    const result = planDraftApprovalCommand(commandInput('ACCEPT_PROPOSAL', { actorRole: role }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.transitionPlan?.from).toBe('draft_pending');
    expect(result.value.transitionPlan?.to).toBe('draft_ready');
    expect(result.value.transitionPlan?.intent).toBe('REVIEW_DRAFT');
    expect(result.value.transitionPlan?.decision).toBe('PLAN_ONLY');
    expect(result.value.transitionPlan?.sendCommand).toBeNull();
  });

  it('walks accept -> approval-required -> approved without exposing send transitions', () => {
    const accept = planDraftApprovalCommand(commandInput('ACCEPT_PROPOSAL'));
    expect(accept.ok).toBe(true);
    if (!accept.ok || !accept.value.receiptToPersist) return;
    const request = planDraftApprovalCommand(commandInput('REQUEST_APPROVAL', {
      expectedVersion: 8,
      readerSnapshot: { tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'), executionRef: ref('execution-1'), stepRef: ref('step-1'), stepVersion: 3, state: 'draft_ready', version: 8 },
    }));
    expect(request.ok).toBe(true);
    if (!request.ok || !request.value.receiptToPersist) return;
    const approve = planDraftApprovalCommand(commandInput('APPROVE_DRAFT', {
      expectedVersion: 9,
      readerSnapshot: { tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'), executionRef: ref('execution-1'), stepRef: ref('step-1'), stepVersion: 3, state: 'approval_required', version: 9 },
    }));
    expect(approve.ok).toBe(true);
    if (approve.ok) {
      expect(approve.value.transitionPlan?.from).toBe('approval_required');
      expect(approve.value.transitionPlan?.to).toBe('approved');
      expect(approve.value.approvalReceiptToPersist?.kind).toBe('MANUAL_DRAFT_APPROVAL');
      expect(approve.value.sendCommand).toBeNull();
      expect(JSON.stringify(approve.value)).not.toMatch(/sending|sent|provider|outbox/i);
    }
  });

  it('rejects skip, wrong intent, CAS drift, and stale proposal state', () => {
    const skip = planDraftApprovalCommand(commandInput('REQUEST_APPROVAL', { readerSnapshot: { tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'), executionRef: ref('execution-1'), stepRef: ref('step-1'), stepVersion: 3, state: 'draft_pending', version: 8 } }));
    const wrongIntent = planDraftApprovalCommand({ ...commandInput('ACCEPT_PROPOSAL'), intent: 'CREATE_DRAFT' });
    const wrongFrom = planDraftApprovalCommand(commandInput('ACCEPT_PROPOSAL', { readerSnapshot: { tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'), executionRef: ref('execution-1'), stepRef: ref('step-1'), stepVersion: 3, state: 'approval_required', version: 7 } }));
    const cas = planDraftApprovalCommand(commandInput('ACCEPT_PROPOSAL', { expectedVersion: 8, readerSnapshot: { tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'), executionRef: ref('execution-1'), stepRef: ref('step-1'), stepVersion: 3, state: 'draft_pending', version: 7 } }));
    const stale = planDraftApprovalCommand({ ...commandInput('ACCEPT_PROPOSAL'), proposal: proposal({ contentDigest: digest('content-new') }) });
    expect(resultCode(skip)).toBe('PROPOSAL_STALE');
    expect(resultCode(wrongIntent)).toBe('INVALID_INTENT');
    expect(resultCode(wrongFrom)).toBe('PROPOSAL_STALE');
    expect(resultCode(cas)).toBe('CAS_CONFLICT');
    expect(resultCode(stale)).toBe('OPERATION_DIGEST_MISMATCH');
  });

  it('binds approval to exact proposal identity and invalidates content/template/variable/step changes', () => {
    const first = planDraftApprovalCommand(commandInput('APPROVE_DRAFT'));
    expect(first.ok).toBe(true);
    if (!first.ok || !first.value.receiptToPersist) return;
    const base = commandInput('APPROVE_DRAFT', { readerSnapshot: { ...commandInput('APPROVE_DRAFT').readerSnapshot, state: 'approved', version: 8 } });
    for (const changed of [
      proposal({ contentDigest: digest('changed-content') }),
      proposal({ templateSnapshotDigest: digest('changed-template') }),
      proposal({ variableSnapshotDigest: digest('changed-vars') }),
      proposal({ stepVersion: 4 }),
      proposal({ proposalVersion: 2 }),
    ]) {
      const result = planDraftApprovalCommand({ ...base, proposal: changed, persistedReceipt: first.value.receiptToPersist });
      expect(resultCode(result)).toMatch(/INVALID_RECEIPT|PROPOSAL_IDENTITY_MISMATCH|SCOPE_MISMATCH|OPERATION_DIGEST_MISMATCH/);
    }
  });

  it('replays only from the persisted post-state and rejects pre-state, terminal, and version drift', () => {
    const first = planDraftApprovalCommand(commandInput('REQUEST_APPROVAL', { expectedVersion: 8, readerSnapshot: { ...commandInput('REQUEST_APPROVAL').readerSnapshot, state: 'draft_ready', version: 8 } }));
    expect(first.ok).toBe(true);
    if (!first.ok || !first.value.receiptToPersist) return;
    const base = commandInput('REQUEST_APPROVAL', { expectedVersion: 8 });
    const replay = planDraftApprovalCommand({ ...base, readerSnapshot: { ...base.readerSnapshot, state: 'approval_required', version: 9 }, persistedReceipt: first.value.receiptToPersist });
    const pre = planDraftApprovalCommand({ ...base, persistedReceipt: first.value.receiptToPersist });
    const wrongVersion = planDraftApprovalCommand({ ...base, readerSnapshot: { ...base.readerSnapshot, state: 'approval_required', version: 10 }, persistedReceipt: first.value.receiptToPersist });
    const terminal = planDraftApprovalCommand({ ...base, readerSnapshot: { ...base.readerSnapshot, state: 'blocked', version: 9 }, persistedReceipt: first.value.receiptToPersist });
    const changedExpectedVersion = planDraftApprovalCommand({ ...base, expectedVersion: 9, readerSnapshot: { ...base.readerSnapshot, state: 'approval_required', version: 9 }, persistedReceipt: first.value.receiptToPersist });
    expect(replay.ok && replay.value.decision).toBe('REPLAY');
    expect(pre.ok ? 'unexpected' : pre.error.code).toBe('REPLAY_STATE_MISMATCH');
    expect(resultCode(wrongVersion)).toBe('REPLAY_STATE_MISMATCH');
    expect(resultCode(terminal)).toBe('REPLAY_STATE_MISMATCH');
    expect(resultCode(changedExpectedVersion)).toBe('CAS_CONFLICT');
  });

  it('rejects an explicitly changed approvalAt while allowing replay to omit it', () => {
    const first = planDraftApprovalCommand(commandInput('APPROVE_DRAFT'));
    expect(first.ok).toBe(true);
    if (!first.ok || !first.value.receiptToPersist) return;
    const base = commandInput('APPROVE_DRAFT', { readerSnapshot: { tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'), executionRef: ref('execution-1'), stepRef: ref('step-1'), stepVersion: 3, state: 'approved', version: 8 } });
    const omitted = { ...base };
    delete (omitted as Record<string, unknown>).approvalAt;
    const changed = planDraftApprovalCommand({ ...base, approvalAt: '2026-08-04T00:02:00Z', persistedReceipt: first.value.receiptToPersist });
    const replayWithoutApprovalAt = planDraftApprovalCommand({ ...omitted, persistedReceipt: first.value.receiptToPersist });
    expect(resultCode(changed)).toBe('INVALID_APPROVAL');
    expect(replayWithoutApprovalAt.ok && replayWithoutApprovalAt.value.decision).toBe('REPLAY');
  });

  it('rejects cross-scope and tampered command receipts before replay', () => {
    const first = planDraftApprovalCommand(commandInput('ACCEPT_PROPOSAL'));
    expect(first.ok).toBe(true);
    if (!first.ok || !first.value.receiptToPersist) return;
    const base = commandInput('ACCEPT_PROPOSAL', { readerSnapshot: { ...commandInput('ACCEPT_PROPOSAL').readerSnapshot, state: 'draft_ready', version: 8 } });
    const crossTenant = planDraftApprovalCommand({ ...base, tenantRef: ref('tenant-2'), persistedReceipt: first.value.receiptToPersist });
    const mutations = [
      { operationDigest: digest('tampered') },
      { receiptRef: 'draft-approval-receipt:' + 'b'.repeat(32) },
      { authorityPlanDigest: digest('authority-tampered') },
      { preVersion: 2 },
      { postVersion: 9 },
      { actorRef: actorRef('ADMIN') },
    ];
    expect(resultCode(crossTenant)).toBe('SCOPE_MISMATCH');
    for (const mutation of mutations) {
      const result = planDraftApprovalCommand({ ...base, persistedReceipt: { ...first.value.receiptToPersist, ...mutation } });
      expect(resultCode(result)).toBe('INVALID_RECEIPT');
    }
  });

  it('rejects tampered manual approval receipt identity on post-state replay', () => {
    const first = planDraftApprovalCommand(commandInput('APPROVE_DRAFT'));
    expect(first.ok).toBe(true);
    if (!first.ok || !first.value.receiptToPersist) return;
    const base = commandInput('APPROVE_DRAFT', { readerSnapshot: { tenantRef: ref('tenant-1'), sequenceRef: ref('sequence-1'), enrollmentRef: ref('enrollment-1'), executionRef: ref('execution-1'), stepRef: ref('step-1'), stepVersion: 3, state: 'approved', version: 8 } });
    const approval = first.value.receiptToPersist.approvalReceipt;
    if (!approval) return;
    const tamperedApproval = planDraftApprovalCommand({
      ...base,
      persistedReceipt: {
        ...first.value.receiptToPersist,
        approvalReceipt: { ...approval, contentDigest: digest('approval-content-tampered') },
      },
    });
    const tamperedDigest = planDraftApprovalCommand({
      ...base,
      persistedReceipt: {
        ...first.value.receiptToPersist,
        approvalReceipt: { ...approval, approvalDigest: digest('approval-tampered') },
      },
    });
    expect(resultCode(tamperedApproval)).toBe('INVALID_RECEIPT');
    expect(resultCode(tamperedDigest)).toBe('INVALID_RECEIPT');
  });

  it('rejects unknown, undefined, PII, raw content, URL, provider, outbox, and send fields', () => {
    const unknown = planDraftArtifactProposal({ ...proposalInput(), body: 'raw body' });
    const undefinedField = planDraftArtifactProposal({ ...proposalInput(), contentDigest: undefined });
    const pii = planDraftArtifactProposal({ ...proposalInput(), rendererRef: 'draft-renderer:person@example.com' });
    const url = planDraftArtifactProposal({ ...proposalInput(), renderedArtifactRef: 'https://provider.invalid/artifact' });
    const provider = planDraftApprovalCommand({ ...commandInput('ACCEPT_PROPOSAL'), providerReceiptRef: 'provider-receipt:x' });
    const outbox = planDraftApprovalCommand({ ...commandInput('ACCEPT_PROPOSAL'), outboxReceiptRef: 'outbox-receipt:x' });
    const send = planDraftApprovalCommand({ ...commandInput('ACCEPT_PROPOSAL'), sendCommand: null });
    expect(resultCode(unknown)).toBe('UNKNOWN_FIELD');
    expect(resultCode(undefinedField)).toBe('EXPLICIT_UNDEFINED');
    expect(resultCode(pii)).toBe('INVALID_REF');
    expect(resultCode(url)).toBe('PII_OR_SECRET_INPUT');
    expect(resultCode(provider)).toBe('UNKNOWN_FIELD');
    expect(resultCode(outbox)).toBe('UNKNOWN_FIELD');
    expect(resultCode(send)).toBe('UNKNOWN_FIELD');
  });

  it('rejects invalid calendar timestamps and non-authoritative client approval receipts', () => {
    const invalidDate = planDraftArtifactProposal({ ...proposalInput(), createdAt: '2026-02-31T00:00:00Z' });
    const clientApproval = planDraftApprovalCommand({ ...commandInput('APPROVE_DRAFT'), approvalReceipt: approvalFor(proposal(), 'OWNER') });
    const wrongRendererActor = planDraftApprovalCommand({ ...commandInput('APPROVE_DRAFT'), actorKind: 'SYSTEM_RENDERER' });
    expect(resultCode(invalidDate)).toBe('INVALID_TIMESTAMP');
    expect(resultCode(clientApproval)).toBe('UNKNOWN_FIELD');
    expect(resultCode(wrongRendererActor)).toBe('ACTOR_NOT_AUTHORIZED');
  });

  it('is deterministic and recursively freezes proposal, command, receipt, and failure wrappers', () => {
    const input = commandInput('APPROVE_DRAFT');
    const reordered = {
      operationDigest: input.operationDigest, readerSnapshot: input.readerSnapshot, proposal: input.proposal, actorRef: input.actorRef,
      actorRole: input.actorRole, actorKind: input.actorKind, intent: input.intent, idempotencyKey: input.idempotencyKey, expectedVersion: input.expectedVersion,
      stepVersion: input.stepVersion, stepRef: input.stepRef, executionRef: input.executionRef, enrollmentRef: input.enrollmentRef, sequenceRef: input.sequenceRef,
      tenantRef: input.tenantRef, command: input.command, policyVersion: input.policyVersion, schemaVersion: input.schemaVersion, approvalAt: input.approvalAt,
    };
    const first = planDraftApprovalCommand(input);
    const second = planDraftApprovalCommand(reordered);
    expect(first.ok && second.ok && first.value.operationDigest).toBe(second.ok ? second.value.operationDigest : undefined);
    expect(Object.isFrozen(first)).toBe(true);
    if (first.ok) {
      expect(Object.isFrozen(first.value)).toBe(true);
      expect(Object.isFrozen(first.value.proposal)).toBe(true);
      expect(Object.isFrozen(first.value.transitionPlan)).toBe(true);
      expect(Object.isFrozen(first.value.approvalReceiptToPersist)).toBe(true);
      expect(Object.isFrozen(first.value.receiptToPersist)).toBe(true);
      expect(Object.isFrozen(first.value.receiptToPersist?.approvalReceipt)).toBe(true);
    }
    const failure = planDraftApprovalCommand({ ...input, intent: 'CREATE_DRAFT' });
    expect(Object.isFrozen(failure)).toBe(true);
    if (!failure.ok) expect(Object.isFrozen(failure.error)).toBe(true);
  });
});
