import {
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
} from 'class-validator';

export class WebsiteWhatsAppClickDto {
  @IsString()
  @Matches(/^[A-Za-z0-9._-]{3,64}$/)
  sourceKey: string;

  @IsInt()
  timestamp: number;

  @IsString()
  @Matches(/^[A-Za-z0-9_-]{16,128}$/)
  nonce: string;

  @IsString()
  @Matches(/^[a-f0-9]{64}$/i)
  signature: string;

  @IsString()
  @Matches(/^\+?[0-9][0-9 ()-]{6,24}$/)
  @MaxLength(25)
  whatsappNumber: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  contactName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  companyName?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2}$/)
  country?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  sourceUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  utmSource?: string;
}
