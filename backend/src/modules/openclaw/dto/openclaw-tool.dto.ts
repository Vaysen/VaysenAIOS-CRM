import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Matches,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class OpenClawActorDto {
  @IsIn(['openclaw-weixin', 'vaysen-crm'])
  channel!: 'openclaw-weixin' | 'vaysen-crm';

  @IsIn(['openclaw-weixin', 'vaysen-crm'])
  source!: 'openclaw-weixin' | 'vaysen-crm';

  @Equals(true)
  senderIsOwner!: true;

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  @IsOptional()
  requesterSenderId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  sessionKey!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  @IsOptional()
  messageId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  toolCallId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  @IsOptional()
  agentAccountId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @IsOptional()
  agentId?: string;
}

export class OpenClawWorkBriefInputDto {
  @IsOptional()
  @IsString()
  @Matches(/^JYACC_OWNER_[a-f0-9]{16}$/)
  acceptanceMarker?: string;
}

export class OpenClawToolRequestDto {
  @ValidateNested()
  @Type(() => OpenClawActorDto)
  actor!: OpenClawActorDto;
}

export class OpenClawWorkBriefDto extends OpenClawToolRequestDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => OpenClawWorkBriefInputDto)
  input?: OpenClawWorkBriefInputDto;
}

export class OpenClawCustomerSearchInputDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  query!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  limit?: number;
}

export class OpenClawCustomerSearchDto extends OpenClawToolRequestDto {
  @ValidateNested()
  @Type(() => OpenClawCustomerSearchInputDto)
  input!: OpenClawCustomerSearchInputDto;
}

export class OpenClawPrepareQuoteInputDto {
  @IsString()
  @MinLength(43)
  @MaxLength(43)
  @Matches(/^[A-Za-z0-9_-]+$/)
  selectionToken!: string;
}

export class OpenClawPrepareQuoteDto extends OpenClawToolRequestDto {
  @ValidateNested()
  @Type(() => OpenClawPrepareQuoteInputDto)
  input!: OpenClawPrepareQuoteInputDto;
}

export class OpenClawStartResearchDto extends OpenClawToolRequestDto {
  @ValidateNested()
  @Type(() => OpenClawPrepareQuoteInputDto)
  input!: OpenClawPrepareQuoteInputDto;
}

export class OpenClawSelectionInputDto extends OpenClawPrepareQuoteInputDto {}

export class OpenClawSelectionToolDto extends OpenClawToolRequestDto {
  @ValidateNested()
  @Type(() => OpenClawSelectionInputDto)
  input!: OpenClawSelectionInputDto;
}

export class OpenClawCustomerNoteInputDto extends OpenClawSelectionInputDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1200)
  note!: string;
}

export class OpenClawCustomerNoteDto extends OpenClawToolRequestDto {
  @ValidateNested()
  @Type(() => OpenClawCustomerNoteInputDto)
  input!: OpenClawCustomerNoteInputDto;
}

export class OpenClawCustomerStageInputDto extends OpenClawSelectionInputDto {
  @IsIn(['new', 'contacted', 'replied', 'interested', 'quoted', 'won', 'lost'])
  stage!: string;
}

export class OpenClawCustomerStageDto extends OpenClawToolRequestDto {
  @ValidateNested()
  @Type(() => OpenClawCustomerStageInputDto)
  input!: OpenClawCustomerStageInputDto;
}

export class OpenClawCustomerUpdateInputDto extends OpenClawSelectionInputDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(240)
  companyName?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(160)
  contactName?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(100)
  country?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(100)
  city?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(160)
  industry?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(180)
  productCategory?: string;

  @IsOptional() @IsString() @Matches(/^[a-z]{2}(?:-[A-Z]{2})?$/)
  language?: string;
}

export class OpenClawCustomerUpdateDto extends OpenClawToolRequestDto {
  @ValidateNested()
  @Type(() => OpenClawCustomerUpdateInputDto)
  input!: OpenClawCustomerUpdateInputDto;
}

export class OpenClawTaskCreateInputDto extends OpenClawSelectionInputDto {
  @IsString()
  @MinLength(1)
  @MaxLength(180)
  title!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)
  dueAt!: string;

  @IsOptional()
  @IsIn(['Low', 'Medium', 'High'])
  priority?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class OpenClawTaskCreateDto extends OpenClawToolRequestDto {
  @ValidateNested()
  @Type(() => OpenClawTaskCreateInputDto)
  input!: OpenClawTaskCreateInputDto;
}

