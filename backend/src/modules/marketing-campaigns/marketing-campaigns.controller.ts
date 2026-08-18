import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { MarketingCampaignsService } from './marketing-campaigns.service';
import { CreateMarketingCampaignDto } from './dto/create-marketing-campaign.dto';
import { UpdateMarketingCampaignDto } from './dto/update-marketing-campaign.dto';
import { CampaignTransitionDto } from './dto/campaign-transition.dto';
import { ChannelPlanDto, UpdateChannelPlanDto } from './dto/channel-plan.dto';
import { AudienceSnapshotDto } from './dto/audience-snapshot.dto';
import { CreateContentVersionDto } from './dto/content-version.dto';
import { LinkCampaignSegmentDto } from './dto/campaign-segment.dto';
import { RecordAttributionDto } from './dto/attribution.dto';
import { MARKETING_CAMPAIGN_TEMPLATES } from './marketing-campaign-templates';

@ApiTags('Marketing Campaigns')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('marketing-campaigns')
export class MarketingCampaignsController {
  constructor(private readonly service: MarketingCampaignsService) {}

  @Get()
  list(@CurrentUser() user: any) {
    return this.service.list(user);
  }

  @Post()
  create(@Body() dto: CreateMarketingCampaignDto, @CurrentUser() user: any) {
    return this.service.create(dto, user);
  }

  // 预设模板（常量数组，不落库；需在 :id 路由之前声明）
  @Get('templates')
  templates() {
    return MARKETING_CAMPAIGN_TEMPLATES;
  }

  // R111 批次D：活动级互动合表（数据看板；固定字面量路由需在 :id 之前声明）
  @Get('engagement')
  @ApiOperation({ summary: '活动级互动合表（memberCount + EmailMessage 互动聚合）' })
  @ApiQuery({ name: 'limit', required: false, description: '条数，默认 20' })
  @ApiQuery({ name: 'channel', required: false, description: '按渠道过滤（email/whatsapp）' })
  engagement(@CurrentUser() user: any, @Query() query: any) {
    return this.service.getEngagement(user, query);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.get(id, user);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateMarketingCampaignDto, @CurrentUser() user: any) {
    return this.service.update(id, dto, user);
  }

  @Post(':id/transitions')
  transition(
    @Param('id') id: string,
    @Body() dto: CampaignTransitionDto,
    @CurrentUser() user: any,
  ) {
    return this.service.transition(id, dto.action, dto, user);
  }

  @Get(':id/events')
  events(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.events(id, user);
  }

  // --------------------------------------------------------- channel plans

  @Get(':id/channel-plans')
  listChannelPlans(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.listChannelPlans(id, user);
  }

  @Post(':id/channel-plans')
  addChannelPlan(@Param('id') id: string, @Body() dto: ChannelPlanDto, @CurrentUser() user: any) {
    return this.service.addChannelPlan(id, dto, user);
  }

  @Patch(':id/channel-plans/:planId')
  updateChannelPlan(
    @Param('id') id: string,
    @Param('planId') planId: string,
    @Body() dto: UpdateChannelPlanDto,
    @CurrentUser() user: any,
  ) {
    return this.service.updateChannelPlan(id, planId, dto, user);
  }

  @Delete(':id/channel-plans/:planId')
  removeChannelPlan(@Param('id') id: string, @Param('planId') planId: string, @CurrentUser() user: any) {
    return this.service.removeChannelPlan(id, planId, user);
  }

  // -------------------------------------------------------------- audience

  @Get(':id/audience')
  audience(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.listAudience(id, user);
  }

  @Post(':id/audience')
  snapshotAudience(@Param('id') id: string, @Body() dto: AudienceSnapshotDto, @CurrentUser() user: any) {
    return this.service.snapshotAudience(id, dto, user);
  }

  // ------------------------------------------------------- campaign segments

  @Get(':id/segments')
  segments(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.listSegments(id, user);
  }

  @Post(':id/segments')
  linkSegment(@Param('id') id: string, @Body() dto: LinkCampaignSegmentDto, @CurrentUser() user: any) {
    return this.service.linkSegment(id, dto, user);
  }

  @Delete(':id/segments/:segmentId')
  unlinkSegment(
    @Param('id') id: string,
    @Param('segmentId') segmentId: string,
    @CurrentUser() user: any,
  ) {
    return this.service.unlinkSegment(id, segmentId, user);
  }

  // -------------------------------------------------------- content versions

  @Get(':id/content-versions')
  contentVersions(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.listContentVersions(id, user);
  }

  @Post(':id/content-versions')
  createContentVersion(@Param('id') id: string, @Body() dto: CreateContentVersionDto, @CurrentUser() user: any) {
    return this.service.createContentVersion(id, dto, user);
  }

  @Post(':id/content-versions/:versionId/activate')
  activateContentVersion(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @CurrentUser() user: any,
  ) {
    return this.service.activateContentVersion(id, versionId, user);
  }

  // ---------------------------------------------------------- preflight runs

  @Get(':id/preflight-runs')
  preflightRuns(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.listPreflightRuns(id, user);
  }

  @Post(':id/preflight-runs')
  runPreflight(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.runPreflight(id, user);
  }

  // ------------------------------------------------------------- attributions

  @Get(':id/attributions')
  attributions(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.listAttributions(id, user);
  }

  @Post(':id/attributions')
  recordAttribution(@Param('id') id: string, @Body() dto: RecordAttributionDto, @CurrentUser() user: any) {
    return this.service.recordAttribution(id, dto, user);
  }

  // ---------------------------------------------------------------- schedule

  @Post(':id/schedule')
  materializeSchedule(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.materializeSchedule(id, user);
  }
}
