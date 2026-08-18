import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

const SORT_FIELDS = [
  'updatedAt',
  'createdAt',
  'companyName',
  'status',
  'nextFollowUpAt',
  'lastContactedAt',
  'opportunityAmount',
] as const;
const WORKSPACE_VIEWS = [
  'all',
  'today_follow_up',
  'new_messages',
  'active_opportunities',
  'identity_pending',
  'merge_pending',
  'archived',
] as const;

export class CustomerAssetsQueryDto {
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @IsIn(WORKSPACE_VIEWS) view: typeof WORKSPACE_VIEWS[number] = 'all';
  @IsOptional() @IsString() @MaxLength(256) status?: string;
  @IsOptional() @IsString() @MaxLength(80) country?: string;
  @IsOptional() @IsString() @MaxLength(128) ownerUserId?: string;
  @IsOptional() @IsString() @MaxLength(80) sourceType?: string;
  @IsOptional() @IsIn(SORT_FIELDS) sortBy: typeof SORT_FIELDS[number] = 'updatedAt';
  @IsOptional() @IsIn(['asc', 'desc']) sortOrder: 'asc' | 'desc' = 'desc';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) pageSize = 20;
}

export const CUSTOMER_ASSET_SORT_FIELDS = new Set<string>(SORT_FIELDS);
export const CUSTOMER_ASSET_WORKSPACE_VIEWS = new Set<string>(WORKSPACE_VIEWS);
