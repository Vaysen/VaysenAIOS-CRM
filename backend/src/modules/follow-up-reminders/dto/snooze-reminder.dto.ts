import { IsString, IsDateString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SnoozeReminderDto {
  @ApiProperty({ description: 'Snooze until this date (ISO 8601)', example: '2026-06-01T00:00:00.000Z' })
  @IsDateString()
  snoozedUntil: string;
}
