import { IsOptional, IsString } from 'class-validator';

/**
 * 创建人工审批请求。quote 级审批可直接挂到报价（outboundRequestId 留空）；
 * 外发级审批由 outbound-requests/:id/approval-requests 路由自动绑定。
 */
export class CreateApprovalRequestDto {
  @IsOptional()
  @IsString()
  outboundRequestId?: string;

  @IsOptional()
  @IsString()
  note?: string;
}
