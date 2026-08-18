import {
  computeFactCommandOperationDigest,
  classifyFactCommandIdempotency,
  decideFactCommand,
  EXPIRY_POLICY_VERSION,
  type FactCommandOperationIntent,
} from './fact-command-contract';

const SCOPE = { tenantRef: 'tenant_a', leadRef: 'lead_a', factKey: 'identity.company_name' as const };
const OTHER_SCOPE = { ...SCOPE, leadRef: 'lead_b' };
const A = `sha256:fact-value-v1:${'a'.repeat(64)}`;
const B = `sha256:fact-value-v1:${'b'.repeat(64)}`;
const C = `sha256:fact-value-v1:${'c'.repeat(64)}`;
const NOW = '2026-08-04T12:00:00Z';
const DUE = '2026-08-04T12:00:00Z';

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function digest(input: FactCommandOperationIntent): string {
  return computeFactCommandOperationDigest(input);
}

function rejectCommand(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const scope = (overrides.scope as typeof SCOPE | undefined) ?? SCOPE;
  const snapshot = (overrides.snapshot as Record<string, unknown> | undefined) ?? {
    proposalRef: 'proposal_a', scope: SCOPE, status: 'PROPOSED', version: 2,
  };
  const command = { schemaVersion: 1, command: 'REJECT_PROPOSAL', actorKind: 'USER', role: 'OWNER', scope, requestId: 'request_reject_a', rejectReasonCode: 'INSUFFICIENT_EVIDENCE', snapshot, expectedVersion: 2, ...overrides };
  if (typeof overrides.operationDigest === 'string') return command;
  return { ...command, operationDigest: digest({
    schemaVersion: 1, command: 'REJECT_PROPOSAL', targetRefs: [snapshot.proposalRef as string], scope,
    expectedVersions: [{ targetRef: snapshot.proposalRef as string, expectedVersion: command.expectedVersion as number }], reasonCode: command.rejectReasonCode as 'INSUFFICIENT_EVIDENCE', policyVersion: null,
  }) };
}

function expireProposalCommand(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const scope = (overrides.scope as typeof SCOPE | undefined) ?? SCOPE;
  const snapshot = (overrides.snapshot as Record<string, unknown> | undefined) ?? {
    proposalRef: 'proposal_expire_a', scope: SCOPE, status: 'PROPOSED', version: 1, expiresAt: DUE,
  };
  const command = { schemaVersion: 1, command: 'EXPIRE_PROPOSAL', actorKind: 'USER', role: 'OWNER', scope, requestId: 'request_expire_proposal_a', expiryReasonCode: 'POLICY_DUE', decisionNow: NOW, snapshot, expectedVersion: 1, ...overrides };
  if (typeof overrides.operationDigest === 'string') return command;
  return { ...command, operationDigest: digest({
    schemaVersion: 1, command: 'EXPIRE_PROPOSAL', targetRefs: [snapshot.proposalRef as string], scope,
    expectedVersions: [{ targetRef: snapshot.proposalRef as string, expectedVersion: command.expectedVersion as number }], reasonCode: command.expiryReasonCode as 'POLICY_DUE', expiryDueAt: (snapshot.expiryDueAt ?? snapshot.expiresAt) as string, policyVersion: null,
  }) };
}

function expireFactCommand(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const scope = (overrides.scope as typeof SCOPE | undefined) ?? SCOPE;
  const snapshot = (overrides.snapshot as Record<string, unknown> | undefined) ?? {
    factRef: 'fact_expire_a', scope: SCOPE, status: 'CONFIRMED', version: 3, normalizedValueDigest: A, validUntil: DUE,
  };
  const command = { schemaVersion: 1, command: 'EXPIRE_FACT', actorKind: 'SYSTEM', role: 'SYSTEM', scope, requestId: 'request_expire_fact_a', expiryReasonCode: 'VALID_UNTIL_REACHED', decisionNow: NOW, policyVersion: 'expiry-policy-v1', snapshot, expectedVersion: 3, ...overrides };
  if (typeof overrides.operationDigest === 'string') return command;
  return { ...command, operationDigest: digest({
    schemaVersion: 1, command: 'EXPIRE_FACT', targetRefs: [snapshot.factRef as string], scope,
    expectedVersions: [{ targetRef: snapshot.factRef as string, expectedVersion: command.expectedVersion as number }], reasonCode: command.expiryReasonCode as 'VALID_UNTIL_REACHED', expiryDueAt: (snapshot.expiryDueAt ?? snapshot.validUntil) as string, policyVersion: command.policyVersion === 'expiry-policy-v1' ? 'expiry-policy-v1' : null,
  }) };
}

