import {
  IsArray,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateWebsiteInquiryDto {
  @IsString()
  @Matches(/^[A-Za-z0-9._-]{3,64}$/)
  sourceKey: string;

  @IsInt()
  timestamp: number;

  @IsString()
  @Matches(/^[A-Za-z0-9_-]{16,128}$/)
  nonce: string;

  @IsString()
  @Matches(/^[a-f0-9]{64}$/i)
  signature: string;

  @ApiProperty({ description: 'Inquiry source', example: 'wordpress_contact_form' })
  @IsString()
  @Matches(/^[^\r\n]*$/)
  @MaxLength(64)
  source: string;

  @ApiProperty({ description: 'Contact name', example: 'John Smith' })
  @IsString()
  @Matches(/^[^\r\n]*$/)
  @MaxLength(120)
  contactName: string;

  @ApiProperty({ description: 'Contact email', example: 'john@example.com' })
  @IsString()
  @IsEmail()
  @Matches(/^[^\r\n]*$/)
  @MaxLength(254)
  email: string;

  @ApiPropertyOptional({ description: 'Contact phone' })
  @IsOptional()
  @IsString()
  @Matches(/^[^\r\n]*$/)
  @MaxLength(64)
  phone?: string;

  @ApiPropertyOptional({ description: 'Company name' })
  @IsOptional()
  @IsString()
  @Matches(/^[^\r\n]*$/)
  @MaxLength(200)
  companyName?: string;

  @ApiPropertyOptional({ description: 'Country' })
  @IsOptional()
  @IsString()
  @Matches(/^[^\r\n]*$/)
  @MaxLength(100)
  country?: string;

  @ApiProperty({ description: 'Inquiry subject' })
  @IsString()
  @Matches(/^[^\r\n]*$/)
  @MaxLength(200)
  subject: string;

  @ApiProperty({ description: 'Inquiry message body' })
  @IsString()
  @Matches(/^[^\r\n]*$/)
  @MaxLength(10000)
  message: string;

  @ApiPropertyOptional({ description: 'Product interest' })
  @IsOptional()
  @IsString()
  @Matches(/^[^\r\n]*$/)
  @MaxLength(500)
  productInterest?: string;

  @ApiPropertyOptional({ description: 'Landing page URL where inquiry was submitted' })
  @IsOptional()
  @IsString()
  @Matches(/^[^\r\n]*$/)
  @MaxLength(2000)
  pageUrl?: string;

  @ApiPropertyOptional({ description: 'UTM source' })
  @IsOptional()
  @IsString()
  @Matches(/^[^\r\n]*$/)
  @MaxLength(200)
  utmSource?: string;

  @ApiPropertyOptional({ description: 'UTM medium' })
  @IsOptional()
  @IsString()
  @Matches(/^[^\r\n]*$/)
  @MaxLength(200)
  utmMedium?: string;

  @ApiPropertyOptional({ description: 'UTM campaign' })
  @IsOptional()
  @IsString()
  @Matches(/^[^\r\n]*$/)
  @MaxLength(200)
  utmCampaign?: string;

  @ApiPropertyOptional({ description: 'Attachments metadata' })
  @IsOptional()
  @IsArray()
  attachments?: { filename: string; size: number; mimeType: string; url: string }[];
}
