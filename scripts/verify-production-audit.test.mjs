import assert from 'node:assert/strict';
import test from 'node:test';
import { auditInvocation, evaluateAudit } from './verify-production-audit.mjs';

const report = {
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 2, critical: 0, total: 2 },
  },
  vulnerabilities: {
    parent: { severity: 'high', via: ['leaf'] },
    leaf: {
      severity: 'high',
      via: [
        {
          dependency: 'leaf',
          severity: 'high',
          source: 123,
          url: 'https://github.com/advisories/GHSA-test-test-test',
          title: 'test advisory',
        },
      ],
    },
  },
};

const validException = {
  scope: 'root',
  package: 'leaf',
  advisory: 'GHSA-test-test-test',
  reason: 'A sufficiently detailed and reviewable temporary exception reason.',
  owner: 'team:vaysen-security',
  expiresAt: '2026-08-31',
};

test('accepts an exact unexpired advisory exception', () => {
  const result = evaluateAudit({
    report,
    exceptionFile: { version: 1, exceptions: [validException] },
    scope: 'root',
    today: new Date('2026-07-28T00:00:00Z'),
  });
  assert.equal(result.approved, 1);
  assert.deepEqual(result.unapproved, []);
  assert.deepEqual(result.unused, []);
});

test('fails closed for a new advisory', () => {
  const result = evaluateAudit({
    report,
    exceptionFile: { version: 1, exceptions: [] },
    scope: 'root',
    today: new Date('2026-07-28T00:00:00Z'),
  });
  assert.equal(result.unapproved.length, 1);
});

test('rejects expired and duplicate exceptions', () => {
  for (const expiresAt of ['2026-07-27', '2026-07-28']) {
    assert.throws(
      () =>
        evaluateAudit({
          report,
          exceptionFile: {
            version: 1,
            exceptions: [{ ...validException, expiresAt }],
          },
          scope: 'root',
          today: new Date('2026-07-28T00:00:00Z'),
        }),
      /Expired audit exception/,
    );
  }
  assert.throws(
    () =>
      evaluateAudit({
        report,
        exceptionFile: { version: 1, exceptions: [validException, validException] },
        scope: 'root',
        today: new Date('2026-07-28T00:00:00Z'),
      }),
    /Duplicate audit exception/,
  );
});

test('rejects an unknown exception scope instead of silently ignoring it', () => {
  assert.throws(
    () =>
      evaluateAudit({
        report,
        exceptionFile: {
          version: 1,
          exceptions: [{ ...validException, scope: 'voice-agent' }],
        },
        scope: 'root',
        today: new Date('2026-07-28T00:00:00Z'),
      }),
    /Invalid audit exception scope/,
  );
});

test('rejects impossible, permanent, and non-allowlisted exceptions', () => {
  for (const [override, pattern] of [
    [{ expiresAt: '2026-99-99' }, /Invalid expiry/],
    [{ expiresAt: '9999-12-31' }, /too far in the future/],
    [{ owner: 'security maintainer' }, /owner is not allowlisted/],
    [{ owner: 'team:unowned-security-role' }, /owner is not allowlisted/],
  ]) {
    assert.throws(
      () =>
        evaluateAudit({
          report,
          exceptionFile: { version: 1, exceptions: [{ ...validException, ...override }] },
          scope: 'root',
          today: new Date('2026-07-28T00:00:00Z'),
        }),
      pattern,
    );
  }
});

test('audits every scope from its independent production lock context', () => {
  for (const [scope, suffix] of [
    ['root', 'vaysen-ai-crm'],
    ['backend', 'backend'],
    ['frontend', 'frontend'],
    ['electron', 'electron'],
    ['openclaw', 'vaysen-crm'],
  ]) {
    const invocation = auditInvocation(scope);
    assert.equal(invocation.cwd.endsWith(suffix), true);
    assert.deepEqual(invocation.args, ['--workspaces=false', 'audit', '--omit=dev', '--json']);
    assert.equal(invocation.args.includes('--workspace'), false);
  }
});

test('rejects audit error JSON and incomplete report structures', () => {
  for (const invalidReport of [
    { error: { code: 'ENETUNREACH', summary: 'registry unavailable' } },
    {},
    { vulnerabilities: {} },
    { vulnerabilities: {}, metadata: { vulnerabilities: { high: '0' } } },
  ]) {
    assert.throws(
      () =>
        evaluateAudit({
          report: invalidReport,
          exceptionFile: { version: 1, exceptions: [] },
          scope: 'root',
          today: new Date('2026-07-28T00:00:00Z'),
        }),
      /npm audit report/,
    );
  }
});
