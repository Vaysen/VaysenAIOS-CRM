import { IsNotEmpty, IsString } from 'class-validator';

/**
 * 活动 ↔ 客群关联（R111 批次B）。
 * 关联时只需 segmentId，活动/公司上下文由路由与租户隔离决定。
 */
export class LinkCampaignSegmentDto {
  @IsString()
  @IsNotEmpty()
  segmentId!: string;
}
