import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { PrismaService } from '@/common/prisma/prisma.service';
import {
  DeepResearchOperator,
  DeepResearchRunService,
  DeepResearchType,
} from './deep-research-run.service';
import { StartDeepResearchDto } from './dto/start-deep-research.dto';
import { AgentRunStatus, Prisma } from '@prisma/client';

@ApiTags('AI Deep Research')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('leads')
export class DeepResearchController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly researchRuns: DeepResearchRunService,
  ) {}

  @Post(':id/deep-research')
  async deepResearch(
    @Param('id') id: string,
    @Body() dto: StartDeepResearchDto,
    @CurrentUser() user: DeepResearchOperator,
  ) {
    const lead = await this.findScopedLead(id, user);
    const type = this.parseResearchType(dto.type);
    const run = await this.researchRuns.enqueueForLead({
      companyId: lead.companyId,
      leadId: lead.id,
      type,
      source: 'lead_detail',
      requestKey: this.requestKey(lead.companyId, user.id, dto.requestId),
    }, user);

    const queued = run.status === AgentRunStatus.PENDING;
    const messageByStatus: Partial<Record<AgentRunStatus, string>> = {
      [AgentRunStatus.PENDING]: 'Deep research queued. Progress is available in the AI assistant task list.',
      [AgentRunStatus.RUNNING]: 'The same deep research request is already running.',
      [AgentRunStatus.COMPLETED]: 'The same deep research request already completed.',
      [AgentRunStatus.FAILED]: 'The same deep research request already failed and was not re-queued.',
      [AgentRunStatus.CANCELLED]: 'The same deep research request was cancelled and was not re-queued.',
    };
    return {
      queued,
      status: run.status,
      agentRunId: run.id,
      message: messageByStatus[run.status as AgentRunStatus] || 'Deep research request is not queueable.',
    };
  }

  @Get(':id/research-reports')
  async listReports(@Param('id') id: string, @CurrentUser() user: DeepResearchOperator) {
    const lead = await this.findScopedLead(id, user);
    const reports = await this.prisma.deepResearchReport.findMany({
      where: {
        leadId: lead.id,
        companyId: lead.companyId,
        ...this.completedReportVisibility(),
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, type: true, title: true, createdAt: true },
    });
    return { data: reports };
  }

  @Get(':id/research-reports/:reportId')
  async getReport(
    @Param('id') id: string,
    @Param('reportId') reportId: string,
    @CurrentUser() user: DeepResearchOperator,
  ) {
    const lead = await this.findScopedLead(id, user);
    const report = await this.prisma.deepResearchReport.findFirst({
      where: {
        id: reportId,
        leadId: lead.id,
        companyId: lead.companyId,
        ...this.completedReportVisibility(),
      },
    });
    if (!report) throw new NotFoundException('Report not found');
    return { html: report.htmlContent, json: report.jsonData, type: report.type, title: report.title };
  }

  @Delete(':id/research-reports/:reportId')
  async deleteReport(
    @Param('id') id: string,
    @Param('reportId') reportId: string,
    @CurrentUser() user: DeepResearchOperator,
  ) {
    const lead = await this.findScopedLead(id, user);
    const deleted = await this.prisma.deepResearchReport.deleteMany({
      where: {
        id: reportId,
        leadId: lead.id,
        companyId: lead.companyId,
        ...this.completedReportVisibility(),
      },
    });
    if (deleted.count !== 1) throw new NotFoundException('Report not found');
    return { message: 'Report deleted' };
  }

  private async findScopedLead(id: string, user: DeepResearchOperator) {
    if (!user?.id || !user.companies?.length) throw new ForbiddenException('No company access');
    const scopes = user.companies.map((company) => (
      ['company_admin', 'super_admin'].includes(company.role)
        ? { companyId: company.id }
        : { companyId: company.id, ownerUserId: user.id }
    ));
    const lead = await this.prisma.lead.findFirst({
      where: { id, deletedAt: null, OR: scopes },
      select: { id: true, companyId: true },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    return lead;
  }

  private parseResearchType(value: string | undefined): DeepResearchType {
    const type = value || 'full';
    if (!['full', 'contacts', 'market'].includes(type)) {
      throw new BadRequestException('Unsupported research type');
    }
    return type as DeepResearchType;
  }

  private requestKey(companyId: string, userId: string, requestId: string) {
    return `lead-detail:${companyId}:${userId}:${requestId}`;
  }

  private completedReportVisibility(): Prisma.DeepResearchReportWhereInput {
    // Legacy, manually-authored reports have no AgentRun. A report produced by
    // the assistant is publishable only after the owning run reached its
    // durable COMPLETED state; archived output from RUNNING/FAILED/CANCELLED
    // work must never leak through the customer report API.
    return {
      OR: [
        { agentRunId: null },
        { agentRun: { is: { status: AgentRunStatus.COMPLETED } } },
      ],
    };
  }
}
