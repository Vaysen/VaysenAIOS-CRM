export type QuoteDocumentType = 'quote' | 'pi' | 'contract' | 'sample';

export type QuoteStatus =
  | 'draft'
  | 'sent'
  | 'accepted'
  | 'rejected'
  | 'expired'
  | 'cancelled';

/** Prisma Decimal values are serialized as strings by the API. */
export type QuoteMoney = string;

/** API dates are ISO-8601 strings after JSON serialization. */
export type QuoteDate = string;

export interface QuoteLeadSummary {
  id: string;
  companyName: string;
  contactName: string | null;
  country: string | null;
}

export interface QuoteLineItem {
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
  unitPrice: QuoteMoney;
  totalPrice: QuoteMoney;
  productSpecId: string | null;
  catalogItemId: string | null;
  notes: string | null;
}

export interface QuoteCreateLineItemInput {
  productCode?: string;
  productName: string;
  material?: string;
  size?: string;
  thickness?: string;
  color?: string;
  printing?: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  totalPrice: number;
  productSpecId?: string;
  catalogItemId?: string;
  notes?: string;
}

export function toQuoteCreateLineItem(item: QuoteLineItem): QuoteCreateLineItemInput {
  return {
    productCode: item.productCode || undefined,
    productName: item.productName,
    material: item.material || undefined,
    size: item.size || undefined,
    thickness: item.thickness || undefined,
    color: item.color || undefined,
    printing: item.printing || undefined,
    quantity: item.quantity,
    unit: item.unit,
    unitPrice: Number(item.unitPrice),
    totalPrice: Number(item.totalPrice),
    productSpecId: item.productSpecId || undefined,
    catalogItemId: item.catalogItemId || undefined,
    notes: item.notes || undefined,
  };
}

export interface QuoteListItem {
  id: string;
  referenceNo: string;
  type: QuoteDocumentType;
  status: QuoteStatus;
  leadId: string | null;
  opportunity: OpportunitySummary | null;
  currency: string;
  totalAmount: QuoteMoney;
  itemCount: number;
  createdAt: QuoteDate;
  updatedAt: QuoteDate;
  lead: QuoteLeadSummary | null;
}

export interface QuoteDetail extends QuoteListItem {
  conversationId: string | null;
  tradeTerms: string | null;
  paymentTerms: string | null;
  deliveryTime: string | null;
  sampleFee: QuoteMoney | null;
  moldFee: QuoteMoney | null;
  discount: QuoteMoney;
  taxRate: QuoteMoney | null;
  subtotal: QuoteMoney;
  taxAmount: QuoteMoney;
  validUntil: QuoteDate | null;
  lineItems: QuoteLineItem[];
}

export interface QuoteLeadHistoryItem extends QuoteListItem {
  lineItems: QuoteLineItem[];
}

export interface QuoteListResponse {
  data: QuoteListItem[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export function formatQuoteAmount(value: QuoteMoney | null | undefined, currency = 'USD'): string {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return `${currency} 0.00`;
  return `${currency} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatQuoteDate(value: QuoteDate): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleDateString('zh-CN');
}

function roundQuotePreviewMoney(value: number): number {
  return Math.round((value + Math.sign(value) * Number.EPSILON) * 100) / 100;
}

export function calculateQuotePreviewTotals(
  lineItemTotals: Array<number | string>,
  discountValue: number | string | null | undefined,
  taxRateValue: number | string | null | undefined,
  sampleFeeValue: number | string | null | undefined,
  moldFeeValue: number | string | null | undefined,
) {
  const subtotal = roundQuotePreviewMoney(lineItemTotals.reduce<number>(
    (sum, value) => sum + (Number(value) || 0),
    0,
  ));
  const discount = Number(discountValue) || 0;
  const taxRate = Number(taxRateValue) || 0;
  const sampleFee = Number(sampleFeeValue) || 0;
  const moldFee = Number(moldFeeValue) || 0;
  const taxableAmount = subtotal - discount;
  const taxAmount = roundQuotePreviewMoney((taxableAmount * taxRate) / 100);
  const totalAmount = roundQuotePreviewMoney(taxableAmount + taxAmount + sampleFee + moldFee);
  return { subtotal, discount, taxableAmount, taxAmount, sampleFee, moldFee, totalAmount };
}
import type { OpportunitySummary } from './opportunity';
