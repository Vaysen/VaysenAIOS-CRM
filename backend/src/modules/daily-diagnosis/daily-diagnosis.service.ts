/**
 * daily-diagnosis.service.ts
 *
 * R111 批次D：每日 AI 运营诊断快照。
 * - GET /daily-diagnosis/today：Asia/Shanghai 工作日日期，当日快照幂等（COMPLETED 直接回显），
 *   GENERATING 防抖（<10 分钟返回 { generating: true } 供前端轮询，>10 分钟接管重算），
 *   无快照则新建 GENERATING → 调 OpenClaw 生成结构化 JSON 诊断 → 落 COMPLETED。
 * - POST /daily-diagnosis/regenerate：管理员强制重算当日快照。
 * - 开关 DAILY_DIAGNOSIS_ENABLED（默认 true）；OpenClaw 不可用（OPENCLAW_ENABLED!=='true'
 *   或网关不可达）→ 503 中文提示，不落 FAILED（避免污染）；生成失败 → FAILED + lastError → 502。
 */

import { createHash } from 'node:crypto';
import {
  BadGatewayException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CurrentUser, requireActiveCompany } from '../../common/utils/data-isolation';
import { AgentService } from '../agent/agent.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { OpenClawGatewayClient } from '../openclaw/openclaw-gateway.client';

/** GENERATING 残留的接管阈值：updatedAt 距今超过该时长视为崩溃残留，允许重算接管。 */
const GENERATING_LEASE_MS = 10 * 60 * 1000;
/** 生成过程中的整体兜底超时（OpenClaw chat 自身 45s，这里给出更宽裕的包裹时间）。 */
const GENERATION_TIMEOUT_MS = 90 * 1000;
/** 结构化 JSON 字段长度上限（防止大字段撑爆快照）。 */
const MAX_TEXT_LEN = 2000;

type DiagnosisResult = {
  healthScore: number;
  summary: string;
  highlights: string[];
  risks: string[];
  recommendations: Array<{ priority: 'P0' | 'P1' | 'P2'; title: string; reason: string; action: string }>;
};

