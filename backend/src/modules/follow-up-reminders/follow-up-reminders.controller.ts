import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery, ApiParam } from '@nestjs/swagger';
import { FollowUpRemindersService } from './follow-up-reminders.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { QueryFollowUpRemindersDto } from './dto/query-follow-up-reminders.dto';
import { GenerateRemindersDto } from './dto/generate-reminders.dto';
import { SnoozeReminderDto } from './dto/snooze-reminder.dto';

@ApiTags('Follow-up Reminders')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('follow-up-reminders')
export class FollowUpRemindersController {
  constructor(private readonly followUpRemindersService: FollowUpRemindersService) {}

  @Get()
  @ApiOperation({ summary: 'Get follow-up reminder list' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, description: 'Pending, Completed, Ignored, Snoozed, Cancelled, Overdue' })
  @ApiQuery({ name: 'reminderType', required: false })
  @ApiQuery({ name: 'priority', required: false, description: 'Low, Medium, High, Urgent' })
  @ApiQuery({ name: 'leadId', required: false })
  @ApiQuery({ name: 'userId', required: false })
  @ApiQuery({ name: 'dueFrom', required: false })
  @ApiQuery({ name: 'dueTo', required: false })
  @ApiQuery({ name: 'overdue', required: false, type: Boolean })
  @ApiQuery({ name: 'search', required: false })
  findAll(@CurrentUser() user: any, @Query() query: QueryFollowUpRemindersDto) {
    return this.followUpRemindersService.findAll(user, query);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get reminder statistics for dashboard' })
  getStats(@CurrentUser() user: any) {
    return this.followUpRemindersService.getStats(user);
  }

  @Get('by-lead/:leadId')
  @ApiOperation({ summary: 'Get reminders for a specific lead' })
  @ApiParam({ name: 'leadId', description: 'Lead ID' })
  findByLead(@Param('leadId') leadId: string, @CurrentUser() user: any) {
    return this.followUpRemindersService.findByLead(leadId, user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get reminder detail' })
  @ApiParam({ name: 'id', description: 'Reminder ID' })
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.followUpRemindersService.findOne(id, user);
  }

  @Post('generate')
  @ApiOperation({ summary: 'Manually trigger reminder generation' })
  generate(@CurrentUser() user: any, @Body() dto?: GenerateRemindersDto) {
    return this.followUpRemindersService.generateReminders(user, dto);
  }

  @Patch(':id/complete')
  @ApiOperation({ summary: 'Mark reminder as completed' })
  @ApiParam({ name: 'id', description: 'Reminder ID' })
  complete(@Param('id') id: string, @CurrentUser() user: any) {
    return this.followUpRemindersService.complete(id, user);
  }

  @Patch(':id/ignore')
  @ApiOperation({ summary: 'Ignore reminder' })
  @ApiParam({ name: 'id', description: 'Reminder ID' })
  ignore(@Param('id') id: string, @CurrentUser() user: any) {
    return this.followUpRemindersService.ignore(id, user);
  }

  @Patch(':id/snooze')
  @ApiOperation({ summary: 'Snooze reminder' })
  @ApiParam({ name: 'id', description: 'Reminder ID' })
  snooze(@Param('id') id: string, @Body() dto: SnoozeReminderDto, @CurrentUser() user: any) {
    return this.followUpRemindersService.snooze(id, dto, user);
  }
}
