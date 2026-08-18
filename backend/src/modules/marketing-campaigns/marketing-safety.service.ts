/**
 * marketing-safety.service.ts
 *
 * wesley-ai-crm 批次2：营销合规安全 —— kill-switch（GLOBAL / CHANNEL:EMAIL / CHANNEL:WHATSAPP）
 * + preflight 审计读取。
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MarketingKillSwitchScope } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  CurrentUser,
  requireActiveCompany,
} from '../../common/utils/data-isolation';
import { MARKETING_EXECUTION_GATES } from './marketing-execution.contract';
import { ActivateKillSwitchDto } from './dto/kill-switch.dto';

const SCOPE_TO_CHANNEL: Record<MarketingKillSwitchScope, string | null> = {
  GLOBAL: null,
  CHANNEL_EMAIL: 'email',
  CHANNEL_WHATSAPP: 'whatsapp',
};

@Injectable()
export class MarketingSafetyService {
  constructor(private readonly prisma: PrismaService) {}

  async capabilities(user: CurrentUser) {
    requireActiveCompany(user);
    return {
      killSwitchScopes: [
        { scope: 'GLOBAL', label: '全部渠道紧急熔断' },
        { scope: 'CHANNEL_EMAIL', label: 'EMAIL 渠道熔断' },
        { scope: 'CHANNEL_WHATSAPP', label: 'WHATSAPP 渠道熔断' },
      ],
      preflightGates: MARKETING_EXECUTION_GATES,
      audit: {
        preflightRuns: true,
        events: true,
        payloadHashEvidence: 'sha256',
      },
    };
  }

  async listKillSwitches(user: CurrentUser) {
    const company = requireActiveCompany(user);
    return this.prisma.marketingKillSwitch.findMany({
      where: { companyId: company.id },
      orderBy: { activatedAt: 'desc' },
    });
  }

  /** 激活 kill-switch（幂等 upsert：同 scope+channel 仅保留一条 active） */
  async activateKillSwitch(dto: ActivateKillSwitchDto, user: CurrentUser) {
    const company = requireActiveCompany(user);
    const channel = SCOPE_TO_CHANNEL[dto.scope];
    if (channel === undefined) {
      throw new BadRequestException(`Unknown kill-switch scope: ${dto.scope}`);
    }

    // 同 scope 先停用旧开关（一个 scope 只允许一个 active）
    await this.prisma.marketingKillSwitch.updateMany({
      where: { companyId: company.id, scope: dto.scope, active: true },
      data: {
        active: false,
        deactivatedById: user.id,
        deactivatedAt: new Date(),
      },
    });

    return this.prisma.marketingKillSwitch.create({
      data: {
        companyId: company.id,
        scope: dto.scope,
        channel,
        reason: dto.reason ?? null,
        active: true,
        activatedById: user.id,
        activatedAt: new Date(),
      },
    });
  }

  /** 停用 kill-switch */
  async deactivateKillSwitch(id: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    const existing = await this.prisma.marketingKillSwitch.findFirst({
      where: { id, companyId: company.id },
    });
    if (!existing) throw new NotFoundException('Kill switch not found');
    return this.prisma.marketingKillSwitch.update({
      where: { id },
      data: { active: false, deactivatedById: user.id, deactivatedAt: new Date() },
    });
  }

  /** preflight 审计读取 */
  async getPreflightRun(runId: string, user: CurrentUser) {
    const company = requireActiveCompany(user);
    const run = await this.prisma.marketingPreflightRun.findFirst({
      where: { id: runId, companyId: company.id },
      include: { attempts: { orderBy: { createdAt: 'asc' } } },
    });
    if (!run) throw new NotFoundException('Preflight run not found');
    return run;
  }
}
