import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class AssistantWhatsappContextDto {
  @IsString()
  @MaxLength(160)
  name!: string;

  @IsString()
  @MaxLength(32)
  phone!: string;

  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @IsOptional()
  @IsUUID()
  leadId?: string;

  @IsOptional()
  @IsBoolean()
  isGroup?: boolean;
}

export class AssistantChatDto {
  @IsUUID()
  requestId!: string;

  @IsUUID()
  companyId!: string;

  @IsString()
  @MinLength(1)
  message!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  threadId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  pathname?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AssistantWhatsappContextDto)
  whatsapp?: AssistantWhatsappContextDto;
}