export function shanghaiToday(): string {
  // Asia/Shanghai 时区的 YYYY-MM-DD（en-CA 输出 ISO 样式日期）
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

@Injectable()
export class DailyDiagnosisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AgentService,
    private readonly analytics: AnalyticsService,
    private readonly openclaw: OpenClawGatewayClient,
  ) {}

  private isEnabled(): boolean {
    return process.env.DAILY_DIAGNOSIS_ENABLED !== 'false';
  }

  /**
   * 解析请求的目标公司：Query 可带 companyId，但必须与当前活跃公司一致
   * （内部聚合复用 analytics/execution，二者均以活跃公司为数据隔离边界，
   * 避免诊断行归属与指标口径不一致）。
   */
  private resolveCompany(user: CurrentUser, companyId?: string) {
    const active = requireActiveCompany(user);
    const requested = companyId?.trim();
    if (requested && requested !== active.id) {
      throw new ForbiddenException('诊断仅支持当前活跃公司');
    }
    return active;
  }

  /** 检查 OpenClaw 可用性；不可用抛 503（不落 FAILED，避免污染快照数据）。 */
  private async assertOpenClawAvailable(): Promise<void> {
    if (!this.openclaw.isEnabled()) {
      throw new ServiceUnavailableException('AI 诊断服务暂不可用，请稍后重试');
    }
    const probe = await this.openclaw.probe();
    if (!probe.gatewayReady || !probe.adapterReady || !probe.modelReady) {
      throw new ServiceUnavailableException('AI 诊断服务暂不可用，请稍后重试');
    }
  }

  /**
   * GET /daily-diagnosis/today：当日快照（幂等）+ 生成。
   */
  async getToday(user: CurrentUser, companyId?: string) {
    if (!this.isEnabled()) {
      throw new ServiceUnavailableException('AI 诊断服务暂不可用，请稍后重试');
    }
    const company = this.resolveCompany(user, companyId);
    const dateStr = shanghaiToday();
    const date = new Date(`${dateStr}T00:00:00.000Z`);
    const existing = await this.prisma.dailyDiagnosis.findUnique({
      where: { companyId_diagnosisDate: { companyId: company.id, diagnosisDate: date } },
    });

    // 当日快照已 COMPLETED → 直接回显（幂等，不重算）
    if (existing && existing.status === 'COMPLETED') {
      return this.toSnapshot(existing);
    }
    // GENERATING 且更新时间在 10 分钟内 → 返回生成中（前端轮询）
    if (
      existing
      && existing.status === 'GENERATING'
      && Date.now() - existing.updatedAt.getTime() < GENERATING_LEASE_MS
    ) {
      return { generating: true };
    }

    // 无快照，或 GENERATING 残留超过 10 分钟 → 接管重算
    await this.assertOpenClawAvailable();
    const createdNow = !existing;
    const row = existing
      ? await this.prisma.dailyDiagnosis.update({
          where: { id: existing.id },
          data: { status: 'GENERATING', lastError: null, updatedAt: new Date() },
        })
      : await this.prisma.dailyDiagnosis.create({
          data: { companyId: company.id, diagnosisDate: date, status: 'GENERATING' },
        });

    try {
      return await this.generate(user, company.id, row);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        // 网关中途不可用：不落 FAILED。新行直接删除（避免留下无人生成的 GENERATING），
        // 接管行保持 GENERATING（10 分钟后可被再次接管）。
        if (createdNow) {
          await this.prisma.dailyDiagnosis.delete({ where: { id: row.id } }).catch(() => undefined);
        }
        throw error;
      }
      const message = error instanceof Error ? error.message : 'unknown_error';
      await this.prisma.dailyDiagnosis
        .update({
          where: { id: row.id },
          data: { status: 'FAILED', lastError: message.slice(0, 500) },
        })
        .catch(() => undefined);
      throw new BadGatewayException('诊断生成失败，请稍后重试');
    }
  }

  /**
   * POST /daily-diagnosis/regenerate：管理员强制重算当日快照。
   * 仅当已有当日快照（任意状态）时允许；无快照返回 404。
   */
  async regenerate(user: CurrentUser, companyId?: string) {
    if (!this.isEnabled()) {
      throw new ServiceUnavailableException('AI 诊断服务暂不可用，请稍后重试');
    }
    const company = this.resolveCompany(user, companyId);
    // 强制重算仅限公司管理员
    const companies = user.companies || [];
    const membership = companies.find((c) => c.id === company.id);
    if (!membership || !['company_admin', 'super_admin'].includes(membership.role)) {
      throw new ForbiddenException('仅公司管理员可强制重新生成诊断');
    }
    const dateStr = shanghaiToday();
    const date = new Date(`${dateStr}T00:00:00.000Z`);
    const existing = await this.prisma.dailyDiagnosis.findUnique({
      where: { companyId_diagnosisDate: { companyId: company.id, diagnosisDate: date } },
    });
    if (!existing) {
      throw new ForbiddenException('今日暂无诊断快照，无需重新生成');
    }
    await this.assertOpenClawAvailable();
    const previousStatus = existing.status;
    const row = await this.prisma.dailyDiagnosis.update({
      where: { id: existing.id },
      data: { status: 'GENERATING', lastError: null, updatedAt: new Date() },
    });
    try {
      return await this.generate(user, company.id, row);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        // 网关不可用：恢复原状态，不落 FAILED（避免污染快照数据）
        await this.prisma.dailyDiagnosis
          .update({ where: { id: row.id }, data: { status: previousStatus } })
          .catch(() => undefined);
        throw error;
      }
      const message = error instanceof Error ? error.message : 'unknown_error';
      await this.prisma.dailyDiagnosis
        .update({ where: { id: row.id }, data: { status: 'FAILED', lastError: message.slice(0, 500) } })
        .catch(() => undefined);
      throw new BadGatewayException('诊断生成失败，请稍后重试');
    }
  }

  /**
   * 生成主流程：聚合输入 → OpenClaw 生成 → 解析（失败重试 1 次）→ 落 COMPLETED。
   */
  private async generate(user: CurrentUser, companyId: string, row: { id: string }): Promise<any> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('diagnosis_generation_timeout')), GENERATION_TIMEOUT_MS);
    });
    try {
      const work = (async () => {
        const metricsSnapshot = await this.collectMetrics(user, companyId);
        const result = await this.callDiagnosis(metricsSnapshot);
        return { metricsSnapshot, result };
      })();
      // 防未处理拒绝：超时先到而 work 后失败时，避免 unhandled rejection
      work.catch(() => undefined);
      const { metricsSnapshot, result } = await Promise.race([work, timeout]);
      const updated = await this.prisma.dailyDiagnosis.update({
        where: { id: row.id },
        data: {
          status: 'COMPLETED',
          healthScore: result.healthScore,
          summary: result.summary,
          highlights: result.highlights.length ? (result.highlights as Prisma.InputJsonValue) : Prisma.DbNull,
          risks: result.risks.length ? (result.risks as Prisma.InputJsonValue) : Prisma.DbNull,
          recommendations: result.recommendations.length
            ? (result.recommendations as Prisma.InputJsonValue)
            : Prisma.DbNull,
          // metricsSnapshot 存输入指标，供快照回显
          metricsSnapshot: JSON.parse(JSON.stringify(metricsSnapshot)) as Prisma.InputJsonValue,
          lastError: null,
        },
      });
      return this.toSnapshot(updated);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 聚合诊断输入：agent.getBrief + analytics overview + sources + whatsapp-stats。 */
  private async collectMetrics(user: CurrentUser, companyId: string) {
    const [brief, overview, sources, whatsapp] = await Promise.all([
      // agent.getBrief 期望 AuthenticatedUser（activeCompanyId 不含 null），此处宽松适配
      this.agent.getBrief(companyId, user as any),
      this.analytics.getOverview(user, {}),
      this.analytics.getSources(user),
      this.analytics.getWhatsappStats(user),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      companyId,
      brief,
      overview,
      sources,
      whatsapp,
    };
  }

  /** 调 OpenClaw 生成结构化 JSON 诊断；JSON 解析失败重试 1 次。 */
  private async callDiagnosis(metrics: unknown): Promise<DiagnosisResult> {
    const systemPrompt = [
      '你是 Vaysen 包装厂资深外贸运营分析师。',
      '你只输出合法 JSON，不输出任何其他文字、解释或 Markdown 代码块标记。',
      '输出格式（严格 JSON，不得增减字段）：',
      '{',
      '  "healthScore": 0到100之间的整数,',
      '  "summary": "中文一句话诊断",',
      '  "highlights": ["最多3条中文亮点"],',
      '  "risks": ["最多3条中文风险（含具体客户/指标数据）"],',
      '  "recommendations": [{"priority": "P0"|"P1"|"P2", "title": "中文标题", "reason": "依据说明", "action": "具体行动建议"}]',
      '}',
    ].join('\n');
    const userMessage = [
      '以下是 Vaysen 包装厂今日运营指标（JSON），请基于数据输出诊断 JSON：',
      JSON.stringify(metrics),
    ].join('\n');

    const sessionDigest = createHash('sha256')
      .update(`daily-diagnosis:${String((metrics as any)?.companyId || '')}`, 'utf8')
      .digest('hex');

    const attempt = async (extraInstruction?: string): Promise<DiagnosisResult> => {
      const result = await this.openclaw.chat(
        systemPrompt,
        extraInstruction ? `${userMessage}\n${extraInstruction}` : userMessage,
        sessionDigest,
        1200,
      );
      if (!result.success) {
        // disabled/not_ready/timeout/gateway_error → 网关不可用，走 503（不落 FAILED）
        throw new ServiceUnavailableException('AI 诊断服务暂不可用，请稍后重试');
      }
      const parsed = this.parseDiagnosisJson(result.content || '');
      if (!parsed) {
        throw new Error('diagnosis_invalid_json');
      }
      return parsed;
    };

    try {
      return await attempt();
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      // 解析失败重试 1 次：要求只输出合法 JSON
      return attempt('上一次输出不是合法 JSON。现在只输出一个合法 JSON 对象，不要任何其他文字。');
    }
  }

  /** 解析并校验诊断 JSON（宽松：剥离 Markdown 代码块围栏后取首个 JSON 对象）。 */
  private parseDiagnosisJson(content: string): DiagnosisResult | null {
    if (!content) return null;
    let text = content.trim();
    // 剥离 ```json ... ``` 围栏
    const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
    if (fence) text = fence[1].trim();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      // 尝试截取首个 { ... } 平衡块
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start < 0 || end <= start) return null;
      try {
        data = JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const healthScore = Math.max(0, Math.min(100, Math.trunc(Number(data.healthScore) || 0)));
    const summary = typeof data.summary === 'string' ? data.summary.slice(0, MAX_TEXT_LEN) : '';
    const highlights = Array.isArray(data.highlights)
      ? data.highlights.filter((h: unknown) => typeof h === 'string').slice(0, 3)
      : [];
    const risks = Array.isArray(data.risks)
      ? data.risks.filter((r: unknown) => typeof r === 'string').slice(0, 3)
      : [];
    const recommendations = Array.isArray(data.recommendations)
      ? data.recommendations
          .filter((r: any) => r && typeof r === 'object' && typeof r.title === 'string')
          .slice(0, 5)
          .map((r: any) => ({
            priority: ['P0', 'P1', 'P2'].includes(r.priority) ? r.priority : 'P2',
            title: String(r.title).slice(0, 200),
            reason: typeof r.reason === 'string' ? r.reason.slice(0, MAX_TEXT_LEN) : '',
            action: typeof r.action === 'string' ? r.action.slice(0, MAX_TEXT_LEN) : '',
          }))
      : [];
    if (!summary && recommendations.length === 0 && highlights.length === 0 && risks.length === 0) {
      return null;
    }
    return { healthScore, summary, highlights, risks, recommendations };
  }

  /** 快照回显：Date 序列化 + 空 JSON 兜底。 */
  private toSnapshot(row: any) {
    return {
      id: row.id,
      companyId: row.companyId,
      diagnosisDate: row.diagnosisDate instanceof Date
        ? row.diagnosisDate.toISOString().slice(0, 10)
        : String(row.diagnosisDate),
      status: row.status,
      healthScore: row.healthScore,
      summary: row.summary,
      highlights: row.highlights,
      risks: row.risks,
      recommendations: row.recommendations,
      metricsSnapshot: row.metricsSnapshot,
      lastError: row.lastError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
