import { IsString, IsOptional, IsInt, IsBoolean, Min, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateEmailAccountDto {
  @ApiPropertyOptional({ description: 'Sender display name' })
  @IsOptional()
  @IsString()
  senderName?: string;

  @ApiPropertyOptional({ description: 'Sender email address' })
  @IsOptional()
  @IsString()
  senderEmail?: string;

  @ApiPropertyOptional({ description: 'SMTP host' })
  @IsOptional()
  @IsString()
  smtpHost?: string;

  @ApiPropertyOptional({ description: 'SMTP port', example: 587 })
  @IsOptional()
  @IsInt()
  smtpPort?: number;

  @ApiPropertyOptional({ description: 'Use SSL/TLS' })
  @IsOptional()
  @IsBoolean()
  smtpSecure?: boolean;

  @ApiPropertyOptional({ description: 'SMTP username' })
  @IsOptional()
  @IsString()
  smtpUsername?: string;

  @ApiPropertyOptional({ description: 'SMTP password (only set to update)' })
  @IsOptional()
  @IsString()
  smtpPassword?: string;

  @ApiPropertyOptional({ description: 'Daily send limit' })
  @IsOptional()
  @IsInt()
  @Min(1)
  dailySendLimit?: number;

  @ApiPropertyOptional({ description: 'Hourly send limit' })
  @IsOptional()
  @IsInt()
  @Min(1)
  hourlySendLimit?: number;

  @ApiPropertyOptional({ description: 'Send interval in seconds' })
  @IsOptional()
  @IsInt()
  @Min(5)
  sendIntervalSeconds?: number;

  @ApiPropertyOptional({ description: 'Enable warmup mode' })
  @IsOptional()
  @IsBoolean()
  warmupEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Assigned sales user ID. Admin/manager only.' })
  @IsOptional()
  @IsUUID('4')
  userId?: string;

  @ApiPropertyOptional({ description: 'Reply-To email address for receiving replies' })
  @IsOptional()
  @IsString()
  replyToEmail?: string;
}
