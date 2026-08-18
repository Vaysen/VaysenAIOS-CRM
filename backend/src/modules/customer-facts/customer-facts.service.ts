import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CurrentUser, requireActiveCompany } from '../../common/utils/data-isolation';
import { validateAndNormalizeEvidence } from './evidence-contract';
import { validateAndNormalizeFactValue } from './fact-contract';
import { CreateFactProposalDto } from './dto/create-fact-proposal.dto';
import { FactCommandDto } from './dto/fact-command.dto';
import { LegacyFactDryRunDto } from './dto/legacy-fact-dry-run.dto';
import { dryRunLegacyBatch } from './legacy-adapter-contract';
import { buildLegacyImportPlan } from './legacy-import-plan-contract';

const REVIEW_ROLES = new Set(['super_admin', 'company_admin', 'sales_manager']);

function digest(value: unknown): string {
  return `sha256:fact-runtime-v1:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function reasonHash(reason: string): string {
  return digest(reason.trim());
}

function normalizeCanonicalUri(value?: string): string | null {
  const uri = value?.trim();
  if (!uri) return null;
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'https:') throw new Error('unsupported protocol');
    return parsed.toString();
  } catch {
    throw new BadRequestException('sourceUri must be a valid HTTPS URL');
  }
}

function requireReviewer(user: CurrentUser) {
  requireActiveCompany(user);
  if (!REVIEW_ROLES.has(user.activeCompany?.role || '')) {
    throw new ForbiddenException('CustomerFact review requires a manager role');
  }
}

function contractError(result: { ok: false; error: { message: string } }): never {
  throw new BadRequestException(result.error.message);
}

@Injectable()
export class CustomerFactsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: CurrentUser) {
    const company = requireActiveCompany(user);
    return this.prisma.customerFact.findMany({
      where: { companyId: company.id },
      orderBy: [{ updatedAt: 'desc' }],
      include: {
        lead: { select: { id: true, companyName: true, contactName: true } },
        evidenceLinks: {
          include: { evidence: { select: { id: true, excerpt: true, excerptHash: true, locator: true, capturedAt: true, source: { select: { title: true, canonicalUri: true, publisher: true } } } } },
        },
      },
    });
  }

  async listProposals(user: CurrentUser) {
    const company = requireActiveCompany(user);
    return this.prisma.customerFactProposal.findMany({
      where: { companyId: company.id },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: {
        lead: { select: { id: true, companyName: true, contactName: true } },
        evidenceLinks: { include: { evidence: { select: { id: true, excerpt: true, excerptHash: true, locator: true, capturedAt: true, source: { select: { title: true, canonicalUri: true, publisher: true } } } } } },
      },
    });
  }

  async legacyDryRun(dto: LegacyFactDryRunDto, user: CurrentUser) {
    const company = requireActiveCompany(user);
    const validationNow = dto.validationNow || new Date().toISOString();
    for (const record of dto.records) {
      const scope = (record && typeof record === 'object' && !Array.isArray(record))
        ? (record as Record<string, unknown>).scope
        : undefined;
      const tenantRef = scope && typeof scope === 'object' && !Array.isArray(scope)
        ? (scope as Record<string, unknown>).tenantRef
        : undefined;
      if (tenantRef !== company.id) throw new ForbiddenException('Legacy dry-run scope does not match the active company');
    }
    const batch = dryRunLegacyBatch(
      { schemaVersion: 1, records: dto.records },
      {
        schemaVersion: 1,
        validationNow,
        adapterVersion: 'legacy-adapter-v1',
        ...(dto.allowlistedSourceRefs ? { allowlistedSourceRefs: dto.allowlistedSourceRefs } : {}),
      },
    );
    if (!batch.ok) throw new BadRequestException(batch.error.message);
    const planInput = {
      schemaVersion: 1 as const,
      adapterVersion: batch.value.adapterVersion,
      batchDigest: batch.value.batchDigest,
      totals: batch.value.totals,
      records: batch.value.records,
    };
    const plan = buildLegacyImportPlan(planInput);
    if (!plan.ok) throw new BadRequestException(plan.error.message);
    return { executionMode: plan.value.executionMode, batch: batch.value, plan: plan.value };
  }

  async createProposal(dto: CreateFactProposalDto, user: CurrentUser) {
    const company = requireActiveCompany(user);
    const lead = await this.prisma.lead.findFirst({ where: { id: dto.leadId, companyId: company.id, deletedAt: null }, select: { id: true } });
    if (!lead) throw new NotFoundException('Lead not found in the active company');

    const normalizedValue = validateAndNormalizeFactValue(dto.factKey, dto.value);
    if (!normalizedValue.ok) contractError(normalizedValue);

    const now = new Date().toISOString();
    const canonicalUri = normalizeCanonicalUri(dto.sourceUri);
    const sourceRef = `internal://source/${createHash('sha256').update(`${company.id}:${canonicalUri || dto.sourceTitle}:${now}`).digest('hex').slice(0, 32)}`;
    const evidence = validateAndNormalizeEvidence({
      schemaVersion: 1,
      kind: 'SOURCE_EXCERPT',
      sourceRef,
      excerpt: dto.excerpt,
      locator: dto.locator,
      capturedAt: dto.capturedAt || now,
      ...(dto.publishedAt ? { publishedAt: dto.publishedAt } : {}),
    }, now);
    if (!evidence.ok) contractError(evidence);
    const observation = evidence.value;
    if (observation.kind !== 'SOURCE_EXCERPT') throw new BadRequestException('Only source excerpt evidence is supported by this endpoint');
    const sourceObservedAt = new Date(observation.capturedAt);
    const valueJson = normalizedValue.value as Prisma.InputJsonValue;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const source = await tx.factSource.create({
          data: {
            companyId: company.id,
            kind: 'PUBLIC_SOURCE',
            canonicalUri,
            title: dto.sourceTitle.trim(),
            publisher: dto.sourcePublisher?.trim() || null,
            observedAt: sourceObservedAt,
            retrievedAt: new Date(now),
            trustLevel: 'UNVERIFIED',
            createdById: user.id,
          },
        });
        const factEvidence = await tx.factEvidence.create({
          data: {
            companyId: company.id,
            sourceId: source.id,
            evidenceKind: 'SOURCE_EXCERPT',
            excerpt: observation.excerpt,
            excerptHash: observation.excerptHash,
            locator: observation.locator,
            capturedAt: sourceObservedAt,
            publishedAt: observation.publishedAt ? new Date(observation.publishedAt) : null,
            evidenceConfidence: dto.confidenceScore ?? 50,
            createdById: user.id,
          },
        });
        const proposal = await tx.customerFactProposal.create({
          data: {
            companyId: company.id,
            leadId: lead.id,
            factKey: dto.factKey,
            valueType: normalizedValue.value.type,
            valueJson,
            status: 'PROPOSED',
            origin: 'PUBLIC_SOURCE_REVIEW',
            confidenceScore: dto.confidenceScore ?? 50,
            generatedAt: new Date(now),
            version: 1,
            evidenceLinks: { create: { companyId: company.id, evidenceId: factEvidence.id, relation: 'SUPPORTS', createdById: user.id } },
          },
          include: { evidenceLinks: { include: { evidence: true } } },
        });
        const receipt = { schemaVersion: 1, mode: 'PROPOSAL_ONLY', proposalRef: `proposal:${proposal.id}`, evidenceRef: `evidence:${factEvidence.id}`, valueDigest: digest(valueJson) };
        await tx.factCommandReceipt.create({ data: { companyId: company.id, proposalId: proposal.id, requestId: `create:${proposal.id}`, operationDigest: digest(receipt), kind: 'PROPOSAL_CREATED', receipt } });
        return proposal;
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException('Duplicate evidence or proposal write');
      throw error;
    }
  }

  async acceptProposal(id: string, dto: FactCommandDto, user: CurrentUser) {
    const company = requireActiveCompany(user);
    requireReviewer(user);
    const proposal = await this.prisma.customerFactProposal.findFirst({ where: { id, companyId: company.id, status: 'PROPOSED' }, include: { evidenceLinks: true } });
    if (!proposal) throw new NotFoundException('Pending CustomerFact proposal not found');
    const valueDigest = digest(proposal.valueJson);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const current = await tx.customerFact.findMany({ where: { companyId: company.id, leadId: proposal.leadId, factKey: proposal.factKey, status: { in: ['CONFIRMED', 'CONFLICT'] } }, orderBy: { createdAt: 'desc' } });
        const sameConfirmed = current.find((fact) => fact.status === 'CONFIRMED' && digest(fact.valueJson) === valueDigest);
        const differentConfirmed = current.filter((fact) => fact.status === 'CONFIRMED' && digest(fact.valueJson) !== valueDigest);
        for (const fact of differentConfirmed) {
          const changed = await tx.customerFact.updateMany({ where: { id: fact.id, companyId: company.id, version: fact.version, status: 'CONFIRMED' }, data: { status: 'CONFLICT', version: { increment: 1 } } });
          if (changed.count !== 1) throw new ConflictException('Existing fact changed; reload and retry');
        }
        const status = differentConfirmed.length ? 'CONFLICT' : 'CONFIRMED';
        const fact = await tx.customerFact.create({
          data: {
            companyId: company.id,
            leadId: proposal.leadId,
            factKey: proposal.factKey,
            valueType: proposal.valueType,
            valueJson: proposal.valueJson as Prisma.InputJsonValue,
            status,
            origin: 'MANUAL_REVIEW',
            confidenceScore: proposal.confidenceScore,
            observedAt: proposal.generatedAt,
            validFrom: new Date(),
            confirmedById: user.id,
            confirmedAt: new Date(),
            supersedesFactId: sameConfirmed?.id || null,
            evidenceLinks: { create: proposal.evidenceLinks.map((link) => ({ companyId: company.id, proposalId: proposal.id, evidenceId: link.evidenceId, relation: link.relation, createdById: user.id })) },
          },
        });
        if (sameConfirmed) {
          const superseded = await tx.customerFact.updateMany({ where: { id: sameConfirmed.id, companyId: company.id, version: sameConfirmed.version, status: 'CONFIRMED' }, data: { status: 'SUPERSEDED', version: { increment: 1 } } });
          if (superseded.count !== 1) throw new ConflictException('Existing fact changed; reload and retry');
        }
        const updated = await tx.customerFactProposal.updateMany({ where: { id, companyId: company.id, version: proposal.version, status: 'PROPOSED' }, data: { status: 'ACCEPTED', reviewedById: user.id, reviewedAt: new Date(), reviewReasonHash: reasonHash(dto.reason), version: { increment: 1 } } });
        if (updated.count !== 1) throw new ConflictException('Proposal changed; reload and retry');
        const receipt = { schemaVersion: 1, mode: 'MANUAL_REVIEW', proposalRef: `proposal:${id}`, factRef: `fact:${fact.id}`, status, evidenceCount: proposal.evidenceLinks.length, reasonHash: reasonHash(dto.reason) };
        await tx.factCommandReceipt.create({ data: { companyId: company.id, proposalId: id, requestId: dto.requestId, operationDigest: digest(receipt), kind: 'PROPOSAL_ACCEPTED', receipt } });
        return fact;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002' || (error as { code?: string }).code === 'P2034') throw new ConflictException('Proposal was changed or command was already processed');
      throw error;
    }
  }

  async rejectProposal(id: string, dto: FactCommandDto, user: CurrentUser) {
    const company = requireActiveCompany(user);
    requireReviewer(user);
    const result = await this.prisma.customerFactProposal.updateMany({ where: { id, companyId: company.id, status: 'PROPOSED', version: 1 }, data: { status: 'REJECTED', reviewedById: user.id, reviewedAt: new Date(), reviewReasonHash: reasonHash(dto.reason), version: { increment: 1 } } });
    if (result.count !== 1) throw new ConflictException('Proposal changed; reload and retry');
    const receipt = { schemaVersion: 1, mode: 'MANUAL_REVIEW', proposalRef: `proposal:${id}`, status: 'REJECTED', reasonHash: reasonHash(dto.reason) };
    try { await this.prisma.factCommandReceipt.create({ data: { companyId: company.id, proposalId: id, requestId: dto.requestId, operationDigest: digest(receipt), kind: 'PROPOSAL_REJECTED', receipt } }); } catch (error) { if ((error as { code?: string }).code === 'P2002') throw new ConflictException('Command was already processed'); throw error; }
    return { id, status: 'REJECTED', mode: 'MANUAL_REVIEW' };
  }
}
