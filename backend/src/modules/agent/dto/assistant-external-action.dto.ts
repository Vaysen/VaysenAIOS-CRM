import {
  IsBoolean,
  IsIn,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class AuthorizeWhatsappTextSendDto {
  @IsUUID()
  companyId!: string;

  @IsUUID()
  conversationId!: string;

  @IsUUID()
  requestId!: string;

  @IsString()
  @Matches(/^\+?\d[\d\s()-]{5,24}$/)
  targetPhone!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  text!: string;

  @IsBoolean()
  confirmed!: boolean;
}

export class CompleteWhatsappTextSendDto {
  @IsIn(['SUCCEEDED', 'FAILED', 'UNKNOWN'])
  outcome!: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';

  @IsString()
  @MaxLength(80)
  code!: string;
}
