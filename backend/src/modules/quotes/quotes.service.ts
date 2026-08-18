import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ensureCompanyAccess, hasFullAccess, requireActiveCompany } from '../../common/utils/data-isolation';
import {
  generateOrderNumber,
  isOrderNumberUniqueConflict,
  ORDER_NUMBER_RETRY_LIMIT,
} from '../../common/utils/order-number';
import { safeLogEvent } from '../../common/security/safe-logging';
import usdPriceCatalog from '../products/data/usd-price-catalog.json';
import { resolvePdfBrowserExecutable } from './pdf-browser';
import { UpdateQuoteDto } from './dto/update-quote.dto';
import {
  assertOpportunityLead,
  findAccessibleOpportunity,
  findAccessibleOpportunitySummaries,
  opportunitySummaryKey,
  type OpportunitySummaryResponse,
} from './opportunity-association';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface CreateLineItemDto {
  productCode?: string;
  productName: string;
  material?: string;
  size?: string;
  thickness?: string;
  color?: string;
  printing?: string;
  quantity: number;
  unit?: string;
  unitPrice: number;
  totalPrice?: number;
  productSpecId?: string;
  notes?: string;
  catalogItemId?: string;
}

interface CreateQuoteDto {
  type?: string;
  referenceNo?: string;
  leadId?: string;
  opportunityId?: string;
  conversationId?: string;
  lineItems: CreateLineItemDto[];
  currency?: string;
  tradeTerms?: string;
  paymentTerms?: string;
  deliveryTime?: string;
  sampleFee?: number;
  moldFee?: number;
  discount?: number;
  taxRate?: number;
  notes?: string;
  validUntil?: string;
  aiExtracted?: boolean;
  aiArtifactId?: string;
}

export interface QuoteLeadSummaryResponse {
  id: string;
  companyName: string;
  contactName: string | null;
  country: string | null;
}

export interface QuoteLineItemResponse {
  id: string;
  productCode: string | null;
  productName: string;
  material: string | null;
  size: string | null;
  thickness: string | null;
  color: string | null;
  printing: string | null;
  quantity: number;
  unit: string;
  unitPrice: string;
  totalPrice: string;
  productSpecId: string | null;
  catalogItemId: string | null;
  notes: string | null;
}

export interface QuoteListItemResponse {
  id: string;
  referenceNo: string;
  type: string;
  status: string;
  leadId: string | null;
  opportunity: OpportunitySummaryResponse | null;
  currency: string;
  totalAmount: string;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
  lead: QuoteLeadSummaryResponse | null;
}

export interface QuoteDetailResponse extends QuoteListItemResponse {
  conversationId: string | null;
  tradeTerms: string | null;
  paymentTerms: string | null;
  deliveryTime: string | null;
  sampleFee: string | null;
  moldFee: string | null;
  discount: string;
  taxRate: string | null;
  subtotal: string;
  taxAmount: string;
  validUntil: string | null;
  lineItems: QuoteLineItemResponse[];
}

export interface QuoteLeadHistoryItemResponse extends QuoteListItemResponse {
  lineItems: QuoteLineItemResponse[];
}

