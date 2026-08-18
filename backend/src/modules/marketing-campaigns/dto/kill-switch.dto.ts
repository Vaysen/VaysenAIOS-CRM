import { IsIn, IsOptional, IsString } from 'class-validator';

export const MARKETING_KILL_SWITCH_SCOPES = [
  'GLOBAL',
  'CHANNEL_EMAIL',
  'CHANNEL_WHATSAPP',
] as const;
export type MarketingKillSwitchScopeValue = (typeof MARKETING_KILL_SWITCH_SCOPES)[number];

export class ActivateKillSwitchDto {
  @IsIn(MARKETING_KILL_SWITCH_SCOPES)
  scope!: MarketingKillSwitchScopeValue;

  @IsOptional()
  @IsString()
  channel?: string;

  @IsOptional()
  @IsString()
  reason?: string;
}
