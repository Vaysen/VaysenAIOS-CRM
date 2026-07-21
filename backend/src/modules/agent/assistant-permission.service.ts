import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AssistantGrantStatus, AssistantPermissionPreset, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { digestAgentInput } from './agent-security';
import type { AuthenticatedUser } from './agent.service';
import {
  ASSISTANT_CAPABILITIES,
  getAssistantCapability,
  resolveAssistantCapabilityDecision,
  validateAssistantOverrides,
  type AssistantPermissionPresetValue,
  type AssistantPolicyDecisionValue,
} from './assistant-capability.registry';
import {
  CreateAssistantTemporaryGrantDto,
  UpdateAssistantPermissionProfileDto,
} from './dto/assistant-permission.dto';

const DEFAULT_THRESHOLDS = Object.freeze({
  highValueUsd: 10_000,
  maxAutoDiscountPercent: 5,
  maxAutoPaymentTermDays: 30,
  maxDailyExternalSends: 50,
});

@Injectable()
export class AssistantPermissionService {
  constructor(private readonly prisma: PrismaService) {}

  async getProfile(companyId: string, user: AuthenticatedUser) {
    this.assertCompanyMembership(user, companyId);
    const stored = await this.prisma.assistantPermissionProfile.findUnique({
      where: { companyId },
    });
    const preset = (stored?.preset || 'ADVISORY') as AssistantPermissionPresetValue;
    const overrides = this.readOverrides(stored?.overrides);
    const thresholds = this.normalizeThresholds(stored?.thresholds);
    return {
      companyId,
      preset,
      overrides,
      thresholds,
      capabilities: ASSISTANT_CAPABILITIES.map((definition) => ({
        ...definition,
        decision: resolveAssistantCapabilityDecision(preset, definition.id, overrides),
      })),
      persisted: !!stored,
      updatedAt: stored?.updatedAt?.toISOString() || null,
    };
  }

  async updateProfile(dto: UpdateAssistantPermissionProfileDto, user: AuthenticatedUser) {
    this.assertCompanyAdmin(user, dto.companyId);
    let overrides: Record<string, AssistantPolicyDecisionValue>;
    try {
      overrides = validateAssistantOverrides(dto.overrides || {});
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid assistant policy override');
    }
    const thresholds = this.normalizeThresholds(dto.thresholds);
    await this.prisma.assistantPermissionProfile.upsert({
      where: { companyId: dto.companyId },
      create: {
        companyId: dto.companyId,
        preset: dto.preset as AssistantPermissionPreset,
        overrides: overrides as Prisma.InputJsonValue,
        thresholds: thresholds as Prisma.InputJsonValue,
        updatedByUserId: user.id,
      },
      update: {
        preset: dto.preset as AssistantPermissionPreset,
        overrides: overrides as Prisma.InputJsonValue,
        thresholds: thresholds as Prisma.InputJsonValue,
        updatedByUserId: user.id,
      },
    });
    return this.getProfile(dto.companyId, user);
  }

  async createTemporaryGrant(dto: CreateAssistantTemporaryGrantDto, user: AuthenticatedUser) {
    this.assertCompanyAdmin(user, dto.companyId);
    const definition = getAssistantCapability(dto.capability);
    if (!definition || !definition.temporaryGrantAllowed || definition.risk === 'L4' || definition.risk === 'F') {
      throw new BadRequestException('This capability cannot receive a temporary grant');
    }
    const operatorUserId = dto.operatorUserId || user.id;
    const isMember = await this.prisma.userCompanyRelation.findFirst({
      where: { companyId: dto.companyId, userId: operatorUserId, isActive: true },
      select: { id: true },
    });
    if (!isMember) throw new BadRequestException('Grant target is not an active company member');
    const scope = this.normalizeScope(dto.scope);
    const expiresAt = new Date(Date.now() + dto.ttlMinutes * 60_000);
    return this.prisma.assistantTemporaryGrant.create({
      data: {
        companyId: dto.companyId,
        operatorUserId,
        createdByUserId: user.id,
        capability: dto.capability,
        scopeDigest: digestAgentInput(scope),
        scope: scope as Prisma.InputJsonValue,
        expiresAt,
        maxUses: dto.maxUses || 1,
      },
    });
  }

