import { IsIn, IsOptional, IsString } from 'class-validator';

export const SALES_DELIVERY_APPROVAL_DECISIONS = ['approve', 'reject'] as const;
export type SalesDeliveryApprovalDecision = (typeof SALES_DELIVERY_APPROVAL_DECISIONS)[number];

/**
 * 审批决策。approvalId 可选：缺省时对外发请求取最新 PENDING 审批。
 * 禁止自我审批（requesterId === 决策者）由 service 强制。
 */
export class ApprovalDecisionDto {
  @IsIn(SALES_DELIVERY_APPROVAL_DECISIONS)
  decision!: SalesDeliveryApprovalDecision;

  @IsOptional()
  @IsString()
  approvalId?: string;

  @IsOptional()
  @IsString()
  reason?: string;
}
