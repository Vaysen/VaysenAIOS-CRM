import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsObject, IsUUID, IsBoolean, IsInt, Min, Max } from 'class-validator';

export class SendSingleDto {
  @ApiProperty({ description: 'Lead ID' })
  @IsUUID()
  leadId: string;

  @ApiProperty({ description: 'Email account ID' })
  @IsUUID()
  emailAccountId: string;

  @ApiProperty({ description: 'Email template ID' })
  @IsUUID()
  emailTemplateId: string;

  @ApiPropertyOptional({ description: 'Override subject' })
  @IsOptional()
  @IsString()
  subject?: string;

  @ApiPropertyOptional({ description: 'Override body' })
  @IsOptional()
  @IsString()
  body?: string;

  @ApiPropertyOptional({ description: 'Product name for variable substitution' })
  @IsOptional()
  @IsString()
  productName?: string;

  @ApiPropertyOptional({ description: 'Custom variables for template rendering' })
  @IsOptional()
  @IsObject()
  customVariables?: Record<string, string>;

  @ApiPropertyOptional({ description: 'Use AI to personalize this email for the lead' })
  @IsOptional()
  @IsBoolean()
  aiPersonalize?: boolean;

  @ApiPropertyOptional({ description: 'Outreach round index', default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  outreachRound?: number;
}