  async listTemporaryGrants(companyId: string, user: AuthenticatedUser) {
    this.assertCompanyMembership(user, companyId);
    const isAdmin = this.isCompanyAdmin(user, companyId);
    return this.prisma.assistantTemporaryGrant.findMany({
      where: {
        companyId,
        ...(isAdmin ? {} : { operatorUserId: user.id }),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async revokeTemporaryGrant(id: string, user: AuthenticatedUser) {
    const grant = await this.prisma.assistantTemporaryGrant.findUnique({ where: { id } });
    if (!grant) throw new NotFoundException('Assistant grant not found');
    this.assertCompanyAdmin(user, grant.companyId);
    if (grant.status !== AssistantGrantStatus.ACTIVE) return grant;
    return this.prisma.assistantTemporaryGrant.update({
      where: { id },
      data: { status: AssistantGrantStatus.REVOKED, revokedAt: new Date() },
    });
  }

  async evaluate(
    companyId: string,
    user: AuthenticatedUser,
    capabilityId: string,
    scope: Record<string, unknown> = {},
  ) {
    const profile = await this.getProfile(companyId, user);
    const definition = getAssistantCapability(capabilityId);
    if (!definition) return { decision: 'DENY' as const, reason: 'UNKNOWN_CAPABILITY', profile };
    const normalizedScope = this.normalizeScope(scope);
    const scopeDigest = digestAgentInput(normalizedScope);
    const grants = definition.temporaryGrantAllowed
      ? await this.prisma.assistantTemporaryGrant.findMany({
          where: {
            companyId,
            operatorUserId: user.id,
            capability: capabilityId,
            status: AssistantGrantStatus.ACTIVE,
            scopeDigest,
            expiresAt: { gt: new Date() },
          },
          orderBy: { expiresAt: 'asc' },
          take: 10,
        })
      : [];
    const grant = grants.find((item) => item.useCount < item.maxUses);
    const decision = resolveAssistantCapabilityDecision(
      profile.preset,
      capabilityId,
      profile.overrides,
      !!grant,
    );
    return {
      decision,
      reason: decision === 'ALLOW'
        ? grant ? 'TEMPORARY_GRANT' : 'PROFILE_POLICY'
        : decision === 'APPROVAL_REQUIRED'
          ? 'APPROVAL_REQUIRED'
          : 'POLICY_DENIED',
      grantId: grant?.id || null,
      scopeDigest,
      profile,
    };
  }

  private readOverrides(value: Prisma.JsonValue | null | undefined) {
    if (!value || Array.isArray(value) || typeof value !== 'object') return {};
    try {
      return validateAssistantOverrides(value as Record<string, unknown>);
    } catch {
      return {};
    }
  }

  private normalizeThresholds(value: unknown) {
    const source = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const number = (key: keyof typeof DEFAULT_THRESHOLDS, min: number, max: number) => {
      const candidate = Number(source[key] ?? DEFAULT_THRESHOLDS[key]);
      if (!Number.isFinite(candidate) || candidate < min || candidate > max) {
        throw new BadRequestException(`Invalid assistant threshold: ${key}`);
      }
      return candidate;
    };
    return {
      highValueUsd: number('highValueUsd', 100, 10_000_000),
      maxAutoDiscountPercent: number('maxAutoDiscountPercent', 0, 100),
      maxAutoPaymentTermDays: number('maxAutoPaymentTermDays', 0, 365),
      maxDailyExternalSends: Math.trunc(number('maxDailyExternalSends', 1, 10_000)),
    };
  }

  private normalizeScope(scope: Record<string, unknown>) {
    const safe: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(scope).sort(([a], [b]) => a.localeCompare(b))) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) {
        throw new BadRequestException('Invalid temporary grant scope key');
      }
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
        throw new BadRequestException('Temporary grant scope values must be scalar');
      }
      safe[key] = value as string | number | boolean | null;
    }
    if (!Object.keys(safe).length) throw new BadRequestException('Temporary grant scope cannot be empty');
    return safe;
  }

  private assertCompanyMembership(user: AuthenticatedUser, companyId: string) {
    if (!user.companies?.some((company) => company.id === companyId)) {
      throw new ForbiddenException('No access to this company');
    }
  }

  private assertCompanyAdmin(user: AuthenticatedUser, companyId: string) {
    this.assertCompanyMembership(user, companyId);
    if (!this.isCompanyAdmin(user, companyId)) {
      throw new ForbiddenException('Only company administrators may manage assistant permissions');
    }
  }

  private isCompanyAdmin(user: AuthenticatedUser, companyId: string) {
    return !!user.companies?.some(
      (company) => company.id === companyId && ['company_admin', 'super_admin'].includes(company.role),
    );
  }
}