export class OpenClawOrderCreateInputDto extends OpenClawSelectionInputDto {
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100000000)
  totalAmount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  quoteReferenceNo?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  deliveryDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  shippingTerms?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  notes?: string;
}

export class OpenClawOrderCreateDto extends OpenClawToolRequestDto {
  @ValidateNested()
  @Type(() => OpenClawOrderCreateInputDto)
  input!: OpenClawOrderCreateInputDto;
}

export class OpenClawOrderStageInputDto extends OpenClawSelectionInputDto {
  @IsString()
  @Matches(/^ORD-[A-Z0-9-]{6,40}$/)
  orderNo!: string;

  @IsIn(['draft', 'won', 'sampling', 'production', 'qc', 'shipping', 'payment', 'completed', 'after_sales'])
  stage!: string;
}

export class OpenClawOrderStageDto extends OpenClawToolRequestDto {
  @ValidateNested()
  @Type(() => OpenClawOrderStageInputDto)
  input!: OpenClawOrderStageInputDto;
}

export class OpenClawQuoteLineItemDto {
  @IsString()
  @Matches(/^JYM-\d{4}$/)
  catalogItemId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000000)
  quantity!: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string;
}

export class OpenClawQuoteCreateInputDto extends OpenClawSelectionInputDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => OpenClawQuoteLineItemDto)
  lineItems!: OpenClawQuoteLineItemDto[];

  @IsOptional()
  @IsIn(['quote', 'pi'])
  documentType?: 'quote' | 'pi';

  @IsOptional()
  @IsIn(['USD'])
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  tradeTerms?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  paymentTerms?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  deliveryTime?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000000)
  discount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  notes?: string;
}

export class OpenClawQuoteCreateDto extends OpenClawToolRequestDto {
  @ValidateNested()
  @Type(() => OpenClawQuoteCreateInputDto)
  input!: OpenClawQuoteCreateInputDto;
}

export class OpenClawProductSearchInputDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  query!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;
}

export class OpenClawProductSearchDto extends OpenClawToolRequestDto {
  @ValidateNested()
  @Type(() => OpenClawProductSearchInputDto)
  input!: OpenClawProductSearchInputDto;
}

export class OpenClawMessageReadInputDto extends OpenClawSelectionInputDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  limit?: number;
}

export class OpenClawMessageReadDto extends OpenClawToolRequestDto {
  @ValidateNested()
  @Type(() => OpenClawMessageReadInputDto)
  input!: OpenClawMessageReadInputDto;
}

export class OpenClawWhatsappSendInputDto extends OpenClawSelectionInputDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  text!: string;
}

export class OpenClawWhatsappSendDto extends OpenClawToolRequestDto {
  @ValidateNested()
  @Type(() => OpenClawWhatsappSendInputDto)
  input!: OpenClawWhatsappSendInputDto;
}

export class OpenClawWhatsappQuoteSendInputDto extends OpenClawSelectionInputDto {
  @IsString()
  @Matches(/^(?:QT|PI)-[A-Z0-9-]{6,64}$/)
  referenceNo!: string;
}

export class OpenClawWhatsappQuoteSendDto extends OpenClawToolRequestDto {
  @ValidateNested()
  @Type(() => OpenClawWhatsappQuoteSendInputDto)
  input!: OpenClawWhatsappQuoteSendInputDto;
}

export class OpenClawEmailSendInputDto extends OpenClawSelectionInputDto {
  @IsString()
  @MinLength(1)
  @MaxLength(240)
  subject!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(12000)
  body!: string;
}

export class OpenClawEmailSendDto extends OpenClawToolRequestDto {
  @ValidateNested()
  @Type(() => OpenClawEmailSendInputDto)
  input!: OpenClawEmailSendInputDto;
}

export class OpenClawEmailReplyInputDto extends OpenClawSelectionInputDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(240)
  subject?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(12000)
  body!: string;
}

export class OpenClawEmailReplyDto extends OpenClawToolRequestDto {
  @ValidateNested()
  @Type(() => OpenClawEmailReplyInputDto)
  input!: OpenClawEmailReplyInputDto;
}
