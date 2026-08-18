import {
  CUSTOMER_FACT_STATUSES,
  FACT_LIFECYCLE_ACTIONS,
  PROPOSAL_ACTIONS,
  PROPOSAL_STATUSES,
  classifyIdempotency,
  computeAcceptOperationDigest,
  decideAcceptProposal,
  planFactLifecycleAction,
  planProposalTransition,
} from './fact-state-machine';
import type { Scope } from './fact-state-machine';

const DIGEST_A = `sha256:fact-value-v1:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:fact-value-v1:${'b'.repeat(64)}`;
const DIGEST_C = `sha256:fact-value-v1:${'c'.repeat(64)}`;
const SCOPE = { tenantRef: 'tenant_a', leadRef: 'lead_a', factKey: 'identity.company_name' as const };
const OTHER_LEAD_SCOPE = { ...SCOPE, leadRef: 'lead_b' };
const OTHER_TENANT_SCOPE = { ...SCOPE, tenantRef: 'tenant_b' };
const OTHER_FACT_KEY_SCOPE = { ...SCOPE, factKey: 'identity.city' as const };
const DECISION_NOW = '2026-08-04T12:00:00Z';

const BASE_PROPOSAL = {
  proposalRef: 'proposal_a',
  scope: SCOPE,
  status: 'PROPOSED' as const,
  version: 4,
  candidateValueDigest: DIGEST_A,
  expiresAt: '2026-08-05T00:00:00Z',
};

const BASE_EVIDENCE = [
  { evidenceId: 'evidence_b', relation: 'SUPPORTS' as const },
  { evidenceId: 'evidence_a', relation: 'SUPPORTS' as const },
];
const CONTRADICTING_EVIDENCE = [
  ...BASE_EVIDENCE,
  { evidenceId: 'evidence_c', relation: 'CONTRADICTS' as const },
];

const BASE_INPUT_FIELDS = {
  schemaVersion: 1 as const,
  operation: 'ACCEPT_PROPOSAL' as const,
  actorKind: 'USER' as const,
  role: 'OWNER' as const,
  scope: SCOPE,
  proposal: BASE_PROPOSAL,
  expectedVersion: 4,
  requestId: 'request_a',
  proposalEvidence: BASE_EVIDENCE,
  currentFacts: [],
  decisionNow: DECISION_NOW,
};

function buildAcceptInput(overrides: Record<string, unknown> = {}) {
  const proposal = { ...BASE_PROPOSAL, ...((overrides.proposal ?? {}) as Partial<typeof BASE_PROPOSAL>) };
  const scope = (overrides.scope as Scope | undefined) ?? SCOPE;
  const expectedVersion = (overrides.expectedVersion as number | undefined) ?? BASE_INPUT_FIELDS.expectedVersion;
  const proposalEvidence = (overrides.proposalEvidence as typeof BASE_EVIDENCE | undefined) ?? BASE_EVIDENCE;
  const input = {
    ...BASE_INPUT_FIELDS,
    ...overrides,
    scope,
    proposal,
    expectedVersion,
    proposalEvidence,
  };
  const operationDigest = typeof overrides.operationDigest === 'string'
    ? overrides.operationDigest
    : computeAcceptOperationDigest({
      schemaVersion: 1,
      operation: 'ACCEPT_PROPOSAL',
      proposalRef: proposal.proposalRef,
      scope,
      expectedVersion,
      candidateValueDigest: proposal.candidateValueDigest,
      proposalEvidence,
    });
  return {
    ...input,
    operationDigest,
  };
}

const BASE_ACCEPT_INPUT = buildAcceptInput();
const OPERATION_DIGEST_A = BASE_ACCEPT_INPUT.operationDigest;
const OPERATION_DIGEST_B = computeAcceptOperationDigest({
  schemaVersion: 1,
  operation: 'ACCEPT_PROPOSAL',
  proposalRef: BASE_PROPOSAL.proposalRef,
  scope: SCOPE,
  expectedVersion: BASE_PROPOSAL.version,
  candidateValueDigest: DIGEST_B,
  proposalEvidence: BASE_EVIDENCE,
});

