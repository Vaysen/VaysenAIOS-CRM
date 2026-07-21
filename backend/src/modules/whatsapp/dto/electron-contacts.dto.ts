import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * 单条 WhatsApp 联系人快照(Electron preload 采集)。
 * 仅含可信 JID/LID/号码候选,不含 UI 状态文本猜号结果。
 */
export class WhatsAppContactSnapshotDto {
  @IsString()
  externalId: string;

  @IsEnum(['phone_jid', 'lid', 'unknown'])
  externalIdKind: 'phone_jid' | 'lid' | 'unknown';

  @IsOptional()
  @IsString()
  phoneCandidate: string | null;

  @IsOptional()
  @IsString()
  displayNameCandidate: string | null;

  @IsBoolean()
  isGroup: boolean;

  @IsBoolean()
  isSelf: boolean;

  @IsNumber()
  observedAt: number;
}

/**
 * /whatsapp/electron-webhook/contacts 入参。
 *
 * `timestamp` / `total` 为主进程透传的兼容字段,以 optional 形式接收,
 * 以满足全局 `forbidNonWhitelisted` 校验,不强制要求前端变更。
 */
export class ContactsSyncDto {
  @IsString()
  accountId: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WhatsAppContactSnapshotDto)
  contacts: WhatsAppContactSnapshotDto[];

  @IsOptional()
  @IsNumber()
  timestamp?: number;

  @IsOptional()
  @IsNumber()
  total?: number;
}
