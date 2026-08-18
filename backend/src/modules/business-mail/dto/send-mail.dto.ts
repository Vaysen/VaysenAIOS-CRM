import { IsString, IsOptional, IsArray, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SendMailDto {
  @ApiProperty({ description: 'Sender email account ID' })
  @IsString()
  emailAccountId: string;

  @ApiProperty({ description: 'Recipient email' })
  @IsString()
  to: string;

  @ApiProperty({ description: 'Email subject' })
  @IsString()
  subject: string;

  @ApiProperty({ description: 'Email body (HTML)' })
  @IsString()
  html: string;

  @ApiPropertyOptional({ description: 'Conversation ID to link message to' })
  @IsOptional()
  @IsString()
  conversationId?: string;

  @ApiPropertyOptional({ description: 'Lead ID' })
  @IsOptional()
  @IsString()
  leadId?: string;

  @ApiPropertyOptional({ description: 'Attachments' })
  @IsOptional()
  @IsArray()
  attachments?: { filename: string; content?: string; mimeType?: string; sourceId?: string }[];

  @ApiPropertyOptional({ description: 'Canonical idempotency key; the HTTP Idempotency-Key header is preferred' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/)
  idempotencyKey?: string;

}
