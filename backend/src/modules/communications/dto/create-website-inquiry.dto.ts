import { IsString, IsOptional, IsEmail, IsArray, IsObject, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateWebsiteInquiryDto {
  @ApiProperty({ description: 'Inquiry source', example: 'wordpress_contact_form' })
  @IsString()
  source: string;

  @ApiProperty({ description: 'Contact name', example: 'John Smith' })
  @IsString()
  contactName: string;

  @ApiProperty({ description: 'Contact email', example: 'john@example.com' })
  @IsString()
  @IsEmail()
  email: string;

  @ApiPropertyOptional({ description: 'Contact phone' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({ description: 'Company name' })
  @IsOptional()
  @IsString()
  companyName?: string;

  @ApiPropertyOptional({ description: 'Country' })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiProperty({ description: 'Inquiry subject' })
  @IsString()
  subject: string;

  @ApiProperty({ description: 'Inquiry message body' })
  @IsString()
  message: string;

  @ApiPropertyOptional({ description: 'Product interest' })
  @IsOptional()
  @IsString()
  productInterest?: string;

  @ApiPropertyOptional({ description: 'Landing page URL where inquiry was submitted' })
  @IsOptional()
  @IsString()
  pageUrl?: string;

  @ApiPropertyOptional({ description: 'UTM source' })
  @IsOptional()
  @IsString()
  utmSource?: string;

  @ApiPropertyOptional({ description: 'UTM medium' })
  @IsOptional()
  @IsString()
  utmMedium?: string;

  @ApiPropertyOptional({ description: 'UTM campaign' })
  @IsOptional()
  @IsString()
  utmCampaign?: string;

  @ApiPropertyOptional({ description: 'Attachments metadata' })
  @IsOptional()
  @IsArray()
  attachments?: { filename: string; size: number; mimeType: string; url: string }[];
}
