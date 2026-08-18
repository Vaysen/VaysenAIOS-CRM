#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), '..');
const fixturePath = resolve(
  repoRoot,
  'backend/src/modules/agent/assistant-prompt-regression.ts',
);

export const SCORE_FORMULA = Object.freeze({
  tenantAndOwnerScope: 2,
  humanApprovalForActions: 2,
  outboundFailClosed: 2,
  deterministicQualityGate: 1,
  checkpointRecovery: 1,
  productionAdapterCompatibility: 2,
});

export const SCORE_THRESHOLDS = Object.freeze({
  minimumNormalizedScore: 0.85,
  requireProductionAdapterCompatibility: 1,
  requireTenantAndOwnerScope: 1,
  requireHumanApprovalForActions: 1,
  requireOutboundFailClosed: 1,
});

const ARCHITECTURES = Object.freeze({
  OPENCLAW: Object.freeze({
    tenantAndOwnerScope: 1,
    humanApprovalForActions: 1,
    outboundFailClosed: 1,
    deterministicQualityGate: 1,
    checkpointRecovery: 0,
    productionAdapterCompatibility: 1,
  }),
  LANGGRAPH: Object.freeze({
    tenantAndOwnerScope: 1,
    humanApprovalForActions: 1,
    outboundFailClosed: 1,
    deterministicQualityGate: 1,
    checkpointRecovery: 1,
    productionAdapterCompatibility: 0,
  }),
});

function loadPromptFixture() {
  const source = readFileSync(fixturePath, 'utf8');
  const match = source.match(
    /ASSISTANT_PROMPT_REGRESSION_FIXTURE_JSON\s*=\s*String\.raw`([\s\S]*?)`;/,
  );
  if (!match) throw new Error('assistant prompt regression JSON marker was not found');
  const cases = JSON.parse(match[1]);
  if (!Array.isArray(cases) || cases.length < 24) {
    throw new Error('assistant prompt regression fixture is incomplete');
  }
  return cases;
}

function scoreArchitecture(controls) {
  const totalWeight = Object.values(SCORE_FORMULA).reduce((sum, weight) => sum + weight, 0);
  const weightedPoints = Object.entries(SCORE_FORMULA).reduce(
    (sum, [control, weight]) => sum + controls[control] * weight,
    0,
  );
  const normalizedScore = Number((weightedPoints / totalWeight).toFixed(4));
  const eligible = normalizedScore >= SCORE_THRESHOLDS.minimumNormalizedScore
    && controls.productionAdapterCompatibility
      === SCORE_THRESHOLDS.requireProductionAdapterCompatibility
    && controls.tenantAndOwnerScope === SCORE_THRESHOLDS.requireTenantAndOwnerScope
    && controls.humanApprovalForActions
      === SCORE_THRESHOLDS.requireHumanApprovalForActions
    && controls.outboundFailClosed === SCORE_THRESHOLDS.requireOutboundFailClosed;
  return { controls, weightedPoints, totalWeight, normalizedScore, eligible };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function runOfflineCopilotEvaluation() {
  const cases = loadPromptFixture();
  const architectureScores = Object.fromEntries(
    Object.entries(ARCHITECTURES).map(([name, controls]) => [name, scoreArchitecture(controls)]),
  );
  const eligibleArchitectures = Object.entries(architectureScores)
    .filter(([, score]) => score.eligible)
    .sort((left, right) => right[1].normalizedScore - left[1].normalizedScore);
  const selectedProductionAdapter = eligibleArchitectures[0]?.[0] || 'NONE';
  const recommendation = selectedProductionAdapter === 'OPENCLAW'
    ? 'KEEP_OPENCLAW_AS_PRODUCTION_ADAPTER_LANGGRAPH_OFFLINE_ONLY'
    : 'NO_ELIGIBLE_PRODUCTION_ADAPTER';
  const summary = {
    mode: 'OFFLINE_SIMULATION_ONLY',
    fixturePath: 'backend/src/modules/agent/assistant-prompt-regression.ts',
    fixtureCases: cases.length,
    fixtureCategories: [...new Set(cases.map((item) => item.category))].sort(),
    fixtureDigest: createHash('sha256').update(stableJson(cases)).digest('hex'),
    dependenciesCalled: {
      network: false,
      provider: false,
      database: false,
      productionOpenClawAdapter: false,
    },
    scoreFormula: SCORE_FORMULA,
    thresholds: SCORE_THRESHOLDS,
    architectureScores,
    selectedProductionAdapter,
    recommendation,
    productionAdapterChanged: false,
    cases: cases.map((item) => ({
      id: item.id,
      category: item.category,
      mode: item.mode,
      expected: item.expected,
      outboundPermitted: false,
      humanInterrupt: item.mode === 'action' && item.signals.authorized,
    })),
  };
  return {
    ...summary,
    summaryHash: createHash('sha256').update(stableJson(summary)).digest('hex'),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  process.stdout.write(`${JSON.stringify(runOfflineCopilotEvaluation(), null, 2)}\n`);
}
