import { IsUUID } from 'class-validator';

export class OpenClawRuntimeQueryDto {
  @IsUUID()
  companyId!: string;
}

export class OpenClawWechatPairingStartDto {
  @IsUUID()
  companyId!: string;
}

export class OpenClawWechatPairingWaitDto {
  @IsUUID()
  companyId!: string;

  @IsUUID()
  pairingId!: string;
}
