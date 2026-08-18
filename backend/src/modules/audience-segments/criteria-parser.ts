/**
 * criteria-parser.ts
 *
 * R111 批次A 客群系统：把客群筛选条件（criteriaJson）翻译为 Prisma Lead where。
 *
 * 实际字段以 prisma/schema.prisma 的 Lead 模型为准：
 *  - tags 是关联表（LeadTag[] → tag.name），不是 String[]
 *  - quotes 是 Quote[]，样品条件用 quotes.some(type='sample')
 *  - orders 是 Order[]，有订单 = orders 存在记录
 *  - opportunities 是 Opportunity[]，商机阶段用 opportunities.some(stage in ...)
 *  - contactPoints 是 ContactPoint[]，email/WhatsApp 用触点存在性判断
 *  - lastContactedAt 是 Lead 上的 DateTime? 字段
 *  - 软删除：deletedAt 非空的一律排除
 */
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SegmentCriteriaDto } from './dto/segment-criteria.dto';

export const SAMPLE_QUOTE_TYPE = 'sample';

const DAY_MS = 24 * 60 * 60 * 1000;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** 归一化字符串枚举过滤：Postgres 下对大小写不敏感，兼容存量数据（如 'Email'/'EMAIL'） */
function insensitive(value: string) {
  return { equals: value, mode: 'insensitive' as const };
}

/**
 * 解析并翻译 criteriaJson → Prisma.LeadWhereInput。
 * 所有条件均为可选；空条件 = 该公司全部未删除客户。
 * 未知键忽略（DTO 白名单已先行剔除，这里再做一次防御）。
 * 类型非法时抛 BadRequestException（沿用现有校验风格）。
 */
