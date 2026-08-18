import { createHash } from 'node:crypto';
import {
  LEGACY_ADAPTER_VERSION,
  classifyLegacyRecord,
  dryRunLegacyBatch,
} from './legacy-adapter-contract';
import {
  LEGACY_IMPORT_EXECUTION_MODE,
  buildLegacyImportPlan,
} from './legacy-import-plan-contract';

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

function common(sourceKind: string, legacyObjectRef = `${sourceKind.toLowerCase()}-synthetic`, scope = SCOPE): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sourceKind,
    legacyObjectRef,
    scope: { ...scope },
    factKey: scope.factKey,
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

function leadRecord(fields: Record<string, unknown> = {}, legacyObjectRef = 'lead-synthetic'): Record<string, unknown> {
  return { ...common('LEGACY_LEAD_SCALAR', legacyObjectRef), legacyField: 'industry', ...fields };
}

function sourceRecord(fields: Record<string, unknown> = {}, legacyObjectRef = 'source-synthetic'): Record<string, unknown> {
  return { ...common('LEAD_SOURCE', legacyObjectRef), sourceUrl: SOURCE_REF, sourceTitle: 'Synthetic source title', ...fields };
}

function deepFindingRecord(fields: Record<string, unknown> = {}, legacyObjectRef = 'finding-synthetic'): Record<string, unknown> {
  return {
    ...common('DEEP_RESEARCH_FINDING', legacyObjectRef),
    findingRef: 'finding-synthetic-ref',
    sourceRef: SOURCE_REF,
    evidenceSourceRef: SOURCE_REF,
    supportingExcerpt: EXCERPT,
    locator: 'paragraph:3',
    ...fields,
  };
}

function aiArtifactRecord(fields: Record<string, unknown> = {}, legacyObjectRef = 'ai-synthetic'): Record<string, unknown> {
  return {
    ...common('AI_ARTIFACT', legacyObjectRef),
    artifactStatus: 'generated',
    confidenceScore: 0.5,
    provider: 'synthetic-provider',
    model: 'synthetic-model',
    ...fields,
  };
}

function expectAdapterBatch(records: readonly Record<string, unknown>[]) {
  const result = dryRunLegacyBatch({ schemaVersion: 1, records }, CONTEXT);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected a synthetic adapter batch');
  return result.value;
}

