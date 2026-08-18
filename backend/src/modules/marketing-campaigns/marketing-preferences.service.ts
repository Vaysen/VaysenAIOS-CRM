/**
 * marketing-preferences.service.ts
 *
 * wesley-ai-crm 批次2：客户偏好 / consent / suppression 管理。
 * - MarketingConsent：按 ContactPoint + channel + 有效期（GRANTED/DENIED/UNKNOWN）
 * - MarketingSuppression：Lead 级或 ContactPoint 级退订/抑制
 * - Lead 偏好汇总（语言、consent、suppression 一览）
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MarketingConsentStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  CurrentUser,
  requireActiveCompany,
} from '../../common/utils/data-isolation';
import { UpsertConsentDto } from './dto/consent.dto';
import { AddSuppressionDto } from './dto/suppression.dto';

function normalizeChannel(channel: string): string {
  const normalized = channel.trim().toLowerCase();
  if (!normalized) throw new BadRequestException('channel is required');
  return normalized;
}

@Injectable()
export class MarketingPreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Lead 偏好一览：语言 + consents + suppressions */
  async getLeadPreferences(leadId: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, companyId: company.id, deletedAt: null },
      include: { contactPoints: true },
    });
    if (!lead) throw new NotFoundException('Lead not found in the active company');

    const consents = await this.prisma.marketingConsent.findMany({
      where: { companyId: company.id, leadId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      orderBy: { updatedAt: 'desc' },
    });
    const suppressions = await this.prisma.marketingSuppression.findMany({
      where: { companyId: company.id, leadId, active: true, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      orderBy: { createdAt: 'desc' },
    });
    return {
      leadId: lead.id,
      leadName: lead.leadName,
      language: lead.language,
      contactPoints: lead.contactPoints.map((cp) => ({
        id: cp.id,
        type: cp.type,
        value: cp.normalizedValue,
        language: cp.language,
        isVerified: cp.isVerified,
      })),
      consents,
      suppressions,
    };
  }

  /** upsert consent：按 companyId+channel+contactRef 幂等 */
  async upsertConsent(dto: UpsertConsentDto, user: CurrentUser) {
    const company = requireActiveCompany(user);
    const channel = normalizeChannel(dto.channel);
    const contactRef = dto.contactRef.trim().toLowerCase();
    if (!contactRef) throw new BadRequestException('contactRef is required');
    const status = dto.status as MarketingConsentStatus;

    const consent = await this.prisma.marketingConsent.upsert({
      where: {
        companyId_channel_contactRef: { companyId: company.id, channel, contactRef },
      },
      create: {
        companyId: company.id,
        channel,
        contactRef,
        status,
        leadId: dto.leadId ?? null,
        contactPointId: dto.contactPointId ?? null,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        source: dto.source ?? 'manual',
        grantedById: user.id,
      },
      update: {
        status,
        leadId: dto.leadId === undefined ? undefined : dto.leadId,
        contactPointId: dto.contactPointId === undefined ? undefined : dto.contactPointId,
        expiresAt: dto.expiresAt === undefined ? undefined : dto.expiresAt ? new Date(dto.expiresAt) : null,
        source: dto.source,
        grantedById: user.id,
      },
    });
    return consent;
  }

  async listConsents(user: CurrentUser) {
    const company = requireActiveCompany(user);
    return this.prisma.marketingConsent.findMany({
      where: { companyId: company.id },
      orderBy: { updatedAt: 'desc' },
      take: 500,
    });
  }

  /** 撤回同意：DENIED + 立即可见 */
  async revokeConsent(id: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    const existing = await this.prisma.marketingConsent.findFirst({
      where: { id, companyId: company.id },
    });
    if (!existing) throw new NotFoundException('Consent not found');
    return this.prisma.marketingConsent.update({
      where: { id },
      data: { status: MarketingConsentStatus.DENIED, grantedById: user.id },
    });
  }

  /** 新增抑制/退订（Lead 级或 ContactPoint 级，同键幂等） */
  async addSuppression(dto: AddSuppressionDto, user: CurrentUser) {
    const company = requireActiveCompany(user);
    if (dto.scope === 'CONTACT_POINT' && !dto.contactRef && !dto.contactPointId) {
      throw new BadRequestException('CONTACT_POINT suppression requires contactRef or contactPointId');
    }
    if (dto.scope === 'LEAD' && !dto.leadId) {
      throw new BadRequestException('LEAD suppression requires leadId');
    }
    const contactRef = dto.contactRef?.trim().toLowerCase() ?? null;
    const channel = dto.channel ? normalizeChannel(dto.channel) : null;
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;

    const existing = await this.prisma.marketingSuppression.findFirst({
      where: { companyId: company.id, scope: dto.scope, contactRef, channel, active: true },
    });
    if (existing) {
      return this.prisma.marketingSuppression.update({
        where: { id: existing.id },
        data: {
          active: true,
          reason: dto.reason ?? undefined,
          expiresAt: dto.expiresAt === undefined ? undefined : expiresAt,
          createdById: user.id,
        },
      });
    }
    return this.prisma.marketingSuppression.create({
      data: {
        companyId: company.id,
        scope: dto.scope,
        leadId: dto.leadId ?? null,
        contactPointId: dto.contactPointId ?? null,
        contactRef,
        channel,
        reason: dto.reason ?? null,
        source: dto.source ?? 'manual',
        expiresAt,
        createdById: user.id,
      },
    });
  }

  async listSuppressions(user: CurrentUser) {
    const company = requireActiveCompany(user);
    return this.prisma.marketingSuppression.findMany({
      where: { companyId: company.id },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
  }

  /** 解除抑制 */
  async removeSuppression(id: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    const existing = await this.prisma.marketingSuppression.findFirst({
      where: { id, companyId: company.id },
    });
    if (!existing) throw new NotFoundException('Suppression not found');
    return this.prisma.marketingSuppression.update({
      where: { id },
      data: { active: false },
    });
  }
}