function supersedeCommand(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const scope = (overrides.scope as typeof SCOPE | undefined) ?? SCOPE;
  const snapshot = (overrides.snapshot as Record<string, unknown> | undefined) ?? {
    factRef: 'fact_supersede_a', scope: SCOPE, status: 'CONFIRMED', version: 3, normalizedValueDigest: A,
  };
  const replacement = (overrides.replacement as Record<string, unknown> | undefined) ?? { scope: SCOPE, status: 'CONFIRMED', normalizedValueDigest: B };
  const command = { schemaVersion: 1, command: 'SUPERSEDE_FACT', actorKind: 'USER', role: 'ADMIN', scope, requestId: 'request_supersede_a', supersedeReasonCode: 'NEWER_SOURCE', snapshot, expectedVersion: 3, replacement, ...overrides };
  if (typeof overrides.operationDigest === 'string') return command;
  return { ...command, operationDigest: digest({
    schemaVersion: 1, command: 'SUPERSEDE_FACT', targetRefs: [snapshot.factRef as string], scope,
    expectedVersions: [{ targetRef: snapshot.factRef as string, expectedVersion: command.expectedVersion as number }], reasonCode: command.supersedeReasonCode as 'NEWER_SOURCE', replacementValueDigest: replacement.normalizedValueDigest as string, policyVersion: null,
  }) };
}

function invalidateCommand(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const scope = (overrides.scope as typeof SCOPE | undefined) ?? SCOPE;
  const snapshot = (overrides.snapshot as Record<string, unknown> | undefined) ?? {
    factRef: 'fact_invalidate_a', scope: SCOPE, status: 'CONFLICT', version: 4, normalizedValueDigest: A,
  };
  const command = { schemaVersion: 1, command: 'INVALIDATE_FACT', actorKind: 'USER', role: 'OWNER', scope, requestId: 'request_invalidate_a', invalidateReasonCode: 'SOURCE_RETRACTED', snapshot, expectedVersion: 4, ...overrides };
  if (typeof overrides.operationDigest === 'string') return command;
  return { ...command, operationDigest: digest({
    schemaVersion: 1, command: 'INVALIDATE_FACT', targetRefs: [snapshot.factRef as string], scope,
    expectedVersions: [{ targetRef: snapshot.factRef as string, expectedVersion: command.expectedVersion as number }], reasonCode: command.invalidateReasonCode as 'SOURCE_RETRACTED', policyVersion: null,
  }) };
}

function resolveCommand(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const scope = (overrides.scope as typeof SCOPE | undefined) ?? SCOPE;
  const conflictFacts = (overrides.conflictFacts as Record<string, unknown>[] | undefined) ?? [
    { factRef: 'fact_conflict_b', scope: SCOPE, status: 'CONFLICT', normalizedValueDigest: B, expectedVersion: 2, currentVersion: 2 },
    { factRef: 'fact_conflict_a', scope: SCOPE, status: 'CONFLICT', normalizedValueDigest: A, expectedVersion: 1, currentVersion: 1 },
  ];
  const replacement = (overrides.replacement as Record<string, unknown> | undefined) ?? { scope: SCOPE, status: 'CONFIRMED', normalizedValueDigest: C };
  const command = { schemaVersion: 1, command: 'RESOLVE_FACT_CONFLICT', actorKind: 'USER', role: 'OWNER', scope, requestId: 'request_resolve_a', resolutionReasonCode: 'SELECT_REPLACEMENT', conflictFacts, replacement, ...overrides };
  if (typeof overrides.operationDigest === 'string') return command;
  const sorted = [...conflictFacts].sort((left, right) => asciiCompare(left.factRef as string, right.factRef as string));
  return { ...command, operationDigest: digest({
    schemaVersion: 1, command: 'RESOLVE_FACT_CONFLICT', targetRefs: sorted.map((fact) => fact.factRef as string), scope,
    expectedVersions: sorted.map((fact) => ({ targetRef: fact.factRef as string, expectedVersion: fact.expectedVersion as number })), reasonCode: command.resolutionReasonCode as 'SELECT_REPLACEMENT' | 'INVALIDATE_CONFLICT_SET', replacementValueDigest: replacement.normalizedValueDigest as string, policyVersion: null,
  }) };
}

