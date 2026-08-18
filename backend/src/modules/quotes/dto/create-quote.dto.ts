import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class QuoteLineItemDto {
  @IsOptional() @IsString() @MaxLength(100)
  productCode?: string;

  @ApiProperty()
  @IsString() @MaxLength(300)
  productName: string;

  @IsOptional() @IsString() @MaxLength(300)
  material?: string;

  @IsOptional() @IsString() @MaxLength(200)
  size?: string;

  @IsOptional() @IsString() @MaxLength(100)
  thickness?: string;

  @IsOptional() @IsString() @MaxLength(100)
  color?: string;

  @IsOptional() @IsString() @MaxLength(500)
  printing?: string;

  @IsInt() @Min(1) @Max(1_000_000_000)
  quantity: number;

  @IsOptional() @IsString() @MaxLength(30)
  unit?: string;

  @IsNumber() @Min(0) @Max(1_000_000_000)
  unitPrice: number;

  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000_000_000)
  totalPrice?: number;

  @IsOptional() @IsUUID()
  productSpecId?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  notes?: string;

  @IsOptional() @IsString() @MaxLength(100)
  catalogItemId?: string;
}

export class CreateQuoteDto {
  @ApiPropertyOptional()
  @IsOptional() @IsUUID()
  conversationId?: string;

  @ApiPropertyOptional()
  @IsOptional() @IsUUID()
  leadId?: string;

  @ApiPropertyOptional({ description: 'Optional Opportunity association; leadId is derived when omitted.' })
  @IsOptional() @IsUUID()
  opportunityId?: string;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(100)
  referenceNo?: string;

  @ApiPropertyOptional({ enum: ['quote', 'pi', 'contract', 'sample'] })
  @IsOptional() @IsIn(['quote', 'pi', 'contract', 'sample'])
  type?: string;

  @ApiProperty({ type: [QuoteLineItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => QuoteLineItemDto)
  lineItems: QuoteLineItemDto[];

  @IsOptional() @IsString() @MaxLength(10)
  currency?: string;

  @IsOptional() @IsString() @MaxLength(100)
  tradeTerms?: string;

  @IsOptional() @IsString() @MaxLength(300)
  paymentTerms?: string;

  @IsOptional() @IsString() @MaxLength(200)
  deliveryTime?: string;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99_999_999.99)
  sampleFee?: number;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99_999_999.99)
  moldFee?: number;

  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000_000)
  discount?: number;

  @IsOptional() @IsNumber() @Min(0) @Max(100)
  taxRate?: number;

  @IsOptional() @IsString() @MaxLength(5000)
  notes?: string;

  @IsOptional() @IsISO8601()
  validUntil?: string;

  @IsOptional() @IsBoolean()
  aiExtracted?: boolean;

  @IsOptional() @IsUUID()
  aiArtifactId?: string;
}

export class UpdateQuoteStatusDto {
  @IsIn(['draft', 'sent', 'accepted', 'rejected', 'expired', 'cancelled'])
  status: string;
}
