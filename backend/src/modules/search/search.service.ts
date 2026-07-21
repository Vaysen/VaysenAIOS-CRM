import { Injectable, Logger, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

function extractDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
    return host.replace(/^www\./, '');
  } catch {
    return null;
  }
}
import { PrismaService } from '@/common/prisma/prisma.service';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import OpenAI from 'openai';
import * as dns from 'dns/promises';
import { QUEUES } from '@/common/queues/queue-names';
import { createAiClient } from '@/common/ai/ai-client.util';
import { CreateSearchTaskDto } from './dto/create-search-task.dto';
import { isLegacyBusinessText, productFocusKeywords, resolveBusinessContext } from '@/common/business-context';

type EvidencePage = {
  url: string;
  text: string;
  title?: string;
};

type EvidenceProspect = {
  title: string;
  url: string;
  website?: string;
  snippet: string;
  whyTarget?: string;
  companyName: string;
  contactEmail: string;
  contactPhone: string;
  contactPerson: string;
  contactTitle: string;
  emailSource: string;
  emailConfidence: string;
  industryCategory: string;
  confidenceScore: number;
  mainProducts: string;
  hasEmail: boolean;
  isExportable?: boolean;
  isSupplier?: boolean;
  source: string;
  pipelineStage: 'ready_for_outreach' | 'manual_review' | 'rejected';
  verificationStatus: string;
  rejectionReasons: string[];
  evidenceSources: any[];
  fieldConfidence: Record<string, any>;
  emailVerification?: any;
  linkedin?: string;
  facebook?: string;
  instagram?: string;
  twitter?: string;
  pinterest?: string;
  reddit?: string;
  youtube?: string;
  tiktok?: string;
  otherSocial?: string;
  contacts?: any[];
};

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);
  private readonly zhipu: OpenAI;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUES.prospectSearch) private readonly searchQueue: Queue,
  ) {
    this.zhipu = createAiClient('prospect');
  }

  async createTask(dto: CreateSearchTaskDto, userId: string, companyId: string) {
    // Check rate limit before writing a task or placing work on the queue.
    const canSubmit = await this.checkAndIncrementRateLimit(userId, 'submit');
    if (!canSubmit.allowed) {
      throw new ForbiddenException(
        `Rate limit reached. You can submit up to 3 tasks per hour. Cooldown ends in ${canSubmit.cooldownMinutes} minutes.`,
      );
    }

    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    const keywords = dto.keywords?.length ? dto.keywords : this.defaultKeywordsForProfile(dto.customerType, company?.settings);
    const excludeWords = this.normalizeExcludeWords(dto.excludeWords || [], dto.targetCountry, dto.customerType);
    const task = await this.prisma.searchTask.create({
      data: {
        companyId,
        createdBy: userId,
        keywords,
        targetCountry: dto.targetCountry,
        customerType: dto.customerType || null,
        excludeWords,
        searchLanguage: dto.searchLanguage || 'en',
        maxResults: dto.maxResults || 20,
        status: 'pending',
      },
    });

    await this.searchQueue.add('execute-search', {
      taskId: task.id,
      keywords,
      targetCountry: dto.targetCountry,
      customerType: dto.customerType,
      excludeWords,
      searchLanguage: dto.searchLanguage || 'en',
      maxResults: dto.maxResults || 20,
    }, {
      jobId: `search-task-${task.id}`,
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100,
    });

    this.logger.log(`Search task ${task.id} queued`);
    return task;
  }

  async cancelTask(id: string, companyId: string, userId: string) {
    // Check rate limit for cancel
    const canCancel = await this.checkAndIncrementRateLimit(userId, 'cancel');
    if (!canCancel.allowed) {
      throw new ForbiddenException(
        `Rate limit reached. You can cancel up to 3 tasks per hour. Cooldown ends in ${canCancel.cooldownMinutes} minutes.`,
      );
    }

    const task = await this.prisma.searchTask.findFirst({
      where: { id, companyId },
    });
    if (!task) throw new NotFoundException('Search task not found');

    // Data isolation: only owner can cancel (unless admin)
    const isFullAccess = await this.userHasFullAccess(userId, companyId);
    if (!isFullAccess && task.createdBy !== userId) {
      throw new ForbiddenException('You can only cancel your own tasks');
    }

    if (!['pending', 'running'].includes(task.status)) {
      throw new BadRequestException('Only pending or running tasks can be cancelled');
    }

    await this.prisma.searchTask.update({
      where: { id },
      data: { status: 'cancelled', completedAt: new Date() },
    });

    return { message: 'Task cancelled' };
  }

  async getQueueStatus(companyId: string, userId?: string) {
    await Promise.all([
      this.finalizeStaleRunningTasks(companyId, userId),
      this.recoverStalePendingTasks(companyId, userId),
    ]);
    const baseWhere: any = { companyId };
    if (userId) baseWhere.createdBy = userId;

    // Running task
    const running = await this.prisma.searchTask.findFirst({
      where: { ...baseWhere, status: 'running' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, keywords: true, targetCountry: true, customerType: true, createdAt: true },
    });

    // Queued tasks (pending, ordered by creation time)
    const pending = await this.prisma.searchTask.findMany({
      where: { ...baseWhere, status: 'pending' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, keywords: true, targetCountry: true, customerType: true, createdAt: true },
    });

    // Find user's position in queue
    let userPosition = 0;
    if (userId && pending.length > 0) {
      userPosition = (running ? 1 : 0) + 1;
    }

    return {
      running: running ? { id: running.id, name: (running.keywords || []).join(', '), since: running.createdAt } : null,
      pendingCount: pending.length,
      userPosition: userPosition || null,
      totalAhead: running ? pending.length + 1 : pending.length,
    };
  }

  async getRateLimit(userId: string) {
    const now = new Date();
    const hourStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0, 0);
    const hourEnd = new Date(hourStart.getTime() + 3600000);

    const records = await this.prisma.systemSetting.findMany({
      where: {
        key: { startsWith: `rate_limit.search.` },
      },
    });

    let submitCount = 0;
    let cancelCount = 0;
    for (const r of records) {
      try {
        const data = JSON.parse(r.value);
        if (data.userId === userId && new Date(data.timestamp) >= hourStart && new Date(data.timestamp) < hourEnd) {
          if (data.action === 'submit') submitCount++;
          if (data.action === 'cancel') cancelCount++;
        }
      } catch (err: any) {
        this.logger?.error?.('Rate limit record JSON parse failed: ' + (err?.message || err), err?.stack);
      }
    }

    const maxPerHour = 3;
    const cooldownMinutes = 60;
    const nowMs = now.getTime();
    const minutesRemaining = Math.max(0, Math.ceil((hourEnd.getTime() - nowMs) / 60000));

    return {
      submitCount,
      cancelCount,
      maxPerHour,
      submitRemaining: Math.max(0, maxPerHour - submitCount),
      cancelRemaining: Math.max(0, maxPerHour - cancelCount),
      cooldownMinutes: minutesRemaining > 0 ? minutesRemaining : 0,
      nextWindow: hourEnd.toISOString(),
    };
  }

  private async checkAndIncrementRateLimit(userId: string, action: 'submit' | 'cancel'): Promise<{ allowed: boolean; cooldownMinutes: number }> {
    const status = await this.getRateLimit(userId);
    const remaining = action === 'submit' ? status.submitRemaining : status.cancelRemaining;

    if (remaining <= 0) {
      return { allowed: false, cooldownMinutes: status.cooldownMinutes };
    }

    // Record this action
    const key = `rate_limit.search.${userId}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    await this.prisma.systemSetting.create({
      data: {
        key,
        value: JSON.stringify({ userId, action, timestamp: new Date().toISOString() }),
        group: 'rate_limit',
        description: 'Search task rate limit counter',
        updatedBy: userId,
      },
    });

    return { allowed: true, cooldownMinutes: 0 };
  }

  private async userHasFullAccess(userId: string, companyId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        companies: {
          where: { companyId, isActive: true },
          include: { role: true },
        },
      },
    });
    if (!user) return false;
    return user.companies.some(c => ['super_admin', 'company_admin'].includes(c.role.name));
  }

  async finalizeStaleRunningTasks(companyId: string, userId?: string) {
    const maxMinutes = Math.max(10, Number(process.env.LEAD_SEARCH_STALE_MINUTES || 45));
    const cutoff = new Date(Date.now() - maxMinutes * 60 * 1000);
    const where: any = { companyId, status: 'running', updatedAt: { lt: cutoff } };
    if (userId) where.createdBy = userId;

    const staleTasks = await this.prisma.searchTask.findMany({
      where,
      select: { id: true, maxResults: true },
    });

    for (const task of staleTasks) {
      const totalFound = await this.prisma.searchResult.count({ where: { searchTaskId: task.id } });
      await this.prisma.searchTask.update({
        where: { id: task.id },
        data: {
          status: 'completed',
          totalFound,
          completedAt: new Date(),
        },
      });
      this.logger.warn(`Search task ${task.id} was stale for ${maxMinutes} minutes; finalized with ${totalFound}/${task.maxResults} results`);
    }
  }

  /** 将被遗忘的 pending 任务重新放入队列或标记为 failed */
  private async recoverStalePendingTasks(companyId: string, userId?: string) {
    const maxMinutes = 20; // pending 超过 20 分钟还没被 worker 接走 = worker 可能挂了
    const cutoff = new Date(Date.now() - maxMinutes * 60 * 1000);
    const where: any = { companyId, status: 'pending', createdAt: { lt: cutoff } };
    if (userId) where.createdBy = userId;

    const stalePending = await this.prisma.searchTask.findMany({
      where,
      select: { id: true, keywords: true, targetCountry: true, customerType: true, excludeWords: true, searchLanguage: true, maxResults: true },
    });

    for (const task of stalePending) {
      // 尝试重新入队
      try {
        await this.searchQueue.add('execute-search', {
          taskId: task.id,
          keywords: task.keywords,
          targetCountry: task.targetCountry,
          customerType: task.customerType,
          excludeWords: task.excludeWords,
          searchLanguage: task.searchLanguage,
          maxResults: task.maxResults,
        }, {
          jobId: `search-task-${task.id}`,
          attempts: 1,
          removeOnComplete: 100,
          removeOnFail: 100,
        });
        await this.prisma.searchTask.update({
          where: { id: task.id },
          data: { updatedAt: new Date() },
        });
        this.logger.warn(`Search task ${task.id} was stuck pending for ${maxMinutes}+ minutes; re-queued`);
      } catch (err: any) {
        this.logger.error(`Failed to re-queue stale pending task ${task.id}: ${err.message}`);
        // 重试失败则标记为 failed
        await this.prisma.searchTask.update({
          where: { id: task.id },
          data: { status: 'failed', completedAt: new Date() },
        });
      }
    }
  }

  async listTasks(companyId: string, userId?: string) {
    await Promise.all([
      this.finalizeStaleRunningTasks(companyId, userId),
      this.recoverStalePendingTasks(companyId, userId),
    ]);
    const where: any = { companyId };
    if (userId) {
      where.createdBy = userId;
    }
    const tasks = await this.prisma.searchTask.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        createdBy: true,
        keywords: true,
        targetCountry: true,
        customerType: true,
        status: true,
        totalFound: true,
        newLeads: true,
        maxResults: true,
        createdAt: true,
        completedAt: true,
      },
    });
    const userIds = [...new Set(tasks.map((task) => task.createdBy).filter(Boolean))];
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, firstName: true, lastName: true, email: true },
    });
    const userMap = new Map(users.map((user) => [user.id, user]));
    return tasks.map((task) => {
      const user = userMap.get(task.createdBy);
      const userName = user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email : 'Unknown';
      const date = new Date(task.createdAt).toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      return {
        ...task,
        createdByName: userName,
        displayName: task.customerType?.startsWith('Similar brand search plan:')
          ? `${date} - ${userName} - 类似品牌搜索计划 - ${task.customerType.replace('Similar brand search plan: find companies similar to ', '')} - ${task.maxResults}条`
          : `${date} - ${userName} - ${task.targetCountry} - ${task.maxResults}条`,
      };
    });
  }

  async getTask(id: string, companyId: string, userId?: string) {
    await this.finalizeStaleRunningTasks(companyId, userId);
    const where: any = { id, companyId };
    if (userId) {
      where.createdBy = userId;
    }
    const task = await this.prisma.searchTask.findFirst({ where });
    if (!task) throw new NotFoundException('Search task not found');
    return task;
  }

  async getResults(taskId: string, companyId: string, userId?: string) {
    await this.getTask(taskId, companyId, userId);
    return this.prisma.searchResult.findMany({
      where: { searchTaskId: taskId },
      orderBy: { collectedAt: 'desc' },
    });
  }

  async convertTaskResults(taskId: string, companyId: string, userId: string) {
    await this.getTask(taskId, companyId); // No userId filter: sub-account can convert if they have the task ID
    const rows = await this.prisma.searchResult.findMany({
      where: { searchTaskId: taskId, status: { not: 'converted' }, hasEmail: true },
      select: { id: true },
    });

    let converted = 0;
    let merged = 0;
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const row of rows) {
      try {
        const result = await this.convertToLead(row.id, companyId, userId, false);
        if ((result as any)?.merged) merged++;
        else converted++;
      } catch (error: any) {
        skipped.push({ id: row.id, reason: error.message || 'convert failed' });
      }
    }

    return { total: rows.length, converted, merged, skipped };
  }

  async verifyResultEmail(resultId: string, companyId: string) {
    const sr = await this.prisma.searchResult.findFirst({
      where: { id: resultId },
      include: { task: true },
    });
    if (!sr || sr.task.companyId !== companyId) throw new NotFoundException('Search result not found');

    const analysis = (sr.aiAnalysis as any) || {};
    const email = this.pickEmail(analysis.contactEmail);
    const verification = email ? await this.verifyEmailDetailed(email) : {
      status: 'failed',
      method: 'none',
      reason: 'No acceptable non-service email found',
    };

    const nextAnalysis = {
      ...analysis,
      contactEmail: email || analysis.contactEmail || '',
      emailVerification: verification,
      emailVerifiedAt: new Date().toISOString(),
    };

    await this.prisma.searchResult.update({
      where: { id: resultId },
      data: {
        hasEmail: !!email && verification.status !== 'failed',
        aiAnalysis: nextAnalysis,
      },
    });

    return { email, verification };
  }

  async verifyReviewBatch(
    dto: { taskId?: string; resultIds?: string[] },
    companyId: string,
    userId: string,
  ) {
    const where: any = {
      task: { companyId },
      status: { in: ['manual_review', 'pending'] },
    };
    if (dto.resultIds?.length) where.id = { in: dto.resultIds };
    if (dto.taskId) where.searchTaskId = dto.taskId;
    if (!dto.resultIds?.length && !dto.taskId) {
      throw new BadRequestException('Provide taskId or resultIds for review verification');
    }

    const rows = await this.prisma.searchResult.findMany({
      where,
      include: { task: true },
      orderBy: { collectedAt: 'desc' },
      take: 200,
    });

    let verified = 0;
    let converted = 0;
    let failed = 0;
    let skipped = 0;
    const details: Array<{ id: string; status: string; email?: string | null; reason?: string }> = [];

    for (const row of rows) {
      if (row.leadId || row.status === 'converted') {
        skipped += 1;
        details.push({ id: row.id, status: 'skipped', reason: 'Already converted' });
        continue;
      }

      const result = await this.verifyResultEmail(row.id, companyId);
      const verificationStatus = result.verification?.status || 'failed';
      const accepted = ['smtp_verified', 'domain_verified'].includes(verificationStatus) && !!result.email;
      if (!accepted) {
        failed += 1;
        await this.prisma.searchResult.update({
          where: { id: row.id },
          data: {
            status: 'manual_review',
            aiAnalysis: {
              ...((row.aiAnalysis as any) || {}),
              emailVerification: result.verification,
              rejectionReasons: [
                ...((((row.aiAnalysis as any) || {}).rejectionReasons) || []),
                result.verification?.reason || 'Email verification failed',
              ],
            },
          },
        });
        details.push({ id: row.id, status: 'failed', email: result.email, reason: result.verification?.reason || 'Email verification failed' });
        continue;
      }

      verified += 1;
      try {
        const convertedResult: any = await this.convertToLead(row.id, companyId, userId, true);
        const newLeadId = convertedResult?.id;
        if (newLeadId) {
          await this.prisma.lead.update({
            where: { id: newLeadId },
            data: {
              ownerUserId: null,
              reviewStatus: 'approved',
              emailVerificationStatus: verificationStatus === 'smtp_verified' ? 'smtp_verified' : 'mx_domain_verified',
              emailVerificationReason: result.verification?.reason || 'Verified from manual review batch',
            },
          });
          converted += 1;
          details.push({ id: row.id, status: 'converted', email: result.email });
          continue;
        }
        if (convertedResult?.merged) {
          skipped += 1;
          details.push({ id: row.id, status: 'merged', email: result.email });
          continue;
        }
        if (convertedResult?.blocked) {
          skipped += 1;
          details.push({ id: row.id, status: 'blocked', email: result.email, reason: convertedResult.reason || 'Blocked by conversion rules' });
          continue;
        }
        skipped += 1;
        details.push({ id: row.id, status: 'skipped', email: result.email, reason: 'No lead was created' });
      } catch (error: any) {
        failed += 1;
        details.push({ id: row.id, status: 'failed', email: result.email, reason: error?.message || 'Convert failed' });
      }
    }

    return { total: rows.length, verified, converted, failed, skipped, details };
  }

  async deepResearch(resultId: string, companyId: string) {
    const sr = await this.prisma.searchResult.findFirst({
      where: { id: resultId },
      include: { task: true },
    });
    if (!sr || sr.task.companyId !== companyId) throw new NotFoundException('Search result not found');

    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    const analysis = (sr.aiAnalysis as any) || {};
    const prompt = `You are a B2B foreign trade research analyst specializing in the configured company's industry. Create a comprehensive background investigation report for this prospect.

## YOUR COMPANY (${company?.name || 'the configured company'})
${JSON.stringify({
  name: company?.name,
  website: company?.website,
  industry: company?.industry,
  description: company?.description,
  settings: company?.settings,
}, null, 2)}

## PROSPECT TO RESEARCH
Title: ${sr.title}
URL: ${sr.url}
Snippet: ${sr.snippet}
Country: ${sr.country}
AI Analysis: ${JSON.stringify(analysis, null, 2)}

## INSTRUCTIONS
Create a comprehensive B2B prospect report. For each section:
- If information is available, provide detailed analysis
- If information is NOT available, explicitly state "未确认" and suggest how to verify
- NEVER invent facts. Mark all uncertain information clearly.
- Provide actionable recommendations

Return strict JSON:
{
  "executiveSummary": "One paragraph summary",
  "companyBasicInfo": {
    "legalName": "", "country": "", "founded": "", "website": "",
    "industry": "", "employeeCount": "", "annualRevenue": "",
    "registrationStatus": "", "confidence": "confirmed/unconfirmed"
  },
  "marketAnalysis": {
    "targetMarkets": [], "targetCustomerProfile": "", "brandPositioning": "",
    "priceRange": "", "mainProductLines": []
  },
  "socialMediaAudit": {
    "platforms": [{"platform": "", "handle": "", "followers": 0, "notes": ""}],
    "overallAssessment": ""
  },
  "websiteAnalysis": {
    "platform": "", "isShopify": false, "trafficEstimate": "",
    "hasOnlineStore": true, "notes": ""
  },
  "keyContacts": {
    "confirmed": [{"name": "", "title": "", "email": "", "source": ""}],
    "unconfirmed": [{"name": "", "title": "", "email": "", "howToVerify": ""}]
  },
  "riskAssessment": {
    "companyLegitimacy": {"score": 0, "maxScore": 5, "notes": ""},
    "brandMaturity": {"score": 0, "maxScore": 5, "notes": ""},
    "procurementPotential": {"score": 0, "maxScore": 5, "notes": ""},
    "overallScore": 0, "overallGrade": "", "recommendation": ""
  },
  "cooperationStrategy": {
    "shortTerm": "", "midTerm": "", "longTerm": "",
    "recommendedProducts": [], "emailAngles": [], "nextActions": []
  },
  "dataSources": []
}`;

    const response = await this.zhipu.chat.completions.create({
      model: process.env.ZHIPU_MODEL || 'glm-4-flash-250414',
      messages: [
        {
          role: 'system',
          content: 'You are a B2B foreign trade research analyst. Return strict JSON only. Do NOT invent unverifiable facts. Mark uncertain items as "未确认". Score risk dimensions 1-5 with justification.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 8000,
    });

    const report = this.parseJsonObject(response.choices[0]?.message?.content || '{}');
    const nextAnalysis = {
      ...analysis,
      deepResearchReport: report,
      deepResearchAt: new Date().toISOString(),
    };

    await this.prisma.searchResult.update({
      where: { id: resultId },
      data: { aiAnalysis: nextAnalysis },
    });

    return report;
  }

  async findSimilarBrands(resultId: string, companyId: string) {
    const sr = await this.prisma.searchResult.findFirst({
      where: { id: resultId },
      include: { task: true },
    });
    if (!sr || sr.task.companyId !== companyId) {
      throw new NotFoundException('Search result not found');
    }
    const analysis = (sr.aiAnalysis as any) || {};
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    const settings = (company?.settings as any) || {};
    const productFocus = settings.defaultProductFocus || settings.productFocus || settings.mainProducts || 'the configured company products';
    const prompt = `Find 8 websites or brands similar to this customer for the configured company's prospecting.

Reference company:
${JSON.stringify({
  companyName: analysis.companyName || sr.title,
  website: sr.url,
  country: sr.country,
  industryCategory: analysis.industryCategory,
  mainProducts: analysis.mainProducts,
  customerType: sr.task.customerType,
}, null, 2)}

Rules:
- Focus on real companies/brands that may need ${productFocus}.
- Prefer companies with public business email/contact email. If no email can be found, omit the company.
- Return only JSON array.

Fields:
companyName, website, country, reason, contactEmail, contactRole, similarityType, emailSource, confidenceScore`;

    const response = await this.zhipu.chat.completions.create({
      model: process.env.ZHIPU_MODEL || 'glm-4-flash-250414',
      messages: [
        { role: 'system', content: 'Return strict JSON only. Omit prospects without an email.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.45,
      max_tokens: 3000,
    });
    const content = response.choices[0]?.message?.content || '[]';
    const parsed = this.parseJsonArray(content);
    const verified = [];
    for (const item of parsed) {
      const verifiedEmail = this.pickEmail(item.contactEmail) ?? '';
      if (!verifiedEmail) continue;
      const mxValid = await this.hasMxRecord(verifiedEmail);
      if (!mxValid) continue;
      verified.push({ ...item, contactEmail: verifiedEmail, mxValid: true, emailVerification: await this.verifyEmailDetailed(verifiedEmail) });
    }
    return { reference: analysis.companyName || sr.title, data: verified };
  }

  async createSimilarBrandsTask(resultId: string, companyId: string, userId: string) {
    const sr = await this.prisma.searchResult.findFirst({
      where: { id: resultId },
      include: { task: true },
    });
    if (!sr || sr.task.companyId !== companyId) throw new NotFoundException('Search result not found');

    const analysis = (sr.aiAnalysis as any) || {};
    const referenceName = analysis.companyName || sr.title;
    const referenceDomain = extractDomain(sr.url);
    const targetCountry = sr.country || sr.task.targetCountry || 'USA';
    const keywords = [
      `${referenceName} similar brands`,
      analysis.industryCategory || sr.task.customerType || 'similar industry-compatible customer',
      analysis.mainProducts || sr.keyword || 'B2B buyer',
    ].filter(Boolean).slice(0, 3);

    const task = await this.prisma.searchTask.create({
      data: {
        companyId,
        createdBy: userId,
        keywords,
        targetCountry,
        customerType: `Similar brand search plan: find companies similar to ${referenceName}${referenceDomain ? ` (${referenceDomain})` : ''}`,
        excludeWords: [],
        searchLanguage: 'en',
        maxResults: 5,
        status: 'pending',
      },
    });

    await this.searchQueue.add('execute-search', {
      taskId: task.id,
      keywords,
      targetCountry,
      customerType: task.customerType || undefined,
      excludeWords: [],
      searchLanguage: 'en',
      maxResults: 5,
    }, {
      jobId: `search-task-${task.id}`,
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100,
    });

    return {
      task,
      displayName: `类似品牌搜索计划 - ${referenceName} - ${targetCountry} - 5条`,
    };
  }

  async convertToLead(resultId: string, companyId: string, userId: string, force = false) {
    const sr = await this.prisma.searchResult.findFirst({
      where: { id: resultId },
      include: { task: true },
    });
    if (!sr || sr.task.companyId !== companyId) {
      throw new NotFoundException('Search result not found');
    }

    const analysis = (sr.aiAnalysis as any) || {};
    const companyName = (analysis.companyName || sr.title || '').trim();
    const domain = extractDomain(sr.url);
    const email = (analysis.contactEmail || '').trim().toLowerCase();

    if (!force) {
      const phone = (analysis.contactPhone || '').replace(/[\s\-()]/g, '');
      const wa = (analysis.whatsapp || '').replace(/[\s\-()]/g, '');
      const brandMatch = await this.findExistingBrand(companyId, companyName, domain);
      if (brandMatch) {
        await this.addContactToLead(companyId, brandMatch.id, analysis);
        await this.prisma.searchResult.update({
          where: { id: resultId },
          data: { leadId: brandMatch.id, status: 'converted' },
        });
        await this.prisma.searchTask.update({
          where: { id: sr.searchTaskId },
          data: { newLeads: { increment: 1 } },
        });
        await this.prisma.leadActivity.create({
          data: {
            companyId,
            leadId: brandMatch.id,
            userId,
            activityType: 'contact_merged',
            title: `AI search contact merged into brand: ${analysis.contactPerson || analysis.contactName || analysis.contactEmail || 'new contact'}`,
            description: `Source: ${sr.url || sr.title}`,
            referenceType: 'SearchResult',
            referenceId: resultId,
          },
        });
        return { merged: true, lead: brandMatch };
      }

      const conditions: any[] = [];
      if (domain) {
        conditions.push({ websiteDomain: domain.toLowerCase() });
      }
      if (email) {
        conditions.push({ contactEmail: { equals: email, mode: 'insensitive' } });
      }
      if (phone) {
        conditions.push({ contactPhone: { contains: phone.slice(-8) } });
      }
      if (wa && wa !== phone) {
        conditions.push({ whatsapp: { contains: wa.slice(-8) } });
      }

      if (conditions.length > 0) {
        const existing = await this.prisma.lead.findMany({
          where: {
            companyId,
            deletedAt: null,
            isMerged: false,
            OR: conditions,
          },
          select: {
            id: true,
            companyName: true,
            website: true,
            websiteDomain: true,
            contactEmail: true,
            contactPhone: true,
            whatsapp: true,
            country: true,
            status: true,
            leadScore: true,
          },
          take: 10,
        });

        if (existing.length > 0) {
          const lowerName = companyName.toLowerCase().replace(/[\s,.\-]+/g, '');
          const matches = existing.filter((e) => {
            const reasons: string[] = [];
            if (domain && e.websiteDomain?.toLowerCase() === domain.toLowerCase()) {
              reasons.push('website');
            }
            if (email && e.contactEmail?.toLowerCase() === email) {
              reasons.push('email');
            }
            if (phone && e.contactPhone?.replace(/[\s\-()]/g, '').slice(-8) === phone.slice(-8)) {
              reasons.push('phone');
            }
            if (wa && e.whatsapp?.replace(/[\s\-()]/g, '').slice(-8) === wa.slice(-8)) {
              reasons.push('whatsapp');
            }
            const eName = (e.companyName || '').toLowerCase().replace(/[\s,.\-]+/g, '');
            if (lowerName && eName && (lowerName === eName || lowerName.includes(eName) || eName.includes(lowerName))) {
              reasons.push('company name');
            }
            return reasons.length > 0;
          });

          const enriched = matches.map((m) => {
            const reasons: string[] = [];
            if (domain && m.websiteDomain?.toLowerCase() === domain.toLowerCase()) reasons.push('Website domain match');
            if (email && m.contactEmail?.toLowerCase() === email) reasons.push('Email exact match');
            if (phone && m.contactPhone?.replace(/[\s\-()]/g, '').slice(-8) === phone.slice(-8)) reasons.push('Phone match');
            if (wa && m.whatsapp?.replace(/[\s\-()]/g, '').slice(-8) === wa.slice(-8)) reasons.push('WhatsApp match');
            const eName = (m.companyName || '').toLowerCase().replace(/[\s,.\-]+/g, '');
            if (lowerName && eName && (lowerName === eName || lowerName.includes(eName) || eName.includes(lowerName))) reasons.push('Company name similar');
            return { ...m, matchReasons: reasons };
          });

          if (enriched.length > 0) {
            return {
              blocked: true,
              matches: enriched,
              searchInfo: {
                companyName,
                website: sr.url,
                email: analysis.contactEmail || null,
                phone: analysis.contactPhone || null,
              },
            };
          }
        }
      }
    }

    const emailVerification = analysis.emailVerification || (analysis.contactEmail
      ? await this.verifyEmailDetailed(String(analysis.contactEmail).split(',')[0].trim())
      : { status: 'failed', reason: 'No email available' });
    const emailStatus = analysis.verificationStatus === 'verified_public_source'
      ? 'official_page_verified'
      : this.toLeadEmailVerificationStatus(emailVerification, analysis.emailSource);
    const socialLinks = this.collectSocialLinks(analysis);
    const pipelineStage = analysis.pipelineStage || sr.status;
    const requiresManualReview = !force && (pipelineStage !== 'ready_for_outreach' || !['smtp_verified', 'official_page_verified'].includes(emailStatus));

    const lead = await this.prisma.lead.create({
      data: {
        companyId,
        companyName: analysis.companyName || sr.title,
        leadName: analysis.companyName || sr.title,
        website: sr.url || null,
        country: sr.country || null,
        sourceType: 'AI鎼滅储',
        sourceKeyword: sr.keyword,
        sourceCountry: sr.country || null,
        contactEmail: analysis.contactEmail || null,
        contactName: analysis.contactPerson || analysis.contactName || null,
        contactPhone: analysis.fieldConfidence?.phone?.status === 'placeholder_rejected' ? null : (analysis.contactPhone || null),
        contactTitle: analysis.contactTitle || null,
        whatsapp: analysis.whatsapp || null,
        linkedinUrl: analysis.linkedin || null,
        facebookUrl: analysis.facebook || null,
        instagramUrl: analysis.instagram || null,
        twitterUrl: analysis.twitter || null,
        pinterestUrl: analysis.pinterest || null,
        redditUrl: analysis.reddit || null,
        youtubeUrl: analysis.youtube || null,
        tiktokUrl: analysis.tiktok || null,
        otherSocialLinks: socialLinks.length ? socialLinks : undefined,
        emailVerificationStatus: emailStatus,
        emailVerificationReason: emailVerification.reason || analysis.emailSource || null,
        confidenceScore: analysis.confidenceScore || null,
        industry: analysis.industryCategory || null,
        yearEstablished: analysis.yearEstablished || null,
        employeeCount: analysis.employeeCount || null,
        mainProducts: analysis.mainProducts || null,
        hasChinaImport: analysis.hasChinaImport ?? null,
        currentSuppliers: analysis.currentSuppliers || null,
        status: 'prospect_pool',
        reviewStatus: requiresManualReview ? 'pending' : 'approved',
        notes: requiresManualReview
          ? `Evidence-first prospect requires manual review before auto sending. Reason: ${(analysis.rejectionReasons || []).join('; ') || emailVerification.reason || emailStatus}`
          : `Evidence-first prospect ready for outreach. Evidence: ${(analysis.evidenceSources || []).map((s: any) => s.url).filter(Boolean).slice(0, 3).join(', ')}`,
        ownerUserId: userId,
      },
    });

    await this.addContactsFromAnalysis(companyId, lead.id, analysis);

    await this.prisma.searchResult.update({
      where: { id: resultId },
      data: { leadId: lead.id, status: 'converted' },
    });

    await this.prisma.searchTask.update({
      where: { id: sr.searchTaskId },
      data: { newLeads: { increment: 1 } },
    });

    // Auto-tag from AI analysis
    await this.autoTagLead(lead.id, lead.companyId, analysis, sr.task.customerType || undefined, userId).catch(() => {});

    return lead;
  }

  private async autoTagLead(leadId: string, companyId: string, analysis: any, customerType?: string, userId?: string) {
    const tags = await this.prisma.tag.findMany({ where: { companyId } });
    const tagIds: string[] = [];
    const category = (analysis?.industryCategory || customerType || '').toLowerCase();

    for (const tag of tags) {
      if (tag.name.toLowerCase().includes(category) || category.includes(tag.name.toLowerCase())) {
        tagIds.push(tag.id);
      }
    }
    // Confidence-based tags
    if ((analysis?.confidenceScore || 0) > 80) {
      const t = tags.find(x => x.name === 'High Confidence');
      if (t) tagIds.push(t.id);
    }
    if (tagIds.length > 0) {
      await this.prisma.leadTag.createMany({
        data: [...new Set(tagIds)].map(tagId => ({ leadId, tagId, createdBy: userId || '' })),
        skipDuplicates: true,
      });
    }
  }

  private async findExistingBrand(companyId: string, companyName: string, domain: string | null) {
    const normalized = companyName.toLowerCase().replace(/[\s,.\-_'"]/g, '');
    const orConditions: any[] = [];
    if (domain) orConditions.push({ websiteDomain: domain.toLowerCase() });
    if (companyName) orConditions.push({ companyName: { contains: companyName, mode: 'insensitive' as const } });
    if (orConditions.length === 0) return null;

    const candidates = await this.prisma.lead.findMany({
      where: {
        companyId,
        deletedAt: null,
        isMerged: false,
        OR: orConditions,
      },
      select: { id: true, companyName: true, websiteDomain: true, status: true },
      take: 10,
    });
    return candidates.find((item) => {
      if (domain && item.websiteDomain?.toLowerCase() === domain.toLowerCase()) return true;
      const existingName = (item.companyName ?? '')
        .toLowerCase()
        .replace(/[\s,.\-_'"]/g, '');
      return normalized && existingName && (normalized === existingName || normalized.includes(existingName) || existingName.includes(normalized));
    }) || null;
  }

  private async addContactToLead(companyId: string, leadId: string, analysis: any) {
    const email = (analysis.contactEmail || '').split(',')[0]?.trim() || null;
    if (email) {
      const existing = await this.prisma.contact.findFirst({ where: { leadId, email: { equals: email, mode: 'insensitive' } } });
      if (existing) return existing;
    }
    const fullName = (analysis.contactPerson || analysis.contactName || '').trim();
    const parts = fullName.split(/\s+/).filter(Boolean);
    return this.prisma.contact.create({
      data: {
        companyId,
        leadId,
        firstName: parts[0] || 'Unknown',
        lastName: parts.slice(1).join(' ') || '',
        email,
        phone: analysis.contactPhone || null,
        title: analysis.contactTitle || null,
        department: analysis.department || null,
        linkedinUrl: analysis.linkedin || null,
        notes: 'Merged from AI search as another contact under the same brand.',
      },
    });
  }

  private async addContactsFromAnalysis(companyId: string, leadId: string, analysis: any) {
    const contacts = Array.isArray(analysis.contacts) ? analysis.contacts : [];
    const primary = {
      name: analysis.contactPerson || analysis.contactName || '',
      title: analysis.contactTitle || '',
      email: analysis.contactEmail || '',
      linkedin: analysis.linkedin || '',
      source: analysis.emailSource || '',
    };

    for (const item of [primary, ...contacts]) {
      const email = this.pickEmail(item.email);
      if (!email) continue;
      const exists = await this.prisma.contact.findFirst({
        where: { leadId, email: { equals: email, mode: 'insensitive' } },
      });
      if (exists) continue;

      const name = String(item.name || '').trim();
      const parts = name.split(/\s+/).filter(Boolean);
      await this.prisma.contact.create({
        data: {
          companyId,
          leadId,
          firstName: parts[0] || 'Unknown',
          lastName: parts.slice(1).join(' ') || '',
          email,
          title: item.title || null,
          department: item.department || null,
          linkedinUrl: item.linkedin || null,
          notes: item.source ? `AI source: ${item.source}` : 'AI-discovered contact',
          isPrimary: email === this.pickEmail(analysis.contactEmail),
        },
      });
    }
  }

  async executeSearch(taskId: string, params: {
    keywords: string[];
    targetCountry: string;
    customerType?: string;
    excludeWords: string[];
    searchLanguage: string;
    maxResults: number;
    companyProfile?: any;
    userPreference?: string;
  }) {
    this.logger.log(`Executing search task ${taskId} 鈥?serial batch mode`);

    if (!params.keywords?.length) {
      const taskForDefaults = await this.prisma.searchTask.findUnique({ where: { id: taskId }, select: { companyId: true } });
      const companyForDefaults = taskForDefaults
        ? await this.prisma.company.findUnique({ where: { id: taskForDefaults.companyId } })
        : null;
      params.keywords = this.defaultKeywordsForProfile(params.customerType, companyForDefaults?.settings);
    }
    if (!params.excludeWords) {
      params.excludeWords = [];
    }

    const existingTask = await this.prisma.searchTask.findUnique({
      where: { id: taskId },
      select: { status: true, completedAt: true },
    });
    if (!existingTask) {
      this.logger.warn(`Task ${taskId} no longer exists; skipping queued job`);
      return;
    }
    if (existingTask.completedAt || !['pending', 'running'].includes(existingTask.status)) {
      this.logger.warn(`Task ${taskId} is already ${existingTask.status}; skipping stale queued job`);
      return;
    }

    await this.prisma.searchTask.update({
      where: { id: taskId },
      data: { status: 'running', startedAt: new Date() },
    });

    try {
      const task = await this.prisma.searchTask.findUnique({ where: { id: taskId } });
      const company = task
        ? await this.prisma.company.findUnique({ where: { id: task.companyId } })
        : null;
      const userPref = task
        ? await this.prisma.systemSetting.findUnique({
            where: {
              companyId_key: {
                companyId: task.companyId,
                key: `user.aiPreference.${task.createdBy}`,
              },
            },
          })
        : null;

      const companyProfile = company ? {
        name: company.name,
        website: company.website,
        industry: company.industry,
        description: company.description,
        settings: company.settings,
      } : null;

      // === SERIAL BATCH MODE ===
      // Process in batches of BATCH_SIZE. Each batch goes through:
      // AI search 鈫?Chinese filter 鈫?email pick 鈫?MX verify 鈫?save
      // Deficit from each batch rolls into the next. Stops at TARGET.
      const TARGET = Math.min(params.maxResults || 50, 500); // User's setting, max 100
      const BATCH_SIZE = 10;
      const MAX_BATCHES = Math.ceil(TARGET / BATCH_SIZE) + 10; // Safety limit
      const MAX_RUNTIME_MS = Math.max(10, Number(process.env.LEAD_SEARCH_MAX_MINUTES || 60)) * 60 * 1000;
      const startedAtMs = Date.now();
      let totalSaved = 0;
      let batchNum = 0;
      let nextBatchSize = BATCH_SIZE;
      let zeroProgressBatches = 0;
      const seenDomains = new Set<string>();
      const existingResults = await this.prisma.searchResult.findMany({
        where: { searchTaskId: taskId },
        select: { url: true, hasEmail: true, status: true, aiAnalysis: true },
      });
      for (const existing of existingResults) {
        const domain = this.extractDomainFromResult({
          url: existing.url,
          contactEmail: (existing.aiAnalysis as any)?.contactEmail,
        });
        if (domain) seenDomains.add(domain);
      }
      totalSaved = existingResults.filter(
        (item) => item.status === 'ready_for_outreach' || item.hasEmail,
      ).length;

      while (totalSaved < TARGET && batchNum < MAX_BATCHES) {
        if (Date.now() - startedAtMs > MAX_RUNTIME_MS) {
          this.logger.warn(`Task ${taskId}: reached runtime limit, finalizing partial results`);
          break;
        }

        // Check if task was cancelled
        const currentTask = await this.prisma.searchTask.findUnique({ where: { id: taskId }, select: { status: true } });
        if (currentTask?.status === 'cancelled') {
          this.logger.log(`Task ${taskId} cancelled by user`);
          break;
        }

        batchNum++;
        this.logger.log(`Task ${taskId} 鈥?Batch ${batchNum}: requesting ${nextBatchSize} prospects`);

        // Step 1: Evidence-first search. LLMs may suggest candidate URLs, but facts are only accepted
        // after public-page extraction and verification.
        const batchResults = await this.searchEvidenceFirstBatch({
          keywords: params.keywords,
          targetCountry: params.targetCountry,
          customerType: params.customerType,
          excludeWords: params.excludeWords,
          batchSize: nextBatchSize,
          batchNum,
          companyProfile,
          userPreference: userPref?.value || '',
        });

        // Step 2: Store triaged results. Only ready_for_outreach counts toward the target.
        let batchSaved = 0;
        for (const r of batchResults) {
          if (this.hasCjkText(JSON.stringify(r))) continue;

          // Market filter
          if (!this.isAllowedMarketProspect(r, params.targetCountry, params.customerType)) continue;

          // Domain dedup within task
          const domain = this.extractDomainFromResult(r);
          if (domain && seenDomains.has(domain)) continue;

          if (domain) seenDomains.add(domain);
          const normalized = {
            ...r,
            contactEmail: r.contactEmail || '',
            emailVerification: r.emailVerification || null,
            emailConfidence: r.emailConfidence || 'Low - evidence required',
            socialLinks: this.collectSocialLinks(r),
          };

          await this.prisma.searchResult.create({
            data: {
              searchTaskId: taskId,
              title: r.title || r.companyName || '',
              url: r.url || r.website || '',
              snippet: r.snippet || r.whyTarget || '',
              source: r.source || 'evidence-first',
              keyword: params.keywords?.[0] || this.defaultKeywordsForProfile(params.customerType, company?.settings)[0] || 'prospecting',
              country: params.targetCountry,
              isExportable: r.isExportable ?? true,
              isSupplier: r.isSupplier ?? false,
              hasEmail: !!r.contactEmail && r.pipelineStage !== 'rejected',
              aiAnalysis: normalized as any,
              status: r.pipelineStage || 'manual_review',
            },
          });
          if (r.pipelineStage === 'ready_for_outreach') {
            batchSaved++;
            totalSaved++;
          }
        }

        this.logger.log(`Task ${taskId} 鈥?Batch ${batchNum}: saved ${batchSaved}/${nextBatchSize}, total ${totalSaved}/${TARGET}`);

        zeroProgressBatches = batchSaved === 0 ? zeroProgressBatches + 1 : 0;
        await this.prisma.searchTask.update({
          where: { id: taskId },
          data: { totalFound: totalSaved },
        });

        // Step 3: Calculate next batch size (deficit rolls over)
        const deficit = nextBatchSize - batchSaved;
        nextBatchSize = Math.min(BATCH_SIZE + Math.max(0, deficit), 30);

        if (totalSaved >= TARGET) break;
        if (zeroProgressBatches >= 8) {
          this.logger.warn(`Task ${taskId}: 3 consecutive batches with no verified email results, finalizing partial results`);
          break;
        }
      }

      await this.prisma.searchTask.update({
        where: { id: taskId },
        data: { status: 'completed', totalFound: totalSaved, completedAt: new Date() },
      });

      this.logger.log(`Search task ${taskId} completed: ${totalSaved} prospects saved`);
    } catch (error: any) {
      const errorMsg = error.killed && error.signal
        ? `搜索进程被 ${error.signal} 终止（超时？），已获取 ${await this.prisma.searchResult.count({ where: { searchTaskId: taskId } })} 条部分结果`
        : `搜索失败: ${error.message || error}`;
      this.logger.error(`Search task ${taskId} failed: ${error.message}`);
      await this.prisma.searchTask.update({
        where: { id: taskId },
        data: { status: 'failed', errorMessage: errorMsg, completedAt: new Date() },
      });
    }
  }

  private extractDomainFromResult(r: any): string | null {
    try {
      const url = r.url || r.website || '';
      if (url) return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '');
    } catch (err: any) {
      this.logger?.error?.('Domain extraction from URL failed: ' + (err?.message || err), err?.stack);
    }
    try {
      const email = r.contactEmail || '';
      const parts = email.split('@');
      if (parts.length === 2) return parts[1].toLowerCase();
    } catch (err: any) {
      this.logger?.error?.('Domain extraction from email failed: ' + (err?.message || err), err?.stack);
    }
    return null;
  }

  private async searchEvidenceFirstBatch(params: {
    keywords: string[];
    targetCountry: string;
    customerType?: string;
    excludeWords: string[];
    batchSize: number;
    batchNum: number;
    companyProfile?: any;
    userPreference?: string;
  }): Promise<EvidenceProspect[]> {
    const candidates = await this.discoverEvidenceCandidates(params);
    const output: EvidenceProspect[] = [];
    const seen = new Set<string>();

    for (const candidate of candidates) {
      if (output.filter((item) => item.pipelineStage === 'ready_for_outreach').length >= params.batchSize) break;
      const domain = extractDomain(candidate.url);
      if (!domain || seen.has(domain)) continue;
      seen.add(domain);
      const prospect = await this.buildEvidenceProspect(candidate, params).catch((error: any) => ({
        title: candidate.title,
        url: candidate.url,
        snippet: candidate.snippet || '',
        companyName: this.cleanCompanyName(candidate.title, domain),
        contactEmail: '',
        contactPhone: '',
        contactPerson: '',
        contactTitle: '',
        emailSource: '',
        emailConfidence: 'Rejected',
        industryCategory: params.customerType || 'Unclassified',
        confidenceScore: 0,
        mainProducts: params.keywords.join(', '),
        hasEmail: false,
        source: 'evidence-first',
        pipelineStage: 'rejected' as const,
        verificationStatus: 'rejected',
        rejectionReasons: [`Crawl or extraction failed: ${error.message || error}`],
        evidenceSources: [{ type: 'candidate', url: candidate.url, title: candidate.title }],
        fieldConfidence: {},
      }));
      output.push(prospect);
    }

    const readyCount = output.filter((item) => item.pipelineStage === 'ready_for_outreach').length;
    if (readyCount >= params.batchSize) return output;

    if (process.env.PROSPECT_LLM_DISCOVERY_ENABLED !== 'true') {
      this.logger.log(`Evidence-first batch ${params.batchNum}: LLM fallback disabled; returning ${readyCount}/${params.batchSize} verified prospects`);
      return output;
    }

    // LLM/Claude fallback is allowed only as candidate-URL discovery. Returned facts are ignored
    // unless the URL can be crawled and evidence extracted.
    const fallback = await this.searchBatchWithClaude(params).catch(() => []);
    for (const item of fallback) {
      if (output.filter((row) => row.pipelineStage === 'ready_for_outreach').length >= params.batchSize) break;
      const url = item.url || item.website;
      const domain = extractDomain(url);
      if (!url || !domain || seen.has(domain)) continue;
      seen.add(domain);
      const candidate = {
        title: item.companyName || item.title || domain,
        url,
        snippet: item.snippet || item.whyTarget || '',
      };
      const prospect = await this.buildEvidenceProspect(candidate, params).catch(() => null);
      if (prospect) output.push(prospect);
    }

    return output;
  }

  private async discoverEvidenceCandidates(params: {
    keywords: string[];
    targetCountry: string;
    customerType?: string;
    excludeWords: string[];
    batchSize: number;
    batchNum: number;
    companyProfile?: any;
    userPreference?: string;
  }) {
    const country = this.normalizeCountry(params.targetCountry);
    const keywordText = params.keywords.join(' ');
    const settings = params.companyProfile?.settings || {};
    const productFocus = settings.defaultProductFocus || settings.productFocus || settings.mainProducts || keywordText;
    const targetProfiles = Array.isArray(settings.targetCustomerProfiles)
      ? settings.targetCustomerProfiles.join(' ')
      : (settings.targetCustomerProfiles || '');
    const profile = params.customerType || targetProfiles || 'B2B buyer procurement manufacturing industrial purchasing';
    const queries = [
      `${country} ${keywordText} brand contact wholesale`,
      `${country} ${profile} "contact us" email`,
      `${country} ${keywordText} exhibitor directory contact`,
      `${country} ${keywordText} supplier partnership buying`,
      `${country} ${productFocus} manufacturer buyer procurement contact`,
      `${country} ${productFocus} industrial supplier distributor contact`,
      `"${keywordText}" "${country}" "sourcing" email`,
      `"${keywordText}" "${country}" "wholesale" "contact"`,
    ];
    const candidates: Array<{ title: string; url: string; snippet: string }> = [];
    for (const query of queries) {
      let rows = await this.searxngSearch(query, Math.max(8, params.batchSize)).catch(() => []);
      if (rows.length === 0) rows = await this.duckDuckGoSearch(query, Math.max(8, params.batchSize)).catch(() => []);
      if (rows.length === 0) rows = await this.bingSearch(query, Math.max(8, params.batchSize)).catch(() => []);
      candidates.push(...rows);
      if (candidates.length >= params.batchSize * 8) break;
    }
    return candidates
      .filter((candidate) => /^https?:\/\//i.test(candidate.url))
      .filter((candidate) => !params.excludeWords.some((word) => `${candidate.url} ${candidate.title} ${candidate.snippet}`.toLowerCase().includes(word.toLowerCase())));
  }

  private async buildEvidenceProspect(candidate: { title: string; url: string; snippet: string }, params: {
    keywords: string[];
    targetCountry: string;
    customerType?: string;
    companyProfile?: any;
    userPreference?: string;
  }): Promise<EvidenceProspect> {
    const domain = extractDomain(candidate.url);
    const evidenceSources: any[] = [{ type: 'candidate', url: candidate.url, title: candidate.title, snippet: candidate.snippet }];
    const rejectionReasons: string[] = [];
    if (!domain) rejectionReasons.push('No valid website domain');
    if (domain && !this.isAllowedDomainForTarget(domain, params.targetCountry, params.customerType)) rejectionReasons.push('Domain is not allowed for target market');

    const pages = domain ? await this.fetchCandidatePagesWithEvidence(candidate.url) : [];
    evidenceSources.push(...pages.map((page) => ({ type: 'crawled_page', url: page.url, title: page.title, excerpt: page.text.slice(0, 240) })));
    if (pages.length === 0) rejectionReasons.push('No public website pages could be crawled');

    const pageText = pages.map((page) => `${page.url}\n${page.text}`).join('\n\n');
    const companyName = this.extractEvidenceCompanyName(candidate, pages, domain || '');
    const emails = this.extractEmailsWithEvidence(pages);
    const emailEvidence = await this.selectBestEvidenceEmail(emails);
    const phoneEvidence = this.extractPhoneWithEvidence(pages);
    const social = this.extractSocialLinksWithEvidence(pages);

    if (phoneEvidence.rejected) rejectionReasons.push(phoneEvidence.reason);
    if (!emailEvidence.email) rejectionReasons.push(emailEvidence.reason || 'No acceptable public business email with source evidence');
    if (pageText && this.hasChinaRegionSignal(pageText.toLowerCase(), domain)) rejectionReasons.push('China/Hong Kong/Taiwan signal found in public evidence');

    const shouldClassifyWithAi = Boolean(emailEvidence.email) && rejectionReasons.length === 0 && process.env.PROSPECT_AI_CLASSIFY_DISABLED !== 'true';
    const classification = shouldClassifyWithAi ? await this.classifyEvidenceProspect({
      companyName,
      website: candidate.url,
      targetCountry: params.targetCountry,
      customerType: params.customerType,
      keywords: params.keywords,
      evidence: evidenceSources.slice(0, 8),
      pageExcerpt: pageText.slice(0, 5000),
    }).catch(() => ({
      industryCategory: params.customerType || 'Evidence-based prospect',
      confidenceScore: emailEvidence.status === 'verified_public_source' ? 70 : 45,
      mainProducts: params.keywords.join(', '),
      snippet: candidate.snippet || 'Public website evidence collected.',
    })) : {
      industryCategory: params.customerType || 'Evidence-based prospect',
      confidenceScore: emailEvidence.status === 'verified_public_source' ? 70 : 35,
      mainProducts: params.keywords.join(', '),
      snippet: candidate.snippet || (emailEvidence.email ? 'Public email evidence collected.' : 'No acceptable public business email found.'),
    };

    const verificationStatus = emailEvidence.status || 'rejected';
    let pipelineStage: EvidenceProspect['pipelineStage'] = 'rejected';
    if (rejectionReasons.length === 0 && ['verified_public_source', 'smtp_verified'].includes(verificationStatus)) {
      pipelineStage = 'ready_for_outreach';
    } else if (emailEvidence.email && ['mx_domain_verified', 'domain_verified'].includes(verificationStatus)) {
      pipelineStage = 'manual_review';
    }

    return {
      title: companyName || candidate.title,
      url: candidate.url,
      snippet: classification.snippet || candidate.snippet || '',
      companyName: companyName || this.cleanCompanyName(candidate.title, domain || ''),
      contactEmail: emailEvidence.email || '',
      contactPhone: phoneEvidence.value || '',
      contactPerson: '',
      contactTitle: '',
      emailSource: emailEvidence.sourceUrl || '',
      emailConfidence: pipelineStage === 'ready_for_outreach' ? 'High - public evidence' : pipelineStage === 'manual_review' ? 'Medium - manual review' : 'Rejected',
      industryCategory: classification.industryCategory || params.customerType || 'Evidence-based prospect',
      confidenceScore: Number(classification.confidenceScore || 0),
      mainProducts: classification.mainProducts || params.keywords.join(', '),
      hasEmail: !!emailEvidence.email,
      source: 'evidence-first',
      pipelineStage,
      verificationStatus,
      rejectionReasons,
      evidenceSources,
      fieldConfidence: {
        company: { status: pages.length ? 'public_source_verified' : 'candidate_only', sourceUrl: candidate.url },
        email: emailEvidence,
        phone: phoneEvidence,
        social,
      },
      emailVerification: emailEvidence.verification,
      linkedin: social.linkedin || '',
      facebook: social.facebook || '',
      instagram: social.instagram || '',
      twitter: social.twitter || '',
      pinterest: social.pinterest || '',
      reddit: social.reddit || '',
      youtube: social.youtube || '',
      tiktok: social.tiktok || '',
      otherSocial: social.other?.join(', ') || '',
      contacts: [],
    };
  }

  private async searchBatchWithClaude(params: {
    keywords: string[];
    targetCountry: string;
    customerType?: string;
    excludeWords: string[];
    batchSize: number;
    batchNum: number;
  }): Promise<any[]> {
    try {
      const cliPath = path.resolve(process.cwd(), 'tools', 'claude-prospect-cli.js');
      if (!fs.existsSync(cliPath)) {
        this.logger.warn(`Claude prospect CLI not found at ${cliPath}, falling back to Zhipu GLM`);
        return this.searchBatchWithZhipu({
          keywords: params.keywords, targetCountry: params.targetCountry,
          customerType: params.customerType, excludeWords: params.excludeWords,
          batchSize: params.batchSize, batchNum: params.batchNum,
          companyProfile: null, userPreference: '',
        });
      }

      const args = [
        '--country', params.targetCountry,
        '--keywords', params.keywords.join(', '),
        '--count', String(params.batchSize),
        '--batch', String(params.batchNum),
      ];
      if (params.customerType) args.push('--profile', params.customerType);
      if (params.excludeWords?.length) args.push('--exclude', params.excludeWords.join(', '));

      const { stdout } = await execFileAsync('node', [cliPath, ...args], {
        encoding: 'utf8',
        maxBuffer: 5 * 1024 * 1024,
        timeout: Number(process.env.CLAUDE_PROSPECT_WRAPPER_TIMEOUT_MS || 360000),
        env: process.env,
      });

      const results = JSON.parse(String(stdout || '[]'));
      if (Array.isArray(results) && results.length > 0) {
        this.logger.log(`Claude found ${results.length} prospects`);
        return results;
      }
    } catch (err: any) {
      this.logger.warn(`Claude prospect CLI failed: ${err.message}, falling back to Zhipu GLM`);
    }
    // Fallback to Zhipu GLM
    return this.searchBatchWithZhipu({
      keywords: params.keywords, targetCountry: params.targetCountry,
      customerType: params.customerType, excludeWords: params.excludeWords,
      batchSize: params.batchSize, batchNum: params.batchNum,
      companyProfile: null, userPreference: '',
    });
  }

  async stopTask(id: string, companyId: string, userId: string) {
    const task = await this.prisma.searchTask.findFirst({ where: { id, companyId } });
    if (!task) throw new NotFoundException('Task not found');
    if (!['running', 'pending'].includes(task.status)) {
      throw new BadRequestException('Only running or pending tasks can be stopped');
    }
    await this.prisma.searchTask.update({
      where: { id },
      data: { status: 'cancelled', completedAt: new Date() },
    });
    return { message: 'Task stopped' };
  }

  private async searchBatchWithZhipu(params: {
    keywords: string[];
    targetCountry: string;
    customerType?: string;
    excludeWords: string[];
    batchSize: number;
    batchNum: number;
    companyProfile?: any;
    userPreference?: string;
  }): Promise<any[]> {
    const settings = params.companyProfile?.settings || {};
    const business = resolveBusinessContext(process.env, settings);
    const productFocus = business.productFocus;
    const targetProfiles = params.customerType && !isLegacyBusinessText(params.customerType)
      ? params.customerType
      : business.targetCustomerProfile;
    const prompt = `You are a B2B lead research assistant for ${business.brandName}.

Supplier business: ${business.brandName}
Products offered: ${productFocus}
Ideal buyers: ${business.targetCustomerProfile}

Find ${params.batchSize} REAL companies in ${this.normalizeCountry(params.targetCountry)} that are potential buyers of ${productFocus}.

Target keywords: ${params.keywords.join(', ')}
Customer type: ${targetProfiles}
Exclude: ${params.excludeWords.join(', ') || 'none'}
Batch: ${params.batchNum} (return DIFFERENT companies not seen before)
Configured company profile: ${JSON.stringify(params.companyProfile || {}, null, 2)}
Salesperson preference: ${params.userPreference || 'none'}

RULES:
- ALL output in English only. NO Chinese characters.
- Each company MUST have a real, sendable business email.
- Prefer companies whose public website, product line, procurement need, or manufacturing process could match ${productFocus}.
- Companies must operate in ${this.normalizeCountry(params.targetCountry)}.
- NO Chinese, Hong Kong, Macau, Taiwan companies.
- NO B2B directories, Alibaba, Made-in-China listings.
- Use founder/owner/buyer/sourcing/wholesale emails, NOT customer service.
- Email domain MUST match the target country:
  * Germany 鈫?.de, France 鈫?.fr, UK 鈫?.co.uk/.uk, Italy 鈫?.it, Spain 鈫?.es
  * Australia 鈫?.com.au/.au, Japan 鈫?.co.jp/.jp, Brazil 鈫?.com.br
  * USA/Canada/global 鈫?.com is acceptable
  * If you cannot find a company with a country-matching email, OMIT it.
- NEVER use .au or .com.au for non-Australian companies.
- NEVER use .de for non-German companies. Same rule for all country TLDs.

Return strict JSON array of ${params.batchSize} results:
[{ "title": "", "url": "", "snippet": "", "companyName": "", "contactEmail": "",
   "contactPerson": "", "contactTitle": "", "linkedin": "", "facebook": "", "instagram": "",
   "industryCategory": "", "confidenceScore": 0, "mainProducts": "", "contactPhone": "",
   "whatsapp": "", "emailSource": "", "emailConfidence": "Medium" }]`;

    const response = await this.zhipu.chat.completions.create({
      model: process.env.ZHIPU_MODEL || 'glm-4-flash-250414',
      messages: [
        { role: 'system', content: `You are the evidence-first B2B prospecting tool for ${business.brandName}, a packaging manufacturer. Return strict JSON only. ALL fields in English. No Chinese. Only real companies with real emails and a demonstrated need for the configured products.` },
        { role: 'user', content: prompt },
      ],
      temperature: 0.4,
      max_tokens: Math.min(8000, params.batchSize * 400 + 300),
    });

    const content = response.choices[0]?.message?.content || '[]';
    const results = this.parseJsonArray(content);
    return Array.isArray(results) ? results : [];
  }

  private async searchWithZhipu(params: {
    keywords: string[];
    targetCountry: string;
    customerType?: string;
    excludeWords: string[];
    searchLanguage: string;
    maxResults: number;
    companyProfile?: any;
    userPreference?: string;
  }): Promise<Array<{
    title: string;
    url?: string;
    snippet?: string;
    source?: string;
    isExportable?: boolean;
    isSupplier?: boolean;
    hasEmail?: boolean;
    companyName?: string;
    contactEmail?: string;
    contactPhone?: string;
    whatsapp?: string;
    linkedin?: string;
    facebook?: string;
    instagram?: string;
    twitter?: string;
    otherSocial?: string;
    contactPerson?: string;
    industryCategory?: string;
    confidenceScore?: number;
    yearEstablished?: number;
    employeeCount?: string;
    mainProducts?: string;
    hasChinaImport?: boolean;
    currentSuppliers?: string;
    emailSource?: string;
    emailConfidence?: string;
    contactTitle?: string;
  }>> {
    return this.searchWithZhipuStable(params);
  }

  private async searchWithZhipuStable(params: {
    keywords: string[];
    targetCountry: string;
    customerType?: string;
    excludeWords: string[];
    searchLanguage: string;
    maxResults: number;
    companyProfile?: any;
    userPreference?: string;
  }) {
    const isSimilarTask = params.customerType?.startsWith('Similar brand search plan:');
    const settings = params.companyProfile?.settings || {};
    const business = resolveBusinessContext(process.env, settings);
    const productFocus = business.productFocus;
    const targetProfiles = params.customerType && !isLegacyBusinessText(params.customerType)
      ? params.customerType
      : business.targetCustomerProfile;
    const prompt = `You are a B2B lead research assistant for ${business.brandName}.

Supplier products: ${productFocus}
Ideal buyer profile: ${business.targetCustomerProfile}

Company operating facts for AI outreach and prospecting:
${JSON.stringify(params.companyProfile || {
  name: 'Your Company',
  positioning: 'B2B supplier for global customers',
}, null, 2)}

Sales user's personal preference:
${params.userPreference || 'No additional personal preference.'}

Find ${params.maxResults} potential buyers or brand customers for the ${this.normalizeCountry(params.targetCountry)} market.

Target:
- Product keywords: ${params.keywords.join(', ')}
- Customer profile: ${targetProfiles}
- Exclude: ${params.excludeWords.join(', ') || 'none'}
${isSimilarTask ? '- Special task: this is a similar-brand search plan. Find companies/websites similar to the reference company, not random general prospects. Limit strictly to 5 results.' : ''}

CRITICAL LANGUAGE RULES:
- ALL output MUST be in English only. Never use Chinese characters (姹夊瓧).
- All company names, product names, snippets, and contact info must be in English.
- Translate any non-English names to English.
- If you are unsure about a translation, omit that company entirely.

Prospect rules:
1. Prefer prospects whose business, production process, product line, distribution model, or procurement role can match ${productFocus}.
2. Generic industry prospects are allowed only when there is a clear public reason they may need ${productFocus}.
3. Every prospect MUST include at least one public sendable company email or decision-maker email. Omit companies without email.
4. Prefer real person emails with contact name and title, such as founder, owner, buyer, product manager, sourcing manager, marketing manager, partnership manager, wholesale manager, or retail buyer.
5. Do not use customer-service, consumer-support, returns, privacy, legal, no-reply, or generic after-sales emails. If only customer service email is available, omit the company.
6. Role emails are acceptable only for business development or wholesale routing, such as wholesale@, partnerships@, buying@, sourcing@, b2b@, sales@, or business@.
7. Do not invent emails. If you are unsure, omit the company.
8. Include why the configured company should develop the account.
9. The prospect must be headquartered or commercially operated in ${this.normalizeCountry(params.targetCountry)}.
10. If the selected target market is not China, DO NOT return companies from Mainland China, Hong Kong, Macau, or Taiwan. This is mandatory even if an email is available.
11. Exclude Chinese suppliers, trading companies, factories, B2B directory listings, Alibaba, Made-in-China, GlobalSources, 1688, and domains ending in .cn/.com.cn unless the selected target country is China.

Return strict JSON array only. Each object must include:
title, url, snippet, source, isExportable, isSupplier, hasEmail, companyName, contactEmail, emailSource, emailConfidence, contactPhone, whatsapp, linkedin, facebook, instagram, twitter, otherSocial, contactPerson, contactTitle, contacts, industryCategory, confidenceScore, yearEstablished, employeeCount, mainProducts, hasChinaImport, currentSuppliers.

contacts must be an array of additional decision makers when available:
[{ "name": "", "title": "", "department": "", "email": "", "linkedin": "", "source": "" }]
Only include contacts with acceptable non-service emails.

Use empty string for unknown text fields, 0 for unknown year, false for unknown booleans.`;

    const response = await this.zhipu.chat.completions.create({
      model: process.env.ZHIPU_MODEL || 'glm-4-flash-250414',
      messages: [
        { role: 'system', content: `Research packaging-product buyers for ${business.brandName}. Return strict JSON only. ALL fields in English. Never use Chinese characters. Omit prospects without a public email address or evidence of a relevant packaging need.` },
        { role: 'user', content: prompt },
      ],
      temperature: 0.35,
      max_tokens: Math.min(Math.max(5000, params.maxResults * 250 + 500), 16000),
    });

    const results = this.parseJsonArray(response.choices[0]?.message?.content || '[]');
    const verified: any[] = [];
    for (const result of results) {
      // Filter out results containing Chinese characters
      const resultText = JSON.stringify(result);
      if (!this.isAllowedMarketProspect(result, params.targetCountry, params.customerType)) continue;
      const email = this.pickEmail(result.contactEmail);
      if (email === null) continue;
      const verifiedEmail: string = email;
      const mxValid = await this.hasMxRecord(verifiedEmail);
      if (!mxValid) continue;
      const verification = await this.verifyEmailDetailed(verifiedEmail);
      verified.push({
        ...result,
        title: result.title || result.companyName,
        url: result.url || '',
        source: result.source || 'zhipu',
        contactEmail: verifiedEmail,
        hasEmail: true,
        emailConfidence: result.emailConfidence || 'Medium',
        emailSource: result.emailSource || 'Zhipu GLM public-source prospecting + MX check',
        emailVerification: verification,
      });
    }

    if (verified.length >= params.maxResults) return verified.slice(0, params.maxResults);

    const webResults = await this.searchWebForEmailProspects(params, params.maxResults - verified.length);
    return [...verified, ...webResults].slice(0, params.maxResults);
  }

  private async searchWebForEmailProspects(params: {
    keywords: string[];
    targetCountry: string;
    customerType?: string;
    excludeWords: string[];
    searchLanguage: string;
    maxResults: number;
    companyProfile?: any;
    userPreference?: string;
  }, needed: number) {
    const country = this.normalizeCountry(params.targetCountry);
    const keywordText = params.keywords.join(' ');
    const settings = params.companyProfile?.settings || {};
    const business = resolveBusinessContext(process.env, settings);
    const productFocus = business.productFocus;
    const queries = [
      `"${keywordText}" brand "contact" email`,
      `"${productFocus}" "contact us" email`,
      `"${productFocus}" procurement buyer contact`,
      `"${productFocus}" distributor contact`,
      `"${productFocus}" manufacturer sourcing email`,
      `"${productFocus}" industrial supplier partnership`,
      `"${keywordText}" "contact@" -amazon -youtube -facebook -pinterest`,
      `"${keywordText}" "info@" -amazon -youtube -facebook -pinterest`,
      `${country} ${keywordText} brand contact`,
    ];
    const candidates: Array<{ title: string; url: string; snippet: string }> = [];
    for (const query of queries) {
      let rows = await this.duckDuckGoSearch(query, 8).catch(() => []);
      if (rows.length === 0) rows = await this.bingSearch(query, 8).catch(() => []);
      candidates.push(...rows);
      if (candidates.length >= needed * 3) break;
    }

    const seenDomains = new Set<string>();
    const output: any[] = [];
    for (const candidate of candidates) {
      if (output.length >= needed) break;
      const domain = extractDomain(candidate.url);
      if (!domain || seenDomains.has(domain)) continue;
      seenDomains.add(domain);
      if (params.excludeWords.some((word) => candidate.url.toLowerCase().includes(word.toLowerCase()))) continue;
      if (!this.isAllowedDomainForTarget(domain, params.targetCountry, params.customerType)) continue;

      const pages = await this.fetchCandidatePages(candidate.url).catch(() => []);
      const email = await this.extractVerifiedEmailFromPages(pages);
      if (!email) continue;

      const item = {
        title: candidate.title,
        url: candidate.url,
        snippet: candidate.snippet || `Website found by web search. Public email verified by MX record: ${email}`,
        source: 'web-crawl',
        isExportable: true,
        isSupplier: false,
        hasEmail: true,
        companyName: this.cleanCompanyName(candidate.title, domain),
        contactEmail: email,
        emailSource: 'website/contact-page crawl + MX check',
        emailConfidence: this.isRoleEmail(email) ? 'Low' : 'Medium',
        emailVerification: await this.verifyEmailDetailed(email),
        contactPhone: '',
        whatsapp: '',
        linkedin: '',
        facebook: '',
        instagram: '',
        twitter: '',
        otherSocial: '',
        contactPerson: '',
        industryCategory: params.customerType || business.targetCustomerProfile,
        confidenceScore: this.isRoleEmail(email) ? 62 : 72,
        yearEstablished: 0,
        employeeCount: '',
        mainProducts: params.keywords.join(', '),
        hasChinaImport: false,
        currentSuppliers: '',
      };
      if (!this.isAllowedMarketProspect(item, params.targetCountry, params.customerType)) continue;
      output.push(item);
    }
    return output;
  }

  private async duckDuckGoSearch(query: string, limit: number) {
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const html = await this.fetchText(url);
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const regex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html)) && results.length < limit) {
      const href = this.decodeDuckUrl(match[1]);
      if (!href || !/^https?:\/\//i.test(href)) continue;
      results.push({
        title: this.stripHtml(match[2]),
        url: href,
        snippet: this.stripHtml(match[3]),
      });
    }
    return results;
  }

  private async bingSearch(query: string, limit: number) {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
    const html = await this.fetchText(url);
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const regex = /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html)) && results.length < limit) {
      const href = this.decodeBingUrl(match[1]?.replace(/&amp;/g, '&') || '');
      if (!href || !/^https?:\/\//i.test(href)) continue;
      if (/bing\.com|microsoft\.com|youtube\.com|facebook\.com|instagram\.com|linkedin\.com\/pulse/i.test(href)) continue;
      results.push({
        title: this.stripHtml(match[2] || ''),
        url: href,
        snippet: this.stripHtml(match[3] || ''),
      });
    }
    return results;
  }

  private async searxngSearch(query: string, limit: number) {
    const base = process.env.SEARXNG_URL || process.env.SEARXNG_BASE_URL || 'http://127.0.0.1:8080';
    const url = `${base.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json&language=en`;
    const text = await this.fetchText(url);
    if (!text) return [];
    const data = JSON.parse(text);
    const rows = Array.isArray(data.results) ? data.results : [];
    return rows.slice(0, limit).map((item: any) => ({
      title: this.stripHtml(item.title || ''),
      url: item.url || '',
      snippet: this.stripHtml(item.content || item.snippet || ''),
    })).filter((item: any) => item.url && /^https?:\/\//i.test(item.url));
  }

  private async fetchCandidatePages(url: string) {
    const base = new URL(url.startsWith('http') ? url : `https://${url}`);
    const paths = ['', '/contact', '/contact-us', '/pages/contact', '/pages/contact-us', '/about', '/pages/about', '/wholesale'];
    const pages: string[] = [];
    for (const path of paths) {
      const target = `${base.protocol}//${base.host}${path}`;
      const text = await this.fetchText(target).catch(() => '');
      if (text) pages.push(text);
      if (pages.join('\n').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)) break;
    }
    return pages;
  }

  private async fetchCandidatePagesWithEvidence(url: string): Promise<EvidencePage[]> {
    const base = new URL(url.startsWith('http') ? url : `https://${url}`);
    const paths = [
      '',
      '/contact',
      '/contact-us',
      '/about',
      '/about-us',
      '/team',
      '/wholesale',
      '/partnerships',
      '/pages/contact',
      '/pages/contact-us',
      '/pages/about',
      '/pages/about-us',
    ];
    const pages: EvidencePage[] = [];
    const seen = new Set<string>();
    for (const pathName of paths) {
      const target = `${base.protocol}//${base.host}${pathName}`;
      if (seen.has(target)) continue;
      seen.add(target);
      const html = await this.fetchText(target).catch(() => '');
      if (!html) continue;
      const text = this.normalizePageText(html);
      if (text.length < 80) continue;
      pages.push({
        url: target,
        title: this.extractTitle(html),
        text,
      });
      const combined = pages.map((page) => page.text).join('\n');
      if (combined.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) && pages.length >= 2) break;
    }
    return pages;
  }

  private normalizePageText(html: string) {
    return this.stripHtml(html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' '))
      .replace(/\s+/g, ' ')
      .trim();
  }

  private extractTitle(html: string) {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return match ? this.stripHtml(match[1]) : '';
  }

  private extractEvidenceCompanyName(candidate: { title: string; url: string }, pages: EvidencePage[], domain: string) {
    const home = pages[0]?.title || candidate.title || '';
    return this.cleanCompanyName(home, domain);
  }

  private extractEmailsWithEvidence(pages: EvidencePage[]) {
    const rows: Array<{ email: string; sourceUrl: string; sourceText: string }> = [];
    const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
    for (const page of pages) {
      const matches = page.text.match(emailRegex) || [];
      for (const raw of matches) {
        const email = raw.toLowerCase();
        if (email.includes('example.') || email.includes('sentry.') || email.includes('wixpress.') || email.includes('schema.org')) continue;
        const idx = page.text.toLowerCase().indexOf(email);
        rows.push({
          email,
          sourceUrl: page.url,
          sourceText: idx >= 0 ? page.text.slice(Math.max(0, idx - 80), idx + email.length + 80) : email,
        });
      }
    }
    return rows.filter((row, index, all) => all.findIndex((item) => item.email === row.email) === index);
  }

  private async selectBestEvidenceEmail(rows: Array<{ email: string; sourceUrl: string; sourceText: string }>) {
    const acceptable = rows
      .map((row) => ({ ...row, email: this.pickEmail(row.email) }))
      .filter((row) => row.email) as Array<{ email: string; sourceUrl: string; sourceText: string }>;
    if (acceptable.length === 0) {
      return { email: '', status: 'rejected', reason: 'No acceptable public business email found on crawled pages' };
    }
    acceptable.sort((a, b) => {
      const score = (item: any) => (this.isRoleEmail(item.email) ? 1 : 0) + (/(wholesale|sourcing|procurement|sales|b2b|business)/i.test(item.email) ? -2 : 0);
      return score(a) - score(b);
    });
    const selected = acceptable[0];
    const verification = await this.verifyEmailDetailed(selected.email);
    const status = verification.status === 'smtp_verified'
      ? 'smtp_verified'
      : verification.status === 'domain_verified'
        ? 'verified_public_source'
        : 'rejected';
    return {
      email: selected.email,
      status,
      sourceUrl: selected.sourceUrl,
      sourceText: selected.sourceText,
      verification,
      reason: verification.reason,
    };
  }

  private extractPhoneWithEvidence(pages: EvidencePage[]) {
    const phoneRegex = /(?:\+\d{1,3}[\s().-]*)?(?:\(?\d{2,4}\)?[\s.-]*){2,5}\d{2,4}/g;
    for (const page of pages) {
      const matches = page.text.match(phoneRegex) || [];
      for (const raw of matches) {
        const value = raw.replace(/\s+/g, ' ').trim();
        if (this.isPlaceholderPhone(value)) {
          return { value: '', status: 'placeholder_rejected', rejected: true, reason: `Placeholder phone rejected: ${value}`, sourceUrl: page.url };
        }
        const digits = value.replace(/\D/g, '');
        if (digits.length < 8 || digits.length > 16) continue;
        const idx = page.text.indexOf(raw);
        return {
          value,
          status: 'public_source_verified',
          sourceUrl: page.url,
          sourceText: idx >= 0 ? page.text.slice(Math.max(0, idx - 80), idx + raw.length + 80) : value,
        };
      }
    }
    return { value: '', status: 'missing', reason: 'No public phone found' };
  }

  private isPlaceholderPhone(value: string) {
    const normalized = value.replace(/\D/g, '');
    if (!normalized) return false;
    if (/^(0{6,}|1{6,}|2{6,}|3{6,}|4{6,}|5{6,}|6{6,}|7{6,}|8{6,}|9{6,})$/.test(normalized)) return true;
    if (/123456|234567|345678|456789|987654|876543/.test(normalized)) return true;
    if (/1234[\s().-]*5678/i.test(value)) return true;
    if (/555[\s().-]*01\d{2}/.test(value)) return true;
    return false;
  }

  private extractSocialLinksWithEvidence(pages: EvidencePage[]) {
    const output: any = {};
    const patterns: Array<[string, RegExp]> = [
      ['linkedin', /https?:\/\/(?:[\w.-]+\.)?linkedin\.com\/[^"'\s<>]+/gi],
      ['facebook', /https?:\/\/(?:[\w.-]+\.)?facebook\.com\/[^"'\s<>]+/gi],
      ['instagram', /https?:\/\/(?:[\w.-]+\.)?instagram\.com\/[^"'\s<>]+/gi],
      ['twitter', /https?:\/\/(?:[\w.-]+\.)?(?:twitter|x)\.com\/[^"'\s<>]+/gi],
      ['pinterest', /https?:\/\/(?:[\w.-]+\.)?pinterest\.com\/[^"'\s<>]+/gi],
      ['reddit', /https?:\/\/(?:[\w.-]+\.)?reddit\.com\/[^"'\s<>]+/gi],
      ['youtube', /https?:\/\/(?:[\w.-]+\.)?youtube\.com\/[^"'\s<>]+/gi],
      ['tiktok', /https?:\/\/(?:[\w.-]+\.)?tiktok\.com\/[^"'\s<>]+/gi],
    ];
    for (const page of pages) {
      for (const [platform, regex] of patterns) {
        const match = page.text.match(regex)?.[0];
        if (match && !output[platform]) output[platform] = match.replace(/[),.]+$/, '');
      }
    }
    output.other = [];
    return output;
  }

  private async classifyEvidenceProspect(input: any) {
    const business = resolveBusinessContext();
    const prompt = `Analyze this B2B prospect for ${business.brandName} ONLY from the provided public evidence.

Products offered: ${business.productFocus}
Ideal buyers: ${business.targetCustomerProfile}

Rules:
- Do not invent company facts, contacts, emails, phones, revenue, employee count, or needs.
- If evidence is insufficient, lower confidence.
- Return strict JSON only.

Target country: ${input.targetCountry}
Customer profile: ${input.customerType || ''}
Keywords: ${(input.keywords || []).join(', ')}

Evidence sources:
${JSON.stringify(input.evidence, null, 2)}

Page excerpt:
${input.pageExcerpt}

Return:
{
  "industryCategory": "",
  "confidenceScore": 0,
  "mainProducts": "",
  "snippet": "",
  "outreachAngle": "",
  "unverifiedFlags": []
}`;
    const response = await this.zhipu.chat.completions.create({
      model: process.env.ZHIPU_MODEL || 'glm-4-flash-250414',
      messages: [
        { role: 'system', content: 'You classify evidence. Never generate facts not present in evidence. Return JSON only.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.15,
      max_tokens: 1200,
    });
    return this.parseJsonObject(response.choices[0]?.message?.content || '{}');
  }

  private async extractVerifiedEmailFromPages(pages: string[]) {
    const found = new Set<string>();
    const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
    for (const page of pages) {
      for (const email of page.match(emailRegex) || []) {
        const clean = email.toLowerCase();
        if (clean.includes('example.') || clean.includes('sentry.') || clean.includes('wixpress.')) continue;
        found.add(clean);
      }
    }
    const ordered = [...found].sort((a, b) => Number(this.isRoleEmail(a)) - Number(this.isRoleEmail(b)));
    for (const email of ordered) {
      if (await this.hasMxRecord(email)) return email;
    }
    return null;
  }

  private async fetchText(url: string) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Vaysen AI CRM/1.0; B2B research bot)',
        },
      });
      if (!res.ok) return '';
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  private decodeDuckUrl(value: string) {
    const decoded = value.replace(/&amp;/g, '&');
    try {
      const url = new URL(decoded, 'https://duckduckgo.com');
      const uddg = url.searchParams.get('uddg');
      return uddg ? decodeURIComponent(uddg) : decoded;
    } catch {
      return decoded;
    }
  }

  private decodeBingUrl(value: string) {
    const decoded = value.replace(/&amp;/g, '&');
    try {
      const url = new URL(decoded);
      const encoded = url.searchParams.get('u');
      if (!encoded) return decoded;
      const normalized = encoded.startsWith('a1') ? encoded.slice(2) : encoded;
      const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
      return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    } catch {
      return decoded;
    }
  }

  private stripHtml(value: string) {
    return value.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').trim();
  }

  private cleanCompanyName(title: string, domain: string) {
    return this.stripHtml(title).replace(/\s*[-|].*$/, '').trim() || domain.replace(/\.[^.]+$/, '');
  }

  private isRoleEmail(email: string) {
    return /^(info|contact|hello|sales|support|service|admin|office|customerservice|press)@/i.test(email);
  }

  private defaultKeywordsForProfile(customerType?: string, companySettings?: any) {
    const configured = companySettings?.defaultProspectKeywords || companySettings?.prospectKeywords;
    if (Array.isArray(configured) && configured.length > 0) {
      const current = configured
        .map((item) => String(item).trim())
        .filter((item) => item && !isLegacyBusinessText(item))
        .slice(0, 8);
      if (current.length) return current;
    }
    if (typeof configured === 'string' && configured.trim() && !isLegacyBusinessText(configured)) {
      return configured.split(',').map((item) => item.trim()).filter(Boolean).slice(0, 8);
    }
    const business = resolveBusinessContext(process.env, companySettings);
    const keywords = productFocusKeywords(business.productFocus);
    const profile = String(customerType || '').trim();
    return Array.from(new Set([
      ...keywords,
      ...(profile ? [`${profile} packaging buyer`] : []),
    ])).slice(0, 8);
  }

  private isAllowedMarketProspect(result: any, targetCountry: string, customerType?: string) {
    const text = [
      result.companyName,
      result.title,
      result.url,
      result.snippet,
      result.country,
      result.location,
      result.address,
      result.emailSource,
      result.source,
      result.contactEmail,
    ].filter(Boolean).join(' ').toLowerCase();
    const domain = extractDomain(result.url || '') || (String(result.contactEmail || '').split('@')[1] || '');

    if (!this.isAllowedDomainForTarget(domain, targetCountry, customerType)) return false;
    if (!this.isChinaAllowedTarget(targetCountry, customerType) && this.hasChinaRegionSignal(text, domain)) return false;
    if (!this.isDevelopedWesternTarget(targetCountry, customerType)) return true;

    const blockedChinaSignals = [
      'china', 'mainland china', 'hong kong', 'hongkong', 'macau', 'macao', 'taiwan',
      'shenzhen', 'guangzhou', 'xiamen', 'yiwu', 'wenzhou', 'dongguan', 'ningbo',
      'alibaba', 'made-in-china', 'globalsources', '1688.com',
      '中国', '香港', '澳门', '台湾', '深圳', '广州', '厦门', '义乌', '东莞', '宁波',
    ];
    if (blockedChinaSignals.some((word) => text.includes(word))) return false;

    const explicitCountry = String(result.country || result.headquartersCountry || result.locationCountry || '').toLowerCase();
    if (explicitCountry) {
      const aliases = this.countryAliases(this.normalizeCountry(targetCountry).toLowerCase());
      if (!aliases.some((alias) => explicitCountry.includes(alias))) return false;
    }

    return true;
  }

  private normalizeExcludeWords(excludeWords: string[], targetCountry: string, customerType?: string) {
    const defaults = this.isChinaAllowedTarget(targetCountry, customerType)
      ? []
      : [
          'china', 'hong kong', 'hongkong', 'macau', 'macao', 'taiwan',
          'shenzhen', 'guangzhou', 'xiamen', 'yiwu', 'wenzhou', 'dongguan', 'ningbo',
          'alibaba', 'made-in-china', 'globalsources', '1688', '.cn', '.com.cn',
          '中国', '香港', '澳门', '台湾', '深圳', '广州', '厦门', '义乌', '温州', '东莞', '宁波',
        ];
    return Array.from(new Set([...excludeWords, ...defaults].filter(Boolean)));
  }

  private isChinaAllowedTarget(targetCountry: string, customerType?: string) {
    const text = `${targetCountry} ${customerType || ''}`.toLowerCase();
    return ['china', 'mainland china', 'hong kong', 'hongkong', 'macau', 'macao', 'taiwan', '中国', '香港', '澳门', '台湾']
      .some((word) => text.includes(word));
  }

  private hasChinaRegionSignal(text: string, domain?: string | null) {
    const cleanDomain = (domain || '').toLowerCase();
    if (cleanDomain.endsWith('.cn') || cleanDomain.endsWith('.com.cn') || cleanDomain.endsWith('.net.cn') || cleanDomain.endsWith('.org.cn')) return true;
    if (/(alibaba|made-in-china|globalsources|1688)\./i.test(cleanDomain)) return true;
    const blocked = [
      'china', 'mainland china', 'hong kong', 'hongkong', 'macau', 'macao', 'taiwan',
      'shenzhen', 'guangzhou', 'xiamen', 'yiwu', 'wenzhou', 'dongguan', 'ningbo',
      '中国', '香港', '澳门', '台湾', '深圳', '广州', '厦门', '义乌', '温州', '东莞', '宁波',
    ];
    return blocked.some((word) => text.includes(word.toLowerCase()));
  }

  private isAllowedDomainForTarget(domain: string | null | undefined, targetCountry: string, customerType?: string) {
    if (!domain) return true;
    const clean = domain.toLowerCase().replace(/^www\./, '');
    if (this.isChinaAllowedTarget(targetCountry, customerType)) return true;
    if (clean.endsWith('.cn') || clean.endsWith('.com.cn') || clean.endsWith('.net.cn') || clean.endsWith('.org.cn')) return false;
    if (/(alibaba|made-in-china|globalsources|1688)\./i.test(clean)) return false;
    return true;
  }

  private isDevelopedWesternTarget(targetCountry: string, customerType?: string) {
    const text = `${targetCountry} ${customerType || ''}`.toLowerCase();
    const westernCountries = [
      'usa', 'united states', 'canada', 'uk', 'united kingdom', 'germany', 'france',
      'italy', 'spain', 'sweden', 'norway', 'denmark', 'finland', 'australia', 'new zealand',
      'tier1', 'developed', 'western',
    ];
    return westernCountries.some((item) => text.includes(item))
      || text.includes('欧美')
      || text.includes('发达');
  }

  private countryAliases(normalizedLowerCountry: string) {
    const map: Record<string, string[]> = {
      'united states': ['united states', 'usa', 'u.s.', 'us', 'america'],
      'united kingdom': ['united kingdom', 'uk', 'u.k.', 'britain', 'england'],
      'new zealand': ['new zealand', 'nz'],
    };
    return map[normalizedLowerCountry] || [normalizedLowerCountry];
  }

  private normalizeCountry(country: string) {
    const text = country.trim();
    const lower = text.toLowerCase();
    if (['usa', 'us', 'u.s.', 'u.s.a.', 'america'].includes(lower)) return 'United States';
    if (['uk', 'u.k.', 'gb', 'great britain'].includes(lower)) return 'United Kingdom';
    return text;
  }

  private parseJsonArray(content: string): any[] {
    const clean = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    try {
      const parsed = JSON.parse(clean);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      const match = clean.match(/\[[\s\S]*\]/);
      if (!match) return [];
      try {
        const parsed = JSON.parse(match[0]);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
  }

  private parseJsonObject(content: string): any {
    const clean = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    try {
      const parsed = JSON.parse(clean);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      const match = clean.match(/\{[\s\S]*\}/);
      if (!match) return {};
      try {
        const parsed = JSON.parse(match[0]);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }
  }

  private hasCjkText(value: string) {
    return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(value || '');
  }

  private collectSocialLinks(result: any) {
    const entries = [
      ['linkedin', result.linkedin || result.linkedinUrl],
      ['facebook', result.facebook || result.facebookUrl],
      ['instagram', result.instagram || result.instagramUrl],
      ['x', result.twitter || result.x || result.twitterUrl],
      ['pinterest', result.pinterest || result.pinterestUrl],
      ['reddit', result.reddit || result.redditUrl],
      ['youtube', result.youtube || result.youtubeUrl],
      ['tiktok', result.tiktok || result.tiktokUrl],
      ['other', result.otherSocial || result.otherSocialLinks],
    ];
    return entries
      .flatMap(([platform, raw]) => String(raw || '').split(/[,;\n]+/).map((url) => ({ platform, url: url.trim() })))
      .filter((item) => item.url && /^https?:\/\//i.test(item.url));
  }

  private mapEmailVerificationToConfidence(verification: any, emailSource?: string) {
    const status = this.toLeadEmailVerificationStatus(verification, emailSource);
    if (status === 'smtp_verified') return 'High';
    if (status === 'official_page_verified') return 'High';
    if (status === 'mx_domain_verified') return 'Medium - manual review required';
    return 'Low - rejected or unverified';
  }

  private toLeadEmailVerificationStatus(verification: any, emailSource?: string) {
    const status = String(verification?.status || '').toLowerCase();
    const source = String(emailSource || verification?.reason || '').toLowerCase();
    if (status === 'smtp_verified') return 'smtp_verified';
    if (status === 'verified_public_source') return 'official_page_verified';
    if (source.includes('official') || source.includes('website') || source.includes('contact page') || source.includes('company site')) {
      return 'official_page_verified';
    }
    if (status === 'domain_verified') return 'mx_domain_verified';
    if (status === 'failed') return 'rejected';
    return 'unverified';
  }

  private pickEmail(value: string | null | undefined) {
    if (!value) return null;
    const emails = String(value)
      .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)
      ?.map((email) => email.toLowerCase())
      .filter((email) => !this.isBlockedServiceEmail(email) && !this.isFreeMailbox(email) && !this.isPlaceholderEmail(email)) || [];

    if (emails.length === 0) return null;
    return emails.find((email) => !this.isRoleEmail(email)) || emails[0];
  }

  private isBlockedServiceEmail(email: string) {
    const local = email.split('@')[0] || '';
    return /^(customer\.?service|customerservice|consumer\.?service|consumerservice|support|help|service|returns?|privacy|legal|abuse|security|noreply|no-reply|do-not-reply|donotreply|webmaster|postmaster)$/i.test(local)
      || /(customer|consumer|support|returns?|privacy|legal|noreply|no-reply|do-not-reply|donotreply)/i.test(local);
  }

  private isFreeMailbox(email: string) {
    const domain = (email.split('@')[1] || '').toLowerCase();
    return new Set([
      'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
      'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com',
      'qq.com', '163.com', '126.com', 'foxmail.com',
    ]).has(domain);
  }

  private isPlaceholderEmail(email: string) {
    const [local = '', domain = ''] = email.toLowerCase().split('@');
    if (['example.com', 'example.org', 'example.net', 'test.com'].includes(domain)) return true;
    if (['example', 'sample', 'demo', 'test', 'user', 'firstname', 'lastname', 'first.last', 'john', 'jane', 'john.doe', 'jane.doe'].includes(local)) return true;
    return /^(john|jane)([._-]?doe)?\d*$/.test(local) || /^test\d*$/.test(local);
  }

  private async hasMxRecord(email: string) {
    const reacherResult = await this.verifyWithReacher(email);
    if (reacherResult !== null) return reacherResult;

    const domain = email.split('@')[1];
    if (!domain) return false;
    try {
      const mx = await dns.resolveMx(domain);
      return mx.length > 0;
    } catch (error: any) {
      const fallback = await this.resolveMxWithFallback(domain);
      if (fallback) return true;
      try {
        await dns.lookup(domain);
        return true;
      } catch {
        return false;
      }
    }
  }

  private async verifyEmailDetailed(email: string): Promise<{ status: string; method: string; reason: string; checkedAt: string }> {
    if (this.isPlaceholderEmail(email)) {
      return {
        status: 'failed',
        method: 'placeholder',
        reason: 'Placeholder email is not a real customer mailbox',
        checkedAt: new Date().toISOString(),
      };
    }
    const reacherResult = await this.verifyWithReacher(email);
    if (reacherResult === true) {
      return {
        status: 'smtp_verified',
        method: 'reacher',
        reason: 'Reacher accepted the mailbox as reachable',
        checkedAt: new Date().toISOString(),
      };
    }
    if (reacherResult === false) {
      return {
        status: 'failed',
        method: 'reacher',
        reason: 'Reacher rejected the mailbox',
        checkedAt: new Date().toISOString(),
      };
    }

    const domain = email.split('@')[1];
    if (!domain) {
      return { status: 'failed', method: 'syntax', reason: 'Missing domain', checkedAt: new Date().toISOString() };
    }

    try {
      const mx = await dns.resolveMx(domain);
      if (mx.length > 0) {
        return {
          status: 'domain_verified',
          method: 'mx',
          reason: 'Domain has MX records. Mailbox existence still needs SMTP verification.',
          checkedAt: new Date().toISOString(),
        };
      }
    } catch {
      if (await this.resolveMxWithFallback(domain)) {
        return {
          status: 'domain_verified',
          method: 'mx_fallback',
          reason: 'Domain has MX records via fallback DNS resolver. Mailbox existence still needs SMTP verification.',
          checkedAt: new Date().toISOString(),
        };
      }
      try {
        await dns.lookup(domain);
        return {
          status: 'domain_verified',
          method: 'dns_lookup',
          reason: 'Domain resolves, but MX lookup was unavailable in this environment. Mailbox existence still needs SMTP verification.',
          checkedAt: new Date().toISOString(),
        };
      } catch {
        return { status: 'failed', method: 'dns', reason: 'Domain does not resolve', checkedAt: new Date().toISOString() };
      }
    }

    return { status: 'failed', method: 'mx', reason: 'Domain has no MX records', checkedAt: new Date().toISOString() };
  }

  private async verifyWithReacher(email: string): Promise<boolean | null> {
    const apiUrl = process.env.REACHER_API_URL;
    if (!apiUrl) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const baseUrl = apiUrl.replace(/\/$/, '');
      const endpoints = baseUrl.endsWith('/check_email')
        ? [baseUrl]
        : [`${baseUrl}/v0/check_email`, `${baseUrl}/v1/check_email`];
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (process.env.REACHER_API_TOKEN) headers.authorization = process.env.REACHER_API_TOKEN;

      let data: any = null;
      for (const endpoint of endpoints) {
        const res = await fetch(endpoint, {
          method: 'POST',
          signal: controller.signal,
          headers,
          body: JSON.stringify({ to_email: email }),
        });
        if (!res.ok) continue;
        data = await res.json();
        break;
      }
      if (!data) return null;

      const reachable = String(data.is_reachable || data.result || data.status || '').toLowerCase();
      if (['safe', 'valid', 'reachable', 'yes'].includes(reachable)) return true;
      if (['invalid', 'unreachable', 'no', 'risky'].includes(reachable)) return false;
      if (typeof data.is_reachable === 'boolean') return data.is_reachable;
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async resolveMxWithFallback(domain: string): Promise<boolean> {
    for (const server of ['223.5.5.5', '114.114.114.114', '8.8.8.8', '1.1.1.1']) {
      try {
        const resolver = new dns.Resolver();
        resolver.setServers([server]);
        const mx = await resolver.resolveMx(domain);
        if (mx.length > 0) return true;
      } catch (err: any) {
        this.logger?.error?.('MX record DNS fallback lookup failed: ' + (err?.message || err), err?.stack);
      }
    }
    return false;
  }
}
