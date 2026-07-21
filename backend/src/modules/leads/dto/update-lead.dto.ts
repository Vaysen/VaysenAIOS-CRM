import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsBoolean, IsInt, Min, Max } from 'class-validator';

export class UpdateLeadDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  leadName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  website?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  websiteDomain?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  industry?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  productCategory?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  businessType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  contactName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  contactTitle?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  contactEmail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  contactPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  whatsapp?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  linkedinUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  facebookUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  instagramUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  twitterUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sourceUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sourceType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sourceKeyword?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sourceCountry?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  confidenceScore?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  leadScore?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  leadGrade?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ownerUserId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  lastContactedAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  nextFollowUpAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reviewStatus?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isUncertain?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  uncertainFields?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  yearEstablished?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  employeeCount?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  annualRevenue?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  mainProducts?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  importPorts?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  currentSuppliers?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  hasChinaImport?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  estimatedOrderVolume?: string;
}