function expectNew(input: Record<string, unknown>): any {
  const result = decideFactCommand(input);
  if (!result.ok) throw new Error(result.error.code);
  expect(result.ok).toBe(true);
  expect(result.value.decision).toBe('NEW');
  return result.value;
}

function expectError(input: Record<string, unknown>, code: string): void {
  const result = decideFactCommand(input);
  expect(result).toEqual({ ok: false, error: { code, message: expect.any(String) } });
  if (result.ok) throw new Error('expected command rejection');
  expect(result.error.message).not.toMatch(/tenant_a|lead_a|proposal_a|fact_a|secret|password|raw/i);
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value as Record<string, unknown>)) expectDeepFrozen(child);
}

describe('CRM-04A-3B command contract', () => {
  it('creates an atomic plan for every supported command', () => {
    const reject = expectNew(rejectCommand());
    expect(reject.underlyingPlan.proposalUpdate).toEqual({ status: 'REJECTED', expectedVersion: 2, nextVersion: 3 });

    const expiredProposal = expectNew(expireProposalCommand());
    expect(expiredProposal.underlyingPlan.proposalUpdate.status).toBe('EXPIRED');

    const expiredFact = expectNew(expireFactCommand());
    expect(expiredFact.underlyingPlan.factTransitions[0]).toMatchObject({ factRef: 'fact_expire_a', from: 'CONFIRMED', to: 'EXPIRED', expectedVersion: 3, nextVersion: 4 });

    const superseded = expectNew(supersedeCommand());
    expect(superseded.underlyingPlan.supersedesFactRefs).toEqual(['fact_supersede_a']);
    expect(superseded.underlyingPlan.newFact).toMatchObject({ status: 'CONFIRMED', normalizedValueDigest: B });

    const invalidated = expectNew(invalidateCommand());
    expect(invalidated.underlyingPlan.factTransitions[0]).toMatchObject({ from: 'CONFLICT', to: 'INVALIDATED' });

    const resolved = expectNew(resolveCommand());
    expect(resolved.underlyingPlan.supersedesFactRefs).toEqual(['fact_conflict_a', 'fact_conflict_b']);
    expect(resolved.underlyingPlan.factTransitions.map((transition: any) => transition.to)).toEqual(['SUPERSEDED', 'SUPERSEDED']);
  });

  it('enforces actor/role permissions and SYSTEM expiry policy', () => {
    const commands = [rejectCommand(), supersedeCommand(), invalidateCommand(), resolveCommand()];
    for (const command of commands) {
      expectError({ ...command, actorKind: 'USER', role: 'VIEWER' }, 'ROLE_NOT_AUTHORIZED');
      expectError({ ...command, actorKind: 'AI_WORKER', role: 'OWNER' }, 'AI_NOT_AUTHORIZED');
      expectError({ ...command, actorKind: 'USER', role: 'SYSTEM' }, 'ACTOR_ROLE_MISMATCH');
      expectError({ ...command, actorKind: 'SYSTEM', role: 'SYSTEM' }, 'SYSTEM_COMMAND_FORBIDDEN');
    }
    const missingPolicy = { ...expireFactCommand() };
    delete missingPolicy.policyVersion;
    expectError(missingPolicy, 'POLICY_VERSION_REQUIRED');
    expectError({ ...expireFactCommand(), policyVersion: 'expiry-policy-v2' }, 'INVALID_POLICY_VERSION');
    expectError({ ...expireFactCommand(), actorKind: 'SYSTEM', role: 'OWNER' }, 'ACTOR_ROLE_MISMATCH');
    expectError({ ...expireFactCommand(), actorKind: 'USER', role: 'OWNER', policyVersion: 'expiry-policy-v1' }, 'INVALID_POLICY_VERSION');
  });

  it('requires matching service scope, CAS version, legal terminal state, and strict fields', () => {
    expectError(rejectCommand({ scope: OTHER_SCOPE }), 'SCOPE_MISMATCH');
    expectError(rejectCommand({ expectedVersion: 3 }), 'VERSION_MISMATCH');
    expectError(rejectCommand({ snapshot: { proposalRef: 'proposal_a', scope: SCOPE, status: 'ACCEPTED', version: 2 } }), 'STATE_PLAN_REJECTED');
    expectError({ ...rejectCommand(), companyId: 'company_a' }, 'UNKNOWN_FIELD');
    expectError({ ...invalidateCommand(), confirmedBy: 'user_a' }, 'UNKNOWN_FIELD');
    expectError({ ...supersedeCommand(), actorRef: 'actor_a' }, 'UNKNOWN_FIELD');
  });

  it('requires due expiry time and applies the inclusive time boundary', () => {
    expectError(expireProposalCommand({ decisionNow: '2026-08-04T11:59:59Z' }), 'EXPIRY_NOT_DUE');
    expectNew(expireProposalCommand({ decisionNow: DUE }));
    expectError(expireProposalCommand({ snapshot: { proposalRef: 'proposal_expire_a', scope: SCOPE, status: 'PROPOSED', version: 1 } }), 'EXPIRY_TIME_REQUIRED');
    expectError(expireProposalCommand({ decisionNow: '2026-08-04T12:00:00+00:00' }), 'INVALID_TIMESTAMP');
    expectError(expireFactCommand({ snapshot: { factRef: 'fact_expire_a', scope: SCOPE, status: 'CONFIRMED', version: 3, normalizedValueDigest: A, validUntil: DUE, expiryDueAt: '2026-08-05T00:00:00Z' } }), 'EXPIRY_TIME_CONFLICT');
  });

  it('binds the operation digest to structured intent but excludes decisionNow', () => {
    const first = expireFactCommand();
    const later = expireFactCommand({ decisionNow: '2026-08-05T12:00:00Z' });
    expect((first.operationDigest as string)).toBe(later.operationDigest as string);
    expectError({ ...rejectCommand(), operationDigest: `sha256:fact-command-v1:${'0'.repeat(64)}` }, 'OPERATION_DIGEST_MISMATCH');
    expectError({ ...supersedeCommand(), replacement: { scope: SCOPE, status: 'CONFIRMED', normalizedValueDigest: C } }, 'OPERATION_DIGEST_MISMATCH');
    expectError({ ...rejectCommand(), requestId: 'request_reject_a', operationDigest: (supersedeCommand().operationDigest as string) }, 'OPERATION_DIGEST_MISMATCH');
  });

  it('persists a complete receipt and returns replay without another write plan', () => {
    const input = rejectCommand();
    const first = expectNew(input);
    const replay = decideFactCommand({ ...input, persistedReceipt: first.receiptToPersist });
    expect(replay).toEqual({ ok: true, value: { schemaVersion: 1, decision: 'IDEMPOTENT_REPLAY' } });
    expectError({ ...input, persistedReceipt: { ...first.receiptToPersist, targetRefs: ['other_fact'] } }, 'IDEMPOTENCY_CONFLICT');
    expectError({ ...input, persistedReceipt: { ...first.receiptToPersist, command: 'INVALIDATE_FACT' } }, 'IDEMPOTENCY_CONFLICT');
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.receiptToPersist)).toBe(true);
    expect(JSON.stringify(first)).not.toContain('tenant_a');
    expect(JSON.stringify(first)).not.toContain('OWNER');
  });

  it('makes conflict resolution order independent and rejects incomplete groups', () => {
    const forward = expectNew(resolveCommand());
    const reversed = expectNew(resolveCommand({
      requestId: 'request_resolve_b',
      conflictFacts: [
        { factRef: 'fact_conflict_a', scope: SCOPE, status: 'CONFLICT', normalizedValueDigest: A, expectedVersion: 1, currentVersion: 1 },
        { factRef: 'fact_conflict_b', scope: SCOPE, status: 'CONFLICT', normalizedValueDigest: B, expectedVersion: 2, currentVersion: 2 },
      ],
    }));
    expect(reversed.underlyingPlan).toEqual(forward.underlyingPlan);
    expectError(resolveCommand({ conflictFacts: [{ factRef: 'fact_conflict_a', scope: SCOPE, status: 'CONFLICT', normalizedValueDigest: A, expectedVersion: 1 }] }), 'CONFLICT_FACTS_INVALID');
    expectError(resolveCommand({ conflictFacts: [
      { factRef: 'fact_conflict_a', scope: SCOPE, status: 'CONFLICT', normalizedValueDigest: A, expectedVersion: 1 },
      { factRef: 'fact_conflict_a', scope: SCOPE, status: 'CONFLICT', normalizedValueDigest: B, expectedVersion: 2 },
    ] }), 'CONFLICT_FACTS_INVALID');
    expectError(resolveCommand({ conflictFacts: [
      { factRef: 'fact_conflict_a', scope: SCOPE, status: 'CONFLICT', normalizedValueDigest: A, expectedVersion: 1, currentVersion: 1 },
      { factRef: 'fact_conflict_b', scope: OTHER_SCOPE, status: 'CONFLICT', normalizedValueDigest: B, expectedVersion: 2, currentVersion: 2 },
    ] }), 'CONFLICT_FACTS_INVALID');
    expectError(resolveCommand({ conflictFacts: [
      { factRef: 'fact_conflict_a', scope: SCOPE, status: 'CONFIRMED', normalizedValueDigest: A, expectedVersion: 1, currentVersion: 1 },
      { factRef: 'fact_conflict_b', scope: SCOPE, status: 'CONFLICT', normalizedValueDigest: B, expectedVersion: 2, currentVersion: 2 },
    ] }), 'CONFLICT_FACTS_INVALID');
    expectError(resolveCommand({ conflictFacts: [
      { factRef: 'fact_conflict_a', scope: SCOPE, status: 'CONFLICT', normalizedValueDigest: A, expectedVersion: 1, currentVersion: 9 },
      { factRef: 'fact_conflict_b', scope: SCOPE, status: 'CONFLICT', normalizedValueDigest: B, expectedVersion: 2, currentVersion: 2 },
    ] }), 'VERSION_MISMATCH');
  });

  it('replays exact receipts after every command has reached its post-state', () => {
    const cases: Array<{ input: Record<string, unknown>; post: Record<string, unknown> }> = [
      { input: rejectCommand(), post: { snapshot: { proposalRef: 'proposal_a', scope: SCOPE, status: 'REJECTED', version: 3 } } },
      { input: expireProposalCommand(), post: { snapshot: { proposalRef: 'proposal_expire_a', scope: SCOPE, status: 'EXPIRED', version: 2, expiresAt: DUE } } },
      { input: expireFactCommand(), post: { snapshot: { factRef: 'fact_expire_a', scope: SCOPE, status: 'EXPIRED', version: 4, normalizedValueDigest: A, validUntil: DUE } } },
      { input: supersedeCommand(), post: { snapshot: { factRef: 'fact_supersede_a', scope: SCOPE, status: 'SUPERSEDED', version: 4, normalizedValueDigest: A } } },
      { input: invalidateCommand(), post: { snapshot: { factRef: 'fact_invalidate_a', scope: SCOPE, status: 'INVALIDATED', version: 5, normalizedValueDigest: A } } },
    ];
    for (const testCase of cases) {
      const first = expectNew(testCase.input);
      const replay = decideFactCommand({ ...testCase.input, ...testCase.post, persistedReceipt: first.receiptToPersist });
      expect(replay).toEqual({ ok: true, value: { schemaVersion: 1, decision: 'IDEMPOTENT_REPLAY' } });
    }

    const resolve = resolveCommand({ resolutionReasonCode: 'INVALIDATE_CONFLICT_SET' });
    const firstResolve = expectNew(resolve);
    const postConflictFacts = [
      { factRef: 'fact_conflict_b', scope: SCOPE, status: 'INVALIDATED', normalizedValueDigest: B, expectedVersion: 2, currentVersion: 3 },
      { factRef: 'fact_conflict_a', scope: SCOPE, status: 'INVALIDATED', normalizedValueDigest: A, expectedVersion: 1, currentVersion: 2 },
    ];
    const replayResolve = decideFactCommand({ ...resolve, conflictFacts: postConflictFacts, persistedReceipt: firstResolve.receiptToPersist });
    expect(replayResolve).toEqual({ ok: true, value: { schemaVersion: 1, decision: 'IDEMPOTENT_REPLAY' } });
  });

  it('keeps authorization ahead of exact receipt replay and rejects changed intent', () => {
    const input = rejectCommand();
    const first = expectNew(input);
    const post = { ...input, snapshot: { proposalRef: 'proposal_a', scope: SCOPE, status: 'REJECTED', version: 3 }, persistedReceipt: first.receiptToPersist };
    expectError({ ...post, actorKind: 'USER', role: 'VIEWER' }, 'ROLE_NOT_AUTHORIZED');
    expectError({ ...post, actorKind: 'AI_WORKER', role: 'OWNER' }, 'AI_NOT_AUTHORIZED');
    expectError({ ...post, actorKind: 'USER', role: 'SYSTEM' }, 'ACTOR_ROLE_MISMATCH');
    expectError({ ...post, rejectReasonCode: 'DUPLICATE_PROPOSAL' }, 'OPERATION_DIGEST_MISMATCH');
    expectError({ ...post, expectedVersion: 99 }, 'OPERATION_DIGEST_MISMATCH');
    expectError({ ...post, snapshot: { proposalRef: 'proposal_b', scope: SCOPE, status: 'REJECTED', version: 3 } }, 'OPERATION_DIGEST_MISMATCH');
    expectError({ ...post, requestId: 'request_reject_other' }, 'IDEMPOTENCY_CONFLICT');
    expectError({ ...supersedeCommand({ replacement: { scope: SCOPE, status: 'CONFIRMED', normalizedValueDigest: C } }), operationDigest: supersedeCommand().operationDigest, persistedReceipt: (expectNew(supersedeCommand()).receiptToPersist) }, 'OPERATION_DIGEST_MISMATCH');
  });

  it('freezes every public result path and uses frozen policy/deterministic ASCII ordering', () => {
    const newPlan = expectNew(rejectCommand());
    expectDeepFrozen(newPlan);
    const replay = decideFactCommand({ ...rejectCommand(), persistedReceipt: newPlan.receiptToPersist });
    expectDeepFrozen(replay);
    const classified = classifyFactCommandIdempotency({
      schemaVersion: 1, requestId: 'request_classify', command: 'REJECT_PROPOSAL', targetRefs: ['Z', 'a'], operationDigest: rejectCommand().operationDigest,
    });
    expectDeepFrozen(classified);
    const invalid = decideFactCommand({ ...rejectCommand(), companyId: 'company_a' });
    expectDeepFrozen(invalid);
    expect(EXPIRY_POLICY_VERSION).toBe('expiry-policy-v1');
    expect(Object.isFrozen(EXPIRY_POLICY_VERSION)).toBe(true);

    const intentA: FactCommandOperationIntent = {
      schemaVersion: 1, command: 'RESOLVE_FACT_CONFLICT', targetRefs: ['Z', 'a'], scope: SCOPE,
      expectedVersions: [{ targetRef: 'Z', expectedVersion: 1 }, { targetRef: 'a', expectedVersion: 2 }], reasonCode: 'SELECT_REPLACEMENT', replacementValueDigest: C, policyVersion: null,
    };
    const intentB: FactCommandOperationIntent = {
      ...intentA, targetRefs: ['a', 'Z'], expectedVersions: [{ targetRef: 'a', expectedVersion: 2 }, { targetRef: 'Z', expectedVersion: 1 }],
    };
    expect(computeFactCommandOperationDigest(intentA)).toBe(computeFactCommandOperationDigest(intentB));
  });

  it('rejects explicit undefined optional fields instead of treating them as absent', () => {
    expectError({ ...rejectCommand(), persistedReceipt: undefined }, 'UNKNOWN_FIELD');
    expectError({ ...expireFactCommand(), policyVersion: undefined }, 'UNKNOWN_FIELD');
    expectError({ ...expireProposalCommand(), snapshot: { proposalRef: 'proposal_expire_a', scope: SCOPE, status: 'PROPOSED', version: 1, expiresAt: undefined } }, 'UNKNOWN_FIELD');
    expectError({ ...expireFactCommand(), snapshot: { factRef: 'fact_expire_a', scope: SCOPE, status: 'CONFIRMED', version: 3, normalizedValueDigest: A, validUntil: undefined } }, 'UNKNOWN_FIELD');
  });
});
