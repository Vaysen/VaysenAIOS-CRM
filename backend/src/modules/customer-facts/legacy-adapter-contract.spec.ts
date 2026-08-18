import {
  LEGACY_ADAPTER_VERSION,
  LEGACY_DISPOSITIONS,
  LEGACY_REASON_CODES,
  LEGACY_SOURCE_KINDS,
  classifyLegacyRecord,
  dryRunLegacyBatch,
} from './legacy-adapter-contract';

const VALIDATION_NOW = '2026-08-04T12:00:00Z';
const SOURCE_REF = 'https://example.com/source';
const EXCERPT = 'Synthetic source excerpt supports the packaging claim.';
const CONTEXT = {
  schemaVersion: 1 as const,
  validationNow: VALIDATION_NOW,
  adapterVersion: LEGACY_ADAPTER_VERSION,
  allowlistedSourceRefs: [SOURCE_REF],
};
const SCOPE = {
  tenantRef: 'tenant-synthetic',
  leadRef: 'lead-synthetic',
  factKey: 'company.industry' as const,
};
const VALUE_ENVELOPE = { schemaVersion: 1 as const, type: 'ENUM' as const, value: 'packaging' };

function common(sourceKind: string, legacyObjectRef = `${sourceKind.toLowerCase()}-synthetic`): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sourceKind,
    legacyObjectRef,
    scope: { ...SCOPE },
    factKey: SCOPE.factKey,
    observedAt: '2026-08-03T11:00:00Z',
    valueEnvelope: { ...VALUE_ENVELOPE },
  };
}

let FACT_VALUE_DIGEST = '';

function sourceEvidence(relation: 'SUPPORTS' | 'CONTRADICTS' = 'SUPPORTS', sourceRef = SOURCE_REF, excerpt = EXCERPT, factKey: string = SCOPE.factKey, valueDigest: string = FACT_VALUE_DIGEST): Record<string, unknown> {
  return {
    schemaVersion: 1,
    relation,
    factKey,
    valueDigest,
    observation: {
      schemaVersion: 1,
      kind: 'SOURCE_EXCERPT',
      sourceRef,
      excerpt,
      locator: 'paragraph:3',
      capturedAt: '2026-08-03T10:00:00Z',
    },
  };
}

function leadRecord(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...common('LEGACY_LEAD_SCALAR'), legacyField: 'industry', ...fields };
}

function sourceRecord(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...common('LEAD_SOURCE'), sourceUrl: SOURCE_REF, ...fields };
}

function deepRecord(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...common('DEEP_RESEARCH_FINDING'),
    findingRef: 'finding-synthetic-1',
    sourceRef: SOURCE_REF,
    supportingExcerpt: EXCERPT,
    locator: 'finding:finding-synthetic-1',
    ...fields,
  };
}

function aiRecord(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...common('AI_ARTIFACT'),
    artifactStatus: 'accepted',
    confidenceScore: 0.99,
    provider: 'synthetic-provider',
    model: 'synthetic-model',
    ...fields,
  };
}

const initialReview = classifyLegacyRecord(leadRecord(), CONTEXT);
if (!initialReview.ok || !initialReview.value.valueDigest) throw new Error('failed to establish synthetic value digest');
FACT_VALUE_DIGEST = initialReview.value.valueDigest;

function expectSuccess(result: ReturnType<typeof classifyLegacyRecord>) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected success');
  return result.value;
}

function expectFailure(result: unknown, code: string): void {
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ code }) });
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

