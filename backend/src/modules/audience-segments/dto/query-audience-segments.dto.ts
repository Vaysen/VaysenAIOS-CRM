/**
 * query-audience-segments.dto.ts
 *
 * R111 批次A 客群系统：列表分页 + 状态过滤查询参数。
 */
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class QueryAudienceSegmentsDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;

  @ApiPropertyOptional({ enum: ['active', 'paused'] })
  @IsOptional()
  @IsIn(['active', 'paused'])
  status?: string;

  @ApiPropertyOptional({ description: '按名称模糊搜索' })
  @IsOptional()
  @IsString()
  search?: string;
}
