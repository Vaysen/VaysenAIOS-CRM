import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ASSISTANT_PERMISSION_PRESETS } from '../assistant-capability.registry';

export class UpdateAssistantPermissionProfileDto {
  @IsUUID()
  companyId!: string;

  @IsIn(ASSISTANT_PERMISSION_PRESETS)
  preset!: 'ADVISORY' | 'EXECUTOR' | 'SUPERVISOR';

  @IsOptional()
  @IsObject()
  overrides?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  thresholds?: Record<string, unknown>;
}

export class CreateAssistantTemporaryGrantDto {
  @IsUUID()
  companyId!: string;

  @IsOptional()
  @IsUUID()
  operatorUserId?: string;

  @IsString()
  @MaxLength(120)
  capability!: string;

  @IsObject()
  scope!: Record<string, unknown>;

  @IsInt()
  @Min(1)
  @Max(30)
  ttlMinutes!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  maxUses?: number;
}
