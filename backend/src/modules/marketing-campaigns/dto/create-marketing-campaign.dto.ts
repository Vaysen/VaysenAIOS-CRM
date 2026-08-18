import {
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

export class CreateMarketingCampaignDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsIn(['email', 'whatsapp'])
  channel?: string;

  @IsOptional()
  @IsObject()
  scheduleIntent?: Record<string, unknown>;

  @IsOptional()
  @IsISO8601()
  windowStart?: string;

  @IsOptional()
  @IsISO8601()
  windowEnd?: string;

  /**
   * 可选：活动发件邮箱账号（email 渠道）。指定时必须为 MARKETING 角色，
   * 否则创建被拒绝。未指定时沿用渠道就绪检查（仅 MARKETING 账号视为就绪）。
   */
  @IsOptional()
  @IsUUID('4')
  senderAccountId?: string;
}
