import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Analytics')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Get analytics overview data' })
  @ApiQuery({ name: 'days', required: false, description: 'Relative day range, defaults to 30' })
  @ApiQuery({ name: 'startDate', required: false, description: 'Custom range start date' })
  @ApiQuery({ name: 'endDate', required: false, description: 'Custom range end date' })
  @ApiQuery({ name: 'ownerUserId', required: false, description: 'Filter by salesperson owner, admin only' })
  getOverview(@CurrentUser() user: any, @Query() query: any) {
    return this.analyticsService.getOverview(user, query);
  }

  @Get('trends')
  @ApiOperation({ summary: 'Get monthly lead creation trend (last 12 months)' })
  getTrends(@CurrentUser() user: any) {
    return this.analyticsService.getTrends(user);
  }

  @Get('email-trends')
  @ApiOperation({ summary: 'Get daily email trend (last 30 days)' })
  @ApiQuery({ name: 'days', required: false, description: 'Relative day range, defaults to 30' })
  @ApiQuery({ name: 'startDate', required: false, description: 'Custom range start date' })
  @ApiQuery({ name: 'endDate', required: false, description: 'Custom range end date' })
  @ApiQuery({ name: 'ownerUserId', required: false, description: 'Filter by salesperson owner, admin only' })
  getEmailTrends(@CurrentUser() user: any, @Query() query: any) {
    return this.analyticsService.getEmailTrends(user, query);
  }

  // ---------------------------------------------------------- R111 批次D

  @Get('engagement-trends')
  @ApiOperation({ summary: '邮件互动率趋势（每日 sent/opened/clicked/replied 及率）' })
  @ApiQuery({ name: 'days', required: false, description: '相对天数，默认 30' })
  @ApiQuery({ name: 'startDate', required: false, description: '自定义范围起始日期' })
  @ApiQuery({ name: 'endDate', required: false, description: '自定义范围结束日期' })
  @ApiQuery({ name: 'ownerUserId', required: false, description: '按销售负责人过滤，仅管理员' })
  getEngagementTrends(@CurrentUser() user: any, @Query() query: any) {
    return this.analyticsService.getEngagementTrends(user, query);
  }

  @Get('mail-center-trends')
  @ApiOperation({ summary: '邮件中心收发信日趋势（inbound/outbound）' })
  @ApiQuery({ name: 'days', required: false, description: '相对天数，默认 7' })
  getMailCenterTrends(@CurrentUser() user: any, @Query() query: any) {
    return this.analyticsService.getMailCenterTrends(user, query);
  }

  @Get('sources')
  @ApiOperation({ summary: '询盘来源分布（Lead groupBy sourceType）' })
  getSources(@CurrentUser() user: any) {
    return this.analyticsService.getSources(user);
  }

  @Get('whatsapp-stats')
  @ApiOperation({ summary: 'WhatsApp 聚合统计（会话/消息/已读/未读）' })
  getWhatsappStats(@CurrentUser() user: any) {
    return this.analyticsService.getWhatsappStats(user);
  }
}
