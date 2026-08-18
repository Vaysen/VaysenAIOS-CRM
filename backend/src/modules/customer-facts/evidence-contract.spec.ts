import {
  EVIDENCE_KINDS,
  EVIDENCE_RELATIONS,
  MAX_EXCERPT_CODE_POINTS,
  MAX_MANUAL_RAW_INPUT_CODE_POINTS,
  MAX_MANUAL_REASON_CODE_POINTS,
  MIN_EXCERPT_CODE_POINTS,
  MIN_MANUAL_REASON_CODE_POINTS,
  computeExcerptHash,
  computeManualInputDigest,
  computeManualReasonHash,
  validateAndNormalizeEvidence,
  validateEvidenceRelation,
} from './evidence-contract';

const VALIDATION_NOW = '2026-08-04T12:00:00Z';
const SOURCE_INPUT = {
  schemaVersion: 1 as const,
  kind: 'SOURCE_EXCERPT' as const,
  sourceRef: 'HTTPS://Example.COM/research/report#section',
  excerpt: 'Cafe\u0301\r\n  verified line\rthird line  ',
  locator: 'paragraph:3',
  capturedAt: '2026-08-03T11:00:00Z',
  publishedAt: '2026-08-02T10:00:00Z',
};
const MANUAL_RAW_INPUT = 'Owner reviewed the public record on request.\r\nAdditional internal note.';
const MANUAL_INPUT = {
  schemaVersion: 1 as const,
  kind: 'MANUAL_ATTESTATION' as const,
  actorRef: 'internal://actor/user-123',
  reason: 'Owner confirmed the record with procurement context.',
  rawInput: MANUAL_RAW_INPUT,
  inputDigest: 'sha256:manual-input-v1:be66ba651ccad161990204cfe4535a6e03955c9ba41c87d11a3482d4433ef20d',
  capturedAt: '2026-08-03T11:00:00Z',
  locator: 'manual://attestation' as const,
};

function expectError(result: ReturnType<typeof validateAndNormalizeEvidence>, code: string, message: string): void {
  expect(result).toEqual({ ok: false, error: { code, message } });
}

describe('immutable evidence vocabulary', () => {
  it('freezes the two evidence kinds and two relations', () => {
    expect(EVIDENCE_KINDS).toEqual(['SOURCE_EXCERPT', 'MANUAL_ATTESTATION']);
    expect(EVIDENCE_RELATIONS).toEqual(['SUPPORTS', 'CONTRADICTS']);
    expect(Object.isFrozen(EVIDENCE_KINDS)).toBe(true);
    expect(Object.isFrozen(EVIDENCE_RELATIONS)).toBe(true);
  });

  it('validates relation independently from the observation envelope', () => {
    expect(validateEvidenceRelation('SUPPORTS')).toEqual({ ok: true, relation: 'SUPPORTS' });
    expect(validateEvidenceRelation('CONTRADICTS')).toEqual({ ok: true, relation: 'CONTRADICTS' });
    expect(validateEvidenceRelation('PROPOSES')).toEqual({
      ok: false,
      error: { code: 'RELATION_INVALID', message: 'evidence relation is not allowed' },
    });
    expect(validateEvidenceRelation({ relation: 'SUPPORTS' })).toEqual({
      ok: false,
      error: { code: 'RELATION_INVALID', message: 'evidence relation is not allowed' },
    });
  });
});

