import { ConflictException, Injectable, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ensureCompanyAccess, hasFullAccess, requireActiveCompany } from '../../common/utils/data-isolation';
import {
  generateOrderNumber,
  isOrderNumberUniqueConflict,
  ORDER_NUMBER_RETRY_LIMIT,
} from '../../common/utils/order-number';
import { safeLogEvent } from '../../common/security/safe-logging';
import { CreateOrderDto, ORDER_STAGES } from './dto/create-order.dto';
import {
  assertOpportunityLead,
  findAccessibleOpportunity,
  findAccessibleOpportunitySummaries,
  opportunitySummaryKey,
  type OpportunitySummaryResponse,
} from '../quotes/opportunity-association';

type OrderStage = (typeof ORDER_STAGES)[number];

const STAGE_LABELS: Record<string, string> = {
  won: '已成交',
  sampling: '打样',
  production: '生产',
  qc: '质检',
  shipping: '出货',
  payment: '收款',
  completed: '完成',
  after_sales: '售后',
};

export interface OrderLeadSummaryResponse {
  id: string;
  companyName: string | null;
  contactName: string | null;
  country: string | null;
}

export interface OrderQuoteSummaryResponse {
  id: string;
  referenceNo: string;
  type: string;
  status: string;
  currency: string;
  totalAmount: string;
  itemCount: number;
}

export interface OrderStageHistoryResponse {
  stage: string;
  fromStage?: string;
  changedAt: string;
  note?: string;
}

export interface OrderListItemResponse {
  id: string;
  orderNo: string;
  leadId: string | null;
  opportunity: OpportunitySummaryResponse | null;
  quoteId: string | null;
  stage: string;
  currency: string;
  totalAmount: string;
  paidAmount: string;
  createdAt: string;
  updatedAt: string;
  lead: OrderLeadSummaryResponse | null;
  quote: OrderQuoteSummaryResponse | null;
}

export interface OrderDetailResponse extends OrderListItemResponse {
  deliveryDate: string | null;
  shippingTerms: string | null;
  trackingNo: string | null;
  stageHistory: OrderStageHistoryResponse[];
}

export interface OrderHistoryResponse {
  orders: OrderListItemResponse[];
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

type OrderReadRecord = {
  id: string;
  companyId: string;
  orderNo: string;
  leadId: string | null;
  opportunityId: string | null;
  opportunity?: OpportunitySummaryResponse | null;
  quoteId: string | null;
  assignedUserId: string | null;
  stage: string;
  currency: string;
  totalAmount: unknown;
  paidAmount: unknown;
  deliveryDate: Date | null;
  shippingTerms: string | null;
  trackingNo: string | null;
  notes: string | null;
  stageHistory: unknown;
  createdAt: Date;
  updatedAt: Date;
  lead?: {
    id: string;
    companyName: string | null;
    contactName: string | null;
    country: string | null;
  } | null;
};

type OrderQuoteReadRecord = {
  id: string;
  referenceNo: string;
  type: string;
  status: string;
  currency: string;
  totalAmount: unknown;
  _count: { lineItems: number };
};

function orderMoney(value: unknown): string {
  return String(value ?? '0');
}

function orderDate(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function toStageHistoryResponse(value: unknown): OrderStageHistoryResponse[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const stage = typeof record.stage === 'string' ? record.stage : null;
    const changedAt = typeof record.changedAt === 'string' ? new Date(record.changedAt) : null;
    if (!stage || !changedAt || Number.isNaN(changedAt.getTime())) return [];
    const item: OrderStageHistoryResponse = { stage, changedAt: changedAt.toISOString() };
    if (typeof record.fromStage === 'string') item.fromStage = record.fromStage;
    if (typeof record.note === 'string') item.note = record.note;
    return [item];
  });
}

function toOrderListItemResponse(
  order: OrderReadRecord,
  quote: OrderQuoteSummaryResponse | null,
): OrderListItemResponse {
  return {
    id: order.id,
    orderNo: order.orderNo,
    leadId: order.leadId,
    opportunity: order.opportunity || null,
    quoteId: order.quoteId,
    stage: order.stage,
    currency: order.currency,
    totalAmount: orderMoney(order.totalAmount),
    paidAmount: orderMoney(order.paidAmount),
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    lead: order.lead ? {
      id: order.lead.id,
      companyName: order.lead.companyName,
      contactName: order.lead.contactName,
      country: order.lead.country,
    } : null,
    quote,
  };
}

