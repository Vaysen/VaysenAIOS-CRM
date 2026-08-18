/**
 * CRM-02A domain contract.
 *
 * This file is intentionally framework-free. It is the shared vocabulary for
 * the future Opportunity service/API; it does not authorize writes, resolve
 * tenants, or project Lead.status back from an Opportunity.
 */

export const OPPORTUNITY_STAGES = [
  'new',
  'discovery',
  'qualified',
  'proposal',
  'negotiation',
  'won',
  'lost',
] as const;

export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

export const OPPORTUNITY_STAGE_TRANSITIONS: Readonly<
  Record<OpportunityStage, readonly OpportunityStage[]>
> = {
  new: ['discovery', 'lost'],
  discovery: ['qualified', 'lost'],
  qualified: ['proposal', 'lost'],
  proposal: ['negotiation', 'lost'],
  negotiation: ['won', 'lost'],
  won: [],
  lost: [],
};

export const OPPORTUNITY_DEFAULT_PROBABILITY: Readonly<
  Record<OpportunityStage, number>
> = {
  new: 10,
  discovery: 25,
  qualified: 40,
  proposal: 60,
  negotiation: 80,
  won: 100,
  lost: 0,
};

export const OPPORTUNITY_CONTACT_ROLE_TYPES = [
  'decision_maker',
  'buyer',
  'champion',
  'influencer',
  'technical',
  'finance',
  'shipping',
  'other',
] as const;

export type OpportunityContactRoleType =
  (typeof OPPORTUNITY_CONTACT_ROLE_TYPES)[number];

export const OPPORTUNITY_STAGE_HISTORY_SOURCES = [
  'USER',
  'SYSTEM',
  'LEGACY_MIGRATION',
  'COMPATIBILITY',
] as const;

export type OpportunityStageHistorySource =
  (typeof OPPORTUNITY_STAGE_HISTORY_SOURCES)[number];

export type StageTransitionResult =
  | { kind: 'allowed'; fromStage: OpportunityStage; toStage: OpportunityStage }
  | { kind: 'same_stage'; stage: OpportunityStage }
  | { kind: 'invalid_stage'; fromStage: string; toStage: string }
  | { kind: 'terminal_stage'; fromStage: OpportunityStage; toStage: OpportunityStage };

export function isOpportunityStage(value: string): value is OpportunityStage {
  return (OPPORTUNITY_STAGES as readonly string[]).includes(value);
}

export function isOpportunityContactRoleType(
  value: string,
): value is OpportunityContactRoleType {
  return (OPPORTUNITY_CONTACT_ROLE_TYPES as readonly string[]).includes(value);
}

export function isOpportunityStageHistorySource(
  value: string,
): value is OpportunityStageHistorySource {
  return (OPPORTUNITY_STAGE_HISTORY_SOURCES as readonly string[]).includes(value);
}

/**
 * Same-stage updates are not stage transitions and must not append history.
 * Won/lost are terminal and cannot be reopened by this V1 contract.
 */
export function evaluateStageTransition(
  fromStage: string,
  toStage: string,
): StageTransitionResult {
  if (!isOpportunityStage(fromStage) || !isOpportunityStage(toStage)) {
    return { kind: 'invalid_stage', fromStage, toStage };
  }
  if (fromStage === toStage) {
    return { kind: 'same_stage', stage: fromStage };
  }
  if (isOpportunityTerminalStage(fromStage)) {
    return { kind: 'terminal_stage', fromStage, toStage };
  }
  if (OPPORTUNITY_STAGE_TRANSITIONS[fromStage].includes(toStage)) {
    return { kind: 'allowed', fromStage, toStage };
  }
  return { kind: 'invalid_stage', fromStage, toStage };
}

export function isOpportunityTerminalStage(stage: OpportunityStage): boolean {
  return stage === 'won' || stage === 'lost';
}

export function getDefaultOpportunityProbability(stage: OpportunityStage): number {
  return OPPORTUNITY_DEFAULT_PROBABILITY[stage];
}

export type LegacyLeadStatusDecision =
  | {
      kind: 'opportunity';
      legacyStatus: string;
      stage: OpportunityStage;
      defaultProbability: number;
    }
  | {
      kind: 'no_opportunity';
      legacyStatus: string;
      reason: 'prospect_pool' | 'non_transactional_lead_state';
    }
  | {
      kind: 'unknown';
      legacyStatus: string;
      reason: 'unrecognized_legacy_status';
    };

const LEGACY_STATUS_TO_STAGE: Readonly<
  Record<string, OpportunityStage>
> = {
  new: 'new',
  contacted: 'discovery',
  opened: 'discovery',
  clicked: 'discovery',
  replied: 'discovery',
  interested: 'qualified',
  qualified: 'qualified',
  quoted: 'proposal',
  proposal: 'proposal',
  negotiating: 'negotiation',
  negotiation: 'negotiation',
  won: 'won',
  lost: 'lost',
};

const NON_TRANSACTIONAL_LEAD_STATES = new Set([
  'to_review',
  'approved',
  'manual_review',
  'rejected',
  'unqualified',
  'do_not_contact',
]);

/**
 * Fail-closed legacy mapping. `prospect_pool` never creates an Opportunity.
 * Unknown values are returned as an exception decision for a later migration
 * report; they are never silently coerced to `new`.
 */
export function mapLegacyLeadStatus(status: string | null | undefined): LegacyLeadStatusDecision {
  const legacyStatus = String(status ?? '').trim().toLowerCase();
  if (legacyStatus === 'prospect_pool') {
    return { kind: 'no_opportunity', legacyStatus, reason: 'prospect_pool' };
  }
  if (NON_TRANSACTIONAL_LEAD_STATES.has(legacyStatus)) {
    return { kind: 'no_opportunity', legacyStatus, reason: 'non_transactional_lead_state' };
  }
  const stage = LEGACY_STATUS_TO_STAGE[legacyStatus];
  if (!stage) {
    return { kind: 'unknown', legacyStatus, reason: 'unrecognized_legacy_status' };
  }
  return {
    kind: 'opportunity',
    legacyStatus,
    stage,
    defaultProbability: getDefaultOpportunityProbability(stage),
  };
}

export interface InitialOpportunityStageHistoryInput {
  toStage: OpportunityStage;
  amountSnapshot: string | null;
  probabilitySnapshot: number;
  expectedCloseDateSnapshot: Date | null;
  changedBy: string | null;
  changedAt: Date;
  note?: string | null;
  source: OpportunityStageHistorySource;
}

export interface InitialOpportunityStageHistory {
  fromStage: null;
  toStage: OpportunityStage;
  amountSnapshot: string | null;
  probabilitySnapshot: number;
  expectedCloseDateSnapshot: Date | null;
  changedBy: string | null;
  changedAt: Date;
  note: string | null;
  source: OpportunityStageHistorySource;
}

export function buildInitialOpportunityStageHistory(
  input: InitialOpportunityStageHistoryInput,
): InitialOpportunityStageHistory {
  return {
    fromStage: null,
    toStage: input.toStage,
    amountSnapshot: input.amountSnapshot,
    probabilitySnapshot: input.probabilitySnapshot,
    expectedCloseDateSnapshot: input.expectedCloseDateSnapshot,
    changedBy: input.changedBy,
    changedAt: input.changedAt,
    note: input.note ?? null,
    source: input.source,
  };
}
