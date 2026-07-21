import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateVoiceTestSessionDto {
  @IsOptional() @IsString()
  leadId?: string;

  @IsOptional() @IsIn(['web_test', 'pstn', 'whatsapp'])
  channel?: string;

  @IsOptional() @IsIn(['zh-CN', 'en-US', 'es-ES', 'fr-FR'])
  locale?: string;

  @IsOptional() @IsString() @MaxLength(40)
  customerNumber?: string;

  @IsOptional() @IsBoolean()
  recordingEnabled?: boolean;
}

export class RequestVoiceHandoffDto {
  @IsString() @MaxLength(500)
  reason: string;

  @IsOptional()
  context?: Record<string, unknown>;
}

export class EndVoiceCallDto {
  @IsOptional() @IsString() @MaxLength(4000)
  summary?: string;
}
