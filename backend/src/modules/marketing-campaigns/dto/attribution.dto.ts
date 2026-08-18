import { IsISO8601, IsObject, IsOptional, IsString } from 'class-validator';

export class RecordAttributionDto {
  @IsOptional()
  @IsString()
  channelPlanId?: string;

  @IsOptional()
  @IsString()
  leadId?: string;

  @IsOptional()
  @IsString()
  contactPointId?: string;

  @IsOptional()
  @IsString()
  contactRef?: string;

  @IsString()
  channel!: string;

  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @IsObject()
  meta?: Record<string, unknown>;

  @IsOptional()
  @IsISO8601()
  attributedAt?: string;
}
