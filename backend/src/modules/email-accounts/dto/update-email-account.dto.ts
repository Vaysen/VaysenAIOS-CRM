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
import { ApiPropertyOptional } from '@nestjs/swagger';
import { EMAIL_ACCOUNT_ROLES, EmailAccountRole } from './create-email-account.dto';

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

  // ========== IMAP（收信，可选） ==========

  @ApiPropertyOptional({ description: 'IMAP host' })
  @IsOptional()
  @IsString()
  imapHost?: string;

  @ApiPropertyOptional({ description: 'IMAP port', example: 993 })
  @IsOptional()
  @IsInt()
  imapPort?: number;

  @ApiPropertyOptional({ description: 'Use SSL/TLS for IMAP' })
  @IsOptional()
  @IsBoolean()
  imapSecure?: boolean;

  @ApiPropertyOptional({ description: 'IMAP username' })
  @IsOptional()
  @IsString()
  imapUsername?: string;

  @ApiPropertyOptional({ description: 'IMAP password (only set to update; encrypted before persistence)' })
  @IsOptional()
  @IsString()
  imapPassword?: string;

  @ApiPropertyOptional({ description: 'Enable inbound IMAP polling' })
  @IsOptional()
  @IsBoolean()
  inboundEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Inbound polling interval in seconds' })
  @IsOptional()
  @IsInt()
  @Min(30)
  inboundPollIntervalSeconds?: number;

  // ========== 分级与标签 ==========

  @ApiPropertyOptional({ description: 'Account role: CORE | MARKETING | SUPPORT', enum: EMAIL_ACCOUNT_ROLES })
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
