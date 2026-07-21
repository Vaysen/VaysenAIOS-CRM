import { IsString, IsOptional, IsInt, IsBoolean, Min, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateEmailAccountDto {
  @ApiProperty({ description: 'Sender display name' })
  @IsString()
  senderName: string;

  @ApiProperty({ description: 'Sender email address' })
  @IsString()
  senderEmail: string;

  @ApiProperty({ description: 'SMTP host' })
  @IsString()
  smtpHost: string;

  @ApiProperty({ description: 'SMTP port', example: 587 })
  @IsInt()
  smtpPort: number;

  @ApiProperty({ description: 'Use SSL/TLS', default: true })
  @IsBoolean()
  smtpSecure: boolean;

  @ApiProperty({ description: 'SMTP username' })
  @IsString()
  smtpUsername: string;

  @ApiProperty({ description: 'SMTP password' })
  @IsString()
  smtpPassword: string;

  @ApiPropertyOptional({ description: 'Reply-To email address for receiving replies' })
  @IsOptional()
  @IsString()
  replyToEmail?: string;

  @ApiPropertyOptional({ description: 'Daily send limit', default: 50 })
  @IsOptional()
  @IsInt()
  @Min(1)
  dailySendLimit?: number;

  @ApiPropertyOptional({ description: 'Hourly send limit', default: 10 })
  @IsOptional()
  @IsInt()
  @Min(1)
  hourlySendLimit?: number;

  @ApiPropertyOptional({ description: 'Send interval in seconds', default: 60 })
  @IsOptional()
  @IsInt()
  @Min(5)
  sendIntervalSeconds?: number;

  @ApiPropertyOptional({ description: 'Enable warmup mode', default: false })
  @IsOptional()
  @IsBoolean()
  warmupEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Assigned sales user ID. Admin/manager only.' })
  @IsOptional()
  @IsUUID('4')
  userId?: string;
}
