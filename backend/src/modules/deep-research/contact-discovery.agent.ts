import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { DataGathererService } from './data-gatherer.service';
import { ResearchAgentResult, ResearchExecutionOptions } from './research-agent.types';

@Injectable()
export class ContactDiscoveryAgent {
  constructor(
    private prisma: PrismaService,
    private gatherer: DataGathererService,
  ) {}

  async discover(
    lead: any,
    userId: string,
    options: ResearchExecutionOptions = {},
  ): Promise<ResearchAgentResult> {
    const gathered = await this.gatherer.gatherAll(
      lead.companyName,
      lead.website || '',
      lead.country || '',
    );

    if (!gathered?.html || !gathered?.json) {
      throw new Error(gathered?.error || '联系人深挖采集失败，未获得可核验的公开证据。');
    }

    const title = `${lead.companyName} - 联系人深挖报告`;
    const reportId = await this.archiveReport(
      lead.id, lead.companyId, 'contacts', title, gathered.html, gathered.json, userId, options.agentRunId,
    );
    return { reportId, html: gathered.html, json: gathered.json, title };
  }

  private async archiveReport(
    leadId: string, companyId: string, type: string, title: string, html: string, json: any,
    userId: string, agentRunId?: string,
  ) {
    const data = { agentRunId, leadId, companyId, type, title, htmlContent: html, jsonData: json, createdBy: userId };
    const report = agentRunId
      ? await this.prisma.deepResearchReport.upsert({
          where: { agentRunId }, create: data, update: {}, select: { id: true },
        })
      : await this.prisma.deepResearchReport.create({ data, select: { id: true } });
    return report.id;
  }
}
