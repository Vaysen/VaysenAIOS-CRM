/**
 * WhatsApp 群发营销 Controller
 *
 * 提供群发任务的创建、查询、取消等功能
 * 群发任务通过 Electron 客户端逐条执行（调用 WhatsApp Web DOM 注入）
 */

import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Patch,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';

@ApiTags('WhatsApp Broadcast')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('whatsapp/broadcast')
export class BroadcastController {
  private readonly logger = new Logger(BroadcastController.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 创建群发任务
   */
  @Post('tasks')
  @ApiOperation({ summary: '创建 WhatsApp 群发任务' })
  async createTask(
    @Body() body: CreateBroadcastTaskDto,
    @CurrentUser() user: any,
  ) {
    const companyId = user.companyId || body.companyId;

    // 验证目标人数
    if (!body.recipients || body.recipients.length === 0) {
      return { success: false, message: '请至少选择一个目标客户' };
    }
    if (body.recipients.length > 50) {
      return { success: false, message: '单次群发不超过 50 人' };
    }

    // 创建群发任务
    const task = await this.prisma.whatsAppBroadcastTask.create({
      data: {
        companyId,
        taskName: body.taskName || `群发任务-${new Date().toLocaleString('zh-CN')}`,
        accountId: body.accountId || 'default',
        template: body.template,
        recipientCount: body.recipients.length,
        recipients: JSON.stringify(body.recipients),
        status: body.scheduledAt ? 'scheduled' : 'pending',
        scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
        createdBy: user.id,
      },
    });

    this.logger.log(`[Broadcast] 群发任务已创建: ${task.id}, 目标 ${body.recipients.length} 人`);

    return { success: true, data: task };
  }

  /**
   * 获取群发任务列表
   */
  @Get('tasks')
  @ApiOperation({ summary: '获取群发任务列表' })
  async getTasks(
    @CurrentUser() user: any,
    @Query('status') status?: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    const companyId = user.companyId;
    const pageNum = parseInt(page) || 1;
    const limitNum = Math.min(parseInt(limit) || 20, 100);

    const where: any = { companyId };
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
      data: tasks.map((t) => ({
        ...t,
        recipients: JSON.parse(t.recipients || '[]'),
      })),
      pagination: { page: pageNum, limit: limitNum, total },
    };
  }

  /**
   * 获取群发任务详情
   */
  @Get('tasks/:id')
  @ApiOperation({ summary: '获取群发任务详情' })
  async getTaskDetail(@Param('id') id: string, @CurrentUser() user: any) {
    const task = await this.prisma.whatsAppBroadcastTask.findFirst({
      where: { id, companyId: user.companyId },
    });

    if (!task) {
      return { success: false, message: '任务不存在' };
    }

    return {
      success: true,
      data: {
        ...task,
        recipients: JSON.parse(task.recipients || '[]'),
      },
    };
  }

  /**
   * 取消群发任务
   */
  @Patch('tasks/:id/cancel')
  @ApiOperation({ summary: '取消群发任务' })
  async cancelTask(@Param('id') id: string, @CurrentUser() user: any) {
    const task = await this.prisma.whatsAppBroadcastTask.findFirst({
      where: { id, companyId: user.companyId },
    });

    if (!task) {
      return { success: false, message: '任务不存在' };
    }

    if (!['pending', 'scheduled', 'sending'].includes(task.status)) {
      return { success: false, message: '任务已完成或已取消' };
    }

    const updated = await this.prisma.whatsAppBroadcastTask.update({
      where: { id },
      data: { status: 'cancelled' },
    });

    this.logger.log(`[Broadcast] 群发任务已取消: ${id}`);
    return { success: true, data: updated };
  }

  /**
   * 更新群发任务进度（Electron 客户端回调）
   */
  @Post('tasks/:id/progress')
  @ApiOperation({ summary: '更新群发任务进度' })
  async updateProgress(
    @Param('id') id: string,
    @Body() body: { sentCount: number; failedCount: number; status?: string },
    @CurrentUser() user: any,
  ) {
    const task = await this.prisma.whatsAppBroadcastTask.findFirst({
      where: { id, companyId: user.companyId },
    });

    if (!task) {
      return { success: false, message: '任务不存在' };
    }

    const newStatus = body.status || (body.sentCount + body.failedCount >= task.recipientCount ? 'completed' : 'sending');

    const updated = await this.prisma.whatsAppBroadcastTask.update({
      where: { id },
      data: {
        sentCount: body.sentCount,
        failedCount: body.failedCount,
        status: newStatus,
        completedAt: newStatus === 'completed' ? new Date() : null,
      },
    });

    return { success: true, data: updated };
  }

  /**
   * 获取群发模板列表
   */
  @Get('templates')
  @ApiOperation({ summary: '获取群发消息模板列表' })
  async getTemplates(@CurrentUser() user: any) {
    // 从系统设置中获取模板（暂用固定模板）
    const defaultTemplates = [
      { id: 'tpl-1', name: '新品推介', content: 'Hello {name}, we have new packaging products available. Would you like to receive our latest catalog?' },
      { id: 'tpl-2', name: '节日问候', content: 'Hi {name}, wishing you a prosperous new year! Thank you for your continued partnership.' },
      { id: 'tpl-3', name: '促销通知', content: 'Dear {name}, special offer on selected packaging materials this month. Contact us for details.' },
      { id: 'tpl-4', name: '跟进提醒', content: 'Hi {name}, just following up on our previous conversation about {product}. Any updates?' },
    ];

    return { success: true, data: defaultTemplates };
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