describe('SOURCE_EXCERPT immutable observation', () => {
  it('normalizes NFC and CRLF/CR while preserving internal whitespace and emits the golden hash', () => {
    expect(validateAndNormalizeEvidence(SOURCE_INPUT, VALIDATION_NOW)).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        kind: 'SOURCE_EXCERPT',
        sourceRef: 'https://example.com/research/report',
        excerpt: 'Café\n  verified line\nthird line',
        excerptHash: 'sha256:source-excerpt-v1:9c79e65177d6f2fce7db470baaaab9d72ee1fe722030521b6967465bacc1921b',
        locator: 'paragraph:3',
        capturedAt: '2026-08-03T11:00:00.000Z',
        publishedAt: '2026-08-02T10:00:00.000Z',
      },
    });
  });

  it('changes the digest when one normalized excerpt character changes', () => {
    expect(computeExcerptHash('same fixture')).toBe('sha256:source-excerpt-v1:198a89c5ea9430cb955ee24381ab281171aa97664c0a841b1f6e204d06b3726b');
    expect(computeExcerptHash('same fixture!')).not.toBe(computeExcerptHash('same fixture'));
    expect(computeExcerptHash('same fixture')).not.toBe(computeManualInputDigest('same fixture'));
    expect(computeManualReasonHash('same fixture')).toBe('sha256:manual-reason-v1:f3b4000a03ce7c908c50a886ca0bae5c3fbb80f2ab56e8e365b2772bb9abcac5');
    expect(computeManualReasonHash('same fixture')).not.toBe(computeExcerptHash('same fixture'));
    expect(computeManualReasonHash('same fixture')).not.toBe(computeManualInputDigest('same fixture'));
  });

  it('accepts 8 and 2000 code points but rejects 2001', () => {
    const atMinimum = { ...SOURCE_INPUT, excerpt: 'a'.repeat(MIN_EXCERPT_CODE_POINTS) };
    const atMaximum = { ...SOURCE_INPUT, excerpt: 'a'.repeat(MAX_EXCERPT_CODE_POINTS) };
    const overMaximum = { ...SOURCE_INPUT, excerpt: 'a'.repeat(MAX_EXCERPT_CODE_POINTS + 1) };
    expect(validateAndNormalizeEvidence(atMinimum, VALIDATION_NOW).ok).toBe(true);
    expect(validateAndNormalizeEvidence(atMaximum, VALIDATION_NOW).ok).toBe(true);
    expectError(validateAndNormalizeEvidence(overMaximum, VALIDATION_NOW), 'EXCERPT_TOO_LONG', 'source excerpt exceeds the maximum length');
  });
});

describe('MANUAL_ATTESTATION immutable observation', () => {
  it('uses a domain-separated input digest and never retains raw input', () => {
    expect(computeManualInputDigest(MANUAL_RAW_INPUT)).toBe('sha256:manual-input-v1:be66ba651ccad161990204cfe4535a6e03955c9ba41c87d11a3482d4433ef20d');
    const result = validateAndNormalizeEvidence(MANUAL_INPUT, VALIDATION_NOW);
    expect(result).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        kind: 'MANUAL_ATTESTATION',
        actorRef: 'internal://actor/user-123',
        reason: 'Owner confirmed the record with procurement context.',
        manualReasonHash: 'sha256:manual-reason-v1:836208aa3129d1b9483f7cc3944900fb821121b5dbc05a4621fe7158a50b9d4b',
        inputDigest: MANUAL_INPUT.inputDigest,
        capturedAt: '2026-08-03T11:00:00.000Z',
        locator: 'manual://attestation',
      },
    });
    expect(JSON.stringify(result)).not.toContain(MANUAL_RAW_INPUT);
    expect(JSON.stringify(result)).not.toContain('rawInput');
    expect(JSON.stringify(result)).not.toContain('companyId');
    expect(JSON.stringify(result)).not.toContain('factId');
    expect(JSON.stringify(result)).not.toContain('proposalId');
    expect(JSON.stringify(result)).not.toContain('relation');
  });

  it('accepts 8 and 500 code points but rejects 501 and vague reasons', () => {
    const atMinimum = { ...MANUAL_INPUT, reason: 'reasonxx' };
    const atMaximum = { ...MANUAL_INPUT, reason: 'r'.repeat(MAX_MANUAL_REASON_CODE_POINTS) };
    const overMaximum = { ...MANUAL_INPUT, reason: 'r'.repeat(MAX_MANUAL_REASON_CODE_POINTS + 1) };
    expect(validateAndNormalizeEvidence(atMinimum, VALIDATION_NOW).ok).toBe(true);
    expect(validateAndNormalizeEvidence(atMaximum, VALIDATION_NOW).ok).toBe(true);
    expectError(validateAndNormalizeEvidence(overMaximum, VALIDATION_NOW), 'MANUAL_REASON_TOO_LONG', 'manual reason exceeds the maximum length');
    expectError(validateAndNormalizeEvidence({ ...MANUAL_INPUT, reason: 'confirmed' }, VALIDATION_NOW), 'MANUAL_REASON_TOO_VAGUE', 'manual reason is too vague');
    expectError(validateAndNormalizeEvidence({ ...MANUAL_INPUT, reason: '12345678' }, VALIDATION_NOW), 'MANUAL_REASON_TOO_VAGUE', 'manual reason is too vague');
  });

  it('binds inputDigest to rawInput and bounds validation-only raw input', () => {
    expect(validateAndNormalizeEvidence(MANUAL_INPUT, VALIDATION_NOW).ok).toBe(true);
    expectError(
      validateAndNormalizeEvidence({ ...MANUAL_INPUT, inputDigest: `sha256:manual-input-v1:${'0'.repeat(64)}` }, VALIDATION_NOW),
      'DIGEST_MISMATCH',
      'manual input digest does not match raw input',
    );
    expectError(
      validateAndNormalizeEvidence({ ...MANUAL_INPUT, rawInput: undefined }, VALIDATION_NOW),
      'TYPE_MISMATCH',
      'evidence field has an invalid type',
    );
    expectError(
      validateAndNormalizeEvidence({ ...MANUAL_INPUT, rawInput: '   \r\n' }, VALIDATION_NOW),
      'RAW_INPUT_EMPTY',
      'manual raw input must not be empty',
    );
    expectError(
      validateAndNormalizeEvidence({ ...MANUAL_INPUT, rawInput: 'x'.repeat(MAX_MANUAL_RAW_INPUT_CODE_POINTS + 1) }, VALIDATION_NOW),
      'RAW_INPUT_TOO_LONG',
      'manual raw input exceeds the maximum length',
    );
  });

  it('requires the fixed manual locator and rejects source excerpt fields', () => {
    expectError(validateAndNormalizeEvidence({ ...MANUAL_INPUT, locator: 'paragraph:1' }, VALIDATION_NOW), 'MANUAL_LOCATOR_INVALID', 'manual attestation locator is invalid');
    expectError(validateAndNormalizeEvidence({ ...MANUAL_INPUT, sourceRef: 'https://example.com' }, VALIDATION_NOW), 'UNKNOWN_ENVELOPE_FIELD', 'evidence envelope contains an unknown field');
    expectError(validateAndNormalizeEvidence({ ...SOURCE_INPUT, actorRef: 'internal://actor/user-123' }, VALIDATION_NOW), 'UNKNOWN_ENVELOPE_FIELD', 'evidence envelope contains an unknown field');
    expectError(validateAndNormalizeEvidence({ ...MANUAL_INPUT, inputDigest: 'sha256:source-excerpt-v1:70e70aca3962b17e1564666af8026b39346f049f3f0f6b02c752b1d04adedba0' }, VALIDATION_NOW), 'INVALID_INPUT_DIGEST', 'manual input digest is invalid');
  });
});

