import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../common/prisma/prisma.service';

@ApiTags('WhatsApp Broadcast')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('whatsapp/broadcast')
export class BroadcastController {
  private readonly logger = new Logger(BroadcastController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Post('tasks')
  @ApiOperation({ summary: 'Create a WhatsApp broadcast task' })
  async createTask(
    @Body() body: CreateBroadcastTaskDto,
    @CurrentUser() user: any,
  ) {
    const companyId = await this.requireActiveAdminCompany(user);
    if (body.companyId && body.companyId !== companyId) {
      throw new BadRequestException(
        'Broadcast tasks can only be created in the active company',
      );
    }
    this.assertOutboxBroadcastAvailable();

    // 验证目标人数
    if (!body.recipients || body.recipients.length === 0) {
      return { success: false, message: '请至少选择一个目标客户' };
    }
    throw new ServiceUnavailableException(
      'WhatsApp broadcast creation is disabled until the trusted outbox workflow is available',
    );
  }

  @Get('tasks')
  @ApiOperation({ summary: 'List WhatsApp broadcast tasks' })
  async getTasks(
    @CurrentUser() user: any,
    @Query('status') status?: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    const companyId = await this.requireActiveAdminCompany(user);
    this.assertOutboxBroadcastAvailable();
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = Math.min(parseInt(limit, 10) || 20, 100);

    const where: { companyId: string; status?: string } = { companyId };
    if (status) {
      where.status = status;
    }

    const [tasks, total] = await Promise.all([
      this.prisma.whatsAppBroadcastTask.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
      this.prisma.whatsAppBroadcastTask.count({ where }),
    ]);

    return {
      success: true,
      data: tasks.map((task) => ({
        ...task,
        recipients: JSON.parse(task.recipients || '[]'),
      })),
      pagination: { page: pageNum, limit: limitNum, total },
    };
  }

  @Get('tasks/:id')
  @ApiOperation({ summary: 'Get a WhatsApp broadcast task' })
  async getTaskDetail(@Param('id') id: string, @CurrentUser() user: any) {
    const companyId = await this.requireActiveAdminCompany(user);
    this.assertOutboxBroadcastAvailable();
    const task = await this.prisma.whatsAppBroadcastTask.findFirst({
      where: { id, companyId },
    });
    if (!task) return { success: false, message: 'Task not found' };

    return {
      success: true,
      data: {
        ...task,
        recipients: JSON.parse(task.recipients || '[]'),
      },
    };
  }

  @Patch('tasks/:id/cancel')
  @ApiOperation({ summary: 'Cancel a WhatsApp broadcast task' })
  async cancelTask(@Param('id') id: string, @CurrentUser() user: any) {
    const companyId = await this.requireActiveAdminCompany(user);
    this.assertOutboxBroadcastAvailable();
    const task = await this.prisma.whatsAppBroadcastTask.findFirst({
      where: { id, companyId },
    });
    if (!task) return { success: false, message: 'Task not found' };
    if (!['pending', 'scheduled', 'sending'].includes(task.status)) {
      return { success: false, message: 'Task can no longer be cancelled' };
    }

    const cancelled = await this.prisma.whatsAppBroadcastTask.updateMany({
      where: {
        id,
        companyId,
        status: { in: ['pending', 'scheduled', 'sending'] },
      },
      data: { status: 'cancelled' },
    });
    if (cancelled.count !== 1) {
      return { success: false, message: 'Broadcast task changed before cancellation' };
    }
    const updated = await this.prisma.whatsAppBroadcastTask.findFirst({
      where: { id, companyId },
    });
    this.logger.log(`[Broadcast] Task cancelled: ${id}`);
    return { success: true, data: updated };
  }

  @Post('tasks/:id/progress')
  @ApiOperation({ summary: 'Update a WhatsApp broadcast task progress' })
  async updateProgress(
    @Param('id') _id: string,
    @Body() _body: {
      sentCount: number;
      failedCount: number;
      status?: string;
    },
    @CurrentUser() user: any,
  ) {
    await this.requireActiveAdminCompany(user);
    this.assertOutboxBroadcastAvailable();
    throw new ServiceUnavailableException(
      'Client-reported broadcast progress is disabled until a trusted worker is available',
    );
  }

  @Get('templates')
  @ApiOperation({ summary: 'List WhatsApp broadcast templates' })
  async getTemplates(@CurrentUser() user: any) {
    await this.requireActiveAdminCompany(user);
    this.assertOutboxBroadcastAvailable();
    return {
      success: true,
      data: [
        {
          id: 'tpl-1',
          name: 'New product introduction',
          content:
            'Hello {name}, we have new packaging products available. Would you like to receive our latest catalog?',
        },
        {
          id: 'tpl-2',
          name: 'Seasonal greeting',
          content:
            'Hi {name}, wishing you a prosperous new year! Thank you for your continued partnership.',
        },
        {
          id: 'tpl-3',
          name: 'Promotion notice',
          content:
            'Dear {name}, special offer on selected packaging materials this month. Contact us for details.',
        },
        {
          id: 'tpl-4',
          name: 'Follow-up reminder',
          content:
            'Hi {name}, just following up on our previous conversation about {product}. Any updates?',
        },
      ],
    };
  }

  private isOutboxBroadcastAvailable() {
    return false;
  }

  private assertOutboxBroadcastAvailable() {
    if (!this.isOutboxBroadcastAvailable()) {
      throw new ServiceUnavailableException(
        'WhatsApp broadcast is disabled until every recipient is reserved through ExternalActionOutbox',
      );
    }
  }

  private async requireActiveAdminCompany(user: any) {
    const companyId = String(user?.activeCompanyId || '').trim();
    if (
      !companyId
      || (user?.activeCompany?.id && user.activeCompany.id !== companyId)
      || !user?.id
    ) {
      throw new ForbiddenException('An authenticated active company is required');
    }
    const relation = await this.prisma.userCompanyRelation.findFirst({
      where: {
        userId: user.id,
        companyId,
        isActive: true,
        user: { is: { isActive: true, deletedAt: null } },
        company: { is: { isActive: true } },
      },
      include: { role: { select: { name: true } } },
    });
    if (!['super_admin', 'company_admin'].includes(String(relation?.role?.name || ''))) {
      throw new ForbiddenException('Company administrator role is required for WhatsApp broadcast');
    }
    return companyId;
  }
}

interface CreateBroadcastTaskDto {
  companyId?: string;
  taskName?: string;
  accountId: string;
  template: string;
  recipients: Array<{ phone: string; name?: string; leadId?: string }>;
  scheduledAt?: string;
}
