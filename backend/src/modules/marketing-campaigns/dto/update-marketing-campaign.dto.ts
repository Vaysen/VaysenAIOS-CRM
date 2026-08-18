import {
  IsIn,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

export class UpdateMarketingCampaignDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsIn(['email', 'whatsapp'])
  channel?: string;

  @IsOptional()
  @IsObject()
  scheduleIntent?: Record<string, unknown> | null;

  @IsOptional()
  @IsISO8601()
  windowStart?: string;

  @IsOptional()
  @IsISO8601()
  windowEnd?: string;

  /**
   * 可选：活动发件邮箱账号（email 渠道）。指定时必须为 MARKETING 角色，
   * 否则更新被拒绝。未指定时沿用渠道就绪检查（仅 MARKETING 账号视为就绪）。
   */
  @IsOptional()
  @IsUUID('4')
  senderAccountId?: string;
}
