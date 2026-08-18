import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  CurrentUser,
  hasFullAccess,
  requireActiveCompany,
} from '../../common/utils/data-isolation';
import { CreateSalesSequenceDto } from './dto/create-sales-sequence.dto';
import { EnrollSalesSequenceDto } from './dto/enroll-sales-sequence.dto';

const MANAGER_ROLES = new Set(['super_admin', 'company_admin', 'sales_manager']);

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function opaqueTargetRef(companyId: string, leadId: string): string {
  return `target:${digest({ companyId, leadId }).slice('sha256:'.length)}`;
}

function assertManager(user: CurrentUser, companyId: string) {
  requireActiveCompany(user);
  if (!hasFullAccess(user, companyId) && !MANAGER_ROLES.has(user.activeCompany?.role || '')) {
    throw new ForbiddenException('Sales sequence management requires a manager role');
  }
}

@Injectable()
export class SalesSequencesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: CurrentUser) {
    const company = requireActiveCompany(user);
    const where = hasFullAccess(user, company.id)
      ? { companyId: company.id }
      : { companyId: company.id, ownerUserId: user.id };
    return this.prisma.salesSequence.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { steps: { orderBy: { position: 'asc' } }, _count: { select: { enrollments: true } } },
    });
  }

  async create(dto: CreateSalesSequenceDto, user: CurrentUser) {
    const company = requireActiveCompany(user);
    assertManager(user, company.id);
    if (!dto.steps.length || dto.steps.length > 20) {
      throw new BadRequestException('A sequence must contain 1 to 20 steps');
    }
    const steps = dto.steps.map((step, index) => ({
      position: index + 1,
      channel: step.channel,
      delaySeconds: step.delaySeconds,
      templateDigest: digest(step.templateSnapshot),
      templateSnapshot: step.templateSnapshot as Prisma.InputJsonValue,
    }));
    return this.prisma.salesSequence.create({
      data: {
        companyId: company.id,
        ownerUserId: user.id,
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        steps: { create: steps },
      },
      include: { steps: { orderBy: { position: 'asc' } } },
    });
  }

  async activate(id: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    assertManager(user, company.id);
    const current = await this.prisma.salesSequence.findFirst({
      where: { id, companyId: company.id },
      include: { steps: true },
    });
    if (!current) throw new NotFoundException('Sales sequence not found');
    if (!current.steps.length) throw new BadRequestException('A sequence must contain at least one step');
    const updated = await this.prisma.salesSequence.updateMany({
      where: { id, companyId: company.id, version: current.version, status: { in: ['DRAFT', 'PAUSED'] } },
      data: { status: 'ACTIVE', version: { increment: 1 } },
    });
    if (updated.count !== 1) throw new ConflictException('Sequence changed; reload and retry');
    return this.prisma.salesSequence.findUniqueOrThrow({ where: { id }, include: { steps: { orderBy: { position: 'asc' } } } });
  }

  async enroll(sequenceId: string, dto: EnrollSalesSequenceDto, user: CurrentUser) {
    const company = requireActiveCompany(user);
    const sequence = await this.prisma.salesSequence.findFirst({
      where: { id: sequenceId, companyId: company.id, status: 'ACTIVE' },
      include: { steps: { orderBy: { position: 'asc' }, take: 1 } },
    });
    if (!sequence || !sequence.steps[0]) throw new NotFoundException('Active sales sequence not found');
    const lead = await this.prisma.lead.findFirst({ where: { id: dto.leadId, companyId: company.id, deletedAt: null }, select: { id: true } });
    if (!lead) throw new NotFoundException('Lead not found in the active company');
    const idempotencyKey = `sales-sequence-enroll:${sequence.id}:${lead.id}`;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const enrollment = await tx.salesSequenceEnrollment.create({
          data: { companyId: company.id, sequenceId: sequence.id, leadId: lead.id, createdById: user.id },
        });
        const step = sequence.steps[0];
        const draftSnapshot = {
          channel: step.channel,
          templateDigest: step.templateDigest,
          templateSnapshot: step.templateSnapshot,
          mode: 'DRAFT_ONLY',
        } as Prisma.InputJsonValue;
        const execution = await tx.salesSequenceStepExecution.create({
          data: {
            companyId: company.id,
            enrollmentId: enrollment.id,
            stepId: step.id,
            idempotencyKey,
            draftDigest: digest(draftSnapshot),
            draftSnapshot,
          },
        });
        const targetRef = opaqueTargetRef(company.id, lead.id);
        const payloadDigest = digest({ executionId: execution.id, draftDigest: execution.draftDigest });
        const draftOutbox = await tx.salesSequenceDraftOutbox.create({
          data: {
            companyId: company.id,
            executionId: execution.id,
            idempotencyKey: `draft-outbox:${execution.id}`,
            channel: step.channel,
            targetRef,
            targetDigest: digest(targetRef),
            payloadDigest,
            contentSnapshot: draftSnapshot,
          },
        });
        const receipt = { schemaVersion: 1, mode: 'DRAFT_ONLY', executionRef: `execution:${execution.id}`, draftDigest: execution.draftDigest, outboxRef: `draft-outbox:${draftOutbox.id}` };
        await tx.salesSequenceExecutionReceipt.create({
          data: { companyId: company.id, executionId: execution.id, kind: 'DRAFT_CREATED', operationDigest: digest(receipt), receipt },
        });
        return { enrollment, execution, draftOutbox };
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException('Lead is already enrolled in this sequence');
      throw error;
    }
  }

  async listEnrollments(sequenceId: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    const where = hasFullAccess(user, company.id)
      ? { sequenceId, companyId: company.id }
      : { sequenceId, companyId: company.id, createdById: user.id };
    return this.prisma.salesSequenceEnrollment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { executions: { include: { step: true, draftOutbox: true, receipts: { orderBy: { createdAt: 'asc' } } } }, lead: { select: { id: true, companyName: true, contactName: true } } },
    });
  }

  async transitionExecution(id: string, action: 'APPROVE' | 'CANCEL', user: CurrentUser) {
    const company = requireActiveCompany(user);
    const current = await this.prisma.salesSequenceStepExecution.findFirst({
      where: { id, companyId: company.id, ...(hasFullAccess(user, company.id) ? {} : { enrollment: { createdById: user.id } }) },
      include: { draftOutbox: true },
    });
    if (!current) throw new NotFoundException('Step execution not found');
    const nextStatus = action === 'APPROVE' ? 'APPROVED' : 'CANCELLED';
    if ((action === 'APPROVE' && current.status !== 'DRAFT_PENDING') || (action === 'CANCEL' && current.status === 'CANCELLED')) {
      throw new ConflictException('Execution is not in a transitionable state');
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.salesSequenceStepExecution.updateMany({
        where: { id, companyId: company.id, version: current.version, status: current.status },
        data: { status: nextStatus, version: { increment: 1 } },
      });
      if (updated.count !== 1) throw new ConflictException('Execution changed; reload and retry');
      const receipt = { schemaVersion: 1, mode: 'DRAFT_ONLY', executionRef: `execution:${id}`, previousStatus: current.status, status: nextStatus, sendCommand: null, providerCommand: null, retryCommand: null };
      await tx.salesSequenceExecutionReceipt.create({
        data: { companyId: company.id, executionId: id, kind: action === 'APPROVE' ? 'DRAFT_APPROVED' : 'DRAFT_CANCELLED', operationDigest: digest(receipt), receipt },
      });
      return tx.salesSequenceStepExecution.findUniqueOrThrow({ where: { id }, include: { draftOutbox: true, receipts: { orderBy: { createdAt: 'asc' } } } });
    });
  }
}
