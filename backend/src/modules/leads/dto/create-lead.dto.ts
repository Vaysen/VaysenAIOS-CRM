import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsBoolean,
  IsInt,
  Min,
  Max,
  IsUrl,
} from 'class-validator';

export class CreateLeadDto {
  @ApiProperty({ example: 'ABC Imports Ltd.' })
  @IsString()
  companyName: string;

  @ApiPropertyOptional({ example: 'ABC Imports' })
  @IsOptional()
  @IsString()
  leadName?: string;

  @ApiPropertyOptional({ example: 'https://www.abcimports.com' })
  @IsOptional()
  @IsString()
  website?: string;

  @ApiPropertyOptional({ example: 'abcimports.com' })
  @IsOptional()
  @IsString()
  websiteDomain?: string;

  @ApiPropertyOptional({ example: 'US' })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional({ example: 'New York' })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({ example: 'Food & Beverage' })
  @IsOptional()
  @IsString()
  industry?: string;

  @ApiPropertyOptional({ example: 'Food Processing Machinery' })
  @IsOptional()
  @IsString()
  productCategory?: string;

  @ApiPropertyOptional({ example: 'importer' })
  @IsOptional()
  @IsString()
  businessType?: string;

  @ApiPropertyOptional({ example: 'John Smith' })
  @IsOptional()
  @IsString()
  contactName?: string;

  @ApiPropertyOptional({ example: 'Procurement Manager' })
  @IsOptional()
  @IsString()
  contactTitle?: string;

  @ApiPropertyOptional({ example: 'john@abcimports.com' })
  @IsOptional()
  @IsString()
  contactEmail?: string;

  @ApiPropertyOptional({ example: '+1-212-555-0123' })
  @IsOptional()
  @IsString()
  contactPhone?: string;

  @ApiPropertyOptional({ example: '+12125550123' })
  @IsOptional()
  @IsString()
  whatsapp?: string;

  @ApiPropertyOptional({ example: 'https://linkedin.com/in/johnsmith' })
  @IsOptional()
  @IsString()
  linkedinUrl?: string;

  @ApiPropertyOptional({ example: 'https://facebook.com/abcimports' })
  @IsOptional()
  @IsString()
  facebookUrl?: string;

  @ApiPropertyOptional({ example: 'https://www.abcimports.com/about' })
  @IsOptional()
  @IsString()
  sourceUrl?: string;

  @ApiPropertyOptional({ example: 'manual' })
  @IsOptional()
  @IsString()
  sourceType?: string;

  @ApiPropertyOptional({ example: 'food machinery importer USA' })
  @IsOptional()
  @IsString()
  sourceKeyword?: string;

  @ApiPropertyOptional({ example: 'US' })
  @IsOptional()
  @IsString()
  sourceCountry?: string;

  @ApiPropertyOptional({ example: 'new' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ example: 'pending', description: 'Review status: pending, approved, rejected' })
  @IsOptional()
  @IsString()
  reviewStatus?: string;

  @ApiPropertyOptional({ example: 85 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  confidenceScore?: number;

  @ApiPropertyOptional({ example: 85 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  leadScore?: number;

  @ApiPropertyOptional({ example: 'A' })
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

  @ApiPropertyOptional({ example: 'Notes about this lead' })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ default: false })
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyId?: string;
}
