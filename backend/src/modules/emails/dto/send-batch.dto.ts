import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsString,
  IsOptional,
  IsObject,
  IsUUID,
  IsInt,
  IsBoolean,
  Min,
  Max,
} from 'class-validator';

export class SendBatchDto {
  @ApiProperty({ description: 'Array of lead IDs', type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  leadIds?: string[];

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

  @ApiPropertyOptional({ description: 'Send interval in seconds (overrides account default)', default: 60 })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(600)
  sendIntervalSeconds?: number;

  @ApiPropertyOptional({ description: 'Product name for variable substitution' })
  @IsOptional()
  @IsString()
  productName?: string;

  @ApiPropertyOptional({ description: 'Custom variables for template rendering' })
  @IsOptional()
  @IsObject()
  customVariables?: Record<string, string>;

  @ApiPropertyOptional({ description: 'Use AI to personalize every selected lead. Capped for stability.' })
  @IsOptional()
  @IsBoolean()
  aiPersonalize?: boolean;

  @ApiPropertyOptional({ description: 'Admin-only override that allows template-only batch sending without AI composition.' })
  @IsOptional()
  @IsBoolean()
  allowTemplateDirect?: boolean;

  @ApiPropertyOptional({ description: 'Send to all leads matching current filters across pages' })
  @IsOptional()
  @IsBoolean()
  selectAll?: boolean;

  @ApiPropertyOptional({ description: 'Outreach round index: 0 = not sent yet, 1/2/3 = follow-up round', default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3)
  outreachRound?: number;

  @ApiPropertyOptional({ description: 'Include leads that already replied. Defaults to false.' })
  @IsOptional()
  @IsBoolean()
  includeReplied?: boolean;

  @ApiPropertyOptional({ description: 'Filters used when selectAll is true' })
  @IsOptional()
  @IsObject()
  filters?: Record<string, any>;
}