function currentFact(overrides: Partial<{
  factRef: string;
  scope: Scope;
  status: 'CONFIRMED' | 'CONFLICT' | 'EXPIRED' | 'SUPERSEDED' | 'INVALIDATED';
  normalizedValueDigest: string;
  version: number;
}> = {}) {
  return {
    factRef: 'fact_a',
    scope: SCOPE,
    status: 'CONFIRMED' as const,
    normalizedValueDigest: DIGEST_A,
    version: 7,
    ...overrides,
  };
}

function lifecycleInput(overrides: Record<string, unknown> = {}) {
  if (overrides.action === 'RESOLVE_CONFLICT') {
    return { schemaVersion: 1, ...overrides };
  }
  return {
    schemaVersion: 1,
    action: 'EXPIRE' as const,
    currentFact: currentFact(),
    ...overrides,
  };
}

function expectError(result: { ok: boolean; error?: { code: string; message: string } }, code: string): void {
  expect(result).toEqual({ ok: false, error: { code, message: expect.any(String) } });
}

describe('strictly separated state vocabularies', () => {
  it('freezes the two independently typed status sets', () => {
    expect(Object.isFrozen(PROPOSAL_STATUSES)).toBe(true);
    expect(Object.isFrozen(CUSTOMER_FACT_STATUSES)).toBe(true);
    expect(Object.isFrozen(PROPOSAL_ACTIONS)).toBe(true);
    expect(Object.isFrozen(FACT_LIFECYCLE_ACTIONS)).toBe(true);
    expect(PROPOSAL_STATUSES).toEqual(['PROPOSED', 'ACCEPTED', 'REJECTED', 'EXPIRED']);
    expect(CUSTOMER_FACT_STATUSES).toEqual(['CONFIRMED', 'CONFLICT', 'EXPIRED', 'SUPERSEDED', 'INVALIDATED']);
    expect(PROPOSAL_STATUSES).not.toContain('CONFIRMED' as never);
    expect(CUSTOMER_FACT_STATUSES).not.toContain('PROPOSED' as never);
    expect(CUSTOMER_FACT_STATUSES).not.toContain('REJECTED' as never);
  });

  it.each(PROPOSAL_STATUSES)('rejects %s as an unknown proposal transition target', (status) => {
    expectError(planProposalTransition({ schemaVersion: 1, currentStatus: status, action: 'REOPEN' }), 'INVALID_ACTION');
  });
});

describe('proposal state machine', () => {
  it('allows only PROPOSED to ACCEPTED, REJECTED, or EXPIRED', () => {
    expect(planProposalTransition({ schemaVersion: 1, currentStatus: 'PROPOSED', action: 'ACCEPT' })).toEqual({
      ok: true, value: { object: 'PROPOSAL', from: 'PROPOSED', to: 'ACCEPTED' },
    });
    expect(planProposalTransition({ schemaVersion: 1, currentStatus: 'PROPOSED', action: 'REJECT' })).toEqual({
      ok: true, value: { object: 'PROPOSAL', from: 'PROPOSED', to: 'REJECTED' },
    });
    expect(planProposalTransition({ schemaVersion: 1, currentStatus: 'PROPOSED', action: 'EXPIRE' })).toEqual({
      ok: true, value: { object: 'PROPOSAL', from: 'PROPOSED', to: 'EXPIRED' },
    });
  });

  it.each(PROPOSAL_STATUSES.filter((status) => status !== 'PROPOSED'))('rejects every action from terminal proposal %s', (status) => {
    for (const action of PROPOSAL_ACTIONS) {
      expectError(planProposalTransition({ schemaVersion: 1, currentStatus: status, action }), 'ILLEGAL_PROPOSAL_TRANSITION');
    }
  });

  it('rejects unknown fields and does not provide a reopen action', () => {
    expectError(planProposalTransition({ schemaVersion: 1, currentStatus: 'PROPOSED', action: 'ACCEPT', proposalId: 'proposal_a' }), 'UNKNOWN_FIELD');
  });
});

