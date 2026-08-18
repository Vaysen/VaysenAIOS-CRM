import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class ChannelPlanDto {
  @IsString()
  channel!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  windowSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxPerContact?: number;

  @IsOptional()
  @IsObject()
  scheduleJson?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateChannelPlanDto {
  @IsOptional()
  @IsString()
  channel?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  windowSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxPerContact?: number;

  @IsOptional()
  @IsObject()
  scheduleJson?: Record<string, unknown> | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  status?: string;
}