function toOrderDetailResponse(
  order: OrderReadRecord,
  quote: OrderQuoteSummaryResponse | null,
): OrderDetailResponse {
  return {
    ...toOrderListItemResponse(order, quote),
    deliveryDate: orderDate(order.deliveryDate),
    shippingTerms: order.shippingTerms,
    trackingNo: order.trackingNo,
    stageHistory: toStageHistoryResponse(order.stageHistory),
  };
}

function toOrderQuoteSummaryResponse(quote: OrderQuoteReadRecord): OrderQuoteSummaryResponse {
  return {
    id: quote.id,
    referenceNo: quote.referenceNo,
    type: quote.type,
    status: quote.status,
    currency: quote.currency,
    totalAmount: orderMoney(quote.totalAmount),
    itemCount: quote._count.lineItems,
  };
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(private prisma: PrismaService) {}

  // ========== Find All ==========
  async findAll(currentUser: any, query?: { page?: number; limit?: number; stage?: string; leadId?: string }) {
    const companyId = requireActiveCompany(currentUser).id;

    const page = query?.page || 1;
    const limit = query?.limit || 50;
    const skip = (page - 1) * limit;

    // Company isolation + optional stage / leadId filters pushed down to the DB
    const where: any = { companyId };
    if (!hasFullAccess(currentUser, companyId)) {
      where.assignedUserId = currentUser.id;
    }
    if (query?.stage) where.stage = query.stage;
    if (query?.leadId) where.leadId = query.leadId;

    const [data, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: {
          lead: {
            select: {
              id: true,
              companyName: true,
              contactName: true,
              country: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    const quoteSummaries = await this.findQuoteSummaries(data, currentUser);
    const opportunitySummaries = await this.findOpportunitySummaries(data, currentUser);
    return {
      data: data.map((order) => toOrderListItemResponse({
        ...(order as OrderReadRecord),
        opportunity: opportunitySummaries.get(opportunitySummaryKey((order as any).opportunityId, (order as any).leadId)) || null,
      }, quoteSummaries.get(order.quoteId || '') || null)),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // ========== Find One ==========
  async findOne(id: string, currentUser: any) {
    const companyId = requireActiveCompany(currentUser).id;
    const order = await this.prisma.order.findFirst({
      where: {
        id,
        companyId,
        ...(!hasFullAccess(currentUser, companyId) ? { assignedUserId: currentUser.id } : {}),
      },
      include: {
        lead: {
          select: {
            id: true,
            companyName: true,
            contactName: true,
            country: true,
          },
        },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    this.ensureAccess(currentUser, order.companyId);
    const quoteSummaries = await this.findQuoteSummaries([order], currentUser);
    const opportunitySummaries = await this.findOpportunitySummaries([order], currentUser);
    return toOrderDetailResponse({
      ...(order as OrderReadRecord),
      opportunity: opportunitySummaries.get(opportunitySummaryKey((order as any).opportunityId, (order as any).leadId)) || null,
    }, quoteSummaries.get(order.quoteId || '') || null);
  }

  // ========== Create ==========
  async create(dto: CreateOrderDto, currentUser: any) {
    const activeCompany = requireActiveCompany(currentUser);
    const activeCompanyId = activeCompany.id;
    if (activeCompany.role === 'viewer') {
      throw new ForbiddenException('Viewer accounts cannot create orders');
    }
    if (dto.quoteId !== undefined) {
      throw new ConflictException('Quote-backed orders must use POST /quotes/:id/convert-to-order');
    }
    const totalAmount = dto.totalAmount ?? 0;
    const paidAmount = dto.paidAmount ?? 0;
    if (paidAmount > totalAmount) {
      throw new ConflictException('Paid amount cannot exceed the order total');
    }
    const assignedUserId = dto.assignedUserId || currentUser.id;
    if (!hasFullAccess(currentUser, activeCompanyId) && assignedUserId !== currentUser.id) {
      throw new ForbiddenException('Users may only assign orders to themselves');
    }
    const companyId = activeCompanyId;

    for (let attempt = 0; attempt < ORDER_NUMBER_RETRY_LIMIT; attempt += 1) {
      const orderNo = generateOrderNumber();
      try {
        const order = await this.prisma.$transaction(
        async (tx) => {
          const assignee = await tx.userCompanyRelation.findFirst({
            where: {
              userId: assignedUserId,
              companyId: activeCompanyId,
              isActive: true,
              user: { isActive: true, deletedAt: null },
            },
            select: { id: true },
          });
          if (!assignee) throw new NotFoundException('Assigned user not found');
          const opportunity = dto.opportunityId
            ? await findAccessibleOpportunity(tx, dto.opportunityId, currentUser, activeCompanyId)
            : null;
          if (opportunity) assertOpportunityLead(opportunity, dto.leadId);
          const leadId = dto.leadId || opportunity?.leadId || null;

          if (leadId) {
            const lead = await tx.lead.findFirst({
              where: {
                id: leadId,
                companyId: activeCompanyId,
                deletedAt: null,
                ...(!hasFullAccess(currentUser, activeCompanyId) ? { ownerUserId: currentUser.id } : {}),
              },
            });
            if (!lead) throw new NotFoundException('Lead not found');
          }

          const stage: OrderStage = dto.stage && (ORDER_STAGES as readonly string[]).includes(dto.stage) ? (dto.stage as OrderStage) : 'won';

          const currency = dto.currency || 'USD';

          const initialHistory: any[] = [
            {
              stage,
              changedAt: new Date().toISOString(),
              changedBy: currentUser.id,
              note: 'Order created',
            },
          ];

          const created = await tx.order.create({
            data: {
              companyId,
              orderNo,
              leadId,
              opportunityId: dto.opportunityId || null,
              quoteId: null,
              assignedUserId,
              stage,
              currency,
              totalAmount,
              paidAmount,
              deliveryDate: dto.deliveryDate ? new Date(dto.deliveryDate) : null,
              shippingTerms: dto.shippingTerms || null,
              trackingNo: dto.trackingNo || null,
              notes: dto.notes || null,
              stageHistory: initialHistory,
            },
            include: {
              lead: {
                select: {
                  id: true,
                  companyName: true,
                  contactName: true,
                  country: true,
                },
              },
            },
          });

          // Log to the lead timeline
          if (leadId) {
            await tx.leadActivity.create({
              data: {
                companyId,
                leadId,
                activityType: 'order_created',
                title: `订单已创建: ${orderNo}`,
                description: `阶段: ${STAGE_LABELS[stage] || stage}`,
                metadata: {
                  orderId: created.id,
                  orderNo,
                  stage,
                  quoteId: null,
                },
                occurredAt: new Date(),
              },
            });
          }

          return created;
        },
        { isolationLevel: 'Serializable' },
      );
        this.logger.log(safeLogEvent('order.created', {
          orderId: order.id,
          orderNo: order.orderNo,
          stage: order.stage,
        }));
        const opportunitySummaries = await this.findOpportunitySummaries([order], currentUser);
        return toOrderDetailResponse({
          ...(order as OrderReadRecord),
          opportunity: opportunitySummaries.get(opportunitySummaryKey((order as any).opportunityId, (order as any).leadId)) || null,
        }, null);
      } catch (error) {
        if (isOrderNumberUniqueConflict(error)) {
          if (attempt + 1 < ORDER_NUMBER_RETRY_LIMIT) continue;
          throw new ConflictException('Could not allocate a unique order number; retry');
        }
        if ((error as { code?: string })?.code === 'P2034') {
          throw new ConflictException('Order changed concurrently; reload and retry');
        }
        throw error;
      }
    }
    throw new ConflictException('Could not allocate a unique order number; retry');
  }

  // ========== Update Stage ==========
  async updateStage(id: string, stage: string, currentUser: any) {
    if (!(ORDER_STAGES as readonly string[]).includes(stage)) {
      throw new ForbiddenException('Invalid order stage');
    }

    const activeCompany = requireActiveCompany(currentUser);
    if (activeCompany.role === 'viewer') {
      throw new ForbiddenException('Viewer accounts cannot update orders');
    }
    const order = await this.prisma.order.findFirst({
      where: {
        id,
        companyId: activeCompany.id,
        ...(!hasFullAccess(currentUser, activeCompany.id) ? { assignedUserId: currentUser.id } : {}),
      },
    });
    if (!order) throw new NotFoundException('Order not found');

    // Append a new entry to the stageHistory JSON array.
    const history: any[] = Array.isArray(order.stageHistory) ? [...(order.stageHistory as any[])] : [];
    history.push({
      stage,
      fromStage: order.stage,
      changedAt: new Date().toISOString(),
      changedBy: currentUser.id,
    });

    const updated = await this.prisma.order.update({
      where: { id },
      data: {
        stage,
        stageHistory: history,
      },
      include: {
        lead: {
          select: {
            id: true,
            companyName: true,
            contactName: true,
            country: true,
          },
        },
      },
    });

    // Log to the lead timeline
    if (order.leadId) {
      await this.prisma.leadActivity.create({
        data: {
          companyId: order.companyId,
          leadId: order.leadId,
          activityType: 'order_stage_changed',
          title: `订单阶段变更: ${STAGE_LABELS[stage] || stage}`,
          description: `${STAGE_LABELS[order.stage] || order.stage} → ${STAGE_LABELS[stage] || stage}`,
          metadata: {
            orderId: id,
            orderNo: order.orderNo,
            fromStage: order.stage,
            stage,
          },
          occurredAt: new Date(),
        },
      });
    }

    this.logger.log(safeLogEvent('order.stage_updated', {
      orderId: order.id,
      orderNo: order.orderNo,
      stage,
    }));
    const quoteSummaries = await this.findQuoteSummaries([updated], currentUser);
    const opportunitySummaries = await this.findOpportunitySummaries([updated], currentUser);
    return toOrderDetailResponse({
      ...(updated as OrderReadRecord),
      opportunity: opportunitySummaries.get(opportunitySummaryKey((updated as any).opportunityId, (updated as any).leadId)) || null,
    }, quoteSummaries.get(updated.quoteId || '') || null);
  }

  // ========== Customer Order History ==========
  async getCustomerOrderHistory(leadId: string, currentUser: any) {
    const companyId = requireActiveCompany(currentUser).id;
    const lead = await this.prisma.lead.findFirst({
      where: {
        id: leadId,
        companyId,
        deletedAt: null,
        ...(!hasFullAccess(currentUser, companyId) ? { ownerUserId: currentUser.id } : {}),
      },
      select: { id: true },
    });
    if (!lead) throw new NotFoundException('Lead not found');

    const orders = await this.prisma.order.findMany({
      where: {
        companyId,
        leadId,
        ...(!hasFullAccess(currentUser, companyId) ? { assignedUserId: currentUser.id } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });

    // Aggregate stats
    let totalAmount = 0;
    let paidAmount = 0;
    const stageDistribution: Record<string, number> = {};
    for (const o of orders) {
      totalAmount += Number(o.totalAmount) || 0;
      paidAmount += Number(o.paidAmount) || 0;
      stageDistribution[o.stage] = (stageDistribution[o.stage] || 0) + 1;
    }

    const completedCount = stageDistribution['completed'] || 0;
    const activeCount = orders.length - completedCount;

    const quoteSummaries = await this.findQuoteSummaries(orders, currentUser);
    const opportunitySummaries = await this.findOpportunitySummaries(orders, currentUser);
    return {
      orders: orders.map((order) => toOrderListItemResponse({
        ...(order as OrderReadRecord),
        opportunity: opportunitySummaries.get(opportunitySummaryKey((order as any).opportunityId, (order as any).leadId)) || null,
      }, quoteSummaries.get(order.quoteId || '') || null)),
      stats: {
        totalOrders: orders.length,
        totalAmount,
        paidAmount,
        outstandingAmount: totalAmount - paidAmount,
        completedCount,
        activeCount,
        stageDistribution,
      },
    };
  }

  // ========== Access Control ==========

  private async findQuoteSummaries(
    orders: OrderReadRecord[],
    currentUser: any,
  ): Promise<Map<string, OrderQuoteSummaryResponse>> {
    const quoteIds = [...new Set(orders.map((order) => order.quoteId).filter((quoteId): quoteId is string => Boolean(quoteId)))];
    if (quoteIds.length === 0) return new Map();
    const companyId = requireActiveCompany(currentUser).id;
    const quotes = await this.prisma.quote.findMany({
      where: {
        id: { in: quoteIds },
        companyId,
        ...(!hasFullAccess(currentUser, companyId) ? { assignedUserId: currentUser.id } : {}),
      },
      select: {
        id: true,
        referenceNo: true,
        type: true,
        status: true,
        currency: true,
        totalAmount: true,
        _count: { select: { lineItems: true } },
      },
    }) as OrderQuoteReadRecord[];
    return new Map(quotes.map((quote) => [quote.id, toOrderQuoteSummaryResponse(quote)]));
  }

  private async findOpportunitySummaries(
    orders: OrderReadRecord[],
    currentUser: any,
  ): Promise<Map<string, OpportunitySummaryResponse>> {
    const companyId = requireActiveCompany(currentUser).id;
    return findAccessibleOpportunitySummaries(
      this.prisma,
      orders.map((order: any) => ({ opportunityId: order.opportunityId, leadId: order.leadId })),
      currentUser,
      companyId,
    );
  }

  private ensureAccess(currentUser: any, companyId: string) {
    try {
      ensureCompanyAccess(currentUser, companyId);
    } catch {
      throw new ForbiddenException('Access denied');
    }
  }
}