describe('fact lifecycle state machine', () => {
  it('expires both CONFIRMED and CONFLICT, as explicitly allowed by the design contract', () => {
    expect(planFactLifecycleAction(lifecycleInput({ action: 'EXPIRE', currentFact: currentFact({ status: 'CONFIRMED' }) }))).toMatchObject({
      ok: true, value: { factTransitions: [{ from: 'CONFIRMED', to: 'EXPIRED', expectedVersion: 7, nextVersion: 8 }] },
    });
    expect(planFactLifecycleAction(lifecycleInput({ action: 'EXPIRE', currentFact: currentFact({ status: 'CONFLICT' }) }))).toMatchObject({
      ok: true, value: { factTransitions: [{ from: 'CONFLICT', to: 'EXPIRED' }] },
    });
  });

  it('supports explicit invalidate and supersede plans only from their legal states', () => {
    expect(planFactLifecycleAction(lifecycleInput({ action: 'INVALIDATE', currentFact: currentFact({ status: 'CONFIRMED' }) }))).toMatchObject({
      ok: true, value: { factTransitions: [{ from: 'CONFIRMED', to: 'INVALIDATED' }] },
    });
    expect(planFactLifecycleAction(lifecycleInput({
      action: 'SUPERSEDE',
      currentFact: currentFact({ status: 'CONFIRMED' }),
      replacement: { scope: SCOPE, status: 'CONFIRMED', normalizedValueDigest: DIGEST_B },
    }))).toMatchObject({
      ok: true,
      value: {
        factTransitions: [{ from: 'CONFIRMED', to: 'SUPERSEDED' }],
        supersedesFactRefs: ['fact_a'],
        newFact: { status: 'CONFIRMED', normalizedValueDigest: DIGEST_B, effectiveProjection: 'EFFECTIVE' },
      },
    });
    expectError(planFactLifecycleAction(lifecycleInput({
      action: 'SUPERSEDE',
      currentFact: currentFact({ status: 'CONFLICT' }),
      replacement: { scope: SCOPE, status: 'CONFIRMED', normalizedValueDigest: DIGEST_B },
    })), 'ILLEGAL_FACT_TRANSITION');
  });

  it('resolves CONFLICT by moving the old fact out and creating an independent confirmed fact', () => {
    for (const resolution of ['SUPERSEDE', 'INVALIDATE'] as const) {
      const result = planFactLifecycleAction(lifecycleInput({
        action: 'RESOLVE_CONFLICT',
        conflictFacts: [
          currentFact({ factRef: 'fact_b', status: 'CONFLICT', normalizedValueDigest: DIGEST_A }),
          currentFact({ factRef: 'fact_a', status: 'CONFLICT', normalizedValueDigest: DIGEST_B }),
        ],
        resolution,
        replacement: { scope: SCOPE, status: 'CONFIRMED', normalizedValueDigest: DIGEST_B },
      }));
      expect(result).toMatchObject({
        ok: true,
        value: {
          factTransitions: [
            { factRef: 'fact_a', from: 'CONFLICT', to: resolution === 'SUPERSEDE' ? 'SUPERSEDED' : 'INVALIDATED' },
            { factRef: 'fact_b', from: 'CONFLICT', to: resolution === 'SUPERSEDE' ? 'SUPERSEDED' : 'INVALIDATED' },
          ],
          supersedesFactRefs: ['fact_a', 'fact_b'],
          newFact: { status: 'CONFIRMED', effectiveProjection: 'EFFECTIVE' },
        },
      });
    }
  });

  it('requires a complete conflict group and produces a stable all-or-nothing supersedes chain', () => {
    const conflictA = currentFact({ factRef: 'fact_a', status: 'CONFLICT', normalizedValueDigest: DIGEST_A });
    const conflictB = currentFact({ factRef: 'fact_b', status: 'CONFLICT', normalizedValueDigest: DIGEST_B, version: 9 });
    const forward = planFactLifecycleAction(lifecycleInput({
      action: 'RESOLVE_CONFLICT',
      conflictFacts: [conflictB, conflictA],
      resolution: 'SUPERSEDE',
      replacement: { scope: SCOPE, status: 'CONFIRMED', normalizedValueDigest: DIGEST_C },
    }));
    const reverse = planFactLifecycleAction(lifecycleInput({
      action: 'RESOLVE_CONFLICT',
      conflictFacts: [conflictA, conflictB],
      resolution: 'SUPERSEDE',
      replacement: { scope: SCOPE, status: 'CONFIRMED', normalizedValueDigest: DIGEST_C },
    }));
    expect(forward).toEqual(reverse);
    expect(forward).toMatchObject({
      ok: true,
      value: {
        atomic: 'ALL_OR_NOTHING',
        supersedesFactRefs: ['fact_a', 'fact_b'],
        factTransitions: [
          { factRef: 'fact_a', from: 'CONFLICT', to: 'SUPERSEDED', expectedVersion: 7, nextVersion: 8 },
          { factRef: 'fact_b', from: 'CONFLICT', to: 'SUPERSEDED', expectedVersion: 9, nextVersion: 10 },
        ],
        newFact: { status: 'CONFIRMED', effectiveProjection: 'EFFECTIVE' },
      },
    });
    expectError(planFactLifecycleAction(lifecycleInput({
      action: 'RESOLVE_CONFLICT',
      conflictFacts: [conflictA],
      resolution: 'SUPERSEDE',
      replacement: { scope: SCOPE, status: 'CONFIRMED', normalizedValueDigest: DIGEST_C },
    })), 'CONFLICT_FACTS_INVALID');
    expectError(planFactLifecycleAction(lifecycleInput({
      action: 'RESOLVE_CONFLICT',
      conflictFacts: [conflictA, currentFact({ factRef: 'fact_b', status: 'CONFIRMED', normalizedValueDigest: DIGEST_B })],
      resolution: 'SUPERSEDE',
      replacement: { scope: SCOPE, status: 'CONFIRMED', normalizedValueDigest: DIGEST_C },
    })), 'CONFLICT_FACTS_INVALID');
    expectError(planFactLifecycleAction(lifecycleInput({
      action: 'RESOLVE_CONFLICT',
      conflictFacts: [conflictA, currentFact({ factRef: 'fact_a', status: 'CONFLICT', normalizedValueDigest: DIGEST_B })],
      resolution: 'SUPERSEDE',
      replacement: { scope: SCOPE, status: 'CONFIRMED', normalizedValueDigest: DIGEST_C },
    })), 'CONFLICT_FACTS_INVALID');
    expectError(planFactLifecycleAction(lifecycleInput({
      action: 'RESOLVE_CONFLICT',
      conflictFacts: [conflictA, currentFact({ factRef: 'fact_b', status: 'CONFLICT', scope: OTHER_TENANT_SCOPE })],
      resolution: 'SUPERSEDE',
      replacement: { scope: SCOPE, status: 'CONFIRMED', normalizedValueDigest: DIGEST_C },
    })), 'SCOPE_MISMATCH');
    expectError(planFactLifecycleAction(lifecycleInput({
      action: 'RESOLVE_CONFLICT',
      conflictFacts: [conflictA, currentFact({ factRef: 'fact_b', status: 'EXPIRED', normalizedValueDigest: DIGEST_B })],
      resolution: 'SUPERSEDE',
      replacement: { scope: SCOPE, status: 'CONFIRMED', normalizedValueDigest: DIGEST_C },
    })), 'CONFLICT_FACTS_INVALID');
  });

  it.each(['EXPIRED', 'SUPERSEDED', 'INVALIDATED'] as const)('rejects every lifecycle action from terminal fact %s', (status) => {
    for (const action of FACT_LIFECYCLE_ACTIONS) {
      const input: Record<string, unknown> = lifecycleInput({ action, currentFact: currentFact({ status }) });
      if (action === 'SUPERSEDE' || action === 'RESOLVE_CONFLICT') {
        input.replacement = { scope: SCOPE, status: 'CONFIRMED', normalizedValueDigest: DIGEST_B };
        if (action === 'RESOLVE_CONFLICT') input.resolution = 'SUPERSEDE';
      }
      expect(planFactLifecycleAction(input).ok).toBe(false);
    }
  });

  it('fails closed for cross-scope, unchanged-value, missing-replacement, and injected self-chain fields', () => {
    expectError(planFactLifecycleAction(lifecycleInput({
      action: 'SUPERSEDE',
      replacement: { scope: OTHER_TENANT_SCOPE, status: 'CONFIRMED', normalizedValueDigest: DIGEST_B },
    })), 'SCOPE_MISMATCH');
    expectError(planFactLifecycleAction(lifecycleInput({
      action: 'SUPERSEDE',
      replacement: { scope: SCOPE, status: 'CONFIRMED', normalizedValueDigest: DIGEST_A },
    })), 'REPLACEMENT_VALUE_UNCHANGED');
    expectError(planFactLifecycleAction(lifecycleInput({ action: 'SUPERSEDE' })), 'REPLACEMENT_REQUIRED');
    expectError(planFactLifecycleAction(lifecycleInput({
      action: 'SUPERSEDE',
      replacement: { scope: SCOPE, status: 'CONFIRMED', normalizedValueDigest: DIGEST_B, factRef: 'fact_a' },
    })), 'UNKNOWN_FIELD');
  });
});

