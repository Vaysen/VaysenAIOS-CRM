import { IsIn, IsOptional, IsUUID } from 'class-validator';

export class StartDeepResearchDto {
  @IsUUID()
  requestId!: string;

  @IsOptional()
  @IsIn(['full', 'contacts', 'market'])
  type?: 'full' | 'contacts' | 'market';
}
