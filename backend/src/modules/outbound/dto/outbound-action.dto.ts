import { ExternalActionStatus } from '@prisma/client';
import {
  IsEnum,
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class CompanyActionDto {
  @IsUUID()
  companyId!: string;
}

export class ListOutboundActionsDto extends CompanyActionDto {
  @IsOptional()
  @IsEnum(ExternalActionStatus)
  status?: ExternalActionStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @Length(8, 1000)
  cursor?: string;
}

export class CancelOutboundActionDto extends CompanyActionDto {
  @IsString()
  @Length(8, 200)
  idempotencyKey!: string;
}

export class ReconcileOutboundActionDto extends CompanyActionDto {
  @IsIn(['SUCCEEDED', 'FAILED', 'CANCELLED'])
  outcome!: 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @Length(3, 1000)
  reason!: string;

  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @Length(1, 500)
  evidenceReference?: string;

  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @Length(1, 100)
  provider?: string;

  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @Length(1, 500)
  providerReceiptId?: string;

  @IsOptional()
  @IsISO8601()
  acceptedAt?: string;
}

export class OutboundActionIdDto {
  @IsUUID()
  id!: string;
}

export class OutboundActionKeyDto {
  @IsString()
  @Length(8, 200)
  idempotencyKey!: string;
}