describe('idempotency and proposal acceptance decisions', () => {
  it('classifies NEW, exact replay, and request/digest conflicts without echoing values', () => {
    expect(classifyIdempotency({
      schemaVersion: 1, requestId: 'request_a', operationDigest: OPERATION_DIGEST_A, proposalRef: 'proposal_a',
    })).toEqual({ ok: true, value: { decision: 'NEW' } });
    const receipt = {
      schemaVersion: 1 as const, requestId: 'request_a', operationDigest: OPERATION_DIGEST_A,
      proposalRef: 'proposal_a', decision: 'ACCEPTED' as const,
    };
    expect(classifyIdempotency({
      schemaVersion: 1, requestId: 'request_a', operationDigest: OPERATION_DIGEST_A, proposalRef: 'proposal_a', persistedReceipt: receipt,
    })).toEqual({ ok: true, value: { decision: 'IDEMPOTENT_REPLAY' } });
    expectError(classifyIdempotency({
      schemaVersion: 1, requestId: 'request_b', operationDigest: OPERATION_DIGEST_A, proposalRef: 'proposal_a', persistedReceipt: receipt,
    }), 'IDEMPOTENCY_CONFLICT');
    expectError(classifyIdempotency({
      schemaVersion: 1, requestId: 'request_a', operationDigest: OPERATION_DIGEST_B, proposalRef: 'proposal_a', persistedReceipt: receipt,
    }), 'IDEMPOTENCY_CONFLICT');
    const invalid = classifyIdempotency({
      schemaVersion: 1, requestId: 'request_a', operationDigest: OPERATION_DIGEST_A, proposalRef: 'proposal_a',
      persistedReceipt: { ...receipt, excerpt: 'fixture customer text' },
    });
    expectError(invalid, 'INVALID_RECEIPT');
    expect(JSON.stringify(invalid)).not.toContain('fixture customer text');
  });

  it('accepts a proposal as an atomic confirmed-fact plan with reused evidence ids', () => {
    const result = decideAcceptProposal(BASE_ACCEPT_INPUT);
    expect(result).toMatchObject({
      ok: true,
      value: {
        schemaVersion: 1,
        decision: 'NEW',
        atomic: 'ALL_OR_NOTHING',
        proposalUpdate: { status: 'ACCEPTED', expectedVersion: 4, nextVersion: 5 },
        factOutcome: { action: 'CREATE', status: 'CONFIRMED', normalizedValueDigest: DIGEST_A, effectiveProjection: 'EFFECTIVE' },
        factEvidenceLinks: [
          { target: 'NEW_FACT', evidenceId: 'evidence_a', relation: 'SUPPORTS' },
          { target: 'NEW_FACT', evidenceId: 'evidence_b', relation: 'SUPPORTS' },
        ],
        audit: { event: 'PROPOSAL_ACCEPTED', factOutcome: 'CREATE_CONFIRMED' },
        receiptToPersist: {
          schemaVersion: 1,
          requestId: 'request_a',
          operationDigest: OPERATION_DIGEST_A,
          proposalRef: 'proposal_a',
          decision: 'ACCEPTED',
        },
      },
    });
    if (!result.ok || result.value.decision !== 'NEW') return;
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.receiptToPersist)).toBe(true);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    const serialized = JSON.stringify(result);
    for (const forbidden of ['tenant_a', 'lead_a', 'identity.company_name', 'OWNER', 'USER', 'confirmedBy', 'companyId', 'rawValue', 'excerpt']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('makes operation digest independent of evidence order, decisionNow, and current-fact snapshots', () => {
    const reversed = buildAcceptInput({
      proposalEvidence: [...BASE_EVIDENCE].reverse(),
      decisionNow: '2026-08-04T13:00:00Z',
      currentFacts: [currentFact({ status: 'CONFLICT', normalizedValueDigest: DIGEST_C })],
    });
    expect(reversed.operationDigest).toBe(OPERATION_DIGEST_A);
    expect(decideAcceptProposal(reversed).ok).toBe(true);
    expect(computeAcceptOperationDigest({
      schemaVersion: 1,
      operation: 'ACCEPT_PROPOSAL',
      proposalRef: BASE_PROPOSAL.proposalRef,
      scope: SCOPE,
      expectedVersion: BASE_PROPOSAL.version,
      candidateValueDigest: DIGEST_B,
      proposalEvidence: BASE_EVIDENCE,
    })).toBe(OPERATION_DIGEST_B);
  });

  it('requires a digest bound to the complete accepted intent and never accepts a hand-filled digest', () => {
    expectError(decideAcceptProposal({
      ...buildAcceptInput({ proposalEvidence: CONTRADICTING_EVIDENCE }),
      operationDigest: OPERATION_DIGEST_A,
    }), 'OPERATION_DIGEST_MISMATCH');
    expectError(decideAcceptProposal({
      ...buildAcceptInput({ expectedVersion: 5 }),
      operationDigest: OPERATION_DIGEST_A,
    }), 'OPERATION_DIGEST_MISMATCH');
    expectError(decideAcceptProposal({
      ...buildAcceptInput({ proposal: { ...BASE_PROPOSAL, candidateValueDigest: DIGEST_B } }),
      operationDigest: OPERATION_DIGEST_A,
    }), 'OPERATION_DIGEST_MISMATCH');
  });

  it.each([
    { label: 'new candidate', currentFacts: [], proposalEvidence: CONTRADICTING_EVIDENCE },
    { label: 'same value existing confirmed', currentFacts: [currentFact({ normalizedValueDigest: DIGEST_A })], proposalEvidence: CONTRADICTING_EVIDENCE },
    { label: 'different value existing confirmed', currentFacts: [currentFact({ normalizedValueDigest: DIGEST_B })], proposalEvidence: CONTRADICTING_EVIDENCE },
  ])('treats CONTRADICTS as conflict for $label and preserves the link', ({ currentFacts, proposalEvidence }) => {
    const result = decideAcceptProposal(buildAcceptInput({ currentFacts, proposalEvidence }));
    expect(result).toMatchObject({
      ok: true,
      value: {
        factOutcome: { action: 'CREATE', status: 'CONFLICT', effectiveProjection: 'EMPTY' },
        factEvidenceLinks: [
          { evidenceId: 'evidence_a', relation: 'SUPPORTS', target: 'NEW_FACT' },
          { evidenceId: 'evidence_b', relation: 'SUPPORTS', target: 'NEW_FACT' },
          { evidenceId: 'evidence_c', relation: 'CONTRADICTS', target: 'NEW_FACT' },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain('EFFECTIVE');
  });

  it('rejects AI, viewer, version mismatch, expired proposal, and client confirmation metadata', () => {
    expectError(decideAcceptProposal(buildAcceptInput({ actorKind: 'AI_WORKER' })), 'AI_NOT_AUTHORIZED');
    expectError(decideAcceptProposal(buildAcceptInput({ role: 'VIEWER' })), 'ROLE_NOT_AUTHORIZED');
    expectError(decideAcceptProposal(buildAcceptInput({ expectedVersion: 3 })), 'VERSION_MISMATCH');
    expectError(decideAcceptProposal(buildAcceptInput({ proposal: { ...BASE_PROPOSAL, expiresAt: DECISION_NOW } })), 'PROPOSAL_EXPIRED');
    expectError(decideAcceptProposal(buildAcceptInput({ confirmedBy: 'user_a' })), 'UNKNOWN_FIELD');
    expectError(decideAcceptProposal(buildAcceptInput({ companyId: 'company_a' })), 'UNKNOWN_FIELD');
    expectError(decideAcceptProposal(buildAcceptInput({ proposalEvidence: [{ ...BASE_EVIDENCE[1], excerpt: 'fixture' }] })), 'UNKNOWN_FIELD');
  });

  it('rejects cross tenant/lead/factKey scopes and invalid CAS/idempotency fields', () => {
    expectError(decideAcceptProposal(buildAcceptInput({ proposal: { ...BASE_PROPOSAL, scope: OTHER_LEAD_SCOPE } })), 'SCOPE_MISMATCH');
    expectError(decideAcceptProposal(buildAcceptInput({ scope: OTHER_TENANT_SCOPE })), 'SCOPE_MISMATCH');
    expectError(decideAcceptProposal(buildAcceptInput({ currentFacts: [currentFact({ scope: OTHER_FACT_KEY_SCOPE })] })), 'SCOPE_MISMATCH');
    expectError(decideAcceptProposal(buildAcceptInput({ expectedVersion: -1 })), 'INVALID_VERSION');
    expectError(decideAcceptProposal(buildAcceptInput({ requestId: 'request/with/path' })), 'INVALID_REQUEST_ID');
    expectError(decideAcceptProposal(buildAcceptInput({ operationDigest: 'sha256:operation-v1:not-a-digest' })), 'INVALID_OPERATION_DIGEST');
  });

  it('requires bounded unique evidence with at least one SUPPORTS and preserves the same id set', () => {
    expectError(decideAcceptProposal(buildAcceptInput({ proposalEvidence: [] })), 'EVIDENCE_REQUIRED');
    expectError(decideAcceptProposal(buildAcceptInput({ proposalEvidence: [{ evidenceId: 'evidence_a', relation: 'CONTRADICTS' }] })), 'SUPPORT_EVIDENCE_REQUIRED');
    expectError(decideAcceptProposal(buildAcceptInput({ proposalEvidence: [BASE_EVIDENCE[1], BASE_EVIDENCE[1]] })), 'DUPLICATE_EVIDENCE_ID');
    expectError(decideAcceptProposal({
      ...buildAcceptInput({
      proposalEvidence: Array.from({ length: 65 }, (_, index) => ({ evidenceId: `evidence_${index}`, relation: 'SUPPORTS' as const })),
      }),
    }), 'EVIDENCE_LIMIT_EXCEEDED');
    const result = decideAcceptProposal(BASE_ACCEPT_INPUT);
    expect(result.ok).toBe(true);
    if (result.ok && result.value.decision === 'NEW') {
      expect(result.value.factEvidenceLinks.map((link) => link.evidenceId).sort()).toEqual(['evidence_a', 'evidence_b']);
    }
  });

  it('reuses the same confirmed value instead of creating a parallel confirmed fact', () => {
    const result = decideAcceptProposal({
      ...buildAcceptInput({ currentFacts: [currentFact({ normalizedValueDigest: DIGEST_A })] }),
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        decision: 'NEW',
        factOutcome: { action: 'REUSE_CONFIRMED', existingFactRef: 'fact_a', status: 'CONFIRMED' },
        factTransitions: [],
        factVersionUpdates: [{ factRef: 'fact_a', expectedVersion: 7, nextVersion: 8 }],
        factEvidenceLinks: [
          { target: 'EXISTING_CONFIRMED', targetFactRef: 'fact_a', evidenceId: 'evidence_a', relation: 'SUPPORTS' },
          { target: 'EXISTING_CONFIRMED', targetFactRef: 'fact_a', evidenceId: 'evidence_b', relation: 'SUPPORTS' },
        ],
      },
    });
  });

  it('plans unresolved conflicts fail closed for different values and concurrent snapshots', () => {
    const first = decideAcceptProposal(buildAcceptInput({
      currentFacts: [currentFact({ normalizedValueDigest: DIGEST_A })],
      proposal: { ...BASE_PROPOSAL, candidateValueDigest: DIGEST_B },
    }));
    const second = decideAcceptProposal(buildAcceptInput({
      requestId: 'request_b',
      currentFacts: [currentFact({ normalizedValueDigest: DIGEST_A })],
      proposal: { ...BASE_PROPOSAL, candidateValueDigest: DIGEST_C },
    }));
    for (const result of [first, second]) {
      expect(result).toMatchObject({
        ok: true,
        value: {
          factOutcome: { action: 'CREATE', status: 'CONFLICT', effectiveProjection: 'EMPTY' },
          factTransitions: [{ from: 'CONFIRMED', to: 'CONFLICT' }],
        },
      });
    }
    const existingConflict = decideAcceptProposal(buildAcceptInput({
      currentFacts: [currentFact({ status: 'CONFLICT', normalizedValueDigest: DIGEST_B })],
    }));
    expect(existingConflict).toMatchObject({ ok: true, value: { factOutcome: { status: 'CONFLICT', effectiveProjection: 'EMPTY' } } });
  });

  it('returns replay without any write plan when the persisted receipt matches', () => {
    const receipt = {
      schemaVersion: 1 as const,
      requestId: 'request_a',
      operationDigest: OPERATION_DIGEST_A,
      proposalRef: 'proposal_a',
      decision: 'ACCEPTED' as const,
    };
    expect(decideAcceptProposal({ ...BASE_ACCEPT_INPUT, persistedReceipt: receipt })).toEqual({
      ok: true, value: { schemaVersion: 1, decision: 'IDEMPOTENT_REPLAY' },
    });
    expect(decideAcceptProposal({
      ...BASE_ACCEPT_INPUT,
      decisionNow: '2026-08-04T13:00:00Z',
      currentFacts: [currentFact({ status: 'CONFLICT', normalizedValueDigest: DIGEST_C })],
      persistedReceipt: receipt,
    })).toEqual({ ok: true, value: { schemaVersion: 1, decision: 'IDEMPOTENT_REPLAY' } });
    expectError(decideAcceptProposal({
      ...buildAcceptInput({ proposalEvidence: CONTRADICTING_EVIDENCE }),
      operationDigest: OPERATION_DIGEST_A,
      persistedReceipt: receipt,
    }), 'OPERATION_DIGEST_MISMATCH');
    expectError(decideAcceptProposal({
      ...buildAcceptInput({ expectedVersion: 5 }),
      operationDigest: OPERATION_DIGEST_A,
      persistedReceipt: receipt,
    }), 'OPERATION_DIGEST_MISMATCH');
    expectError(decideAcceptProposal({
      ...buildAcceptInput({ proposal: { ...BASE_PROPOSAL, candidateValueDigest: DIGEST_B } }),
      operationDigest: OPERATION_DIGEST_A,
      persistedReceipt: receipt,
    }), 'OPERATION_DIGEST_MISMATCH');
    expectError(decideAcceptProposal({
      ...buildAcceptInput({ proposalEvidence: CONTRADICTING_EVIDENCE }),
      persistedReceipt: receipt,
    }), 'IDEMPOTENCY_CONFLICT');
    expect(decideAcceptProposal({
      ...BASE_ACCEPT_INPUT,
      proposal: { ...BASE_PROPOSAL, status: 'ACCEPTED', version: 5 },
      persistedReceipt: receipt,
    })).toEqual({ ok: true, value: { schemaVersion: 1, decision: 'IDEMPOTENT_REPLAY' } });
  });
});