describe('legacy adapter vocabulary and fail-closed provenance', () => {
  it('exposes only the four source kinds and four dry-run dispositions', () => {
    expect(LEGACY_SOURCE_KINDS).toEqual([
      'LEGACY_LEAD_SCALAR', 'LEAD_SOURCE', 'DEEP_RESEARCH_FINDING', 'AI_ARTIFACT',
    ]);
    expect(LEGACY_DISPOSITIONS).toEqual([
      'PROPOSAL_WITH_EVIDENCE', 'PROPOSAL_REVIEW_REQUIRED', 'QUARANTINED', 'SKIPPED',
    ]);
    expect(Object.isFrozen(LEGACY_SOURCE_KINDS)).toBe(true);
    expect(Object.isFrozen(LEGACY_DISPOSITIONS)).toBe(true);
    expect(Object.isFrozen(LEGACY_REASON_CODES)).toBe(true);
  });

  it('keeps a non-empty Lead scalar at review until independent evidence exists', () => {
    const receipt = expectSuccess(classifyLegacyRecord(leadRecord(), CONTEXT));
    expect(receipt.disposition).toBe('PROPOSAL_REVIEW_REQUIRED');
    expect(receipt.reasonCode).toBe('NO_INDEPENDENT_EVIDENCE');
    expect(receipt.valueDigest).toMatch(/^sha256:fact-value-v1:[0-9a-f]{64}$/);
  });

  it('upgrades a Lead scalar only with immutable source excerpt evidence', () => {
    const receipt = expectSuccess(classifyLegacyRecord(leadRecord({ evidence: sourceEvidence() }), CONTEXT));
    expect(receipt.disposition).toBe('PROPOSAL_WITH_EVIDENCE');
    expect(receipt.evidenceCount).toBe(1);
    expect(receipt.evidence?.[0].relation).toBe('SUPPORTS');
  });

  it('requires immutable evidence to bind the exact fact key and normalized value digest', () => {
    const wrongFact = expectSuccess(classifyLegacyRecord(leadRecord({ evidence: sourceEvidence('SUPPORTS', SOURCE_REF, EXCERPT, 'company.country') }), CONTEXT));
    expect(wrongFact.disposition).toBe('QUARANTINED');
    expect(wrongFact.reasonCode).toBe('EVIDENCE_INVALID');
    const wrongValue = expectSuccess(classifyLegacyRecord(leadRecord({ evidence: sourceEvidence('SUPPORTS', SOURCE_REF, EXCERPT, SCOPE.factKey, `sha256:fact-value-v1:${'0'.repeat(64)}`) }), CONTEXT));
    expect(wrongValue.disposition).toBe('QUARANTINED');
    expect(wrongValue.reasonCode).toBe('EVIDENCE_INVALID');
  });

  it('never treats a manual attestation as independent public evidence', () => {
    const receipt = expectSuccess(classifyLegacyRecord(leadRecord({ evidence: {
      schemaVersion: 1,
      relation: 'SUPPORTS',
      observation: {
        schemaVersion: 1,
        kind: 'MANUAL_ATTESTATION',
        actorRef: 'internal://actor/synthetic-user',
        reason: 'Synthetic owner reviewed the public record.',
        rawInput: 'Synthetic raw input for validation only.',
        inputDigest: 'sha256:manual-input-v1:3c86e6c2e2a60f9cccf6d9df3dd7c3a77d38f7bf488a29c5af4d744b19a9e4f',
        capturedAt: '2026-08-03T10:00:00Z',
        locator: 'manual://attestation',
      },
    } }), CONTEXT));
    expect(receipt.disposition).toBe('QUARANTINED');
    expect(receipt.reasonCode).toBe('EVIDENCE_INVALID');
  });

  it('does not accept a fabricated LeadSource URL as evidence', () => {
    const receipt = expectSuccess(classifyLegacyRecord(sourceRecord(), CONTEXT));
    expect(receipt.disposition).toBe('PROPOSAL_REVIEW_REQUIRED');
    expect(receipt.reasonCode).toBe('SOURCE_URL_NOT_EVIDENCE');
    expect(receipt.evidenceCount).toBe(0);
  });

  it('requires LeadSource evidence to use the same safe source reference', () => {
    expect(expectSuccess(classifyLegacyRecord(sourceRecord({ evidence: sourceEvidence() }), CONTEXT)).disposition)
      .toBe('PROPOSAL_WITH_EVIDENCE');
    const mismatch = expectSuccess(classifyLegacyRecord(sourceRecord({ evidence: sourceEvidence('SUPPORTS', 'https://other.example/source') }), CONTEXT));
    expect(mismatch.disposition).toBe('QUARANTINED');
    expect(mismatch.reasonCode).toBe('SOURCE_REF_MISMATCH');
    const contradiction = expectSuccess(classifyLegacyRecord(sourceRecord({ evidence: sourceEvidence('CONTRADICTS') }), CONTEXT));
    expect(contradiction.disposition).toBe('QUARANTINED');
    expect(contradiction.reasonCode).toBe('EVIDENCE_CONTRADICTS');
  });

  it('accepts only a finding-level deep research excerpt from an allowlisted source', () => {
    const receipt = expectSuccess(classifyLegacyRecord(deepRecord(), CONTEXT));
    expect(receipt.disposition).toBe('PROPOSAL_WITH_EVIDENCE');
    expect(receipt.reasonCode).toBe('EVIDENCE_ACCEPTED');

    const notAllowlisted = expectSuccess(classifyLegacyRecord(deepRecord({ sourceRef: 'https://other.example/source' }), CONTEXT));
    expect(notAllowlisted.reasonCode).toBe('SOURCE_REF_NOT_ALLOWLISTED');
    const missing = expectSuccess(classifyLegacyRecord(deepRecord({ supportingExcerpt: '' }), CONTEXT));
    expect(missing.reasonCode).toBe('FINDING_EXCERPT_MISSING');
    const mismatch = expectSuccess(classifyLegacyRecord(deepRecord({ evidenceSourceRef: 'https://other.example/source' }), CONTEXT));
    expect(mismatch.reasonCode).toBe('SOURCE_REF_MISMATCH');
  });

  it('rejects report-shaped, sensitive, or unmapped deep research input without echoing it', () => {
    const report = classifyLegacyRecord(deepRecord({ jsonData: { raw: 'Synthetic report body' } }), CONTEXT);
    expectFailure(report, 'UNKNOWN_FIELD');
    const sensitive = expectSuccess(classifyLegacyRecord(deepRecord({ supportingExcerpt: 'Email synthetic@example.com is sensitive.' }), CONTEXT));
    expect(sensitive.reasonCode).toBe('EVIDENCE_INVALID');
    const unsafeRef = expectSuccess(classifyLegacyRecord(deepRecord({ sourceRef: 'https://example.com/source?token=synthetic' }), CONTEXT));
    expect(unsafeRef.reasonCode).toBe('SOURCE_REF_INVALID');
  });

  it('keeps AI artifact confidence, provider, model, and accepted status inert', () => {
    const review = expectSuccess(classifyLegacyRecord(aiRecord(), CONTEXT));
    expect(review.disposition).toBe('PROPOSAL_REVIEW_REQUIRED');
    expect(review.reasonCode).toBe('AI_ARTIFACT_REVIEW_ONLY');
    expectFailure(classifyLegacyRecord(aiRecord({ prompt: 'Synthetic prompt' }), CONTEXT), 'UNKNOWN_FIELD');
    expectFailure(classifyLegacyRecord(aiRecord({ outputContent: 'Synthetic output' }), CONTEXT), 'UNKNOWN_FIELD');
  });

  it('accepts an AI artifact only when it references a verified external evidence summary', () => {
    const sourceReceipt = expectSuccess(classifyLegacyRecord(leadRecord({ evidence: sourceEvidence() }), CONTEXT));
    const evidence = sourceReceipt.evidence?.[0];
    expect(evidence?.sourceRefDigest).toBeDefined();
    expect(evidence?.excerptHash).toBeDefined();
    const accepted = expectSuccess(classifyLegacyRecord(aiRecord({ verifiedEvidence: {
      schemaVersion: 1,
      relation: 'SUPPORTS',
      factKey: SCOPE.factKey,
      valueDigest: sourceReceipt.valueDigest,
      sourceRefDigest: evidence?.sourceRefDigest,
      excerptHash: evidence?.excerptHash,
    } }), CONTEXT));
    expect(accepted.disposition).toBe('PROPOSAL_WITH_EVIDENCE');
    const contradiction = expectSuccess(classifyLegacyRecord(aiRecord({ verifiedEvidence: {
      schemaVersion: 1,
      relation: 'CONTRADICTS',
      factKey: SCOPE.factKey,
      valueDigest: sourceReceipt.valueDigest,
      sourceRefDigest: evidence?.sourceRefDigest,
      excerptHash: evidence?.excerptHash,
    } }), CONTEXT));
    expect(contradiction.disposition).toBe('QUARANTINED');
    expect(contradiction.reasonCode).toBe('EVIDENCE_CONTRADICTS');
    const unverifiedDigest = expectSuccess(classifyLegacyRecord(aiRecord({ verifiedEvidence: {
      schemaVersion: 1,
      relation: 'SUPPORTS',
      factKey: SCOPE.factKey,
      valueDigest: sourceReceipt.valueDigest,
      sourceRefDigest: `sha256:legacy-source-ref-v1:${'0'.repeat(64)}`,
      excerptHash: evidence?.excerptHash,
    } }), CONTEXT));
    expect(unverifiedDigest.reasonCode).toBe('VERIFIED_EVIDENCE_INVALID');
  });

  it('reuses the fact contract and quarantines unknown, PII, and invalid values', () => {
    const invalidValue = classifyLegacyRecord(leadRecord({ valueEnvelope: { schemaVersion: 1, type: 'ENUM', value: 'not-allowed' } }), CONTEXT);
    expect(expectSuccess(invalidValue).reasonCode).toBe('INVALID_FACT_VALUE');
    const unknownScope = classifyLegacyRecord({ ...leadRecord(), scope: { ...SCOPE, factKey: 'identity.email' } }, CONTEXT);
    expectFailure(unknownScope, 'INVALID_SCOPE');
    const unknownValueKey = classifyLegacyRecord({ ...leadRecord(), scope: { ...SCOPE, factKey: 'company.unknown' } }, CONTEXT);
    expectFailure(unknownValueKey, 'INVALID_SCOPE');
  });

  it('rejects client metadata, explicit undefined, and unsafe source queries', () => {
    expectFailure(classifyLegacyRecord({ ...leadRecord(), companyId: 'synthetic-company' }, CONTEXT), 'UNKNOWN_FIELD');
    expectFailure(classifyLegacyRecord({ ...leadRecord(), evidence: undefined }, CONTEXT), 'UNKNOWN_FIELD');
    const unsafe = expectSuccess(classifyLegacyRecord(sourceRecord({ sourceUrl: 'https://example.com/source?api_key=synthetic' }), CONTEXT));
    expect(unsafe.disposition).toBe('QUARANTINED');
    expect(unsafe.reasonCode).toBe('SOURCE_REF_INVALID');
    const insecure = expectSuccess(classifyLegacyRecord(sourceRecord({ sourceUrl: 'http://example.com/source' }), CONTEXT));
    expect(insecure.reasonCode).toBe('SOURCE_REF_INVALID');
  });

  it('rejects unsupported adapter versions and future source timestamps', () => {
    expectFailure(classifyLegacyRecord(leadRecord(), { ...CONTEXT, adapterVersion: 'legacy-adapter-v2' }), 'INVALID_ADAPTER_VERSION');
    expectFailure(classifyLegacyRecord(leadRecord({ observedAt: '2026-08-04T12:00:00.001Z' }), CONTEXT), 'INVALID_TIMESTAMP');
    expect(classifyLegacyRecord(leadRecord({ observedAt: VALIDATION_NOW }), CONTEXT).ok).toBe(true);
  });
});

