import { IsString, IsOptional, IsBoolean, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class TemplateVariableDto {
  @ApiProperty({ description: 'Variable name, e.g. {{contact_name}}' })
  @IsString()
  variable: string;

  @ApiProperty({ description: 'Human-readable label' })
  @IsString()
  label: string;

  @ApiPropertyOptional({ description: 'Is this variable required?', default: false })
  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;
}

export class CreateEmailTemplateDto {
  @ApiProperty({ description: 'Template name' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'Template category', example: 'First Outreach' })
  @IsString()
  category: string;

  @ApiProperty({ description: 'Email subject line (supports variables)' })
  @IsString()
  subject: string;

  @ApiProperty({ description: 'Email body HTML (supports variables)' })
  @IsString()
  body: string;

  @ApiPropertyOptional({ description: 'Language code', default: 'en' })
  @IsOptional()
  @IsString()
  language?: string;

  @ApiPropertyOptional({ description: 'Product category' })
  @IsOptional()
  @IsString()
  productCategory?: string;

  @ApiPropertyOptional({ description: 'Template variables', type: [TemplateVariableDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TemplateVariableDto)
  variables?: TemplateVariableDto[];

  @ApiPropertyOptional({ description: 'Is template active?', default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
