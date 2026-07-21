import { IsOptional, IsString, IsInt, IsBoolean } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class QueryFollowUpRemindersDto {
  @ApiPropertyOptional({ description: 'Page number', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  page?: number;

  @ApiPropertyOptional({ description: 'Items per page', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number;

  @ApiPropertyOptional({ description: 'Filter by status (Pending, Completed, Ignored, Snoozed, Cancelled, Overdue)' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ description: 'Filter by reminder type' })
  @IsOptional()
  @IsString()
  reminderType?: string;

  @ApiPropertyOptional({ description: 'Filter by priority (Low, Medium, High, Urgent)' })
  @IsOptional()
  @IsString()
  priority?: string;

  @ApiPropertyOptional({ description: 'Filter by lead ID' })
  @IsOptional()
  @IsString()
  leadId?: string;

  @ApiPropertyOptional({ description: 'Filter by user ID' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ description: 'Filter due from date (ISO)' })
  @IsOptional()
  @IsString()
  dueFrom?: string;

  @ApiPropertyOptional({ description: 'Filter due to date (ISO)' })
  @IsOptional()
  @IsString()
  dueTo?: string;

  @ApiPropertyOptional({ description: 'Only show overdue reminders' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  overdue?: boolean;

  @ApiPropertyOptional({ description: 'Search in title or reason' })
  @IsOptional()
  @IsString()
  search?: string;
}
