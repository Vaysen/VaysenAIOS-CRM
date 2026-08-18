import { IsBoolean, IsOptional } from 'class-validator';

/** 创建报价渲染任务（幂等：同 quoteVersion 已存在任务时直接返回既有任务）。 */
export class CreateRenderJobDto {
  @IsOptional()
  @IsBoolean()
  forceRefresh?: boolean;
}
