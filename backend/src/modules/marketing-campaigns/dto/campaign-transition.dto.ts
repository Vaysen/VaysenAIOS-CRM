import { IsIn, IsNotEmpty, IsString } from 'class-validator';

/** 活动状态机允许的转移动作（与 marketing-campaigns.service CAMPAIGN_ACTIONS 一一对应） */
export const CAMPAIGN_TRANSITION_ACTIONS = [
  'start_planning',
  'submit_review',
  'request_changes',
  'approve',
  // R111 批次C：显式「开始执行」（channel=whatsapp 时触发投放入队）
  'execute',
  'pause',
  'resume',
  'cancel',
  'archive',
] as const;

export type CampaignTransitionAction = (typeof CAMPAIGN_TRANSITION_ACTIONS)[number];

export class CampaignTransitionDto {
  @IsString()
  @IsNotEmpty()
  @IsIn(CAMPAIGN_TRANSITION_ACTIONS)
  action!: CampaignTransitionAction;
}