describe('legacy adapter dry-run batch determinism', () => {
  it('deduplicates identity+fact+value and produces no raw input in receipts', () => {
    const first = leadRecord({ evidence: sourceEvidence() });
    const duplicate = leadRecord({ evidence: sourceEvidence(), legacyObjectRef: first.legacyObjectRef });
    const batch = dryRunLegacyBatch({ schemaVersion: 1, records: [duplicate, first] }, CONTEXT);
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(batch.value.records).toHaveLength(2);
    expect(batch.value.records.some((record) => record.disposition === 'SKIPPED' && record.reasonCode === 'DUPLICATE_SKIPPED')).toBe(true);
    const serialized = JSON.stringify(batch.value);
    for (const secret of [String(first.legacyObjectRef), 'tenant-synthetic', 'lead-synthetic', EXCERPT, SOURCE_REF]) expect(serialized).not.toContain(secret);
  });

  it('never deduplicates equal opaque references across scopes or source kinds', () => {
    const sharedRef = 'legacy-shared-ref';
    const crossTenant = leadRecord({ legacyObjectRef: sharedRef, scope: { ...SCOPE, tenantRef: 'tenant-other' } });
    const crossKind = sourceRecord({ legacyObjectRef: sharedRef });
    const batch = dryRunLegacyBatch({ schemaVersion: 1, records: [leadRecord({ legacyObjectRef: sharedRef }), crossTenant, crossKind] }, CONTEXT);
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(batch.value.records).toHaveLength(3);
    expect(batch.value.records.some((record) => record.disposition === 'SKIPPED')).toBe(false);
  });

  it('is byte-for-byte stable when record order changes', () => {
    const records = [leadRecord(), sourceRecord(), deepRecord()];
    const left = dryRunLegacyBatch({ schemaVersion: 1, records }, CONTEXT);
    const right = dryRunLegacyBatch({ schemaVersion: 1, records: [...records].reverse() }, CONTEXT);
    expect(left).toEqual(right);
    expect(JSON.stringify(left)).toBe(JSON.stringify(right));
  });

  it('accepts 500 synthetic records and rejects 501', () => {
    const records = Array.from({ length: 500 }, (_, index) => leadRecord({ legacyObjectRef: `lead-synthetic-${index}` }));
    const valid = dryRunLegacyBatch({ schemaVersion: 1, records }, CONTEXT);
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.value.records).toHaveLength(500);
    const tooLarge = dryRunLegacyBatch({ schemaVersion: 1, records: [...records, leadRecord({ legacyObjectRef: 'lead-synthetic-500' })] }, CONTEXT);
    expectFailure(tooLarge, 'BATCH_TOO_LARGE');
  });

  it('deep-freezes success and failure structures', () => {
    const success = dryRunLegacyBatch({ schemaVersion: 1, records: [leadRecord()] }, CONTEXT);
    const failure = dryRunLegacyBatch({ schemaVersion: 1, records: [] }, CONTEXT);
    expectDeepFrozen(success);
    expectDeepFrozen(failure);
  });
});
