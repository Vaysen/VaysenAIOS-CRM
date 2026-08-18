/**
 * segment-criteria.dto.ts
 *
 * R111 批次A 客群系统：筛选条件（criteriaJson 的快照形状）。
 * 全部键可选；翻译逻辑见 criteria-parser.ts。
 * ValidationPipe(whitelist + forbidNonWhitelisted) 会剔除未知键。
 */
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class SegmentCriteriaDto {
  /** 客户阶段多选（Lead.status） */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  leadStatuses?: string[];

  /** 分级（Lead.leadGrade） */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  leadGrades?: string[];

  /** 国家（Lead.country） */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  countries?: string[];

  /** 来源（Lead.sourceType） */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sourceTypes?: string[];

  /** 标签（LeadTag → Tag.name，命中任一） */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  /** 近 N 天新客（Lead.createdAt） */
  @IsOptional()
  @IsInt()
  @Min(1)
  createdWithinDays?: number;

  /** 要过样品（quotes 存在 type='sample'） */
  @IsOptional()
  @IsBoolean()
  hasSampleQuote?: boolean;

  /** 有订单（orders 存在记录） */
  @IsOptional()
  @IsBoolean()
  hasOrder?: boolean;

  /** 已跟进未回复：lastContactedAt 距今 > N 天且无 inbound 回复 */
  @IsOptional()
  @IsInt()
  @Min(1)
  followedUpNoReplyDays?: number;

  /** 客户有 email 触点 */
  @IsOptional()
  @IsBoolean()
  hasEmail?: boolean;

  /** 客户有 WhatsApp 触点 */
  @IsOptional()
  @IsBoolean()
  hasWhatsapp?: boolean;

  /** 商机阶段（Opportunity.stage） */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  opportunityStages?: string[];

  /** 排除已在某客群（如已营销过） */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  notInSegmentIds?: string[];

  /** 成员上限（可选，1..50000） */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50000)
  limit?: number;
}
