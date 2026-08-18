import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  OPPORTUNITY_CONTACT_ROLE_TYPES,
  OPPORTUNITY_DEFAULT_PROBABILITY,
  OPPORTUNITY_STAGE_HISTORY_SOURCES,
  OPPORTUNITY_STAGES,
  buildInitialOpportunityStageHistory,
  evaluateStageTransition,
  mapLegacyLeadStatus,
} from './opportunity-policy';

const backendRoot = resolve(__dirname, '../../../');
const schema = readFileSync(resolve(backendRoot, 'prisma/schema.prisma'), 'utf8');
const migration = readFileSync(
  resolve(
    backendRoot,
    'prisma/migrations/20260803130000_add_opportunity_foundation/migration.sql',
  ),
  'utf8',
);

describe('CRM-02A Opportunity foundation contract', () => {
  it('freezes stages, probabilities, role vocabulary, and terminal policy', () => {
    expect(OPPORTUNITY_STAGES).toEqual([
      'new',
      'discovery',
      'qualified',
      'proposal',
      'negotiation',
      'won',
      'lost',
    ]);
    expect(OPPORTUNITY_DEFAULT_PROBABILITY).toEqual({
      new: 10,
      discovery: 25,
      qualified: 40,
      proposal: 60,
      negotiation: 80,
      won: 100,
      lost: 0,
    });
    expect(OPPORTUNITY_CONTACT_ROLE_TYPES).toEqual([
      'decision_maker',
      'buyer',
      'champion',
      'influencer',
      'technical',
      'finance',
      'shipping',
      'other',
    ]);
    expect(OPPORTUNITY_STAGE_HISTORY_SOURCES).toEqual([
      'USER',
      'SYSTEM',
      'LEGACY_MIGRATION',
      'COMPATIBILITY',
    ]);
  });

  it('allows only forward transitions plus loss and forbids self-loop/reopen', () => {
    expect(evaluateStageTransition('new', 'discovery')).toEqual({
      kind: 'allowed',
      fromStage: 'new',
      toStage: 'discovery',
    });
    expect(evaluateStageTransition('negotiation', 'won')).toEqual({
      kind: 'allowed',
      fromStage: 'negotiation',
      toStage: 'won',
    });
    expect(evaluateStageTransition('proposal', 'lost')).toEqual({
      kind: 'allowed',
      fromStage: 'proposal',
      toStage: 'lost',
    });
    expect(evaluateStageTransition('qualified', 'qualified')).toEqual({
      kind: 'same_stage',
      stage: 'qualified',
    });
    expect(evaluateStageTransition('won', 'negotiation')).toEqual({
      kind: 'terminal_stage',
      fromStage: 'won',
      toStage: 'negotiation',
    });
    expect(evaluateStageTransition('proposal', 'new').kind).toBe('invalid_stage');
    expect(evaluateStageTransition('invalid', 'new').kind).toBe('invalid_stage');
  });

  it('maps legacy Lead.status fail-closed and never maps prospect_pool to an opportunity', () => {
    expect(mapLegacyLeadStatus('prospect_pool')).toEqual({
      kind: 'no_opportunity',
      legacyStatus: 'prospect_pool',
      reason: 'prospect_pool',
    });
    expect(mapLegacyLeadStatus('contacted')).toMatchObject({
      kind: 'opportunity',
      stage: 'discovery',
      defaultProbability: 25,
    });
    expect(mapLegacyLeadStatus('quoted')).toMatchObject({
      kind: 'opportunity',
      stage: 'proposal',
      defaultProbability: 60,
    });
    expect(mapLegacyLeadStatus('negotiating')).toMatchObject({
      kind: 'opportunity',
      stage: 'negotiation',
      defaultProbability: 80,
    });
    expect(mapLegacyLeadStatus('approved').kind).toBe('no_opportunity');
    expect(mapLegacyLeadStatus('never_seen_before').kind).toBe('unknown');
  });

  it('defines an initial append-only history row with a null fromStage', () => {
    const changedAt = new Date('2026-08-03T12:00:00.000Z');
    expect(buildInitialOpportunityStageHistory({
      toStage: 'new',
      amountSnapshot: null,
      probabilitySnapshot: 10,
      expectedCloseDateSnapshot: null,
      changedBy: null,
      changedAt,
      source: 'LEGACY_MIGRATION',
    })).toEqual({
      fromStage: null,
      toStage: 'new',
      amountSnapshot: null,
      probabilitySnapshot: 10,
      expectedCloseDateSnapshot: null,
      changedBy: null,
      changedAt,
      note: null,
      source: 'LEGACY_MIGRATION',
    });
  });

  it('contains the additive schema and migration contract without backfill or Lead.status changes', () => {
    expect(schema).toMatch(/model Opportunity \{/);
    expect(schema).toMatch(/model OpportunityStageHistory \{/);
    expect(schema).toMatch(/model OpportunityContactRole \{/);
    expect(schema).toMatch(/amount\s+Decimal\?\s+@db\.Decimal\(14, 2\)/);
    expect(schema).toMatch(/probability\s+Int\s+@default\(10\)/);
    expect(schema).toMatch(/currency\s+String\s+@default\("USD"\)/);
    expect(schema).toMatch(/legacySeedKey\s+String\?/);
    expect(schema).toMatch(/@@unique\(\[companyId, legacySeedKey\]\)/);
    expect(schema).toMatch(/@@unique\(\[opportunityId, contactId\]\)/);
    expect(schema).toMatch(/PostgreSQL migration enforces at most one true primary per opportunity/);
    expect(schema).toMatch(/opportunityId\s+String\?/);
    expect(schema).toMatch(/opportunity\s+Opportunity\?/);

    expect(migration).toMatch(/CREATE TABLE "Opportunity"/);
    expect(migration).toMatch(/CREATE TABLE "OpportunityStageHistory"/);
    expect(migration).toMatch(/CREATE TABLE "OpportunityContactRole"/);
    expect(migration).toMatch(/ALTER TABLE "Quote" ADD COLUMN "opportunityId" TEXT/);
    expect(migration).toMatch(/ALTER TABLE "Order" ADD COLUMN "opportunityId" TEXT/);
    expect(migration).toMatch(/"probability" INTEGER NOT NULL DEFAULT 10/);
    expect(migration).toMatch(/CHECK \("currency" ~ '\^\[A-Z\]\{3\}\$'\)/);
    expect(migration).toMatch(/Opportunity_companyId_legacySeedKey_key/);
    expect(migration).not.toMatch(/Opportunity_legacySeedKey_key/);
    expect(migration).toMatch(/OpportunityContactRole_one_primary_per_opportunity_key/);
    expect(migration).toMatch(/ON "OpportunityContactRole"\("opportunityId"\)\s+WHERE "isPrimary" = true/s);
    expect(migration).toMatch(/CHECK \("probability" BETWEEN 0 AND 100\)/);
    expect(migration).toMatch(/OpportunityContactRole_opportunityId_contactId_key/);
    expect(migration).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|DROP)\b/im);
    expect(migration).not.toMatch(/ALTER TABLE "Lead"/);
    expect(migration).not.toMatch(/ALTER COLUMN/);
  });
});
