import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  CurrentUser,
  hasFullAccess,
  requireActiveCompany,
} from '../../common/utils/data-isolation';
import { safeLogEvent } from '../../common/security/safe-logging';
import {
  OPPORTUNITY_CONTACT_ROLE_TYPES,
  OPPORTUNITY_DEFAULT_PROBABILITY,
  evaluateStageTransition,
  getDefaultOpportunityProbability,
  isOpportunityContactRoleType,
  isOpportunityStage,
  type OpportunityStage,
} from './opportunity-policy';
import { CreateOpportunityDto } from './dto/create-opportunity.dto';
import { ListOpportunitiesDto } from './dto/list-opportunities.dto';
import { UpdateOpportunityDto } from './dto/update-opportunity.dto';
import { TransitionOpportunityDto } from './dto/transition-opportunity.dto';
import {
  CreateOpportunityContactRoleDto,
  UpdateOpportunityContactRoleDto,
} from './dto/opportunity-contact-role.dto';

const OPPORTUNITY_SELECT = {
  id: true,
  companyId: true,
  leadId: true,
  ownerUserId: true,
  name: true,
  description: true,
  stage: true,
  amount: true,
  currency: true,
  probability: true,
  expectedCloseDate: true,
  nextStep: true,
  wonAt: true,
  lostAt: true,
  lostReason: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

const HISTORY_SELECT = {
  id: true,
  fromStage: true,
  toStage: true,
  changedAt: true,
  note: true,
  amountSnapshot: true,
  probabilitySnapshot: true,
  expectedCloseDateSnapshot: true,
  source: true,
} as const;

const CONTACT_ROLE_SELECT = {
  id: true,
  contactId: true,
  roleType: true,
  isPrimary: true,
  createdAt: true,
} as const;

export interface OpportunityResponse {
  id: string;
  leadId: string;
  name: string;
  description: string | null;
  stage: string;
  amount: string | null;
  currency: string;
  probability: number;
  expectedCloseDate: string | null;
  nextStep: string | null;
  wonAt: string | null;
  lostAt: string | null;
  lostReason: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  lead: OpportunityLeadSummaryResponse | null;
  owner: OpportunityOwnerSummaryResponse | null;
}

export interface OpportunityLeadSummaryResponse {
  id: string;
  companyName: string | null;
  contactName: string | null;
  country: string | null;
}

export interface OpportunityOwnerSummaryResponse {
  id: string;
  displayName: string;
}

type OpportunityDisplaySummary = {
  lead: OpportunityLeadSummaryResponse | null;
  owner: OpportunityOwnerSummaryResponse | null;
};

export interface OpportunityHistoryResponse {
  id: string;
  fromStage: string | null;
  toStage: string;
  changedAt: string;
  note: string | null;
  amountSnapshot: string | null;
  probabilitySnapshot: number | null;
  expectedCloseDateSnapshot: string | null;
  source: string;
}

export interface OpportunityContactRoleResponse {
  id: string;
  contactId: string;
  roleType: string;
  isPrimary: boolean;
  createdAt: string;
  contact: OpportunityContactSummaryResponse | null;
}

export interface OpportunityContactSummaryResponse {
  id: string;
  displayName: string;
  title: string | null;
  isPrimary: boolean;
}

type DbClient = any;

function decimalToJson(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function dateToJson(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function isUniqueConflict(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'P2002';
}

function isSerializableConflict(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'P2034';
}

export function toOpportunityResponse(
  record: any,
  display: OpportunityDisplaySummary = { lead: null, owner: null },
): OpportunityResponse {
  return {
    id: record.id,
    leadId: record.leadId,
    name: record.name,
    description: record.description ?? null,
    stage: record.stage,
    amount: decimalToJson(record.amount),
    currency: record.currency,
    probability: record.probability,
    expectedCloseDate: dateToJson(record.expectedCloseDate),
    nextStep: record.nextStep ?? null,
    wonAt: dateToJson(record.wonAt),
    lostAt: dateToJson(record.lostAt),
    lostReason: record.lostReason ?? null,
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    lead: display.lead,
    owner: display.owner,
  };
}

function toHistoryResponse(record: any): OpportunityHistoryResponse {
  return {
    id: record.id,
    fromStage: record.fromStage ?? null,
    toStage: record.toStage,
    changedAt: record.changedAt.toISOString(),
    note: record.note ?? null,
    amountSnapshot: decimalToJson(record.amountSnapshot),
    probabilitySnapshot: record.probabilitySnapshot ?? null,
    expectedCloseDateSnapshot: dateToJson(record.expectedCloseDateSnapshot),
    source: record.source,
  };
}

function toContactRoleResponse(
  record: any,
  contact: OpportunityContactSummaryResponse | null = null,
): OpportunityContactRoleResponse {
  return {
    id: record.id,
    contactId: record.contactId,
    roleType: record.roleType,
    isPrimary: record.isPrimary,
    createdAt: record.createdAt.toISOString(),
    contact,
  };
}

@Injectable()
export class OpportunitiesService {
  private readonly logger = new Logger(OpportunitiesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAll(currentUser: CurrentUser, query: ListOpportunitiesDto = new ListOpportunitiesDto()) {
    const companyId = requireActiveCompany(currentUser).id;
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const where = this.opportunityWhere(currentUser, companyId, {
      stage: query.stage,
      leadId: query.leadId,
      ownerUserId: query.ownerUserId,
      search: query.search,
    });

    const [records, total] = await Promise.all([
      this.prisma.opportunity.findMany({
        where,
        select: OPPORTUNITY_SELECT,
        orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.opportunity.count({ where }),
    ]);

    return {
      data: (await this.loadDisplaySummaries(this.prisma, records, companyId)).map((display, index) =>
        toOpportunityResponse(records[index], display)),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string, currentUser: CurrentUser) {
    const companyId = requireActiveCompany(currentUser).id;
    const record = await this.findAccessibleOpportunity(
      this.prisma,
      id,
      currentUser,
      companyId,
    );
    const [display] = await this.loadDisplaySummaries(this.prisma, [record], companyId);
    return toOpportunityResponse(record, display);
  }

  async create(dto: CreateOpportunityDto, currentUser: CurrentUser) {
    const companyId = requireActiveCompany(currentUser).id;
    this.assertWritable(currentUser);
    const stage = dto.stage || 'new';
    if (!isOpportunityStage(stage)) {
      throw new BadRequestException('Invalid opportunity stage');
    }

    const probability = this.validateProbability(
      dto.probability ?? getDefaultOpportunityProbability(stage),
    );
    const amount = this.normalizeAmount(dto.amount);
    const expectedCloseDate = this.parseDate(dto.expectedCloseDate, 'expectedCloseDate');
    const name = String(dto.name || '').trim();
    if (!name) throw new BadRequestException('Opportunity name is required');
    const lostReason = dto.lostReason?.trim() || null;
    if (stage === 'lost' && !lostReason) {
      throw new BadRequestException('lostReason is required for lost opportunities');
    }
    if (stage !== 'lost' && dto.lostReason !== undefined && dto.lostReason !== null) {
      throw new BadRequestException('lostReason is only valid for lost opportunities');
    }
    const terminalAt = stage === 'won' || stage === 'lost' ? new Date() : null;

    const ownerUserId = dto.ownerUserId || currentUser.id;
    this.assertOwnerAssignment(currentUser, companyId, ownerUserId);

    return this.safeOperation(async () => {
      const created = await this.runSerializable(async (tx: DbClient) => {
        await this.assertLeadAccess(tx, currentUser, companyId, dto.leadId);
        await this.assertOwnerMembership(tx, companyId, ownerUserId);

        const opportunity = await tx.opportunity.create({
          data: {
            companyId,
            leadId: dto.leadId,
            ownerUserId,
            name,
            description: dto.description?.trim() || null,
            stage,
            amount,
            currency: this.normalizeCurrency(dto.currency),
            probability,
            expectedCloseDate,
            nextStep: dto.nextStep?.trim() || null,
            wonAt: stage === 'won' ? terminalAt : null,
            lostAt: stage === 'lost' ? terminalAt : null,
            lostReason: stage === 'lost' ? lostReason : null,
          },
          select: OPPORTUNITY_SELECT,
        });

        await tx.opportunityStageHistory.create({
          data: {
            companyId,
            opportunityId: opportunity.id,
            fromStage: null,
            toStage: stage,
            changedBy: currentUser.id,
            amountSnapshot: opportunity.amount,
            probabilitySnapshot: opportunity.probability,
            expectedCloseDateSnapshot: opportunity.expectedCloseDate,
            source: 'USER',
          },
        });

        return opportunity;
      });

      this.logOperation('created', stage, 'success');
      const [display] = await this.loadDisplaySummaries(this.prisma, [created], companyId);
      return toOpportunityResponse(created, display);
    });
  }

  async update(id: string, dto: UpdateOpportunityDto, currentUser: CurrentUser) {
    const companyId = requireActiveCompany(currentUser).id;
    this.assertWritable(currentUser);

    return this.safeOperation(async () => {
      const updated = await this.runSerializable(async (tx: DbClient) => {
        const existing = await this.findAccessibleOpportunity(tx, id, currentUser, companyId);
        const expectedVersion = dto.version ?? existing.version;
        if (expectedVersion !== existing.version) {
          throw new ConflictException('Opportunity version conflict');
        }

        if (dto.ownerUserId !== undefined) {
          this.assertOwnerAssignment(currentUser, companyId, dto.ownerUserId);
          await this.assertOwnerMembership(tx, companyId, dto.ownerUserId);
        }

        const data: Record<string, unknown> = {};
        if (dto.name !== undefined) {
          const name = dto.name.trim();
          if (!name) throw new BadRequestException('Opportunity name is required');
          data.name = name;
        }
        if (dto.description !== undefined) data.description = dto.description?.trim() || null;
        if (dto.amount !== undefined) data.amount = this.normalizeAmount(dto.amount);
        if (dto.currency !== undefined) data.currency = this.normalizeCurrency(dto.currency);
        if (dto.probability !== undefined) data.probability = this.validateProbability(dto.probability);
        if (dto.expectedCloseDate !== undefined) {
          data.expectedCloseDate = this.parseDate(dto.expectedCloseDate, 'expectedCloseDate');
        }
        if (dto.nextStep !== undefined) data.nextStep = dto.nextStep?.trim() || null;
        if (dto.ownerUserId !== undefined) data.ownerUserId = dto.ownerUserId;

        if (Object.keys(data).length === 0) return existing;

        const result = await tx.opportunity.updateMany({
          where: {
            id,
            companyId,
            deletedAt: null,
            version: expectedVersion,
            ...this.ownerWhere(currentUser, companyId),
          },
          data: { ...data, version: { increment: 1 } },
        });
        if (result.count !== 1) throw new ConflictException('Opportunity version conflict');
        return this.findAccessibleOpportunity(tx, id, currentUser, companyId);
      });

      this.logOperation('updated', updated.stage, 'success');
      const [display] = await this.loadDisplaySummaries(this.prisma, [updated], companyId);
      return toOpportunityResponse(updated, display);
    });
  }

  async remove(id: string, currentUser: CurrentUser) {
    const companyId = requireActiveCompany(currentUser).id;
    this.assertWritable(currentUser);

    return this.safeOperation(async () => {
      const deletedStage = await this.runSerializable(async (tx: DbClient) => {
        const existing = await this.findAccessibleOpportunity(tx, id, currentUser, companyId);
        const result = await tx.opportunity.updateMany({
          where: {
            id,
            companyId,
            deletedAt: null,
            version: existing.version,
            ...this.ownerWhere(currentUser, companyId),
          },
          data: { deletedAt: new Date(), version: { increment: 1 } },
        });
        if (result.count !== 1) throw new ConflictException('Opportunity version conflict');
        return existing.stage;
      });
      this.logOperation('deleted', deletedStage, 'success');
      return { deleted: true };
    });
  }

  async transition(id: string, dto: TransitionOpportunityDto, currentUser: CurrentUser) {
    const companyId = requireActiveCompany(currentUser).id;
    this.assertWritable(currentUser);

    return this.safeOperation(async () => {
      const updated = await this.runSerializable(async (tx: DbClient) => {
        const existing = await this.findAccessibleOpportunity(tx, id, currentUser, companyId);
        if (dto.version !== existing.version) {
          throw new ConflictException('Opportunity version conflict');
        }
        const decision = evaluateStageTransition(existing.stage, dto.stage);
        if (decision.kind === 'invalid_stage') {
          throw new BadRequestException('Invalid opportunity stage transition');
        }
        if (decision.kind === 'terminal_stage') {
          throw new ConflictException('Terminal opportunity cannot be reopened');
        }
        if (decision.kind === 'same_stage') return existing;

        const lostReason = dto.lostReason?.trim() || null;
        if (dto.stage === 'lost' && !lostReason) {
          throw new BadRequestException('lostReason is required for lost opportunities');
        }
        if (dto.stage !== 'lost' && lostReason) {
          throw new BadRequestException('lostReason is only valid for lost opportunities');
        }

        const now = new Date();
        const probability = this.validateProbability(
          dto.probability ?? getDefaultOpportunityProbability(dto.stage as OpportunityStage),
        );
        const result = await tx.opportunity.updateMany({
          where: {
            id,
            companyId,
            deletedAt: null,
            version: dto.version,
            ...this.ownerWhere(currentUser, companyId),
          },
          data: {
            stage: dto.stage,
            probability,
            wonAt: dto.stage === 'won' ? now : null,
            lostAt: dto.stage === 'lost' ? now : null,
            lostReason: dto.stage === 'lost' ? lostReason : null,
            version: { increment: 1 },
          },
        });
        if (result.count !== 1) throw new ConflictException('Opportunity version conflict');

        await tx.opportunityStageHistory.create({
          data: {
            companyId,
            opportunityId: id,
            fromStage: existing.stage,
            toStage: dto.stage,
            changedBy: currentUser.id,
            changedAt: now,
            note: dto.note?.trim() || null,
            amountSnapshot: existing.amount,
            probabilitySnapshot: probability,
            expectedCloseDateSnapshot: existing.expectedCloseDate,
            source: 'USER',
          },
        });

        return this.findAccessibleOpportunity(tx, id, currentUser, companyId);
      });

      this.logOperation('stage_transition', updated.stage, 'success');
      const [display] = await this.loadDisplaySummaries(this.prisma, [updated], companyId);
      return toOpportunityResponse(updated, display);
    });
  }

  async getHistory(id: string, currentUser: CurrentUser) {
    const companyId = requireActiveCompany(currentUser).id;
    await this.findAccessibleOpportunity(this.prisma, id, currentUser, companyId);
    const records = await this.prisma.opportunityStageHistory.findMany({
      where: { opportunityId: id, companyId },
      select: HISTORY_SELECT,
      orderBy: { changedAt: 'asc' },
    });
    return { data: records.map(toHistoryResponse) };
  }

  async listContactRoles(id: string, currentUser: CurrentUser) {
    const companyId = requireActiveCompany(currentUser).id;
    const opportunity = await this.findAccessibleOpportunity(this.prisma, id, currentUser, companyId);
    const records = await this.prisma.opportunityContactRole.findMany({
      where: { opportunityId: id, companyId },
      select: CONTACT_ROLE_SELECT,
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
    const contacts = await this.loadContactSummaries(this.prisma, records, companyId, opportunity.leadId);
    return { data: records.map((record: any) => toContactRoleResponse(record, contacts.get(record.contactId) || null)) };
  }

  async addContactRole(
    opportunityId: string,
    dto: CreateOpportunityContactRoleDto,
    currentUser: CurrentUser,
  ) {
    const companyId = requireActiveCompany(currentUser).id;
    this.assertWritable(currentUser);
    this.assertRoleType(dto.roleType);

    return this.safeOperation(async () => {
      let opportunityLeadId = '';
      const role = await this.runSerializable(async (tx: DbClient) => {
        const opportunity = await this.findAccessibleOpportunity(tx, opportunityId, currentUser, companyId);
        opportunityLeadId = opportunity.leadId;
        await this.assertContactAccess(tx, companyId, opportunity.leadId, dto.contactId);
        if (dto.isPrimary) await this.clearPrimary(tx, opportunityId);
        return tx.opportunityContactRole.create({
          data: {
            companyId,
            opportunityId,
            contactId: dto.contactId,
            roleType: dto.roleType,
            isPrimary: dto.isPrimary ?? false,
            createdBy: currentUser.id,
          },
          select: CONTACT_ROLE_SELECT,
        });
      });
      this.logOperation('contact_role_add', 'projection', 'success');
      const contacts = await this.loadContactSummaries(this.prisma, [role], companyId, opportunityLeadId);
      return toContactRoleResponse(role, contacts.get(role.contactId) || null);
    });
  }

  async updateContactRole(
    opportunityId: string,
    roleId: string,
    dto: UpdateOpportunityContactRoleDto,
    currentUser: CurrentUser,
  ) {
    const companyId = requireActiveCompany(currentUser).id;
    this.assertWritable(currentUser);
    if (dto.roleType !== undefined) this.assertRoleType(dto.roleType);

    return this.safeOperation(async () => {
      let opportunityLeadId = '';
      const role = await this.runSerializable(async (tx: DbClient) => {
        const opportunity = await this.findAccessibleOpportunity(tx, opportunityId, currentUser, companyId);
        opportunityLeadId = opportunity.leadId;
        const existing = await tx.opportunityContactRole.findFirst({
          where: { id: roleId, opportunityId, companyId },
          select: { ...CONTACT_ROLE_SELECT, roleType: true },
        });
        if (!existing) throw new NotFoundException('Opportunity contact role not found');

        const contactId = dto.contactId ?? existing.contactId;
        await this.assertContactAccess(tx, companyId, opportunity.leadId, contactId);
        const isPrimary = dto.isPrimary ?? existing.isPrimary;
        if (isPrimary) await this.clearPrimary(tx, opportunityId, roleId);

        return tx.opportunityContactRole.update({
          where: { id: roleId },
          data: {
            contactId,
            roleType: dto.roleType ?? existing.roleType,
            isPrimary,
          },
          select: CONTACT_ROLE_SELECT,
        });
      });
      this.logOperation('contact_role_update', 'projection', 'success');
      const contacts = await this.loadContactSummaries(this.prisma, [role], companyId, opportunityLeadId);
      return toContactRoleResponse(role, contacts.get(role.contactId) || null);
    });
  }

  async removeContactRole(opportunityId: string, roleId: string, currentUser: CurrentUser) {
    const companyId = requireActiveCompany(currentUser).id;
    this.assertWritable(currentUser);

    return this.safeOperation(async () => {
      await this.runSerializable(async (tx: DbClient) => {
        await this.findAccessibleOpportunity(tx, opportunityId, currentUser, companyId);
        const result = await tx.opportunityContactRole.deleteMany({
          where: { id: roleId, opportunityId, companyId },
        });
        if (result.count !== 1) throw new NotFoundException('Opportunity contact role not found');
      });
      this.logOperation('contact_role_remove', 'projection', 'success');
      return { removed: true };
    });
  }

  private opportunityWhere(
    currentUser: CurrentUser,
    companyId: string,
    filters: { stage?: string; leadId?: string; ownerUserId?: string; search?: string },
  ) {
    const where: Record<string, any> = {
      companyId,
      deletedAt: null,
      ...this.ownerWhere(currentUser, companyId),
    };
    if (filters.stage) where.stage = filters.stage;
    if (filters.leadId) where.leadId = filters.leadId;
    if (filters.ownerUserId && hasFullAccess(currentUser, companyId)) {
      where.ownerUserId = filters.ownerUserId;
    }
    if (filters.search?.trim()) {
      where.name = { contains: filters.search.trim(), mode: 'insensitive' };
    }
    return where;
  }

  private async loadDisplaySummaries(
    db: DbClient,
    records: any[],
    companyId: string,
  ): Promise<OpportunityDisplaySummary[]> {
    const leadIds = [...new Set(records.map((record) => record.leadId).filter(Boolean))];
    const ownerIds = [...new Set(records.map((record) => record.ownerUserId).filter(Boolean))];
    const leads = leadIds.length && db.lead?.findMany
      ? await db.lead.findMany({
        where: {
          id: { in: leadIds },
          companyId,
          deletedAt: null,
        },
        select: {
          id: true,
          companyName: true,
          contactName: true,
          country: true,
          deletedAt: true,
        },
      })
      : [];
    const owners = ownerIds.length && db.user?.findMany
      ? await db.user.findMany({
        where: {
          id: { in: ownerIds },
          isActive: true,
          deletedAt: null,
          companies: {
            some: {
              companyId,
              isActive: true,
              company: { isActive: true },
            },
          },
        },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          isActive: true,
          deletedAt: true,
          companies: {
            where: { companyId, isActive: true },
            select: { id: true },
          },
        },
      })
      : [];

    const leadById = new Map<string, OpportunityLeadSummaryResponse>();
    for (const lead of leads) {
      if (lead.deletedAt) continue;
      leadById.set(lead.id, {
        id: lead.id,
        companyName: lead.companyName ?? null,
        contactName: lead.contactName ?? null,
        country: lead.country ?? null,
      });
    }
    const ownerById = new Map<string, OpportunityOwnerSummaryResponse>();
    for (const owner of owners) {
      if (owner.deletedAt || !owner.isActive || !owner.companies?.length) continue;
      const displayName = [owner.firstName, owner.lastName]
        .map((part: unknown) => String(part || '').trim())
        .filter(Boolean)
        .join(' ');
      if (displayName) ownerById.set(owner.id, { id: owner.id, displayName });
    }

    return records.map((record) => ({
      lead: leadById.get(record.leadId) || null,
      owner: ownerById.get(record.ownerUserId) || null,
    }));
  }

  private async loadContactSummaries(
    db: DbClient,
    records: any[],
    companyId: string,
    leadId: string,
  ): Promise<Map<string, OpportunityContactSummaryResponse>> {
    const contactIds = [...new Set(records.map((record) => record.contactId).filter(Boolean))];
    if (!contactIds.length || !db.contact?.findMany) return new Map();

    const contacts = await db.contact.findMany({
      where: {
        id: { in: contactIds },
        companyId,
        leadId,
      },
      select: {
        id: true,
        companyId: true,
        leadId: true,
        displayName: true,
        firstName: true,
        lastName: true,
        title: true,
        isPrimary: true,
      },
    });

    const byId = new Map<string, OpportunityContactSummaryResponse>();
    for (const contact of contacts) {
      if (contact.companyId !== companyId || contact.leadId !== leadId) continue;
      const displayName = String(contact.displayName || '').trim()
        || [contact.firstName, contact.lastName]
          .map((part: unknown) => String(part || '').trim())
          .filter(Boolean)
          .join(' ');
      if (!displayName) continue;
      byId.set(contact.id, {
        id: contact.id,
        displayName,
        title: contact.title ?? null,
        isPrimary: contact.isPrimary === true,
      });
    }
    return byId;
  }

  private ownerWhere(currentUser: CurrentUser, companyId: string) {
    return hasFullAccess(currentUser, companyId) ? {} : { ownerUserId: currentUser.id };
  }

  private async findAccessibleOpportunity(
    db: DbClient,
    id: string,
    currentUser: CurrentUser,
    companyId: string,
  ) {
    const record = await db.opportunity.findFirst({
      where: {
        id,
        companyId,
        deletedAt: null,
        ...this.ownerWhere(currentUser, companyId),
      },
      select: OPPORTUNITY_SELECT,
    });
    if (!record) throw new NotFoundException('Opportunity not found');
    return record;
  }

  private async assertLeadAccess(db: DbClient, currentUser: CurrentUser, companyId: string, leadId: string) {
    const lead = await db.lead.findFirst({
      where: {
        id: leadId,
        companyId,
        deletedAt: null,
        ...this.ownerWhere(currentUser, companyId),
      },
      select: { id: true },
    });
    if (!lead) throw new BadRequestException('Lead is not accessible in the active company');
  }

  private async assertOwnerMembership(db: DbClient, companyId: string, userId: string) {
    const membership = await db.userCompanyRelation.findFirst({
      where: {
        companyId,
        userId,
        isActive: true,
        user: { isActive: true, deletedAt: null },
        company: { isActive: true },
      },
      select: { id: true },
    });
    if (!membership) throw new BadRequestException('Owner is not an active user in the company');
  }

  private async assertContactAccess(db: DbClient, companyId: string, leadId: string, contactId: string) {
    const contact = await db.contact.findFirst({
      where: { id: contactId, companyId, leadId },
      select: { id: true },
    });
    if (!contact) throw new BadRequestException('Contact is not attached to the opportunity lead');
  }

  private async clearPrimary(db: DbClient, opportunityId: string, exceptRoleId?: string) {
    await db.opportunityContactRole.updateMany({
      where: {
        opportunityId,
        isPrimary: true,
        ...(exceptRoleId ? { id: { not: exceptRoleId } } : {}),
      },
      data: { isPrimary: false },
    });
  }

  private assertWritable(currentUser: CurrentUser) {
    if (requireActiveCompany(currentUser).role === 'viewer') {
      throw new ForbiddenException('Viewer access is read-only');
    }
  }

  private assertOwnerAssignment(currentUser: CurrentUser, companyId: string, ownerUserId: string) {
    if (!hasFullAccess(currentUser, companyId) && ownerUserId !== currentUser.id) {
      throw new ForbiddenException('Only administrators can assign another owner');
    }
  }

  private assertRoleType(roleType: string) {
    if (!isOpportunityContactRoleType(roleType)) {
      throw new BadRequestException(`Invalid contact role; expected one of ${OPPORTUNITY_CONTACT_ROLE_TYPES.join(', ')}`);
    }
  }

  private validateProbability(value: number) {
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      throw new BadRequestException('Probability must be an integer between 0 and 100');
    }
    return value;
  }

  private normalizeAmount(value: string | null | undefined): string | null {
    if (value === null || value === undefined || value === '') return null;
    const text = String(value);
    if (!/^\d+(\.\d{1,2})?$/.test(text)) {
      throw new BadRequestException('Amount must be a non-negative decimal with at most two decimals');
    }
    const [integerPart, fractionPart = ''] = text.split('.');
    const normalizedInteger = integerPart.replace(/^0+/, '') || '0';
    const canonical = `${normalizedInteger}.${fractionPart.padEnd(2, '0')}`;
    if (
      normalizedInteger.length > 12
      || (normalizedInteger.length === 12 && canonical > '999999999999.99')
    ) {
      throw new BadRequestException('Amount exceeds Decimal(14,2) maximum 999999999999.99');
    }
    return text;
  }

  private normalizeCurrency(value: string | undefined): string {
    const currency = value || 'USD';
    if (!/^[A-Z]{3}$/.test(currency)) throw new BadRequestException('Currency must be three uppercase ASCII letters');
    return currency;
  }

  private parseDate(value: string | null | undefined, field: string): Date | null {
    if (value === null || value === undefined || value === '') return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new BadRequestException(`Invalid ${field}`);
    return parsed;
  }

  private async runSerializable<T>(work: (tx: DbClient) => Promise<T>): Promise<T> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(work, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (!isSerializableConflict(error) || attempt === maxAttempts) throw error;
      }
    }
    throw new Error('Unreachable Serializable transaction state');
  }

  private async safeOperation<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.warn(safeLogEvent('opportunity.operation_failed', {
        status: 'error',
        error,
      }));
      if (isUniqueConflict(error) || isSerializableConflict(error)) {
        throw new ConflictException('Opportunity conflict');
      }
      throw new InternalServerErrorException('Opportunity operation failed');
    }
  }

  private logOperation(operation: string, stage: string, status: string) {
    this.logger.log(safeLogEvent('opportunity.operation', {
      status,
      stage,
      operation,
      count: 1,
    }));
  }
}
