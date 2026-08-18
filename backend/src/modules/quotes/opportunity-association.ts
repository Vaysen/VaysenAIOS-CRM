import { BadRequestException, NotFoundException } from '@nestjs/common';
import { hasFullAccess } from '../../common/utils/data-isolation';

export type OpportunityAssociationRecord = {
  id: string;
  companyId: string;
  ownerUserId: string | null;
  leadId: string;
};

export type OpportunitySummaryResponse = {
  id: string;
  name: string;
  stage: string;
  amount: string | null;
  currency: string;
  probability: number;
  version: number;
};

export type OpportunityAssociationRef = {
  opportunityId: string | null | undefined;
  leadId: string | null | undefined;
};

export function opportunitySummaryKey(
  opportunityId: string | null | undefined,
  leadId: string | null | undefined,
): string {
  return `${opportunityId || ''}\u0000${leadId || ''}`;
}

function opportunityOwnerWhere(currentUser: any, companyId: string) {
  return hasFullAccess(currentUser, companyId)
    ? {}
    : { ownerUserId: currentUser.id };
}

export async function findAccessibleOpportunity(
  db: any,
  opportunityId: string,
  currentUser: any,
  companyId: string,
): Promise<OpportunityAssociationRecord> {
  const opportunity = await db.opportunity.findFirst({
    where: {
      id: opportunityId,
      companyId,
      deletedAt: null,
      ...opportunityOwnerWhere(currentUser, companyId),
    },
    select: { id: true, companyId: true, ownerUserId: true, leadId: true },
  });
  if (!opportunity) throw new NotFoundException('Opportunity not found');
  return opportunity as OpportunityAssociationRecord;
}

export function assertOpportunityLead(
  opportunity: OpportunityAssociationRecord,
  leadId: string | null | undefined,
) {
  if (leadId !== undefined && leadId !== null && opportunity.leadId !== leadId) {
    throw new BadRequestException(
      'Opportunity and lead must reference the same active-tenant customer',
    );
  }
}

export function opportunitySummaryFromRecord(
  opportunity: any,
): OpportunitySummaryResponse | null {
  if (!opportunity || opportunity.deletedAt) return null;
  return {
    id: opportunity.id,
    name: opportunity.name,
    stage: opportunity.stage,
    amount: opportunity.amount === null || opportunity.amount === undefined
      ? null
      : String(opportunity.amount),
    currency: opportunity.currency,
    probability: opportunity.probability,
    version: opportunity.version,
  };
}

export async function findAccessibleOpportunitySummaries(
  db: any,
  associations: OpportunityAssociationRef[],
  currentUser: any,
  companyId: string,
): Promise<Map<string, OpportunitySummaryResponse>> {
  const refs = associations.filter((association) => Boolean(association.opportunityId));
  const ids = [...new Set(refs.map((association) => association.opportunityId).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0 || !db.opportunity?.findMany) return new Map();
  const opportunities = await db.opportunity.findMany({
    where: {
      id: { in: ids },
      companyId,
      deletedAt: null,
      ...opportunityOwnerWhere(currentUser, companyId),
    },
    select: {
      id: true,
      leadId: true,
      name: true,
      stage: true,
      amount: true,
      currency: true,
      probability: true,
      version: true,
      deletedAt: true,
    },
  });
  const opportunityById = new Map<string, any>(
    opportunities.map((opportunity: any) => [opportunity.id, opportunity]),
  );
  const result = new Map<string, OpportunitySummaryResponse>();
  for (const association of refs) {
    if (!association.opportunityId) continue;
    const record = opportunityById.get(association.opportunityId);
    if (!record || record.leadId !== association.leadId) continue;
    const summary = opportunitySummaryFromRecord(record);
    if (summary) result.set(
      opportunitySummaryKey(association.opportunityId, association.leadId),
      summary,
    );
  }
  return result;
}