export interface QuoteListResponse {
  data: QuoteListItemResponse[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface QuoteConvertOrderResponse {
  id: string;
  orderNo: string;
  leadId: string | null;
  quoteId: string;
  stage: string;
  currency: string;
  totalAmount: string;
  paidAmount: string;
  createdAt: string;
  updatedAt: string;
}

function toQuoteConvertOrderResponse(order: {
  id: string;
  orderNo: string;
  leadId: string | null;
  quoteId: string | null;
  stage: string;
  currency: string;
  totalAmount: unknown;
  paidAmount: unknown;
  createdAt?: Date;
  updatedAt?: Date;
}): QuoteConvertOrderResponse {
  return {
    id: order.id,
    orderNo: order.orderNo,
    leadId: order.leadId,
    quoteId: order.quoteId || '',
    stage: order.stage,
    currency: order.currency,
    totalAmount: String(order.totalAmount ?? '0'),
    paidAmount: String(order.paidAmount ?? '0'),
    createdAt: order.createdAt?.toISOString() || '',
    updatedAt: order.updatedAt?.toISOString() || '',
  };
}

type QuoteReadRecord = {
  id: string;
  companyId: string;
  referenceNo: string;
  type: string;
  status: string;
  leadId: string | null;
  conversationId: string | null;
  opportunityId: string | null;
  opportunity?: OpportunitySummaryResponse | null;
  currency: string;
  tradeTerms: string | null;
  paymentTerms: string | null;
  deliveryTime: string | null;
  sampleFee: unknown;
  moldFee: unknown;
  discount: unknown;
  taxRate: unknown;
  subtotal: unknown;
  taxAmount: unknown;
  totalAmount: unknown;
  notes: string | null;
  validUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
  lineItems: Array<{
    id: string;
    productCode: string | null;
    productName: string;
    material: string | null;
    size: string | null;
    thickness: string | null;
    color: string | null;
    printing: string | null;
    quantity: number;
    unit: string;
    unitPrice: unknown;
    totalPrice: unknown;
    productSpecId: string | null;
    catalogItemId: string | null;
    notes: string | null;
  }>;
  lead?: {
    id: string;
    companyName: string;
    contactName: string | null;
    country: string | null;
    contactEmail?: string | null;
  } | null;
};

function quoteMoney(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function quoteDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function toQuoteLineItemResponse(item: QuoteReadRecord['lineItems'][number]): QuoteLineItemResponse {
  return {
    id: item.id,
    productCode: item.productCode,
    productName: item.productName,
    material: item.material,
    size: item.size,
    thickness: item.thickness,
    color: item.color,
    printing: item.printing,
    quantity: item.quantity,
    unit: item.unit,
    unitPrice: quoteMoney(item.unitPrice) || '0',
    totalPrice: quoteMoney(item.totalPrice) || '0',
    productSpecId: item.productSpecId,
    catalogItemId: item.catalogItemId,
    notes: item.notes,
  };
}

function toQuoteLeadSummaryResponse(lead: QuoteReadRecord['lead']): QuoteLeadSummaryResponse | null {
  if (!lead) return null;
  return {
    id: lead.id,
    companyName: lead.companyName,
    contactName: lead.contactName,
    country: lead.country,
  };
}

function toQuoteListItemResponse(quote: QuoteReadRecord): QuoteListItemResponse {
  const lineItems = quote.lineItems || [];
  return {
    id: quote.id,
    referenceNo: quote.referenceNo,
    type: quote.type,
    status: quote.status,
    leadId: quote.leadId,
    opportunity: quote.opportunity || null,
    currency: quote.currency,
    totalAmount: quoteMoney(quote.totalAmount) || '0',
    itemCount: lineItems.length,
    createdAt: quote.createdAt ? quote.createdAt.toISOString() : '',
    updatedAt: quote.updatedAt ? quote.updatedAt.toISOString() : '',
    lead: toQuoteLeadSummaryResponse(quote.lead),
  };
}

function toQuoteDetailResponse(quote: QuoteReadRecord): QuoteDetailResponse {
  return {
    ...toQuoteListItemResponse(quote),
    conversationId: quote.conversationId,
    tradeTerms: quote.tradeTerms,
    paymentTerms: quote.paymentTerms,
    deliveryTime: quote.deliveryTime,
    sampleFee: quoteMoney(quote.sampleFee),
    moldFee: quoteMoney(quote.moldFee),
    discount: quoteMoney(quote.discount) || '0',
    taxRate: quoteMoney(quote.taxRate),
    subtotal: quoteMoney(quote.subtotal) || '0',
    taxAmount: quoteMoney(quote.taxAmount) || '0',
    validUntil: quoteDate(quote.validUntil),
    lineItems: (quote.lineItems || []).map(toQuoteLineItemResponse),
  };
}

function roundQuoteMoney(value: number): number {
  return Math.round(
    (value + Math.sign(value) * Number.EPSILON) * 100,
  ) / 100;
}

const QUOTE_FEE_MAX = 99_999_999.99;

function normalizeQuoteFee(value: unknown, fieldName: string): number {
  if (value === null || value === undefined || value === '') return 0;
  const numeric = Number(value);
  const rounded = Math.round(numeric * 100) / 100;
  if (
    !Number.isFinite(numeric)
    || numeric < 0
    || numeric > QUOTE_FEE_MAX
    || Math.abs(numeric - rounded) > Number.EPSILON * Math.max(1, Math.abs(numeric))
  ) {
    throw new BadRequestException(
      `${fieldName} must be a non-negative amount with at most two decimal places`,
    );
  }
  return rounded;
}

export function calculateQuoteTotals(
  lineItemTotals: Array<number | string | { toString(): string }>,
  discountValue: number | string | { toString(): string } | null | undefined,
  taxRateValue: number | string | { toString(): string } | null | undefined,
  sampleFeeValue?: number | string | { toString(): string } | null,
  moldFeeValue?: number | string | { toString(): string } | null,
) {
  const subtotal = roundQuoteMoney(lineItemTotals.reduce<number>(
    (sum, value) => sum + Number(value),
    0,
  ));
  if (!Number.isFinite(subtotal) || subtotal < 0) {
    throw new BadRequestException('Quote line-item totals are invalid');
  }
  const discount = Number(discountValue) || 0;
  const taxRate = Number(taxRateValue) || 0;
  if (!Number.isFinite(discount) || discount < 0 || discount > subtotal) {
    throw new BadRequestException(
      'Quote discount must be between zero and the subtotal',
    );
  }
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
    throw new BadRequestException(
      'Quote tax rate must be between zero and 100',
    );
  }
  const taxableAmount = subtotal - discount;
  const taxAmount = roundQuoteMoney((taxableAmount * taxRate) / 100);
  const sampleFee = normalizeQuoteFee(sampleFeeValue, 'sampleFee');
  const moldFee = normalizeQuoteFee(moldFeeValue, 'moldFee');
  const totalAmount = roundQuoteMoney(
    taxableAmount + taxAmount + sampleFee + moldFee,
  );
  return { subtotal, taxAmount, totalAmount, sampleFee, moldFee };
}

@Injectable()
export class QuotesService {
  private readonly logger = new Logger(QuotesService.name);

  constructor(private prisma: PrismaService) {}

  // ========== CRUD ==========

  async findAll(currentUser: any, query?: { page?: number; limit?: number; type?: string; status?: string; leadId?: string }) {
    const companyId = requireActiveCompany(currentUser).id;

    const page = query?.page || 1;
    const limit = query?.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = { companyId };
    if (!hasFullAccess(currentUser, companyId)) {
      where.assignedUserId = currentUser.id;
    }
    if (query?.type) where.type = query.type;
    if (query?.status) where.status = query.status;
    if (query?.leadId) where.leadId = query.leadId;

    const [data, total] = await Promise.all([
      this.prisma.quote.findMany({
        where,
        include: {
          lineItems: { orderBy: { sortOrder: 'asc' } },
          lead: { select: { id: true, companyName: true, contactName: true, country: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.quote.count({ where }),
    ]);

    const opportunitySummaries = await findAccessibleOpportunitySummaries(
      this.prisma,
      data.map((quote: any) => ({ opportunityId: quote.opportunityId, leadId: quote.leadId })),
      currentUser,
      companyId,
    );
    return {
      data: data.map((quote) => toQuoteListItemResponse({
        ...(quote as QuoteReadRecord),
        opportunity: opportunitySummaries.get(opportunitySummaryKey((quote as any).opportunityId, (quote as any).leadId)) || null,
      })),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    } satisfies QuoteListResponse;
  }

  async findOne(id: string, currentUser: any) {
    const quote = await this.findOneRecord(id, currentUser);
    return toQuoteDetailResponse(quote);
  }

  private async findOneRecord(id: string, currentUser: any): Promise<QuoteReadRecord> {
    const companyId = requireActiveCompany(currentUser).id;
    const quote = await this.prisma.quote.findFirst({
      where: {
        id,
        companyId,
        ...(!hasFullAccess(currentUser, companyId)
          ? { assignedUserId: currentUser.id }
          : {}),
      },
      include: {
        lineItems: { orderBy: { sortOrder: 'asc' } },
        lead: { select: { id: true, companyName: true, contactName: true, country: true, contactEmail: true } },
      },
    });
    if (!quote) throw new NotFoundException('Quote not found');
    this.ensureAccess(currentUser, quote.companyId);
    const opportunitySummaries = await findAccessibleOpportunitySummaries(
      this.prisma,
      [{ opportunityId: (quote as any).opportunityId, leadId: (quote as any).leadId }],
      currentUser,
      companyId,
    );
    return {
      ...(quote as QuoteReadRecord),
      opportunity: opportunitySummaries.get(opportunitySummaryKey((quote as any).opportunityId, (quote as any).leadId)) || null,
    };
  }

  async createQuote(dto: CreateQuoteDto, currentUser: any) {
    const activeCompanyId = requireActiveCompany(currentUser).id;
    this.assertQuoteWriteAllowed(currentUser);
    const companyId = activeCompanyId;
    const opportunity = dto.opportunityId
      ? await findAccessibleOpportunity(this.prisma, dto.opportunityId, currentUser, activeCompanyId)
      : null;
    if (opportunity && dto.leadId) assertOpportunityLead(opportunity, dto.leadId);
    let explicitLead: { id: string } | null = null;
    if (dto.leadId) {
      explicitLead = await this.prisma.lead.findFirst({
        where: {
          id: dto.leadId,
          companyId: activeCompanyId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!explicitLead) throw new NotFoundException('Lead not found');
    }

    let conversationLeadId: string | null = null;
    if (dto.conversationId) {
      const conversation = await this.prisma.conversation.findFirst({
        where: {
          id: dto.conversationId,
          companyId: activeCompanyId,
          ...(!hasFullAccess(currentUser, activeCompanyId)
            ? { assignedUserId: currentUser.id }
            : {}),
        },
        select: { id: true, companyId: true, leadId: true },
      });
      if (!conversation) throw new NotFoundException('Conversation not found');
      conversationLeadId = conversation.leadId;
      if (conversationLeadId) {
        const conversationLead = await this.prisma.lead.findFirst({
          where: {
            id: conversationLeadId,
            companyId: activeCompanyId,
            deletedAt: null,
          },
          select: { id: true },
        });
        if (!conversationLead) {
          throw new NotFoundException('Conversation lead not found');
        }
      }
      if (
        (dto.leadId || opportunity?.leadId)
        && (!conversationLeadId || conversationLeadId !== (dto.leadId || opportunity?.leadId))
      ) {
        throw new BadRequestException(
          'Conversation and lead must reference the same active-tenant customer',
        );
      }
    }

    const leadId = explicitLead?.id || conversationLeadId || opportunity?.leadId || null;
    if (leadId) {
      const authorizedLead = await this.prisma.lead.findFirst({
        where: {
          id: leadId,
          companyId: activeCompanyId,
          deletedAt: null,
          ...(!hasFullAccess(currentUser, activeCompanyId)
            ? { ownerUserId: currentUser.id }
            : {}),
        },
        select: { id: true },
      });
      if (!authorizedLead) throw new NotFoundException('Lead not found');
    }

    // Generate reference number
    const docType = dto.type || 'quote';
    const prefix = docType === 'pi' ? 'PI' : docType === 'contract' ? 'CT' : docType === 'sample' ? 'SP' : 'QT';
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const refNo = dto.referenceNo || `${prefix}-${dateStr}-${String(Date.now()).slice(-4)}`;

    // Calculate amounts
    const lineItems = dto.lineItems.map((item, i) => {
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
        throw new BadRequestException(`Line item ${i + 1} quantity must be a positive integer`);
      }

      const catalogItem = item.catalogItemId
        ? usdPriceCatalog.items.find((candidate) => candidate.catalogItemId === item.catalogItemId)
        : undefined;
      if (item.catalogItemId && !catalogItem) {
        throw new BadRequestException(`Unknown pricing catalog item: ${item.catalogItemId}`);
      }

      const unitPrice = catalogItem ? catalogItem.saleUsd : Number(item.unitPrice);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        throw new BadRequestException(`Line item ${i + 1} unit price is invalid`);
      }

      return {
        ...item,
        productName: catalogItem?.categoryCn || item.productName,
        size: catalogItem?.size || item.size,
        thickness: catalogItem?.thickness || item.thickness,
        unitPrice,
        totalPrice: roundQuoteMoney(item.quantity * unitPrice),
        catalogItemId: catalogItem?.catalogItemId || null,
        costPriceCny: catalogItem?.costCny ?? null,
        sourceCurrency: catalogItem ? usdPriceCatalog.pricingPolicy.sourceCurrency : null,
        fxRate: catalogItem ? usdPriceCatalog.pricingPolicy.protectionFxRateCnyPerUsd : null,
        markup: catalogItem ? usdPriceCatalog.pricingPolicy.markup : null,
        priceVersion: catalogItem ? usdPriceCatalog.priceVersion : null,
        priceSource: catalogItem ? usdPriceCatalog.source : null,
        sortOrder: i,
      };
    });
    const discount = Number(dto.discount) || 0;
    const taxRate = Number(dto.taxRate) || 0;
    const sampleFee = normalizeQuoteFee(dto.sampleFee, 'sampleFee');
    const moldFee = normalizeQuoteFee(dto.moldFee, 'moldFee');
    const { subtotal, taxAmount, totalAmount } = calculateQuoteTotals(
      lineItems.map((item) => item.totalPrice),
      discount,
      taxRate,
      sampleFee,
      moldFee,
    );

    // Create quote with line items in a transaction
    const quote = await this.prisma.$transaction(async (tx) => {
      if (dto.opportunityId) {
        const transactionOpportunity = await findAccessibleOpportunity(
          tx,
          dto.opportunityId,
          currentUser,
          companyId,
        );
        assertOpportunityLead(transactionOpportunity, leadId);
      }
      const created = await tx.quote.create({
        data: {
          companyId,
          referenceNo: refNo,
          type: docType,
          status: 'draft',
          leadId,
          opportunityId: dto.opportunityId || null,
          conversationId: dto.conversationId || null,
          assignedUserId: currentUser.id,
          currency: dto.currency || 'USD',
          tradeTerms: dto.tradeTerms || null,
          paymentTerms: dto.paymentTerms || null,
          deliveryTime: dto.deliveryTime || null,
          sampleFee: dto.sampleFee === null || dto.sampleFee === undefined ? null : sampleFee,
          moldFee: dto.moldFee === null || dto.moldFee === undefined ? null : moldFee,
          discount,
          taxRate: dto.taxRate || null,
          subtotal,
          taxAmount,
          totalAmount,
          notes: dto.notes || null,
          validUntil: dto.validUntil ? new Date(dto.validUntil) : null,
          aiExtracted: dto.aiExtracted || false,
          aiArtifactId: dto.aiArtifactId || null,
          lineItems: {
            create: lineItems.map((item) => ({
              productCode: item.productCode || null,
              productName: item.productName,
              material: item.material || null,
              size: item.size || null,
              thickness: item.thickness || null,
              color: item.color || null,
              printing: item.printing || null,
              quantity: item.quantity,
              unit: item.unit || 'pcs',
              unitPrice: item.unitPrice,
              totalPrice: item.totalPrice,
              productSpecId: item.productSpecId || null,
              catalogItemId: item.catalogItemId,
              costPriceCny: item.costPriceCny,
              sourceCurrency: item.sourceCurrency,
              fxRate: item.fxRate,
              markup: item.markup,
              priceVersion: item.priceVersion,
              priceSource: item.priceSource,
              sortOrder: item.sortOrder || 0,
              notes: item.notes || null,
            })),
          },
        },
        include: { lineItems: true },
      });
      return created;
    });

    // Log to timeline
    if (leadId) {
      await this.prisma.leadActivity.create({
        data: {
          companyId,
          leadId,
          activityType: 'quote_logged',
          title: `报价草稿已创建: ${refNo}`,
          description: `${lineItems.length} items, total $${totalAmount.toFixed(2)}`,
          metadata: { quoteId: quote.id, referenceNo: refNo },
          occurredAt: new Date(),
        },
      });
    }

    this.logger.log(safeLogEvent('quote.created', {
      status: 'draft',
      count: lineItems.length,
    }));
    return {
      id: quote.id,
      referenceNo: refNo,
      totalAmount,
      subtotal,
      taxAmount,
      sampleFee,
      moldFee,
      itemCount: lineItems.length,
      status: 'draft',
    };
  }

  async updateQuote(id: string, dto: UpdateQuoteDto, currentUser: any) {
    this.assertQuoteWriteAllowed(currentUser);
    const forbiddenFields = [
      'companyId',
      'assignedUserId',
      'createdBy',
      'status',
      'subtotal',
      'taxAmount',
      'totalAmount',
      'acceptedAt',
      'sentAt',
    ];
    const forbiddenField = forbiddenFields.find((field) =>
      Object.prototype.hasOwnProperty.call(dto, field),
    );
    if (forbiddenField) {
      throw new BadRequestException(
        `Quote field cannot be updated: ${forbiddenField}`,
      );
    }

    const companyId = requireActiveCompany(currentUser).id;
    const isolated = !hasFullAccess(currentUser, companyId);

    const updateData: any = {};
    const scalarFields: Array<keyof UpdateQuoteDto> = [
      'referenceNo',
      'type',
      'leadId',
      'conversationId',
      'opportunityId',
      'currency',
      'tradeTerms',
      'paymentTerms',
      'deliveryTime',
      'sampleFee',
      'moldFee',
      'discount',
      'taxRate',
      'notes',
    ];
    for (const field of scalarFields) {
      if (dto[field] === undefined) continue;
      updateData[field] = field === 'sampleFee' || field === 'moldFee'
        ? normalizeQuoteFee(dto[field], field)
        : dto[field];
    }
    if (dto.validUntil !== undefined) {
      updateData.validUntil = new Date(dto.validUntil);
    }

    let replacementLineItems: any[] | null = null;
    if (dto.lineItems) {
      replacementLineItems = dto.lineItems.map((item: any, i: number) => ({
        productCode: item.productCode,
        productName: item.productName,
        material: item.material,
        size: item.size,
        thickness: item.thickness,
        color: item.color,
        printing: item.printing,
        quantity: item.quantity,
        unit: item.unit,
        unitPrice: item.unitPrice,
        totalPrice: roundQuoteMoney(item.quantity * Number(item.unitPrice)),
        productSpecId: item.productSpecId,
        notes: item.notes,
        sortOrder: i,
      }));
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const quote = await tx.quote.findFirst({
          where: this.quoteAccessWhere(id, currentUser),
          select: {
            id: true,
            status: true,
            leadId: true,
            conversationId: true,
            opportunityId: true,
            sampleFee: true,
            moldFee: true,
            discount: true,
            taxRate: true,
          },
        });
        if (!quote) throw new NotFoundException('Quote not found');
        this.assertEditableDraft(quote.status);

        const effectiveLeadId = dto.leadId !== undefined
          ? dto.leadId
          : quote.leadId;
        const effectiveConversationId = dto.conversationId !== undefined
          ? dto.conversationId
          : quote.conversationId;
        const effectiveOpportunityId = dto.opportunityId !== undefined
          ? dto.opportunityId
          : quote.opportunityId;
        const opportunity = effectiveOpportunityId
          ? await findAccessibleOpportunity(tx, effectiveOpportunityId, currentUser, companyId)
          : null;
        if (opportunity) assertOpportunityLead(opportunity, effectiveLeadId);
        const resolvedLeadId = effectiveLeadId || opportunity?.leadId || null;
        if (resolvedLeadId) {
          const lead = await tx.lead.findFirst({
            where: {
              id: resolvedLeadId,
              companyId,
              deletedAt: null,
              ...(isolated ? { ownerUserId: currentUser.id } : {}),
            },
            select: { id: true },
          });
          if (!lead) throw new NotFoundException('Lead not found');
        }
        if (effectiveConversationId) {
          const conversation = await tx.conversation.findFirst({
            where: {
              id: effectiveConversationId,
              companyId,
              ...(isolated ? { assignedUserId: currentUser.id } : {}),
            },
            select: { id: true, leadId: true },
          });
          if (!conversation) {
            throw new NotFoundException('Conversation not found');
          }
          if (conversation.leadId !== resolvedLeadId) {
            throw new BadRequestException(
              'Conversation and lead must reference the same customer',
            );
          }
        }
        if (opportunity && !effectiveLeadId) updateData.leadId = opportunity.leadId;

        const priceChanged = replacementLineItems !== null
          || dto.sampleFee !== undefined
          || dto.moldFee !== undefined
          || dto.discount !== undefined
          || dto.taxRate !== undefined;
        if (priceChanged) {
          const finalLineItemTotals = replacementLineItems
            ? replacementLineItems.map((item: any) => item.totalPrice)
            : (await tx.quoteLineItem.findMany({
              where: { quoteId: id },
              select: { totalPrice: true },
            })).map((item) => item.totalPrice);
          const discount = dto.discount !== undefined
            ? Number(dto.discount)
            : Number(quote.discount) || 0;
          const taxRate = dto.taxRate !== undefined
            ? Number(dto.taxRate)
            : Number(quote.taxRate) || 0;
          const sampleFee = dto.sampleFee !== undefined
            ? normalizeQuoteFee(dto.sampleFee, 'sampleFee')
            : normalizeQuoteFee(quote.sampleFee, 'sampleFee');
          const moldFee = dto.moldFee !== undefined
            ? normalizeQuoteFee(dto.moldFee, 'moldFee')
            : normalizeQuoteFee(quote.moldFee, 'moldFee');
          Object.assign(
            updateData,
            calculateQuoteTotals(
              finalLineItemTotals,
              discount,
              taxRate,
              sampleFee,
              moldFee,
            ),
          );
        }

        const updated = await tx.quote.updateMany({
          where: {
            ...this.quoteAccessWhere(id, currentUser),
            status: 'draft',
          },
          data: updateData,
        });
        if (updated.count !== 1) {
          throw new ConflictException(
            'Quote is no longer an editable draft; reload and retry',
          );
        }
        if (replacementLineItems) {
          await tx.quoteLineItem.deleteMany({ where: { quoteId: id } });
          await tx.quoteLineItem.createMany({
            data: replacementLineItems.map((item: any) => ({
              quoteId: id,
              productCode: item.productCode || null,
              productName: item.productName,
              material: item.material || null,
              size: item.size || null,
              thickness: item.thickness || null,
              color: item.color || null,
              printing: item.printing || null,
              quantity: item.quantity,
              unit: item.unit || 'pcs',
              unitPrice: item.unitPrice,
              totalPrice: item.totalPrice,
              productSpecId: item.productSpecId || null,
              sortOrder: item.sortOrder || 0,
              notes: item.notes || null,
            })),
          });
        }
        return tx.quote.findFirst({
          where: {
            ...this.quoteAccessWhere(id, currentUser),
            status: 'draft',
          },
          include: { lineItems: true },
        });
      }, { isolationLevel: 'Serializable' });
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2034') {
        throw new ConflictException(
          'Quote changed concurrently; reload and retry',
        );
      }
      throw error;
    }
  }

  async deleteQuote(id: string, currentUser: any) {
    this.assertQuoteWriteAllowed(currentUser);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const quote = await tx.quote.findFirst({
          where: this.quoteAccessWhere(id, currentUser),
          include: {
            lineItems: { orderBy: { sortOrder: 'asc' } },
            lead: {
              select: {
                id: true,
                companyName: true,
                contactName: true,
                country: true,
                contactEmail: true,
              },
            },
          },
        });
        if (!quote) throw new NotFoundException('Quote not found');
        this.assertEditableDraft(quote.status);
        const orderReference = await tx.order.findFirst({
          where: { quoteId: quote.id },
          select: { id: true },
        });
        if (orderReference) {
          throw new ConflictException(
            'Quote is referenced by an order and cannot be deleted',
          );
        }
        const deleted = await tx.quote.deleteMany({
          where: {
            ...this.quoteAccessWhere(id, currentUser),
            status: 'draft',
          },
        });
        if (deleted.count !== 1) {
          throw this.quoteMutationConflict();
        }
        return quote;
      }, { isolationLevel: 'Serializable' });
    } catch (error) {
      this.rethrowQuoteSerializationConflict(error);
    }
  }

  // ========== Line Item CRUD ==========

  async addLineItem(quoteId: string, dto: CreateLineItemDto, currentUser: any) {
    this.assertQuoteWriteAllowed(currentUser);
    const totalPrice = roundQuoteMoney(dto.quantity * Number(dto.unitPrice));
    try {
      return await this.prisma.$transaction(async (tx) => {
        const quote = await this.findEditableDraft(tx, quoteId, currentUser);
        const sortOrder = await tx.quoteLineItem.count({
          where: { quoteId: quote.id },
        });
        const item = await tx.quoteLineItem.create({
          data: {
            quoteId: quote.id,
            productCode: dto.productCode || null,
            productName: dto.productName,
            material: dto.material || null,
            size: dto.size || null,
            thickness: dto.thickness || null,
            color: dto.color || null,
            printing: dto.printing || null,
            quantity: dto.quantity,
            unit: dto.unit || 'pcs',
            unitPrice: dto.unitPrice,
            totalPrice,
            productSpecId: dto.productSpecId || null,
            sortOrder,
            notes: dto.notes || null,
          },
        });
        await this.persistDraftTotals(tx, quote, currentUser);
        return item;
      }, { isolationLevel: 'Serializable' });
    } catch (error) {
      this.rethrowQuoteSerializationConflict(error);
    }
  }

  async updateLineItem(quoteId: string, itemId: string, dto: any, currentUser: any) {
    this.assertQuoteWriteAllowed(currentUser);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const quote = await this.findEditableDraft(tx, quoteId, currentUser);
        const existing = await tx.quoteLineItem.findFirst({
          where: { id: itemId, quoteId: quote.id },
        });
        if (!existing) throw new NotFoundException('Line item not found');
        const updateData: any = {};
        const allowedFields = [
          'productCode',
          'productName',
          'material',
          'size',
          'thickness',
          'color',
          'printing',
          'quantity',
          'unit',
          'unitPrice',
          'productSpecId',
          'notes',
        ];
        for (const field of allowedFields) {
          if (dto[field] !== undefined) updateData[field] = dto[field];
        }
        if (dto.quantity !== undefined || dto.unitPrice !== undefined) {
          const qty = dto.quantity ?? existing.quantity;
          const price = dto.unitPrice ?? existing.unitPrice;
          updateData.totalPrice = roundQuoteMoney(qty * Number(price));
        }
        const result = await tx.quoteLineItem.updateMany({
          where: { id: itemId, quoteId: quote.id },
          data: updateData,
        });
        if (result.count !== 1) {
          throw new NotFoundException('Line item not found');
        }
        const item = await tx.quoteLineItem.findFirst({
          where: { id: itemId, quoteId: quote.id },
        });
        await this.persistDraftTotals(tx, quote, currentUser);
        return item;
      }, { isolationLevel: 'Serializable' });
    } catch (error) {
      this.rethrowQuoteSerializationConflict(error);
    }
  }

  async deleteLineItem(quoteId: string, itemId: string, currentUser: any) {
    this.assertQuoteWriteAllowed(currentUser);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const quote = await this.findEditableDraft(tx, quoteId, currentUser);
        const result = await tx.quoteLineItem.deleteMany({
          where: { id: itemId, quoteId: quote.id },
        });
        if (result.count !== 1) {
          throw new NotFoundException('Line item not found');
        }
        await this.persistDraftTotals(tx, quote, currentUser);
        return { success: true };
      }, { isolationLevel: 'Serializable' });
    } catch (error) {
      this.rethrowQuoteSerializationConflict(error);
    }
  }

  // ========== Calculate ==========

  async calculate(quoteId: string, currentUser: any) {
    this.assertQuoteWriteAllowed(currentUser);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const quote = await this.findEditableDraft(tx, quoteId, currentUser);
        await this.persistDraftTotals(tx, quote, currentUser);
        return tx.quote.findFirst({
          where: {
            ...this.quoteAccessWhere(quoteId, currentUser),
            status: 'draft',
          },
          include: { lineItems: { orderBy: { sortOrder: 'asc' } } },
        });
      }, { isolationLevel: 'Serializable' });
    } catch (error) {
      this.rethrowQuoteSerializationConflict(error);
    }
  }

  private async findEditableDraft(
    tx: Prisma.TransactionClient,
    quoteId: string,
    currentUser: any,
  ) {
    const quote = await tx.quote.findFirst({
      where: this.quoteAccessWhere(quoteId, currentUser),
      select: {
        id: true,
        status: true,
        sampleFee: true,
        moldFee: true,
        discount: true,
        taxRate: true,
      },
    });
    if (!quote) throw new NotFoundException('Quote not found');
    this.assertEditableDraft(quote.status);
    return quote;
  }

  private async persistDraftTotals(
    tx: Prisma.TransactionClient,
    quote: {
      id: string;
      sampleFee: number | string | { toString(): string } | null;
      moldFee: number | string | { toString(): string } | null;
      discount: number | string | { toString(): string };
      taxRate: number | string | { toString(): string } | null;
    },
    currentUser: any,
  ) {
    const items = await tx.quoteLineItem.findMany({
      where: { quoteId: quote.id },
      select: { totalPrice: true },
    });
    const totals = calculateQuoteTotals(
      items.map((item) => item.totalPrice),
      quote.discount,
      quote.taxRate,
      quote.sampleFee,
      quote.moldFee,
    );
    const updated = await tx.quote.updateMany({
      where: {
        ...this.quoteAccessWhere(quote.id, currentUser),
        status: 'draft',
      },
      data: totals,
    });
    if (updated.count !== 1) throw this.quoteMutationConflict();
    return totals;
  }

  private assertEditableDraft(status: string) {
    if (status !== 'draft') throw this.quoteMutationConflict();
  }

  private quoteMutationConflict() {
    return new ConflictException(
      'Quote is no longer an editable draft; reload and retry',
    );
  }

  private rethrowQuoteSerializationConflict(error: unknown): never {
    if ((error as { code?: string })?.code === 'P2034') {
      throw new ConflictException(
        'Quote changed concurrently; reload and retry',
      );
    }
    throw error;
  }

  // ========== PI Generation ==========

  async generatePiHtml(quoteId: string, currentUser: any) {
    // Keep the internal PI source separate from the public detail projection so
    // notes/contactEmail and other rendering-only fields are not exposed by the
    // business read contract while the existing authenticated PI path remains intact.
    const quote = await this.findOneRecord(quoteId, currentUser) as any;
    const lead = quote.lead;

    const rows = (quote.lineItems || []).map((item: any, i: number) => `
      <tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(item.productName)}</td>
        <td>${escapeHtml(item.material || '-')}</td>
        <td>${escapeHtml(item.size || '-')}</td>
        <td>${item.quantity.toLocaleString()}</td>
        <td>${quote.currency} ${Number(item.unitPrice).toFixed(4)}</td>
        <td>${quote.currency} ${Number(item.totalPrice).toFixed(2)}</td>
      </tr>
    `).join('');

    const refNo = escapeHtml(quote.referenceNo);
    const companyName = escapeHtml(lead?.companyName || 'N/A');
    const contactName = escapeHtml(lead?.contactName || '');
    const country = escapeHtml(lead?.country || '');
    const tradeTerms = escapeHtml(quote.tradeTerms || 'FOB');
    const paymentTerms = escapeHtml(quote.paymentTerms || 'T/T 30% advance, 70% before shipment');
    const deliveryTime = escapeHtml(quote.deliveryTime || 'TBD');
    const currency = quote.currency;
    const subtotal = Number(quote.subtotal).toFixed(2);
    const discount = Number(quote.discount || 0).toFixed(2);
    const sampleFee = Number(quote.sampleFee || 0).toFixed(2);
    const moldFee = Number(quote.moldFee || 0).toFixed(2);
    const taxAmount = Number(quote.taxAmount || 0).toFixed(2);
    const totalAmount = Number(quote.totalAmount).toFixed(2);
    const notes = quote.notes ? escapeHtml(quote.notes) : '';
    const isDraft = quote.status === 'draft';

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Proforma Invoice ${refNo}</title>
<style>
  body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 40px; color: #333; }
  .header { text-align: center; margin-bottom: 30px; }
  .header h1 { margin: 0; font-size: 24px; }
  .header p { color: #666; margin: 5px 0; }
  table { width: 100%; border-collapse: collapse; margin: 20px 0; }
  th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; font-size: 13px; }
  th { background: #f5f5f5; font-weight: 600; }
  .info { display: flex; justify-content: space-between; margin-bottom: 20px; }
  .info-box { flex: 1; }
  .info-box strong { display: block; margin-bottom: 4px; }
  .totals { text-align: right; margin-top: 20px; font-size: 14px; }
  .totals div { margin: 4px 0; }
  .totals .grand { font-size: 18px; font-weight: bold; border-top: 2px solid #333; padding-top: 8px; }
  .footer { margin-top: 40px; font-size: 12px; color: #999; text-align: center; }
  ${isDraft ? '.draft-watermark { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%) rotate(-30deg); font-size: 72px; color: rgba(0,0,0,0.04); pointer-events: none; z-index: 1000; }' : ''}
</style></head><body>
  ${isDraft ? '<div class="draft-watermark">DRAFT</div>' : ''}
  <div class="header">
    <h1>Vaysen Packaging</h1>
    <p>${isDraft ? 'Proforma Invoice (Draft — Not Yet Confirmed)' : 'Proforma Invoice'}</p>
  </div>
  <div class="info">
    <div class="info-box"><strong>PI No:</strong> ${refNo}</div>
    <div class="info-box"><strong>Date:</strong> ${new Date().toLocaleDateString('en-US')}</div>
  </div>
  <div class="info">
    <div class="info-box"><strong>To:</strong><br>${companyName}<br>${contactName}<br>${country}</div>
    <div class="info-box"><strong>Trade Terms:</strong> ${tradeTerms}<br><strong>Payment:</strong> ${paymentTerms}<br><strong>Delivery:</strong> ${deliveryTime}</div>
  </div>
  <table><thead><tr><th>#</th><th>Product</th><th>Material</th><th>Size</th><th>Qty</th><th>Unit Price</th><th>Amount</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="totals">
    <div>Subtotal: ${currency} ${subtotal}</div>
    ${Number(quote.discount) > 0 ? `<div>Discount: -${currency} ${discount}</div>` : ''}
    ${Number(quote.taxAmount) > 0 ? `<div>Tax: ${currency} ${taxAmount}</div>` : ''}
    ${Number(quote.sampleFee) > 0 ? `<div>Sample Fee: ${currency} ${sampleFee}</div>` : ''}
    ${Number(quote.moldFee) > 0 ? `<div>Mold Fee: ${currency} ${moldFee}</div>` : ''}
    <div class="grand">Total: ${currency} ${totalAmount}</div>
  </div>
  ${notes ? `<p style="margin-top:20px;"><strong>Notes:</strong> ${notes}</p>` : ''}
  ${isDraft ? '<p style="margin-top:20px; color:#b45309; font-weight:600;">This is a draft. Prices, terms, and delivery dates must be confirmed by a sales representative before becoming effective.</p>' : ''}
  <div class="footer">Vaysen Packaging · vaysen.com · Generated by Trade System</div>
</body></html>`;
  }

  /**
   * 使用 puppeteer-core + 系统 Chrome 将 HTML 转为 PDF Buffer
   */
  async htmlToPdf(html: string): Promise<Buffer> {
    let browser: any = null;
    try {
      const puppeteer = require('puppeteer-core');
      const executablePath = resolvePdfBrowserExecutable();

      browser = await puppeteer.launch({
        executablePath,
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      });

      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '20px', bottom: '20px', left: '15px', right: '15px' },
      });

      return Buffer.from(pdfBuffer);
    } catch (err: any) {
      this.logger.error(`htmlToPdf failed: ${err.message}`);
      throw err;
    } finally {
      if (browser) {
        try { await browser.close(); } catch {}
      }
    }
  }

  // ========== Status Management ==========

  async updateStatus(quoteId: string, status: string, currentUser: any) {
    this.assertQuoteWriteAllowed(currentUser);
    const quote = await this.findOne(quoteId, currentUser);
    const transitions: Record<string, readonly string[]> = {
      draft: ['sent', 'cancelled'],
      sent: ['accepted', 'rejected', 'expired', 'cancelled'],
      accepted: [],
      rejected: [],
      expired: [],
      cancelled: [],
    };
    if (!Object.prototype.hasOwnProperty.call(transitions, status)) {
      throw new BadRequestException('Invalid quote status');
    }
    if (status !== quote.status && !transitions[quote.status]?.includes(status)) {
      throw new BadRequestException(
        `Invalid quote status transition: ${quote.status} -> ${status}`,
      );
    }
    const updateData: any = { status };
    if (status === 'sent') updateData.sentAt = new Date();
    if (status === 'accepted') updateData.acceptedAt = new Date();
    const updated = await this.prisma.quote.updateMany({
      where: {
        ...this.quoteAccessWhere(quote.id, currentUser),
        status: quote.status,
      },
      data: updateData,
    });
    if (updated.count !== 1) {
      throw new ConflictException('Quote changed concurrently; reload and retry');
    }
    return this.findOne(quote.id, currentUser);
  }

  // ========== Convert to Order ==========

  async convertToOrder(quoteId: string, currentUser: any) {
    this.assertQuoteWriteAllowed(currentUser);
    const companyId = requireActiveCompany(currentUser).id;
    const isolated = !hasFullAccess(currentUser, companyId);
    for (let attempt = 0; attempt < ORDER_NUMBER_RETRY_LIMIT; attempt += 1) {
      const orderNo = generateOrderNumber();
      try {
        const order = await this.prisma.$transaction(async (tx) => {
        const acceptedAt = new Date();
        const quoteUpdate = await tx.quote.updateMany({
          where: {
            ...this.quoteAccessWhere(quoteId, currentUser),
            status: 'sent',
          },
          data: { status: 'accepted', acceptedAt },
        });
        if (quoteUpdate.count !== 1) {
          throw new ConflictException(
            'Quote was already converted or changed concurrently',
          );
        }

        // Perform the global historical-reference check only after the exact
        // tenant/owner CAS. Any conflict rolls the CAS back without an ID oracle.
        const existingOrder = await tx.order.findFirst({
          where: { quoteId },
          select: { id: true },
        });
        if (existingOrder) {
          throw new ConflictException('Quote is already linked to an order');
        }

        const quote = await tx.quote.findFirst({
          where: {
            ...this.quoteAccessWhere(quoteId, currentUser),
            status: 'accepted',
            acceptedAt,
          },
          select: {
            id: true,
            companyId: true,
            leadId: true,
            opportunityId: true,
            conversationId: true,
            referenceNo: true,
            currency: true,
            totalAmount: true,
            tradeTerms: true,
          },
        });
        if (!quote) {
          throw new ConflictException(
            'Quote snapshot changed during conversion',
          );
        }
        if (quote.opportunityId) {
          const opportunity = await findAccessibleOpportunity(
            tx,
            quote.opportunityId,
            currentUser,
            companyId,
          );
          assertOpportunityLead(opportunity, quote.leadId);
        }
        if (quote.leadId) {
          const lead = await tx.lead.findFirst({
            where: {
              id: quote.leadId,
              companyId,
              deletedAt: null,
              ...(isolated ? { ownerUserId: currentUser.id } : {}),
            },
            select: { id: true },
          });
          if (!lead) throw new NotFoundException('Lead not found');
        }
        if (quote.conversationId) {
          const conversation = await tx.conversation.findFirst({
            where: {
              id: quote.conversationId,
              companyId,
              leadId: quote.leadId,
              ...(isolated ? { assignedUserId: currentUser.id } : {}),
            },
            select: { id: true },
          });
          if (!conversation) {
            throw new NotFoundException('Conversation not found');
          }
        }

        const created = await tx.order.create({
          data: {
            companyId: quote.companyId,
            orderNo,
            leadId: quote.leadId || null,
            opportunityId: quote.opportunityId || null,
            quoteId: quote.id,
            assignedUserId: currentUser.id,
            stage: 'won',
            currency: quote.currency,
            totalAmount: quote.totalAmount,
            paidAmount: 0,
            shippingTerms: quote.tradeTerms,
            notes: `Converted from quote ${quote.referenceNo}`,
            stageHistory: [
              { stage: 'won', changedAt: acceptedAt.toISOString(), changedBy: currentUser.id, note: `Converted from ${quote.referenceNo}` },
            ] as Prisma.InputJsonValue,
          },
        });

        // Log to timeline
        if (quote.leadId) {
          await tx.leadActivity.create({
            data: {
              companyId: quote.companyId,
              leadId: quote.leadId,
              activityType: 'order_created',
              title: `订单已创建: ${orderNo}`,
              description: `From quote ${quote.referenceNo}, total ${quote.currency} ${Number(quote.totalAmount).toFixed(2)}`,
              metadata: { orderId: created.id, orderNo, quoteId: quote.id },
              occurredAt: new Date(),
            },
          });
        }
          return created;
        }, { isolationLevel: 'Serializable' });
        this.logger.log(safeLogEvent('quote.converted_to_order', {
          orderNo,
          quoteId,
          status: 'accepted',
        }));
        return toQuoteConvertOrderResponse(order);
      } catch (error) {
        if (isOrderNumberUniqueConflict(error)) {
          if (attempt + 1 < ORDER_NUMBER_RETRY_LIMIT) continue;
          throw new ConflictException('Could not allocate a unique order number; retry');
        }
        if ((error as { code?: string })?.code === 'P2034') {
          throw new ConflictException(
            'Quote was already converted or changed concurrently',
          );
        }
        throw error;
      }
    }
    throw new ConflictException('Could not allocate a unique order number; retry');
  }

  // ========== List by Lead ==========

  async listByLead(leadId: string, currentUser: any) {
    const companyId = requireActiveCompany(currentUser).id;
    const lead = await this.prisma.lead.findFirst({
      where: {
        id: leadId,
        companyId,
        deletedAt: null,
        ...(!hasFullAccess(currentUser, companyId)
          ? { ownerUserId: currentUser.id }
          : {}),
      },
      select: { id: true },
    });
    if (!lead) throw new NotFoundException('Lead not found');

    const quotes = await this.prisma.quote.findMany({
      where: {
        companyId,
        leadId,
        ...(!hasFullAccess(currentUser, companyId)
          ? { assignedUserId: currentUser.id }
          : {}),
      },
      include: { lineItems: { orderBy: { sortOrder: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });
    const opportunitySummaries = await findAccessibleOpportunitySummaries(
      this.prisma,
      quotes.map((quote: any) => ({ opportunityId: quote.opportunityId, leadId: quote.leadId })),
      currentUser,
      companyId,
    );

    return quotes.map((quote) => ({
      ...toQuoteListItemResponse({
        ...(quote as QuoteReadRecord),
        opportunity: opportunitySummaries.get(opportunitySummaryKey((quote as any).opportunityId, (quote as any).leadId)) || null,
      }),
      lineItems: (quote as QuoteReadRecord).lineItems.map(toQuoteLineItemResponse),
    } satisfies QuoteLeadHistoryItemResponse));
  }

  // ========== Access Control ==========

  private ensureAccess(currentUser: any, companyId: string) {
    try {
      ensureCompanyAccess(currentUser, companyId);
    } catch (err: any) {
      throw new ForbiddenException(err.message?.replace('FORBIDDEN: ', '') || 'Access denied');
    }
  }

  private assertQuoteWriteAllowed(currentUser: any) {
    if (requireActiveCompany(currentUser).role === 'viewer') {
      throw new ForbiddenException('Viewer accounts cannot modify quotes');
    }
  }

  private quoteAccessWhere(id: string, currentUser: any) {
    const companyId = requireActiveCompany(currentUser).id;
    return {
      id,
      companyId,
      ...(!hasFullAccess(currentUser, companyId)
        ? { assignedUserId: currentUser.id }
        : {}),
    };
  }
}
