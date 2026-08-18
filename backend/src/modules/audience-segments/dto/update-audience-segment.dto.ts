/**
 * update-audience-segment.dto.ts
 *
 * R111 批次A 客群系统：更新客群（名称/描述/条件/自动刷新设置/状态）。
 * 全部可选；description 传 null 表示清空。
 */
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { SegmentCriteriaDto } from './segment-criteria.dto';

export class UpdateAudienceSegmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

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
