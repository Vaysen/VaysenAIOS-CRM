import { IsString, IsOptional, IsDateString, IsObject, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const MANUAL_TYPES = ['note_added', 'call_logged', 'whatsapp_logged', 'quote_logged', 'sample_logged'];

export class CreateActivityDto {
  @ApiProperty({ description: 'Activity type', enum: MANUAL_TYPES })
  @IsString()
  @IsIn(MANUAL_TYPES)
  activityType: string;

  @ApiProperty({ description: 'Activity title' })
  @IsString()
  title: string;

  @ApiPropertyOptional({ description: 'Activity description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'When the activity occurred' })
  @IsOptional()
  @IsDateString()
  occurredAt?: string;

  @ApiPropertyOptional({ description: 'Additional metadata' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
