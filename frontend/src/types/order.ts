export type OrderStage =
  | 'won'
  | 'sampling'
  | 'production'
  | 'qc'
  | 'shipping'
  | 'payment'
  | 'completed'
  | 'after_sales';

export interface OrderLeadSummary {
  id: string;
  companyName: string | null;
  contactName: string | null;
  country: string | null;
}

export interface OrderQuoteSummary {
  id: string;
  referenceNo: string;
  type: string;
  status: string;
  currency: string;
  totalAmount: string;
  itemCount: number;
}

export interface OrderStageHistoryEntry {
  stage: string;
  fromStage?: string;
  changedAt: string;
  note?: string;
}

export interface OrderListItem {
  id: string;
  orderNo: string;
  leadId: string | null;
  opportunity: OpportunitySummary | null;
  quoteId: string | null;
  stage: OrderStage | string;
  currency: string;
  totalAmount: string;
  paidAmount: string;
  createdAt: string;
  updatedAt: string;
  lead: OrderLeadSummary | null;
  quote: OrderQuoteSummary | null;
}

export interface OrderDetail extends OrderListItem {
  deliveryDate: string | null;
  shippingTerms: string | null;
  trackingNo: string | null;
  stageHistory: OrderStageHistoryEntry[];
}

export interface OrderListResponse {
  data: OrderListItem[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface OrderHistoryResponse {
  orders: OrderListItem[];
  stats: {
    totalOrders: number;
    totalAmount: number;
    paidAmount: number;
    outstandingAmount: number;
    completedCount: number;
    activeCount: number;
    stageDistribution: Record<string, number>;
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

export function formatOrderAmount(value: string | number | null | undefined, currency = 'USD'): string {
  const amount = Number(value);
  return `${currency} ${Number.isFinite(amount) ? amount.toFixed(2) : '0.00'}`;
}
import type { OpportunitySummary } from './opportunity';
