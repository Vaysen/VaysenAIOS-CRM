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
}
