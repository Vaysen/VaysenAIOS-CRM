import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runOfflineCopilotEvaluation } from './ai-sales-copilot-offline-eval.mjs';

test('offline evaluation is reproducible and keeps OpenClaw as the production adapter', () => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('network access is forbidden in the offline evaluation');
  };
  try {
    const first = runOfflineCopilotEvaluation();
    const second = runOfflineCopilotEvaluation();
    assert.equal(first.summaryHash, second.summaryHash);
    assert.equal(first.fixtureDigest, second.fixtureDigest);
    assert.equal(first.fixtureCases, 24);
    assert.equal(first.fixtureCategories.length, 8);
    assert.equal(first.selectedProductionAdapter, 'OPENCLAW');
    assert.equal(
      first.recommendation,
      'KEEP_OPENCLAW_AS_PRODUCTION_ADAPTER_LANGGRAPH_OFFLINE_ONLY',
    );
    assert.equal(first.architectureScores.OPENCLAW.eligible, true);
    assert.equal(first.architectureScores.LANGGRAPH.eligible, false);
    assert.equal(first.productionAdapterChanged, false);
    assert.deepEqual(first.dependenciesCalled, {
      network: false,
      provider: false,
      database: false,
      productionOpenClawAdapter: false,
    });
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('every Action fixture requires a human interrupt and no case permits outbound work', () => {
  const result = runOfflineCopilotEvaluation();
  const actions = result.cases.filter((item) => item.mode === 'action');
  assert.ok(actions.length >= 3);
  assert.ok(actions.filter((item) => item.expected !== 'RBAC_DENY').every(
    (item) => item.humanInterrupt,
  ));
  assert.ok(result.cases.every((item) => item.outboundPermitted === false));
});

test('evaluation source cannot import network, provider, database, or production adapter modules', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(resolve(here, 'ai-sales-copilot-offline-eval.mjs'), 'utf8');
  for (const forbidden of [
    /from ['"]node:(?:http|https|net|tls|child_process)['"]/,
    /from ['"](?:axios|openai|@prisma\/client)['"]/,
    /openclaw-gateway\.client/,
    /\bfetch\s*\(/,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});
