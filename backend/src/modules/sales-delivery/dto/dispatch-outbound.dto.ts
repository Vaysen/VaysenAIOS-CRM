import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export const SALES_DELIVERY_CHANNELS = ['email', 'whatsapp', 'meta'] as const;
export type SalesDeliveryChannelInput = (typeof SALES_DELIVERY_CHANNELS)[number];

/**
 * 报价交付：创建 OutboundRequest（DISPATCHING）→ 人工审批 → 发送。
 * channel 与 target 必填；connectionBindingId 可选（缺省取该渠道首个 active 绑定）。
 */
export class DispatchOutboundDto {
  @IsIn(SALES_DELIVERY_CHANNELS)
  channel!: SalesDeliveryChannelInput;

  @IsString()
  @IsNotEmpty()
  target!: string;

  @IsOptional()
  @IsString()
  connectionBindingId?: string;

  @IsOptional()
  @IsString()
  subject?: string;

  @IsOptional()
  @IsString()
  body?: string;
}
