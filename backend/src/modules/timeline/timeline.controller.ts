import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TimelineService } from './timeline.service';
import { QueryTimelineDto } from './dto/query-timeline.dto';
import { CreateActivityDto } from './dto/create-activity.dto';
import { UpdateActivityDto } from './dto/update-activity.dto';

@ApiTags('Timeline')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class TimelineController {
  constructor(private readonly timelineService: TimelineService) {}

  @Get('activities')
  @ApiOperation({ summary: 'Get global activity list' })
  findAllActivities(@Query() query: QueryTimelineDto, @CurrentUser() user: any) {
    return this.timelineService.findAllActivities(query, user);
  }

  @Get('leads/:id/timeline')
  @ApiOperation({ summary: 'Get lead timeline' })
  findTimeline(
    @Param('id') id: string,
    @Query() query: QueryTimelineDto,
    @CurrentUser() user: any,
  ) {
    return this.timelineService.findTimeline(id, query, user);
  }

  @Get('leads/:id/timeline/export')
  @ApiOperation({ summary: 'Export lead timeline as CSV' })
  async exportTimeline(
    @Param('id') id: string,
    @Query() query: QueryTimelineDto,
    @CurrentUser() user: any,
    @Res() res: Response,
  ) {
    const csv = await this.timelineService.exportTimelineCSV(id, query, user);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="timeline-${id}.csv"`);
    res.send(csv);
  }

  @Post('leads/:id/activities')
  @ApiOperation({ summary: 'Add manual activity to lead' })
  createActivity(
    @Param('id') id: string,
    @Body() dto: CreateActivityDto,
    @CurrentUser() user: any,
  ) {
    return this.timelineService.createActivity(id, dto, user);
  }

  @Get('leads/:id/activities/:activityId')
  @ApiOperation({ summary: 'Get single activity detail' })
  findOneActivity(
    @Param('id') id: string,
    @Param('activityId') activityId: string,
    @CurrentUser() user: any,
  ) {
    return this.timelineService.findOneActivity(id, activityId, user);
  }

  @Patch('leads/:id/activities/:activityId')
  @ApiOperation({ summary: 'Update a manual activity' })
  updateActivity(
    @Param('id') id: string,
    @Param('activityId') activityId: string,
    @Body() dto: UpdateActivityDto,
    @CurrentUser() user: any,
  ) {
    return this.timelineService.updateActivity(id, activityId, dto, user);
  }

  @Delete('leads/:id/activities/:activityId')
  @ApiOperation({ summary: 'Soft-delete a manual activity' })
  deleteActivity(
    @Param('id') id: string,
    @Param('activityId') activityId: string,
    @CurrentUser() user: any,
  ) {
    return this.timelineService.deleteActivity(id, activityId, user);
  }
}
