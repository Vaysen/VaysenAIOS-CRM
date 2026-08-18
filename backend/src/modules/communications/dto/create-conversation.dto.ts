import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export const USER_CREATABLE_CONVERSATION_CHANNELS = [
  'whatsapp',
  'email',
  'business_email',
  'marketing_email',
] as const;

export const CONVERSATION_STATUSES = [
  'active',
  'archived',
  'closed',
] as const;

export class CreateConversationDto {
  @ApiPropertyOptional({ enum: USER_CREATABLE_CONVERSATION_CHANNELS })
  @IsOptional()
  @IsString()
  @IsIn(USER_CREATABLE_CONVERSATION_CHANNELS)
  channel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  leadId?: string;

  @ApiPropertyOptional({
    description:
      'Reserved for validation compatibility; manual identity binding is rejected by the service',
    example: '+8615306000000',
  })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  @Matches(/^\+[1-9]\d{7,14}$/)
  contactPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  subject?: string;

  @ApiPropertyOptional({ enum: CONVERSATION_STATUSES })
  @IsOptional()
  @IsString()
  @IsIn(CONVERSATION_STATUSES)
  status?: string;
}
