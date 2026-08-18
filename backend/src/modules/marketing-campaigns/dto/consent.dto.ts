import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
} from 'class-validator';

export const MARKETING_CONSENT_STATUSES = ['GRANTED', 'DENIED', 'UNKNOWN'] as const;
export type MarketingConsentStatusValue = (typeof MARKETING_CONSENT_STATUSES)[number];

export class UpsertConsentDto {
  @IsString()
  contactRef!: string;

  @IsString()
  channel!: string;

  @IsIn(MARKETING_CONSENT_STATUSES)
  status!: MarketingConsentStatusValue;

  @IsOptional()
  @IsString()
  leadId?: string;

  @IsOptional()
  @IsString()
  contactPointId?: string;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @IsOptional()
  @IsString()
  source?: string;
}
