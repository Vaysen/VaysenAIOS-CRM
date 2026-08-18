import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Res,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { LeadsService } from './leads.service';
import { LeadScoresService } from '../lead-scores/lead-scores.service';
import { AiCoachService } from './ai-coach.service';
import { CreateLeadDto } from './dto/create-lead.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import { UpdateLeadStatusDto } from './dto/update-lead-status.dto';
import { BatchOperationDto } from './dto/batch-operation.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Leads')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('leads')
export class LeadsController {
  constructor(
    private readonly leadsService: LeadsService,
    private readonly leadScoresService: LeadScoresService,
    private readonly aiCoachService: AiCoachService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List all leads' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, description: 'Filter by status (comma-separated)' })
  @ApiQuery({ name: 'country', required: false, description: 'Filter by country (comma-separated)' })
  @ApiQuery({ name: 'productCategory', required: false, description: 'Filter by product category' })
  @ApiQuery({ name: 'ownerUserId', required: false, description: 'Filter by owner' })
  @ApiQuery({ name: 'leadGrade', required: false, description: 'Filter by grade (comma-separated)' })
  @ApiQuery({ name: 'search', required: false, description: 'Search by company name, email, website, contact name' })
  @ApiQuery({ name: 'sortBy', required: false, description: 'Sort: score (high-low), score_asc (low-high), name (A-Z)' })
  @ApiQuery({ name: 'reviewStatus', required: false, description: 'Filter by review status (comma-separated)' })
  @ApiQuery({ name: 'sentFrom', required: false, description: 'Filter leads with email sent from date (ISO)' })
  @ApiQuery({ name: 'sentTo', required: false, description: 'Filter leads with email sent to date (ISO)' })
  @ApiQuery({ name: 'hasEmailHistory', required: false, description: 'Only leads with email history' })
  @ApiQuery({ name: 'sourceType', required: false, description: 'Filter by source type' })
  @ApiQuery({ name: 'tagId', required: false, description: 'Filter by tag id' })
  @ApiQuery({ name: 'emailVerificationStatus', required: false, description: 'Filter by email verification status' })
  @ApiQuery({ name: 'outreachRound', required: false, description: 'Filter prospect pool by current outreach round' })
  @ApiQuery({ name: 'engagement', required: false, description: 'Filter by engagement: opened/clicked/replied' })
  @ApiQuery({ name: 'includeReplied', required: false, description: 'Include replied leads in prospect pool filters' })
  @ApiQuery({ name: 'createdAfter', required: false, description: 'Filter leads created after date (ISO)' })
  @ApiQuery({ name: 'createdBefore', required: false, description: 'Filter leads created before date (ISO)' })
  findAll(
    @CurrentUser() user: any,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('status') status?: string,
    @Query('country') country?: string,
    @Query('productCategory') productCategory?: string,
    @Query('ownerUserId') ownerUserId?: string,
    @Query('leadGrade') leadGrade?: string,
    @Query('search') search?: string,
    @Query('sortBy') sortBy?: string,
    @Query('reviewStatus') reviewStatus?: string,
    @Query('sentFrom') sentFrom?: string,
    @Query('sentTo') sentTo?: string,
    @Query('hasEmailHistory') hasEmailHistory?: string,
    @Query('sourceType') sourceType?: string,
    @Query('tagId') tagId?: string,
    @Query('emailVerificationStatus') emailVerificationStatus?: string,
    @Query('outreachRound') outreachRound?: string,
    @Query('engagement') engagement?: string,
    @Query('includeReplied') includeReplied?: string,
    @Query('createdAfter') createdAfter?: string,
    @Query('createdBefore') createdBefore?: string,
  ) {
    return this.leadsService.findAll(user, {
      page, limit, status, country, productCategory, ownerUserId, leadGrade, search, sortBy, reviewStatus, sentFrom, sentTo, hasEmailHistory, sourceType, tagId, emailVerificationStatus, outreachRound, engagement, includeReplied, createdAfter, createdBefore,
    });
  }

  @Post('batch')
  @ApiOperation({ summary: 'Batch operation on leads (update status or delete)' })
  batchOperation(@Body() dto: BatchOperationDto, @CurrentUser() user: any) {
    return this.leadsService.batchOperation(dto, user);
  }

  @Post('external-sync')
  @ApiOperation({ summary: 'Sync leads from external agent markdown archive' })
  syncExternalMarkdownLeads(@CurrentUser() user: any) {
    return this.leadsService.syncExternalMarkdownLeads(user);
  }

  @Get('external-sync')
  @ApiOperation({ summary: 'Get external agent markdown lead pool' })
  getExternalMarkdownPool(
    @CurrentUser() user: any,
    @Query('date') date?: string,
    @Query('assigned') assigned?: string,
    @Query('dateRange') dateRange?: string,
    @Query('emailVerificationBucket') emailVerificationBucket?: string,
  ) {
    return this.leadsService.getExternalMarkdownPool(user, { date, assigned, dateRange, emailVerificationBucket });
  }

  @Post('external-sync/distribute')
  @ApiOperation({ summary: 'Equally distribute external markdown leads to sales users' })
  distributeExternalMarkdownLeads(
    @Body() dto: { date?: string; dateRange?: string; userIds?: string[] },
    @CurrentUser() user: any,
  ) {
    return this.leadsService.distributeExternalMarkdownLeads(user, dto);
  }

  @Post('external-sync/assign')
  @ApiOperation({ summary: 'Manually assign external markdown leads to one sales user' })
  assignExternalMarkdownLeads(
    @Body() dto: { leadIds: string[]; ownerUserId: string },
    @CurrentUser() user: any,
  ) {
    return this.leadsService.assignExternalMarkdownLeads(user, dto);
  }

  @Post('verify-emails')
  @ApiOperation({ summary: 'Batch verify lead email authenticity' })
  verifyLeadEmails(
    @Body() dto: { leadIds?: string[]; assigned?: string; date?: string; dateRange?: string; sourceTypes?: string[] },
    @CurrentUser() user: any,
  ) {
    return this.leadsService.verifyLeadEmails(user, dto);
  }

  @Post(':id/verify-email')
  @ApiOperation({ summary: 'Verify a single lead email authenticity' })
  verifyLeadEmail(@Param('id') id: string, @CurrentUser() user: any) {
    return this.leadsService.verifyLeadEmail(user, id);
  }

  @Get('assignment-notices')
  @ApiOperation({ summary: 'Get current user assignment notices' })
  getAssignmentNotices(@CurrentUser() user: any) {
    return this.leadsService.getAssignmentNotices(user);
  }

  @Post('assignment-notices/read')
  @ApiOperation({ summary: 'Mark current user assignment notices as read' })
  markAssignmentNoticesRead(@CurrentUser() user: any) {
    return this.leadsService.markAssignmentNoticesRead(user);
  }

  @Get('export')
  @ApiOperation({ summary: 'Export leads as CSV or Excel' })
  @ApiQuery({ name: 'format', required: false, enum: ['csv', 'xlsx'] })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'country', required: false })
  @ApiQuery({ name: 'productCategory', required: false })
  @ApiQuery({ name: 'ownerUserId', required: false })
  @ApiQuery({ name: 'leadGrade', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'reviewStatus', required: false })
  async exportLeads(
    @CurrentUser() user: any,
    @Query('format') format?: string,
    @Query('status') status?: string,
    @Query('country') country?: string,
    @Query('productCategory') productCategory?: string,
    @Query('ownerUserId') ownerUserId?: string,
    @Query('leadGrade') leadGrade?: string,
    @Query('search') search?: string,
    @Query('reviewStatus') reviewStatus?: string,
    @Res() res?: any,
  ) {
    const exportFormat = (format === 'xlsx' ? 'xlsx' : 'csv') as 'csv' | 'xlsx';
    const result = await this.leadsService.exportLeads(user, {
      status, country, productCategory, ownerUserId, leadGrade, search, reviewStatus,
    }, exportFormat);

    res.set({
      'Content-Type': result.contentType,
      'Content-Disposition': `attachment; filename="${result.filename}"`,
    });

    if (exportFormat === 'csv') {
      res.send(result.data);
    } else {
      res.send(result.data);
    }
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get lead details' })
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.leadsService.findOne(id, user);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new lead' })
  @ApiResponse({ status: 201, description: 'Lead created' })
  create(@Body() dto: CreateLeadDto, @CurrentUser() user: any) {
    return this.leadsService.create(dto, user);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update lead information' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateLeadDto,
    @CurrentUser() user: any,
  ) {
    return this.leadsService.update(id, dto, user);
  }

  @Patch(':id/language')
  @ApiOperation({ summary: 'Update lead language preference' })
  updateLanguage(
    @Param('id') id: string,
    @Body() body: { language: string },
    @CurrentUser() user: any,
  ) {
    return this.leadsService.updateLanguage(id, body.language, user);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft delete a lead' })
  @ApiResponse({ status: 200, description: 'Lead deleted' })
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.leadsService.remove(id, user);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Update lead status' })
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateLeadStatusDto,
    @CurrentUser() user: any,
  ) {
    return this.leadsService.updateStatus(id, dto, user);
  }

  @Post('calculate-scores')
  @ApiOperation({ summary: 'Batch calculate scores for all leads in company' })
  @ApiResponse({ status: 201, description: 'Scores calculated' })
  calculateScores(@CurrentUser() user: any) {
    return this.leadScoresService.calculateAllForCompany(user);
  }

  @Post(':id/calculate-score')
  @ApiOperation({ summary: 'Calculate/recalculate score for a lead' })
  @ApiResponse({ status: 201, description: 'Score calculated' })
  calculateScore(@Param('id') id: string, @CurrentUser() user: any) {
    return this.leadScoresService.calculateAndSave(id, user);
  }

  @Get(':id/score')
  @ApiOperation({ summary: 'Get score history for a lead' })
  getScore(@Param('id') id: string, @CurrentUser() user: any) {
    return this.leadScoresService.getScoreForLead(id, user);
  }

  @Post(':id/ai-coach')
  @ApiOperation({ summary: 'AI sales coach analysis for a lead' })
  @ApiResponse({ status: 201, description: 'AI analysis completed' })
  getAiCoach(@Param('id') id: string, @CurrentUser() user: any) {
    return this.aiCoachService.analyze(id, user);
  }

  @Post(':id/tags')
  @ApiOperation({ summary: 'Add tags to a lead' })
  addTags(@Param('id') id: string, @Body() dto: { tagIds: string[] }, @CurrentUser() user: any) {
    return this.leadsService.addTagsToLead(id, dto.tagIds, user);
  }

  @Delete(':id/tags/:tagId')
  @ApiOperation({ summary: 'Remove a tag from a lead' })
  removeTag(@Param('id') id: string, @Param('tagId') tagId: string, @CurrentUser() user: any) {
    return this.leadsService.removeTagFromLead(id, tagId, user);
  }

  @Put(':id/pin')
  @ApiOperation({ summary: 'Pin a lead (user-level)' })
  pinLead(@Param('id') id: string, @CurrentUser() user: any) {
    return this.leadsService.pinLead(id, user);
  }

  @Delete(':id/pin')
  @ApiOperation({ summary: 'Unpin a lead' })
  unpinLead(@Param('id') id: string, @CurrentUser() user: any) {
    return this.leadsService.unpinLead(id, user);
  }
}