function expectReceipt(record: Record<string, unknown>) {
  const result = classifyLegacyRecord(record, CONTEXT);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected a synthetic receipt');
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

const BATCH_DOMAIN = 'vaysen-trade-crm/legacy-adapter/batch/v1';
const DISPOSITIONS = ['PROPOSAL_WITH_EVIDENCE', 'PROPOSAL_REVIEW_REQUIRED', 'QUARANTINED', 'SKIPPED'] as const;
const SOURCE_KINDS = ['LEGACY_LEAD_SCALAR', 'LEAD_SOURCE', 'DEEP_RESEARCH_FINDING', 'AI_ARTIFACT'] as const;
const REASONS = [
  'EVIDENCE_ACCEPTED', 'NO_INDEPENDENT_EVIDENCE', 'EVIDENCE_NOT_INDEPENDENT', 'SOURCE_URL_NOT_EVIDENCE',
  'EVIDENCE_INVALID', 'EVIDENCE_CONTRADICTS', 'SOURCE_REF_INVALID', 'SOURCE_REF_NOT_ALLOWLISTED',
  'SOURCE_REF_MISMATCH', 'FINDING_EXCERPT_MISSING', 'FINDING_MAPPING_INVALID', 'VERIFIED_EVIDENCE_ACCEPTED',
  'AI_ARTIFACT_REVIEW_ONLY', 'VERIFIED_EVIDENCE_INVALID', 'INVALID_FACT_VALUE', 'DUPLICATE_SKIPPED', 'UNKNOWN_FACT_KEY',
  'INPUT_REJECTED', 'SKIPPED_EMPTY',
] as const;

function asciiCanonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(asciiCanonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort((left, right) => left < right ? -1 : left > right ? 1 : 0).map((key) => `${JSON.stringify(key)}:${asciiCanonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

function sameDomainBatchDigest(records: readonly Record<string, unknown>[]): string {
  const sorted = [...records].sort((left, right) => {
    const leftCanonical = asciiCanonical(left);
    const rightCanonical = asciiCanonical(right);
    return leftCanonical < rightCanonical ? -1 : leftCanonical > rightCanonical ? 1 : 0;
  });
  return `sha256:legacy-batch-v1:${createHash('sha256').update(`${BATCH_DOMAIN}\0${asciiCanonical(sorted)}`, 'utf8').digest('hex')}`;
}

function rebuildSelfConsistentBatch(batch: ReturnType<typeof expectAdapterBatch>, records: readonly Record<string, unknown>[]) {
  const byDisposition = Object.fromEntries(DISPOSITIONS.map((key) => [key, 0])) as Record<string, number>;
  const bySourceKind = Object.fromEntries(SOURCE_KINDS.map((key) => [key, 0])) as Record<string, number>;
  const byReasonCode = Object.fromEntries(REASONS.map((key) => [key, 0])) as Record<string, number>;
  for (const record of records) {
    byDisposition[String(record.disposition)] += 1;
    bySourceKind[String(record.sourceKind)] += 1;
    byReasonCode[String(record.reasonCode)] += 1;
  }
  return {
    ...batch,
    records,
    totals: { byDisposition, bySourceKind, byReasonCode },
    batchDigest: sameDomainBatchDigest(records),
  };
}

const initialReceipt = expectReceipt(leadRecord());
if (!initialReceipt.valueDigest) throw new Error('failed to establish synthetic value digest');
FACT_VALUE_DIGEST = initialReceipt.valueDigest;

describe('legacy import plan input boundary', () => {
  it('accepts only adapter receipts and emits dry-run proposal/rejection projections', () => {
    const withEvidence = expectReceipt(leadRecord({ evidence: sourceEvidence() }, 'lead-with-evidence'));
    const review = expectReceipt(leadRecord({}, 'lead-review'));
    const contradiction = expectReceipt(leadRecord({ evidence: sourceEvidence('CONTRADICTS') }, 'lead-contradiction'));
    const invalidValue = expectReceipt(leadRecord({ valueEnvelope: { schemaVersion: 1, type: 'ENUM', value: 'not-registered' } }, 'lead-invalid'));
    const batch = expectAdapterBatch([
      leadRecord({ evidence: sourceEvidence() }, 'lead-with-evidence'),
      leadRecord({}, 'lead-review'),
      leadRecord({ evidence: sourceEvidence('CONTRADICTS') }, 'lead-contradiction'),
      leadRecord({ valueEnvelope: { schemaVersion: 1, type: 'ENUM', value: 'not-registered' } }, 'lead-invalid'),
    ]);
    const plan = buildLegacyImportPlan(batch);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.executionMode).toBe(LEGACY_IMPORT_EXECUTION_MODE);
    expect(plan.value.proposalPlanItems.map((item) => item.valueDigest)).toContain(withEvidence.valueDigest);
    expect(plan.value.proposalPlanItems.map((item) => item.valueDigest)).toContain(review.valueDigest);
    expect(plan.value.rejectionReport.some((item) => item.reasonCode === contradiction.reasonCode)).toBe(true);
    expect(plan.value.rejectionReport.some((item) => item.reasonCode === invalidValue.reasonCode && !item.valueDigest)).toBe(true);
    const invalidReport = plan.value.rejectionReport.find((item) => item.reasonCode === invalidValue.reasonCode);
    expect(invalidReport?.valueDigest).toBeUndefined();
    expect(invalidReport?.valueType).toBeUndefined();
    const serialized = JSON.stringify(plan.value);
    expect(serialized).not.toContain('CONFIRMED');
    expect(serialized).not.toContain('ACCEPTED');
    expect(serialized).not.toContain('Synthetic');
    expect(serialized).not.toContain('tenant-synthetic');
    expect(serialized).not.toContain('lead-with-evidence');
    expect(serialized).not.toContain(SOURCE_REF);
    expect(serialized).not.toContain(EXCERPT);
  });

  it('preserves quarantine evidence relation and never upgrades CONTRADICTS', () => {
    const batch = expectAdapterBatch([leadRecord({ evidence: sourceEvidence('CONTRADICTS') }, 'lead-contradiction')]);
    const plan = buildLegacyImportPlan(batch);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.proposalPlanItems).toHaveLength(0);
    expect(plan.value.rejectionReport[0].reportKind).toBe('QUARANTINE');
    expect(plan.value.rejectionReport[0].reasonCode).toBe('EVIDENCE_CONTRADICTS');
    expect(plan.value.rejectionReport[0].valueDigest).toBeDefined();
    expect(plan.value.rejectionReport[0].valueType).toBeDefined();
    expect(plan.value.rejectionReport[0].evidence?.[0].relation).toBe('CONTRADICTS');
  });

  it('rejects raw legacy rows, URLs, excerpts, AI output, and unknown fields', () => {
    const batch = expectAdapterBatch([leadRecord({}, 'lead-safe')]);
    expectFailure(buildLegacyImportPlan({ ...batch, companyName: 'Synthetic Company' }), 'UNKNOWN_FIELD');
    expectFailure(buildLegacyImportPlan({ ...batch, records: [{ ...batch.records[0], excerpt: EXCERPT }] }), 'UNKNOWN_FIELD');
    expectFailure(buildLegacyImportPlan({ ...batch, records: [{ ...batch.records[0], sourceUrl: SOURCE_REF }] }), 'UNKNOWN_FIELD');
    expectFailure(buildLegacyImportPlan({ ...batch, records: [{ ...batch.records[0], outputContent: 'Synthetic model output' }] }), 'UNKNOWN_FIELD');
    expectFailure(buildLegacyImportPlan({ ...batch, records: [{ ...batch.records[0], valueDigest: undefined }] }), 'UNKNOWN_FIELD');
  });

  it('rejects mixed/future adapter versions and all batch/record digest tampering', () => {
    const batch = expectAdapterBatch([leadRecord({}, 'lead-safe')]);
    expectFailure(buildLegacyImportPlan({ ...batch, adapterVersion: 'legacy-adapter-v2' }), 'INVALID_ADAPTER_VERSION');
    expectFailure(buildLegacyImportPlan({ ...batch, records: [{ ...batch.records[0], adapterVersion: 'legacy-adapter-v2' }] }), 'INVALID_ADAPTER_VERSION');
    expectFailure(buildLegacyImportPlan({ ...batch, batchDigest: `sha256:legacy-batch-v1:${'0'.repeat(64)}` }), 'BATCH_DIGEST_MISMATCH');
    expectFailure(buildLegacyImportPlan({ ...batch, batchDigest: `sha256:fact-value-v1:${'0'.repeat(64)}` }), 'INVALID_BATCH_DIGEST');
    expectFailure(buildLegacyImportPlan({ ...batch, records: [{ ...batch.records[0], scopeDigest: `sha256:fact-value-v1:${'0'.repeat(64)}` }] }), 'INVALID_RECORD');
    expectFailure(buildLegacyImportPlan({ ...batch, records: [{ ...batch.records[0], valueDigest: `sha256:source-excerpt-v1:${'0'.repeat(64)}` }] }), 'INVALID_VALUE_DIGEST');
  });

  it('rejects duplicate identities, evidence count drift, and forged proposal contradictions', () => {
    const batch = expectAdapterBatch([leadRecord({ evidence: sourceEvidence() }, 'lead-one')]);
    expectFailure(buildLegacyImportPlan(rebuildSelfConsistentBatch(batch, [
      batch.records[0] as Record<string, unknown>,
      { ...batch.records[0] },
    ])), 'DUPLICATE_RECORD_IDENTITY');
    expectFailure(buildLegacyImportPlan({
      ...batch,
      records: [{ ...batch.records[0], evidenceCount: 2 }],
    }), 'EVIDENCE_COUNT_MISMATCH');
    expectFailure(buildLegacyImportPlan({
      ...batch,
      records: [{ ...batch.records[0], evidence: [{ ...batch.records[0].evidence?.[0], relation: 'CONTRADICTS' }] }],
    }), 'CONTRADICTORY_PROPOSAL');
    const review = expectAdapterBatch([leadRecord({}, 'lead-review')]);
    expectFailure(buildLegacyImportPlan({
      ...review,
      records: [{ ...review.records[0], evidenceCount: 1, evidence: [{ relation: 'CONTRADICTS', kind: 'MANUAL_ATTESTATION' } as never] }],
    }), 'CONTRADICTORY_PROPOSAL');
  });
});

describe('legacy import plan determinism and limits', () => {
  it('accepts adapter duplicate skip receipts only as skip report items', () => {
    const records = Array.from({ length: 4 }, () => leadRecord({ evidence: sourceEvidence() }, 'lead-duplicate'));
    const batch = expectAdapterBatch(records);
    const plan = buildLegacyImportPlan(batch);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.proposalPlanItems).toHaveLength(1);
    expect(plan.value.rejectionReport.filter((item) => item.reportKind === 'SKIP')).toHaveLength(3);
    expect(plan.value.rejectionReport.find((item) => item.reportKind === 'SKIP')?.reasonCode).toBe('DUPLICATE_SKIPPED');
    const duplicateSkip = plan.value.rejectionReport.find((item) => item.reportKind === 'SKIP');
    expect(duplicateSkip?.valueDigest).toBeDefined();
    expect(duplicateSkip?.valueType).toBeDefined();

    const isolatedSkip = batch.records.find((record) => record.disposition === 'SKIPPED');
    expect(isolatedSkip).toBeDefined();
    expectFailure(buildLegacyImportPlan(rebuildSelfConsistentBatch(batch, [isolatedSkip as Record<string, unknown>])), 'DUPLICATE_RECORD_IDENTITY');
  });

  it('keeps repeated invalid-value receipts as separate quarantine reports', () => {
    const invalidRecords = Array.from({ length: 2 }, () => leadRecord({ valueEnvelope: { schemaVersion: 1, type: 'ENUM', value: 'not-registered' } }, 'invalid-duplicate'));
    const batch = expectAdapterBatch(invalidRecords);
    const reversedBatch = expectAdapterBatch([...invalidRecords].reverse());
    const plan = buildLegacyImportPlan(batch);
    const reversedPlan = buildLegacyImportPlan(reversedBatch);
    expect(plan.ok).toBe(true);
    expect(reversedPlan).toEqual(plan);
    expect(JSON.stringify(reversedPlan)).toBe(JSON.stringify(plan));
    if (!plan.ok) return;
    expect(plan.value.proposalPlanItems).toHaveLength(0);
    expect(plan.value.rejectionReport).toHaveLength(2);
    expect(plan.value.rejectionReport.every((item) => item.reasonCode === 'INVALID_FACT_VALUE' && item.reportKind === 'QUARANTINE')).toBe(true);
    expect(plan.value.rejectionReport.every((item) => item.valueDigest === undefined && item.valueType === undefined)).toBe(true);
  });

  it('requires value digests for every reachable receipt except INVALID_FACT_VALUE', () => {
    const invalidValueBatch = expectAdapterBatch([leadRecord({ valueEnvelope: { schemaVersion: 1, type: 'ENUM', value: 'not-registered' } }, 'value-shape-invalid')]);
    const forgedInvalidValue = { ...invalidValueBatch.records[0], valueDigest: FACT_VALUE_DIGEST, valueType: 'ENUM' };
    expectFailure(buildLegacyImportPlan(rebuildSelfConsistentBatch(invalidValueBatch, [forgedInvalidValue as Record<string, unknown>])), 'INVALID_VALUE_SHAPE');

    const contradictionBatch = expectAdapterBatch([sourceRecord({ evidence: sourceEvidence('CONTRADICTS') }, 'value-shape-contradiction')]);
    const { valueDigest: _valueDigest, valueType: _valueType, ...withoutValue } = contradictionBatch.records[0];
    void _valueDigest;
    void _valueType;
    expectFailure(buildLegacyImportPlan(rebuildSelfConsistentBatch(contradictionBatch, [withoutValue as Record<string, unknown>])), 'INVALID_VALUE_SHAPE');

    const sourceInvalidBatch = expectAdapterBatch([sourceRecord({ sourceUrl: 'http://invalid.synthetic/source' }, 'value-shape-source-invalid')]);
    const sourceInvalidPlan = buildLegacyImportPlan(sourceInvalidBatch);
    expect(sourceInvalidPlan.ok).toBe(true);
    if (sourceInvalidPlan.ok) {
      expect(sourceInvalidPlan.value.rejectionReport[0].reasonCode).toBe('SOURCE_REF_INVALID');
      expect(sourceInvalidPlan.value.rejectionReport[0].valueDigest).toBeDefined();
      expect(sourceInvalidPlan.value.rejectionReport[0].valueType).toBeDefined();
    }
  });

  it('rejects source-kind unreachable reasons even when forged records have a valid recomputed batch digest', () => {
    const scalar = expectAdapterBatch([leadRecord({ evidence: sourceEvidence() }, 'matrix-scalar')]).records[0];
    const source = expectAdapterBatch([sourceRecord({ evidence: sourceEvidence() }, 'matrix-source')]).records[0];
    const deep = expectAdapterBatch([deepFindingRecord({}, 'matrix-deep')]).records[0];
    const sourceEvidenceReceipt = expectAdapterBatch([sourceRecord({ evidence: sourceEvidence() }, 'matrix-ai-evidence')]).records[0];
    const verified = sourceEvidenceReceipt.evidence?.[0];
    const ai = expectAdapterBatch([aiArtifactRecord({ verifiedEvidence: {
      schemaVersion: 1,
      relation: 'SUPPORTS',
      factKey: SCOPE.factKey,
      valueDigest: sourceEvidenceReceipt.valueDigest,
      sourceRefDigest: verified?.sourceRefDigest,
      excerptHash: verified?.excerptHash,
    } }, 'matrix-ai')]).records[0];
    const forged: Array<[ReturnType<typeof expectAdapterBatch>, Record<string, unknown>]> = [
      [expectAdapterBatch([leadRecord({ evidence: sourceEvidence() }, 'matrix-scalar')]), { ...scalar, reasonCode: 'VERIFIED_EVIDENCE_ACCEPTED' }],
      [expectAdapterBatch([sourceRecord({ evidence: sourceEvidence() }, 'matrix-source')]), { ...source, reasonCode: 'VERIFIED_EVIDENCE_ACCEPTED' }],
      [expectAdapterBatch([deepFindingRecord({}, 'matrix-deep')]), { ...deep, disposition: 'PROPOSAL_REVIEW_REQUIRED', reasonCode: 'AI_ARTIFACT_REVIEW_ONLY' }],
      [expectAdapterBatch([aiArtifactRecord({ verifiedEvidence: {
        schemaVersion: 1,
        relation: 'SUPPORTS',
        factKey: SCOPE.factKey,
        valueDigest: sourceEvidenceReceipt.valueDigest,
        sourceRefDigest: verified?.sourceRefDigest,
        excerptHash: verified?.excerptHash,
      } }, 'matrix-ai')]), { ...ai, reasonCode: 'EVIDENCE_ACCEPTED' }],
    ];
    for (const [base, record] of forged) {
      expectFailure(buildLegacyImportPlan(rebuildSelfConsistentBatch(base, [record as Record<string, unknown>])), 'INVALID_RECEIPT_REACHABILITY');
    }
  });

  it('rejects self-consistent multi-evidence and enforces reason-specific evidence shapes', () => {
    const base = expectAdapterBatch([leadRecord({ evidence: sourceEvidence() }, 'shape-base')]);
    const duplicatedEvidence = {
      ...base.records[0],
      evidenceCount: 2,
      evidence: [base.records[0].evidence?.[0], base.records[0].evidence?.[0]],
    };
    expectFailure(buildLegacyImportPlan(rebuildSelfConsistentBatch(base, [duplicatedEvidence as Record<string, unknown>])), 'EVIDENCE_COUNT_MISMATCH');

    const contradiction = expectAdapterBatch([leadRecord({ evidence: sourceEvidence('CONTRADICTS') }, 'shape-contradiction')]);
    const wrongContradictionShape = {
      ...contradiction.records[0],
      evidence: [{ relation: 'CONTRADICTS', kind: 'MANUAL_ATTESTATION' }],
    };
    expectFailure(buildLegacyImportPlan(rebuildSelfConsistentBatch(contradiction, [wrongContradictionShape as Record<string, unknown>])), 'INVALID_EVIDENCE_SUMMARY');

    const review = expectAdapterBatch([leadRecord({}, 'shape-review')]);
    const fakeEvidence = {
      ...review.records[0],
      disposition: 'PROPOSAL_REVIEW_REQUIRED',
      reasonCode: 'NO_INDEPENDENT_EVIDENCE',
      evidenceCount: 1,
      evidence: [{ relation: 'SUPPORTS', kind: 'SOURCE_EXCERPT', sourceRefDigest: 'sha256:legacy-source-ref-v1:' + '1'.repeat(64), excerptHash: 'sha256:source-excerpt-v1:' + '2'.repeat(64) }],
    };
    expectFailure(buildLegacyImportPlan(rebuildSelfConsistentBatch(review, [fakeEvidence as Record<string, unknown>])), 'INVALID_EVIDENCE_SUMMARY');

    const manualReview = {
      ...review.records[0],
      disposition: 'PROPOSAL_REVIEW_REQUIRED',
      reasonCode: 'EVIDENCE_NOT_INDEPENDENT',
      evidenceCount: 1,
      evidence: [{ relation: 'SUPPORTS', kind: 'MANUAL_ATTESTATION' }],
    };
    const manualPlan = buildLegacyImportPlan(rebuildSelfConsistentBatch(review, [manualReview as Record<string, unknown>]));
    expect(manualPlan.ok).toBe(true);
    if (manualPlan.ok) expect(manualPlan.value.proposalPlanItems[0].evidence?.[0]).toEqual({ relation: 'SUPPORTS', kind: 'MANUAL_ATTESTATION' });
  });

  it('does not merge equal opaque identities across scopes', () => {
    const otherScope = { ...SCOPE, tenantRef: 'tenant-other-synthetic' };
    const batch = expectAdapterBatch([
      leadRecord({ evidence: sourceEvidence() }, 'shared-legacy-ref'),
      { ...common('LEGACY_LEAD_SCALAR', 'shared-legacy-ref', otherScope), legacyField: 'industry', evidence: sourceEvidence('SUPPORTS', SOURCE_REF, EXCERPT, otherScope.factKey, FACT_VALUE_DIGEST) },
    ]);
    const plan = buildLegacyImportPlan(batch);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.proposalPlanItems).toHaveLength(2);
    expect(new Set(plan.value.proposalPlanItems.map((item) => item.scopeDigest)).size).toBe(2);
  });

  it('is byte-for-byte stable when adapter receipt order changes', () => {
    const batch = expectAdapterBatch([
      leadRecord({ evidence: sourceEvidence() }, 'lead-a'),
      leadRecord({}, 'lead-b'),
      leadRecord({ evidence: sourceEvidence('CONTRADICTS') }, 'lead-c'),
    ]);
    const left = buildLegacyImportPlan(batch);
    const right = buildLegacyImportPlan({ ...batch, records: [...batch.records].reverse() });
    expect(left).toEqual(right);
    expect(JSON.stringify(left)).toBe(JSON.stringify(right));
  });

  it('enforces the 1–500 input boundary and rejects 501', () => {
    const records = Array.from({ length: 500 }, (_, index) => leadRecord({}, `lead-batch-${index}`));
    const batch = expectAdapterBatch(records);
    expect(buildLegacyImportPlan(batch).ok).toBe(true);
    expectFailure(buildLegacyImportPlan({ ...batch, records: [...batch.records, batch.records[0]] }), 'INVALID_BATCH_SIZE');
  });

  it('deep-freezes success and failure output recursively', () => {
    const batch = expectAdapterBatch([leadRecord({}, 'lead-freeze')]);
    const success = buildLegacyImportPlan(batch);
    const failure = buildLegacyImportPlan({ ...batch, records: [] });
    expectDeepFrozen(success);
    expectDeepFrozen(failure);
  });
});
