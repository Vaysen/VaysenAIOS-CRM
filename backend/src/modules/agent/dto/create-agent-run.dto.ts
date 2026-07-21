import { IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export enum SafeAgentRunKind {
  READ_LEAD_SUMMARY = 'READ_LEAD_SUMMARY',
  DRAFT_FOLLOW_UP = 'DRAFT_FOLLOW_UP',
}

export class CreateAgentRunDto {
  @IsUUID()
  companyId!: string;

  @IsEnum(SafeAgentRunKind)
  kind!: SafeAgentRunKind;

  @IsUUID()
  leadId!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  brief?: string;

  @IsOptional()
  @IsString()
  @MaxLength(24)
  language?: string;
}
