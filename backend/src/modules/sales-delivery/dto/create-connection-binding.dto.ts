import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { SALES_DELIVERY_CHANNELS } from './dispatch-outbound.dto';

/**
 * 渠道连接绑定：provider → 我方连接（emailAccount id / whatsapp session id / meta connection）。
 * Webhook 回执端点通过 (provider, connectionId) 解析租户。
 */
export class CreateConnectionBindingDto {
  @IsIn(SALES_DELIVERY_CHANNELS)
  provider!: (typeof SALES_DELIVERY_CHANNELS)[number];

  @IsString()
  @IsNotEmpty()
  connectionId!: string;

  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
