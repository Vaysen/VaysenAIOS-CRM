import { IsUUID } from 'class-validator';

export class PendingAssistantActionsQueryDto {
  @IsUUID()
  companyId!: string;
}
