import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { AiProviderService } from '../../common/ai/ai-provider.service';
import { ensureCompanyAccess, requireActiveCompany } from '../../common/utils/data-isolation';

export interface AiCoachResult {
  stageAnalysis: string;
  recommendations: { priority: 'high' | 'medium' | 'low'; action: string; reason: string }[];
  emailDraft?: { subject: string; body: string };
  urgencyLevel: 'urgent' | 'soon' | 'routine' | 'none';
  reasoning: string;
}

@Injectable()
export class AiCoachService {
  private readonly logger = new Logger(AiCoachService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiProviderService,
  ) {}

  async analyze(leadId: string, currentUser: any): Promise<AiCoachResult> {
    const activeCompany = requireActiveCompany(currentUser);
    const companyId = activeCompany.id;

    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, companyId },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    this.ensureAccess(currentUser, lead.companyId);

    const [emails, reminders, timeline] = await Promise.all([
      this.prisma.emailMessage.findMany({
        where: { leadId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { subject: true, status: true, openedAt: true, clickedAt: true, createdAt: true },
      }),
      this.prisma.followUpReminder.findMany({
        where: { leadId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { title: true, reason: true, status: true, priority: true, dueAt: true },
      }),
      this.prisma.leadActivity.findMany({
        where: { leadId },
        orderBy: { occurredAt: 'desc' },
        take: 10,
        select: { activityType: true, title: true, description: true, occurredAt: true },
      }),
    ]);

    const context = {
      company: {
        name: lead.companyName,
        industry: lead.industry,
        country: lead.country,
        city: lead.city,
        mainProducts: lead.mainProducts,
        yearEstablished: lead.yearEstablished,
        employeeCount: lead.employeeCount,
        hasChinaImport: lead.hasChinaImport,
        currentSuppliers: lead.currentSuppliers,
      },
      contact: {
        name: lead.contactName,
        title: lead.contactTitle,
        email: lead.contactEmail,
        phone: lead.contactPhone,
        whatsapp: lead.whatsapp,
      },
      pipeline: {
        status: lead.status,
        leadScore: lead.leadScore,
        leadGrade: lead.leadGrade,
        confidenceScore: lead.confidenceScore,
        lastContactedAt: lead.lastContactedAt,
        nextFollowUpAt: lead.nextFollowUpAt,
        notes: lead.notes,
      },
      emailStats: {
        totalSent: emails.length,
        opened: emails.filter((e) => e.openedAt).length,
        clicked: emails.filter((e) => e.clickedAt).length,
        lastEmailSent: emails[0]?.createdAt || null,
        recentEmails: emails.slice(0, 5).map((e) => ({
          subject: e.subject,
          status: e.status,
          wasOpened: !!e.openedAt,
          wasClicked: !!e.clickedAt,
          sentAt: e.createdAt,
        })),
      },
      reminders: reminders.map((r) => ({
        title: r.title,
        reason: r.reason,
        status: r.status,
        priority: r.priority,
        dueAt: r.dueAt,
      })),
      recentActivities: timeline.map((a) => ({
        type: a.activityType,
        title: a.title,
        description: a.description,
        date: a.occurredAt,
      })),
    };

    const prompt = this.buildPrompt(context);
    return this.callAi(prompt);
  }

  private buildPrompt(context: any): string {
    const statusLabels: Record<string, string> = {
      new: '新客户（刚获取，尚未联系）',
      contacted: '已联系（已发送第一封开发信）',
      replied: '已回复（客户已回复邮件，进入对话阶段）',
      interested: '有意向（客户表现出采购兴趣，正在洽谈）',
      quoted: '已报价（已发送报价单）',
      won: '已成交（已下单/签约）',
      lost: '无效客户（已流失/不合格/勿联系）',
    };

    const stageDesc = statusLabels[context.pipeline.status] || context.pipeline.status;
    const emailHistory = context.emailStats.recentEmails.length > 0
      ? context.emailStats.recentEmails.map((e: any) =>
          `- "${e.subject}" (${e.status})${e.wasOpened ? ' [已打开]' : ''}${e.wasClicked ? ' [已点击链接]' : ''} - ${new Date(e.sentAt).toLocaleDateString()}`
        ).join('\n')
      : '暂无邮件记录';

    const activityHistory = context.recentActivities.length > 0
      ? context.recentActivities.map((a: any) =>
          `- [${a.type}] ${a.title}${a.description ? ': ' + a.description : ''} - ${new Date(a.date).toLocaleDateString()}`
        ).join('\n')
      : '暂无活动记录';

    const remindersList = context.reminders.length > 0
      ? context.reminders.map((r: any) =>
          `- ${r.title} (${r.status}, 优先级: ${r.priority}, 截止: ${new Date(r.dueAt).toLocaleDateString()})`
        ).join('\n')
      : '暂无跟进提醒';

    return `你是一个资深的外贸B2B销售教练，拥有20年外贸客户开发经验。请根据以下客户信息，分析当前销售阶段并给出下一步行动建议。

## 客户信息

**公司：** ${context.company.name || '未知'}
**行业：** ${context.company.industry || '未知'}
**国家：** ${context.company.country || '未知'}
**城市：** ${context.company.city || '未知'}
**主营产品：** ${context.company.mainProducts || '未知'}
**成立年份：** ${context.company.yearEstablished || '未知'}
**员工规模：** ${context.company.employeeCount || '未知'}
**有中国进口记录：** ${context.company.hasChinaImport != null ? (context.company.hasChinaImport ? '是' : '否') : '未知'}
**现有供应商：** ${context.company.currentSuppliers || '未知'}

**联系人：** ${context.contact.name || '未知'}
**职位：** ${context.contact.title || '未知'}
**邮箱：** ${context.contact.email || '未知'}
**电话：** ${context.contact.phone || '未知'}

## 当前销售阶段

**状态：** ${stageDesc}
**评分：** ${context.pipeline.leadScore ?? '未评分'} / 100
**等级：** ${context.pipeline.leadGrade || '未评级'}
**上次联系时间：** ${context.pipeline.lastContactedAt ? new Date(context.pipeline.lastContactedAt).toLocaleDateString() : '从未联系'}
**下次跟进日期：** ${context.pipeline.nextFollowUpAt ? new Date(context.pipeline.nextFollowUpAt).toLocaleDateString() : '未设定'}
**备注：** ${context.pipeline.notes || '无'}

## 邮件沟通历史

总发送: ${context.emailStats.totalSent} | 已打开: ${context.emailStats.opened} | 已点击: ${context.emailStats.clicked}
${emailHistory}

## 跟进提醒

${remindersList}

## 最近活动

${activityHistory}

---
请以JSON格式返回分析结果，结构如下：

\`\`\`json
{
  "stageAnalysis": "分析该客户当前处于什么销售阶段，为什么（2-3句话）",
  "recommendations": [
    { "priority": "high/medium/low", "action": "具体行动建议", "reason": "为什么建议这个行动" }
  ],
  "emailDraft": {
    "subject": "邮件主题（英文，外贸风格）",
    "body": "邮件正文（英文HTML格式，用<p>分段，个性化、专业、不要过于推销，根据客户阶段调整内容。如果已经成交或流失则不需要写邮件，设为null）"
  },
  "urgencyLevel": "urgent/soon/routine/none",
  "reasoning": "整体策略思路（2-3句话，中文）"
}
\`\`\`

要求：
1. 邮件草稿必须针对性强，引用客户的具体情况（行业、产品、国家等）
2. 建议必须可执行，不能泛泛而谈
3. 如果客户状态是won/lost，emailDraft设为null
4. urgencyLevel: 超过3天未联系且有打开/点击→urgent；有未读邮件→soon；正常跟进→routine；不需要跟进→none
5. 只返回JSON，不要其他文字

请直接返回JSON：`;
  }

  private async callAi(prompt: string): Promise<AiCoachResult> {
    const result = await this.ai.chat(
      '你是一个专业的外贸B2B销售教练。只返回JSON数据，不返回其他任何内容。',
      prompt,
      { task: 'ai_coach', temperature: 0.7, maxTokens: 4096 },
    );

    const content = result.content || '';
    const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    let parsed: any = null;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      const match = jsonStr.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch { parsed = null; }
      }
    }

    return {
      stageAnalysis: typeof parsed?.stageAnalysis === 'string' ? parsed.stageAnalysis : '',
      recommendations: Array.isArray(parsed?.recommendations) ? parsed.recommendations : [],
      emailDraft: parsed?.emailDraft || undefined,
      urgencyLevel: parsed?.urgencyLevel || 'routine',
      reasoning: typeof parsed?.reasoning === 'string' ? parsed.reasoning : '',
    };
  }

  private ensureAccess(currentUser: any, companyId: string) {
    try {
      ensureCompanyAccess(currentUser, companyId);
    } catch (err: any) {
      throw new ForbiddenException(err.message?.replace('FORBIDDEN: ', '') || 'Access denied');
    }
  }
}
