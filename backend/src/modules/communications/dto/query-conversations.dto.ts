import { IsOptional, IsString, IsInt, Min, IsIn } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class QueryConversationsDto {
  @ApiPropertyOptional({ description: 'Page number', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: 'Items per page', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({ description: 'Filter by channel', enum: ['business_email', 'marketing_email', 'whatsapp', 'website_inquiry', 'manual'] })
  @IsOptional()
  @IsString()
  @IsIn(['business_email', 'marketing_email', 'whatsapp', 'website_inquiry', 'manual'])
  channel?: string;

  @ApiPropertyOptional({ description: 'Filter by status', enum: ['active', 'archived', 'closed'] })
  @IsOptional()
  @IsString()
  @IsIn(['active', 'archived', 'closed'])
  status?: string;

  @ApiPropertyOptional({ description: 'Search keyword (subject, message content)' })
  @IsOptional()
  @IsString()
  keyword?: string;

  @ApiPropertyOptional({ description: 'Filter by lead ID' })
  @IsOptional()
  @IsString()
  leadId?: string;

  @ApiPropertyOptional({ description: 'Filter by assigned user ID' })
  @IsOptional()
  @IsString()
  assignedUserId?: string;
}
