import { ForbiddenException, Get, Query, Controller } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  OpenClawBindingStatus,
  OwnerNotificationStatus,
} from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OpenClawGatewayClient } from '../openclaw/openclaw-gateway.client';

@ApiTags('Owner notifications')
@ApiBearerAuth()
@Controller('owner-notifications')
export class OwnerNotificationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly openClawGateway: OpenClawGatewayClient,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'Get tenant-scoped owner WeChat notification delivery status' })
  async status(@Query('companyId') companyId: string, @CurrentUser() user: any) {
    if (!companyId || !user?.companies?.some((company: any) => company.id === companyId)) {
      throw new ForbiddenException('No access to this company');
    }

    const [bindingCount, pending, sending, sent, failed, lastDelivery, probe] = await Promise.all([
      this.prisma.openClawOperatorBinding.count({
        where: {
          companyId,
          channel: 'openclaw-weixin',
          status: OpenClawBindingStatus.ACTIVE,
        },
      }),
      this.prisma.ownerNotificationOutbox.count({
        where: { companyId, status: OwnerNotificationStatus.PENDING },
      }),
      this.prisma.ownerNotificationOutbox.count({
        where: { companyId, status: OwnerNotificationStatus.SENDING },
      }),
      this.prisma.ownerNotificationOutbox.count({
        where: { companyId, status: OwnerNotificationStatus.SENT },
      }),
      this.prisma.ownerNotificationOutbox.count({
        where: { companyId, status: OwnerNotificationStatus.FAILED },
      }),
      this.prisma.ownerNotificationOutbox.findFirst({
        where: { companyId },
        orderBy: { createdAt: 'desc' },
        select: {
          status: true,
          eventType: true,
          createdAt: true,
          sentAt: true,
          lastError: true,
        },
      }),
      this.openClawGateway.probe().catch(() => null),
    ]);

    const hasUniqueBinding = bindingCount === 1;
    const configured = hasUniqueBinding && probe?.enabled === true;
    const connected = configured
      && probe?.wechatOwnerChannel.status === 'CONNECTED';
    const channelStatus = !hasUniqueBinding
      ? 'UNBOUND'
      : connected
        ? 'CONNECTED'
        : 'OFFLINE';

    return {
      enabled: configured,
      channel: 'openclaw-weixin' as const,
      channelStatus,
      counts: { pending, sending, sent, failed },
      lastDelivery: lastDelivery
        ? {
            status: lastDelivery.status,
            eventType: lastDelivery.eventType,
            createdAt: lastDelivery.createdAt.toISOString(),
            sentAt: lastDelivery.sentAt?.toISOString() || null,
            errorCode: lastDelivery.status === OwnerNotificationStatus.FAILED
              ? this.safeFailureCode(lastDelivery.lastError)
              : null,
          }
        : null,
    };
  }

  private safeFailureCode(value: string | null) {
    const normalized = String(value || '').trim().toUpperCase();
    return /^[A-Z0-9_.-]{1,80}$/.test(normalized)
      ? normalized
      : 'DELIVERY_FAILED';
  }
}
