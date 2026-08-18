import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  applyDataIsolation,
  hasFullAccess,
  requireActiveCompany,
  type CurrentUser as RequestUser,
} from '../../common/utils/data-isolation';
import { CustomerMergeService } from '../customer-identity/customer-merge.service';
import { normalizePhoneIdentity } from '../customer-identity/domain/normalize-phone';
import type { MergeCustomerCommand, MergePreview } from '../customer-identity/dto/merge-customer.dto';
import type { RejectCandidateCommand } from '../customer-identity/dto/reject-candidate.dto';
import type {
  CustomerAssetContactDto,
  CustomerAssetDto,
  CustomerAssetLinkDto,
  CustomerAssetConversationDto,
} from './dto/customer-asset.dto';
import type { DuplicateCheckCommand, DuplicateCheckResult } from './dto/duplicate-check.dto';

const DISPLAY_NAME_FALLBACK = '公司待补充';

function channelForContactPoint(type: string): string[] {
  if (type === 'email') return ['business_email', 'marketing_email'];
  if (type === 'whatsapp') return ['whatsapp'];
  if (type === 'website') return ['website_inquiry'];
  return [];
}

@Injectable()
export class CustomerAssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mergeService: CustomerMergeService,
  ) {}

  async getCustomerAsset(companyId: string, leadId: string, currentUser: RequestUser): Promise<CustomerAssetDto> {
    const user = this.requireReaderContext(companyId, currentUser);
    const lead = await this.prisma.lead.findFirst({
      where: applyDataIsolation(user, { id: leadId, companyId, deletedAt: null }),
      include: {
        contacts: { include: { contactPoints: true } },
        contactPoints: true,
        conversations: true,
        emailMessages: { select: { id: true, subject: true, status: true, createdAt: true } },
        quotes: { select: { id: true, referenceNo: true, status: true, totalAmount: true, createdAt: true } },
        orders: { select: { id: true, orderNo: true, stage: true, totalAmount: true, createdAt: true } },
      },
    }) as any;

    if (!lead) throw new NotFoundException('customer asset not found');

    const candidates = await this.prisma.identityMatchCandidate.findMany({
      where: {
        companyId,
        targetLeadId: leadId,
        status: 'pending',
        ...(hasFullAccess(user, companyId)
          ? {}
          : { sourceLead: { companyId, ownerUserId: user.id, deletedAt: null } }),
      },
      orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
    });
    return this.toDto(lead, candidates);
  }

  async listContacts(companyId: string, leadId: string, currentUser: RequestUser): Promise<CustomerAssetContactDto[]> {
    return (await this.getCustomerAsset(companyId, leadId, currentUser)).contacts;
  }

  private requireReaderContext(companyId: string, currentUser: RequestUser): RequestUser {
    const activeCompany = requireActiveCompany(currentUser);
    if (activeCompany.id !== companyId) throw new NotFoundException('customer asset not found');
    return currentUser;
  }

  async duplicateCheck(command: DuplicateCheckCommand): Promise<DuplicateCheckResult> {
    const filters: Array<{ type: string; normalizedValue: string }> = [];
    const email = command.email?.trim().toLowerCase();
    const companyName = command.companyName?.trim();
    if (email) filters.push({ type: 'email', normalizedValue: email });

    if (command.phone) {
      const identity = normalizePhoneIdentity(command.phone);
      if (identity.status === 'resolved') {
        filters.push({ type: 'whatsapp', normalizedValue: identity.e164 });
        filters.push({ type: 'phone', normalizedValue: identity.e164 });
      }
    }
    const [points, companyNameLeads] = await Promise.all([
      filters.length > 0
        ? this.prisma.contactPoint.findMany({
          where: { companyId: command.companyId, leadId: { not: command.leadId }, OR: filters },
          include: { lead: { select: { id: true, companyName: true, leadName: true, contactName: true, country: true, deletedAt: true } } },
        })
        : Promise.resolve([]),
      companyName
        ? this.prisma.lead.findMany({
          where: {
            companyId: command.companyId,
            id: { not: command.leadId },
            deletedAt: null,
            companyName: { equals: companyName, mode: 'insensitive' },
          },
          select: { id: true, companyName: true, leadName: true, contactName: true, country: true },
        })
        : Promise.resolve([]),
    ]);
    const seen = new Set<string>();
    const hits: DuplicateCheckResult['hits'] = [];
    for (const lead of companyNameLeads as any[]) {
      if (seen.has(lead.id)) continue;
      seen.add(lead.id);
      hits.push({
        leadId: lead.id,
        companyName: lead.companyName,
        displayName: lead.companyName ?? lead.leadName ?? lead.contactName ?? null,
        countryIso2: lead.country ?? null,
        contactPointPreview: null,
        matchedChannel: 'companyName',
        matchedValue: lead.companyName ?? companyName!,
        score: 100,
      });
    }
    return {
      queryLeadId: command.leadId,
      hits: hits.concat((points as any[]).flatMap((point: any) => {
        if (!point.lead || point.lead.deletedAt || seen.has(point.lead.id)) return [];
        seen.add(point.lead.id);
        return [{
          leadId: point.lead.id,
          companyName: point.lead.companyName,
          displayName: point.lead.companyName ?? point.lead.leadName ?? point.lead.contactName ?? null,
          countryIso2: point.lead.country ?? null,
          contactPointPreview: point.originalValue ?? point.normalizedValue ?? null,
          matchedChannel: point.type === 'email' ? 'email' : point.type === 'whatsapp' ? 'whatsapp' : 'phone',
          matchedValue: point.normalizedValue,
          score: 100,
        } as const];
      })),
    };
  }

  mergePreview(companyId: string, candidateId: string, user: RequestUser): Promise<MergePreview> {
    return this.mergeService.previewAuthorized(companyId, candidateId, user);
  }

  merge(
    companyId: string,
    command: Omit<MergeCustomerCommand, 'actorId'>,
    user: RequestUser,
  ) {
    if (!command.targetUpdatedAt) {
      throw new BadRequestException('targetUpdatedAt from merge preview is required');
    }
    return this.mergeService.mergeAuthorized({ ...command, companyId }, user);
  }

  reject(companyId: string, command: RejectCandidateCommand, user: RequestUser): Promise<void> {
    return this.mergeService.rejectAuthorized({ ...command, companyId }, user);
  }

  undo(companyId: string, auditId: string, user: RequestUser): Promise<void> {
    return this.mergeService.undoAuthorized({ companyId, auditId, actorId: user.id }, user);
  }

  private toDto(lead: any, candidates: any[]): CustomerAssetDto {
    const conversations = (lead.conversations ?? []).map((item: any): CustomerAssetConversationDto => ({
      id: item.id,
      channel: item.channel,
      subject: item.subject ?? null,
      status: item.status,
      isGroup: item.isGroup ?? null,
      contactPointId: item.contactPointId ?? null,
      lastMessageAt: item.lastMessageAt?.toISOString?.() ?? null,
      lastMessagePreview: item.lastMessagePreview ?? null,
      unreadCount: item.unreadCount ?? 0,
    }));
    const byPoint = new Map<string, string[]>();
    for (const item of conversations) {
      if (item.contactPointId) byPoint.set(item.contactPointId, [...(byPoint.get(item.contactPointId) ?? []), item.id]);
    }
    const mapPoint = (point: any) => ({
      id: point.id,
      type: point.type,
      originalValue: point.originalValue,
      normalizedValue: point.normalizedValue,
      isVerified: point.isVerified === true,
      conversationIds: byPoint.get(point.id) ?? conversations
        .filter((item: CustomerAssetConversationDto) => channelForContactPoint(point.type).includes(item.channel)).map((item: CustomerAssetConversationDto) => item.id),
    });
    const contactPoints = (lead.contactPoints ?? []).map(mapPoint);
    const contacts = (lead.contacts ?? []).map((contact: any): CustomerAssetContactDto => ({
      id: contact.id,
      displayName: contact.displayName ?? null,
      firstName: contact.firstName ?? null,
      lastName: contact.lastName ?? null,
      email: contact.email ?? null,
      phone: contact.phone ?? null,
      title: contact.title ?? null,
      isPrimary: contact.isPrimary === true,
      contactPoints: (contact.contactPoints ?? []).map(mapPoint),
      updatedAt: contact.updatedAt.toISOString(),
    })).sort((a: CustomerAssetContactDto, b: CustomerAssetContactDto) => Number(b.isPrimary) - Number(a.isPrimary) || b.updatedAt.localeCompare(a.updatedAt));
    const link = (item: any, reference: string, status: string, amount?: unknown): CustomerAssetLinkDto => ({
      id: item.id,
      reference: item[reference] ?? item.id,
      status: item[status] ?? 'unknown',
      ...(amount !== undefined ? { amount: String(amount) } : {}),
      createdAt: item.createdAt.toISOString(),
    });
    return {
      id: lead.id,
      companyName: lead.companyName ?? null,
      displayName: lead.companyName ?? DISPLAY_NAME_FALLBACK,
      countryIso2: lead.country ?? null,
      contacts,
      contactPoints,
      conversations,
      emails: (lead.emailMessages ?? []).map((item: any) => link(item, 'subject', 'status')),
      quotes: (lead.quotes ?? []).map((item: any) => link(item, 'referenceNo', 'status', item.totalAmount)),
      orders: (lead.orders ?? []).map((item: any) => link(item, 'orderNo', 'stage', item.totalAmount)),
      selectedContactId: contacts.find((item: CustomerAssetContactDto) => item.isPrimary)?.id ?? contacts[0]?.id ?? null,
      pendingMatchCount: candidates.length,
      pendingCandidates: candidates.map((item) => ({
        id: item.id,
        sourceLeadId: item.sourceLeadId,
        targetLeadId: item.targetLeadId,
        score: item.score,
        reasons: item.reasons,
        status: item.status,
        createdAt: item.createdAt.toISOString(),
      })),
      updatedAt: lead.updatedAt.toISOString(),
    };
  }
}
