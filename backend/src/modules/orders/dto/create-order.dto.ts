import {
  IsISO8601,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const ORDER_STAGES = [
  'won',
  'sampling',
  'production',
  'qc',
  'shipping',
  'payment',
  'completed',
  'after_sales',
] as const;

export class CreateOrderDto {
  @IsOptional()
  @IsUUID()
  leadId?: string;

  @IsOptional()
  @IsUUID()
  opportunityId?: string;

  /**
   * Kept only so legacy clients receive the explicit service-level migration
   * error. Quote-backed orders must use POST /quotes/:id/convert-to-order.
   */
  @IsOptional()
  @IsUUID()
  quoteId?: string;

  @IsOptional()
  @IsUUID()
  assignedUserId?: string;

  @IsOptional()
  @IsIn(ORDER_STAGES)
  stage?: string;

  @IsOptional()
  @IsIn(['USD', 'EUR', 'GBP', 'CNY', 'HKD', 'JPY', 'AUD', 'CAD'])
  currency?: string;

  @IsOptional()
  @IsNumber({
    allowNaN: false,
    allowInfinity: false,
    maxDecimalPlaces: 2,
  })
  @Min(0)
  @Max(9_999_999_999.99)
  totalAmount?: number;

  @IsOptional()
  @IsNumber({
    allowNaN: false,
    allowInfinity: false,
    maxDecimalPlaces: 2,
  })
  @Min(0)
  @Max(9_999_999_999.99)
  paidAmount?: number;

  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  deliveryDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  shippingTerms?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  trackingNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;
}
