import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class GenerateRemindersDto {
  @ApiPropertyOptional({ description: 'Generate for a specific lead' })
  @IsOptional()
  @IsString()
  leadId?: string;

  @ApiPropertyOptional({ description: 'Generate for a specific user' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ description: 'Generate for a specific reminder type' })
  @IsOptional()
  @IsString()
  reminderType?: string;
}
