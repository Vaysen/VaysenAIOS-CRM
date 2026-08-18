/**
 * create-audience-segment.dto.ts
 *
 * R111 批次A 客群系统：创建客群。
 * criteriaJson 用嵌套 SegmentCriteriaDto 校验（class-validator + class-transformer）。
 */
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { SegmentCriteriaDto } from './segment-criteria.dto';

export class CreateAudienceSegmentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => SegmentCriteriaDto)
  criteriaJson?: SegmentCriteriaDto;

  @IsOptional()
  @IsBoolean()
  autoRefreshEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  autoRefreshIntervalHours?: number;

  @IsOptional()
  @IsIn(['active', 'paused'])
  status?: string;
}
