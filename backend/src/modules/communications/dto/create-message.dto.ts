import { IsString, IsOptional, IsObject, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateMessageDto {
  @ApiProperty({ description: 'Message direction', enum: ['inbound', 'outbound'] })
  @IsString()
  @IsIn(['inbound', 'outbound'])
  direction: string;

  @ApiProperty({ description: 'Message content' })
  @IsString()
  content: string;

  @ApiPropertyOptional({ description: 'Content type', default: 'text' })
  @IsOptional()
  @IsString()
  @IsIn(['text', 'html', 'template', 'image', 'video', 'audio', 'document', 'sticker', 'contact', 'location', 'reaction', 'system'])
  contentType?: string;

  @ApiPropertyOptional({ description: 'External message ID (IMAP UID, WhatsApp msg ID, etc.)' })
  @IsOptional()
  @IsString()
  externalMessageId?: string;

  @ApiPropertyOptional({ description: 'Sender address (email or phone)' })
  @IsOptional()
  @IsString()
  fromAddress?: string;

  @ApiPropertyOptional({ description: 'Recipient address' })
  @IsOptional()
  @IsString()
  toAddress?: string;

  @ApiPropertyOptional({ description: 'Message subject' })
  @IsOptional()
  @IsString()
  subject?: string;

  @ApiPropertyOptional({ description: 'Attachments metadata' })
  @IsOptional()
  @IsObject()
  attachmentsMeta?: Record<string, any>;

  @ApiPropertyOptional({ description: 'When the message was sent' })
  @IsOptional()
  @IsString()
  sentAt?: string;

  @ApiPropertyOptional({ description: 'When the message was received' })
  @IsOptional()
  @IsString()
  receivedAt?: string;
}
