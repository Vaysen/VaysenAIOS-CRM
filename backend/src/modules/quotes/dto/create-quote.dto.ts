import { IsString, IsOptional, IsNumber, IsArray, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class QuoteLineItemDto {
  @ApiProperty({ description: 'Product name' })
  @IsString()
  productName: string;

  @ApiPropertyOptional({ description: 'Material' })
  @IsOptional() @IsString()
  material?: string;

  @ApiPropertyOptional({ description: 'Size' })
  @IsOptional() @IsString()
  size?: string;

  @ApiPropertyOptional({ description: 'Thickness' })
  @IsOptional() @IsString()
  thickness?: string;

  @ApiPropertyOptional({ description: 'Color' })
  @IsOptional() @IsString()
  color?: string;

  @ApiPropertyOptional({ description: 'Printing requirements' })
  @IsOptional() @IsString()
  printing?: string;

  @ApiProperty({ description: 'Quantity' })
  @IsNumber()
  quantity: number;

  @ApiProperty({ description: 'Unit price in USD' })
  @IsNumber()
  unitPrice: number;

  @ApiPropertyOptional({ description: 'Total price' })
  @IsOptional() @IsNumber()
  totalPrice?: number;
}

export class CreateQuoteDto {
  @ApiPropertyOptional({ description: 'Conversation ID (optional — standalone quotes ok)' })
  @IsOptional() @IsString()
  conversationId?: string;

  @ApiPropertyOptional({ description: 'Lead ID (optional — standalone quotes ok)' })
  @IsOptional() @IsString()
  leadId?: string;

  @ApiPropertyOptional({ description: 'Quote reference number' })
  @IsOptional() @IsString()
  referenceNo?: string;

  @ApiPropertyOptional({ description: 'Document type', enum: ['quote', 'pi', 'contract', 'sample'], default: 'quote' })
  @IsOptional() @IsString()
  type?: string;

  @ApiProperty({ description: 'Line items', type: [QuoteLineItemDto] })
  @IsArray()
  lineItems: QuoteLineItemDto[];

  @ApiPropertyOptional({ description: 'Trade terms (FOB, CIF, etc.)' })
  @IsOptional() @IsString()
  tradeTerms?: string;

  @ApiPropertyOptional({ description: 'Payment terms' })
  @IsOptional() @IsString()
  paymentTerms?: string;

  @ApiPropertyOptional({ description: 'Estimated delivery time' })
  @IsOptional() @IsString()
  deliveryTime?: string;

  @ApiPropertyOptional({ description: 'Sample fee' })
  @IsOptional() @IsNumber()
  sampleFee?: number;

  @ApiPropertyOptional({ description: 'Additional notes' })
  @IsOptional() @IsString()
  notes?: string;

  @ApiPropertyOptional({ description: 'AI-extracted fields for pre-fill' })
  @IsOptional() @IsObject()
  aiExtracted?: Record<string, any>;
}