describe('strict references, dates, immutability, and error safety', () => {
  it('accepts safe HTTPS/internal refs and ordinary query keys', () => {
    expect(validateAndNormalizeEvidence({ ...SOURCE_INPUT, sourceRef: 'https://example.com/report?id=1&page=2&monkey=ok&authentic=yes&accessibility=full' }, VALIDATION_NOW).ok).toBe(true);
    expect(validateAndNormalizeEvidence({ ...SOURCE_INPUT, sourceRef: 'internal://report/report-123' }, VALIDATION_NOW).ok).toBe(true);
    expect(validateAndNormalizeEvidence({ ...SOURCE_INPUT, locator: 'selector:#main > p' }, VALIDATION_NOW).ok).toBe(true);
  });

  it.each([
    'http://example.com/report',
    'https://user:password@example.com/report',
    'https://example.com/report?access_token=fixture-secret',
    'file:///C:/private/report.txt',
    'C:\\private\\report.txt',
    'internal://report/../private',
  ])('rejects unsafe sourceRef %s without echoing it', (sourceRef) => {
    const result = validateAndNormalizeEvidence({ ...SOURCE_INPUT, sourceRef }, VALIDATION_NOW);
    expectError(result, 'INVALID_SOURCE_REF', 'sourceRef is not an allowed safe reference');
    expect(JSON.stringify(result)).not.toContain(sourceRef);
  });

  it('rejects invalid source locators and actor references', () => {
    expectError(validateAndNormalizeEvidence({ ...SOURCE_INPUT, locator: 'url:https://example.com' }, VALIDATION_NOW), 'INVALID_LOCATOR', 'locator is not an allowed source locator');
    expectError(validateAndNormalizeEvidence({ ...MANUAL_INPUT, actorRef: 'https://example.com/user' }, VALIDATION_NOW), 'INVALID_ACTOR_REF', 'actorRef is not an allowed internal reference');
  });

  it.each([
    'Contact admin@example.com for details.',
    'See https://example.com/report for details.',
    'Authorization: Bearer fixture-token',
    'authorization=Basic fixture-value',
    'Bearer fixture-token',
    'Cookie: sid=fixture-value',
    'Set-Cookie: sid=fixture-value',
    'token=fixture-value',
    'password=fixture-value',
    'secret=fixture-value',
    'api_key=fixture-value',
    'C:\\Users\\fixture\\report.txt',
    '\\\\server\\share\\report.txt',
    '/home/user/report.txt',
    '/root/report.txt',
    '/Users/test/report.txt',
    '+8613812345678',
  ])('rejects sensitive source excerpt content without echoing %s', (excerpt) => {
    const result = validateAndNormalizeEvidence({ ...SOURCE_INPUT, excerpt }, VALIDATION_NOW);
    expectError(result, 'SENSITIVE_CONTENT_FORBIDDEN', 'sensitive content is not allowed in evidence text');
    expect(JSON.stringify(result)).not.toContain(excerpt);
  });

  it.each([
    'Contact admin@example.com for details.',
    'See https://example.com/report for details.',
    'Authorization: Bearer fixture-token',
    'authorization=Basic fixture-value',
    'Bearer fixture-token',
    'Cookie: sid=fixture-value',
    'Set-Cookie: sid=fixture-value',
    'token=fixture-value',
    'password=fixture-value',
    'secret=fixture-value',
    'api_key=fixture-value',
    'C:\\Users\\fixture\\report.txt',
    '\\\\server\\share\\report.txt',
    '/home/user/report.txt',
    '/root/report.txt',
    '/Users/test/report.txt',
    '+8613812345678',
  ])('rejects sensitive manual reason content without echoing %s', (reason) => {
    const result = validateAndNormalizeEvidence({ ...MANUAL_INPUT, reason }, VALIDATION_NOW);
    expectError(result, 'SENSITIVE_CONTENT_FORBIDDEN', 'sensitive content is not allowed in evidence text');
    expect(JSON.stringify(result)).not.toContain(reason);
  });

  it.each([
    'cookie packaging manufacturer',
    'authorization requirements published',
    'bearer shares disclosure',
  ])('allows ordinary business wording containing credential terms: %s', (text) => {
    expect(validateAndNormalizeEvidence({ ...SOURCE_INPUT, excerpt: text }, VALIDATION_NOW).ok).toBe(true);
    expect(validateAndNormalizeEvidence({ ...MANUAL_INPUT, reason: text }, VALIDATION_NOW).ok).toBe(true);
  });

  it.each([
    'selector:https://example.com/report',
    'selector:Authorization: Bearer fixture-token',
    'selector:authorization=Basic fixture-value',
    'selector:Bearer fixture-token',
    'selector:Cookie: sid=fixture-value',
    'selector:Set-Cookie: sid=fixture-value',
    'selector:token=fixture-value',
    'selector:C:\\Users\\fixture\\report.txt',
    'selector:\\\\server\\share\\report.txt',
    'selector:/home/user/report.txt',
    'selector:+8613812345678',
  ])('rejects sensitive selector locator content without echoing %s', (locator) => {
    const result = validateAndNormalizeEvidence({ ...SOURCE_INPUT, locator }, VALIDATION_NOW);
    expectError(result, 'SENSITIVE_CONTENT_FORBIDDEN', 'sensitive content is not allowed in evidence text');
    expect(JSON.stringify(result)).not.toContain(locator);
  });

  it('enforces validationNow, capturedAt, and publishedAt boundaries', () => {
    expectError(validateAndNormalizeEvidence(SOURCE_INPUT, '2026-08-04T12:00:00+08:00'), 'INVALID_VALIDATION_NOW', 'validationNow is not a valid UTC instant');
    expectError(validateAndNormalizeEvidence({ ...SOURCE_INPUT, capturedAt: '2026-08-04T12:00:00.001Z' }, VALIDATION_NOW), 'CAPTURED_AT_FUTURE', 'capturedAt is later than validationNow');
    expect(validateAndNormalizeEvidence({ ...SOURCE_INPUT, capturedAt: VALIDATION_NOW, publishedAt: VALIDATION_NOW }, VALIDATION_NOW).ok).toBe(true);
    expectError(validateAndNormalizeEvidence({ ...SOURCE_INPUT, publishedAt: '2026-08-03T12:00:01Z' }, VALIDATION_NOW), 'PUBLISHED_AT_AFTER_CAPTURE', 'publishedAt is later than capturedAt');
    expectError(validateAndNormalizeEvidence({ ...SOURCE_INPUT, capturedAt: '2026-02-30T11:00:00Z' }, VALIDATION_NOW), 'INVALID_DATE', 'date is not a valid UTC instant');
  });

  it('deep-freezes the observation and returns JSON-safe output', () => {
    const result = validateAndNormalizeEvidence(SOURCE_INPUT, VALIDATION_NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(() => ((result.value as { excerpt: string }).excerpt = 'mutated')).toThrow(TypeError);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('keeps errors stable and free of raw refs, excerpts, and digests', () => {
    const sourceRef = 'https://user:password@example.com/report?token=fixture-secret';
    const result = validateAndNormalizeEvidence({ ...SOURCE_INPUT, sourceRef, excerpt: 'short' }, VALIDATION_NOW);
    expectError(result, 'INVALID_SOURCE_REF', 'sourceRef is not an allowed safe reference');
    expect(JSON.stringify(result)).not.toContain(sourceRef);
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
  });
});