export function buildLeadCriteriaWhere(
  companyId: string,
  criteria: SegmentCriteriaDto | Record<string, unknown>,
): Prisma.LeadWhereInput {
  const where: Prisma.LeadWhereInput = {
    companyId,
    deletedAt: null,
  };

  const conditions: Prisma.LeadWhereInput[] = [];

  // 客户阶段多选
  const leadStatuses = (criteria as Record<string, unknown>).leadStatuses;
  if (leadStatuses !== undefined) {
    if (!isStringArray(leadStatuses) || leadStatuses.length === 0) {
      throw new BadRequestException('criteria.leadStatuses must be a non-empty string array');
    }
    conditions.push({ status: { in: leadStatuses } });
  }

  // 分级
  const leadGrades = (criteria as Record<string, unknown>).leadGrades;
  if (leadGrades !== undefined) {
    if (!isStringArray(leadGrades) || leadGrades.length === 0) {
      throw new BadRequestException('criteria.leadGrades must be a non-empty string array');
    }
    conditions.push({ leadGrade: { in: leadGrades } });
  }

  // 国家（country 字段）
  const countries = (criteria as Record<string, unknown>).countries;
  if (countries !== undefined) {
    if (!isStringArray(countries) || countries.length === 0) {
      throw new BadRequestException('criteria.countries must be a non-empty string array');
    }
    conditions.push({ country: { in: countries } });
  }

  // 来源
  const sourceTypes = (criteria as Record<string, unknown>).sourceTypes;
  if (sourceTypes !== undefined) {
    if (!isStringArray(sourceTypes) || sourceTypes.length === 0) {
      throw new BadRequestException('criteria.sourceTypes must be a non-empty string array');
    }
    conditions.push({ sourceType: { in: sourceTypes } });
  }

  // 标签（tags 是 LeadTag[] 关联表，通过 tag.name 匹配，命中任一）
  const tags = (criteria as Record<string, unknown>).tags;
  if (tags !== undefined) {
    if (!isStringArray(tags) || tags.length === 0) {
      throw new BadRequestException('criteria.tags must be a non-empty string array');
    }
    conditions.push({ tags: { some: { tag: { name: { in: tags } } } } });
  }

  // 近 N 天新客（createdAt）
  const createdWithinDays = (criteria as Record<string, unknown>).createdWithinDays;
  if (createdWithinDays !== undefined) {
    if (!isPositiveInt(createdWithinDays)) {
      throw new BadRequestException('criteria.createdWithinDays must be a positive integer');
    }
    conditions.push({ createdAt: { gte: new Date(Date.now() - createdWithinDays * DAY_MS) } });
  }

  // 要过样品（quotes 存在 type='sample'）
  const hasSampleQuote = (criteria as Record<string, unknown>).hasSampleQuote;
  if (hasSampleQuote !== undefined) {
    if (!isBoolean(hasSampleQuote)) {
      throw new BadRequestException('criteria.hasSampleQuote must be a boolean');
    }
    if (hasSampleQuote) {
      conditions.push({ quotes: { some: { type: insensitive(SAMPLE_QUOTE_TYPE) } } });
    }
  }

  // 有订单（orders 存在记录）
  const hasOrder = (criteria as Record<string, unknown>).hasOrder;
  if (hasOrder !== undefined) {
    if (!isBoolean(hasOrder)) {
      throw new BadRequestException('criteria.hasOrder must be a boolean');
    }
    if (hasOrder) {
      conditions.push({ orders: { some: {} } });
    }
  }

  // 已跟进未回复：lastContactedAt 距今 > N 天（排除从未联系），
  // 且 N 天内没有任何 inbound 消息（CommunicationMessage.direction='inbound'）。
  const followedUpNoReplyDays = (criteria as Record<string, unknown>).followedUpNoReplyDays;
  if (followedUpNoReplyDays !== undefined) {
    if (!isPositiveInt(followedUpNoReplyDays)) {
      throw new BadRequestException('criteria.followedUpNoReplyDays must be a positive integer');
    }
    const cutoff = new Date(Date.now() - followedUpNoReplyDays * DAY_MS);
    conditions.push({
      lastContactedAt: { lte: cutoff },
      conversations: {
        none: {
          messages: { some: { direction: 'inbound', receivedAt: { gt: cutoff } } },
        },
      },
    });
  }

  // 客户有 email 触点（ContactPoint 存在性）
  const hasEmail = (criteria as Record<string, unknown>).hasEmail;
  if (hasEmail !== undefined) {
    if (!isBoolean(hasEmail)) {
      throw new BadRequestException('criteria.hasEmail must be a boolean');
    }
    if (hasEmail) {
      conditions.push({ contactPoints: { some: { type: insensitive('email') } } });
    }
  }

  // 客户有 WhatsApp 触点
  const hasWhatsapp = (criteria as Record<string, unknown>).hasWhatsapp;
  if (hasWhatsapp !== undefined) {
    if (!isBoolean(hasWhatsapp)) {
      throw new BadRequestException('criteria.hasWhatsapp must be a boolean');
    }
    if (hasWhatsapp) {
      conditions.push({ contactPoints: { some: { type: insensitive('whatsapp') } } });
    }
  }

  // 商机阶段（Opportunity.stage）
  const opportunityStages = (criteria as Record<string, unknown>).opportunityStages;
  if (opportunityStages !== undefined) {
    if (!isStringArray(opportunityStages) || opportunityStages.length === 0) {
      throw new BadRequestException('criteria.opportunityStages must be a non-empty string array');
    }
    conditions.push({ opportunities: { some: { stage: { in: opportunityStages } } } });
  }

  // 排除已在某客群（如已营销过）：只要目标客群存在该客户的成员记录
  // （含 skipped —— 表示曾命中过/曾营销过）即排除。
  const notInSegmentIds = (criteria as Record<string, unknown>).notInSegmentIds;
  if (notInSegmentIds !== undefined) {
    if (!isStringArray(notInSegmentIds) || notInSegmentIds.length === 0) {
      throw new BadRequestException('criteria.notInSegmentIds must be a non-empty string array');
    }
    conditions.push({
      NOT: [{ audienceSegmentMembers: { some: { segmentId: { in: notInSegmentIds } } } }],
    });
  }

  if (conditions.length > 0) {
    where.AND = conditions;
  }
  return where;
}

/** 提取并校验成员上限（可选，1..50000），缺省不限制 */
export function extractCriteriaLimit(
  criteria: SegmentCriteriaDto | Record<string, unknown>,
): number | undefined {
  const limit = (criteria as Record<string, unknown>).limit;
  if (limit === undefined || limit === null) return undefined;
  if (!isPositiveInt(limit)) {
    throw new BadRequestException('criteria.limit must be a positive integer');
  }
  return Math.min(limit, 50000);
}
