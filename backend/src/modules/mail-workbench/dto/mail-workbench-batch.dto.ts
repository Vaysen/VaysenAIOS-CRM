import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsIn, IsString } from 'class-validator';

export const MAIL_WORKBENCH_BATCH_ACTIONS = ['mark_read', 'mark_unread', 'star', 'unstar', 'archive', 'delete'] as const;
export type MailWorkbenchBatchAction = (typeof MAIL_WORKBENCH_BATCH_ACTIONS)[number];

/** PATCH /mail-workbench/messages/batch 请求体（R111 批次B） */
export class MailWorkbenchBatchDto {
  @ApiProperty({ description: '收件消息 id 列表（inbound:* 前缀之后的原始 id）', example: ['uuid-1', 'uuid-2'] })
  @IsArray()
  @ArrayNotEmpty({ message: 'ids must be a non-empty array' })
  @IsString({ each: true })
  ids!: string[];

  @ApiProperty({ description: '批量动作', enum: MAIL_WORKBENCH_BATCH_ACTIONS, example: 'archive' })
  @IsString()
  @IsIn(MAIL_WORKBENCH_BATCH_ACTIONS, { message: 'action must be one of: mark_read, mark_unread, star, unstar, archive, delete' })
  action!: MailWorkbenchBatchAction;
}
