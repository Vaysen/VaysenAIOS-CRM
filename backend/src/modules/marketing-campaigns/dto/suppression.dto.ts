import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
} from 'class-validator';

export const MARKETING_SUPPRESSION_SCOPES = ['LEAD', 'CONTACT_POINT'] as const;
export type MarketingSuppressionScopeValue = (typeof MARKETING_SUPPRESSION_SCOPES)[number];

export class AddSuppressionDto {
  @IsIn(MARKETING_SUPPRESSION_SCOPES)
  scope!: MarketingSuppressionScopeValue;

  @IsOptional()
  @IsString()
  leadId?: string;

  @IsOptional()
  @IsString()
  contactPointId?: string;

  @IsOptional()
  @IsString()
  contactRef?: string;

  @IsOptional()
  @IsString()
  channel?: string;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}
