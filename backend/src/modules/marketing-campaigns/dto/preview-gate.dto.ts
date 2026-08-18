import { IsOptional, IsString } from 'class-validator';

export class PreviewGateDto {
  @IsString()
  campaignId!: string;

  @IsOptional()
  @IsString()
  contactRef?: string;

  @IsOptional()
  @IsString()
  channel?: string;

  @IsOptional()
  @IsString()
  leadId?: string;

  @IsOptional()
  @IsString()
  contactPointId?: string;

  @IsOptional()
  @IsString()
  channelPlanId?: string;
}

export class PreviewRecoveryDto extends PreviewGateDto {
  @IsOptional()
  @IsString()
  deliveryRunId?: string;
}
