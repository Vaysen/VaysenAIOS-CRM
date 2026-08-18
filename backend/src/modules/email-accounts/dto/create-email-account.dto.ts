import {
  IsString,
  IsOptional,
  IsInt,
  IsBoolean,
  Min,
  IsUUID,
  IsIn,
  IsArray,
  ArrayMaxSize,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const EMAIL_ACCOUNT_ROLES = ['CORE', 'MARKETING', 'SUPPORT'] as const;
export type EmailAccountRole = (typeof EMAIL_ACCOUNT_ROLES)[number];

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

  // ========== IMAP（收信，可选） ==========

  @ApiPropertyOptional({ description: 'IMAP host' })
  @IsOptional()
  @IsString()
  imapHost?: string;

  @ApiPropertyOptional({ description: 'IMAP port', example: 993 })
  @IsOptional()
  @IsInt()
  imapPort?: number;

  @ApiPropertyOptional({ description: 'Use SSL/TLS for IMAP', default: true })
  @IsOptional()
  @IsBoolean()
  imapSecure?: boolean;

  @ApiPropertyOptional({ description: 'IMAP username' })
  @IsOptional()
  @IsString()
  imapUsername?: string;

  @ApiPropertyOptional({ description: 'IMAP password (encrypted before persistence)' })
  @IsOptional()
  @IsString()
  imapPassword?: string;

  @ApiPropertyOptional({ description: 'Enable inbound IMAP polling', default: false })
  @IsOptional()
  @IsBoolean()
  inboundEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Inbound polling interval in seconds', default: 300 })
  @IsOptional()
  @IsInt()
  @Min(30)
  inboundPollIntervalSeconds?: number;

  // ========== 分级与标签 ==========

  @ApiPropertyOptional({ description: 'Account role: CORE | MARKETING | SUPPORT', enum: EMAIL_ACCOUNT_ROLES, default: 'CORE' })
  @IsOptional()
  @IsIn(EMAIL_ACCOUNT_ROLES)
  accountRole?: EmailAccountRole;

  @ApiPropertyOptional({ description: 'Free-form tags, e.g. ["主域名","备用域1"]', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  tags?: string[];

  // ========== 配额 ==========

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
