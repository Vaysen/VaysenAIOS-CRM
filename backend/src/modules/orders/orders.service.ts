import { Injectable, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ensureCompanyAccess } from '../../common/utils/data-isolation';

const ORDER_STAGES = [
  'won', 'sampling', 'production', 'qc', 'shipping', 'payment', 'completed', 'after_sales',
] as const;
type OrderStage = (typeof ORDER_STAGES)[number];

const STAGE_LABELS: Record<string, string> = {
  won: '已成交', sampling: '打样', production: '生产', qc: '质检',
  shipping: '出货', payment: '收款', completed: '完成', after_sales: '售后',
};

export interface CreateOrderDto {
  leadId?: string;
  quoteId?: string;
  assignedUserId?: string;
  stage?: string;
  currency?: string;
  totalAmount?: number;
  paidAmount?: number;
  deliveryDate?: string;
  shippingTerms?: string;
  trackingNo?: string;
  notes?: string;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(private prisma: PrismaService) {}

  // ========== Order No Generation ==========
  // Format: ORD-YYYYMMDD-XXXX  (XXXX = last 4 digits of timestamp)
  private generateOrderNo(): string {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const xxxx = String(Date.now()).slice(-4);
    return `ORD-${yyyy}${mm}${dd}-${xxxx}`;
  }

  /**
   * Generate a unique order number. The timestamp-based suffix makes collisions
   * extremely unlikely, but we still verify against the unique constraint and
   * retry a few times before falling back to a random suffix.
   */
  private async generateUniqueOrderNo(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const orderNo = this.generateOrderNo();
      const existing = await this.prisma.order.findUnique({
        where: { orderNo },
        select: { id: true },
      });
      if (!existing) return orderNo;
    }
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const rand = Math.floor(1000 + Math.random() * 9000);
    return `ORD-${yyyy}${mm}${dd}-${rand}`;
  }

  // ========== Find All ==========
  async findAll(
    currentUser: any,
    query?: { page?: number; limit?: number; stage?: string; leadId?: string },
  ) {
    const companyIds = currentUser?.companies?.map((c: any) => c.id) || [];
    if (companyIds.length === 0) return { data: [], meta: { total: 0 } };

    const page = query?.page || 1;
    const limit = query?.limit || 50;
    const skip = (page - 1) * limit;

    // Company isolation + optional stage / leadId filters pushed down to the DB
    const where: any = { companyId: { in: companyIds } };
    if (query?.stage) where.stage = query.stage;
    if (query?.leadId) where.leadId = query.leadId;

    const [data, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: {
          lead: { select: { id: true, companyName: true, contactName: true, country: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  // ========== Find One ==========
  async findOne(id: string, currentUser: any) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        lead: {
          select: { id: true, companyName: true, contactName: true, country: true, contactEmail: true },
        },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    this.ensureAccess(currentUser, order.companyId);
    return order;
  }

  // ========== Create ==========
  async create(dto: CreateOrderDto, currentUser: any) {
    let companyId = '';
    let leadId = dto.leadId || null;

    // Resolve company from the linked lead (with access check), otherwise fall
    // back to the user's first company membership.
    if (dto.leadId) {
      const lead = await this.prisma.lead.findUnique({ where: { id: dto.leadId } });
      if (!lead) throw new NotFoundException('Lead not found');
      this.ensureAccess(currentUser, lead.companyId);
      companyId = lead.companyId;
    } else {
      const userCompanies = currentUser?.companies || [];
      if (userCompanies.length === 0) throw new ForbiddenException('No company access');
      companyId = userCompanies[0].id;
    }

    // Optionally link a quote — validate company ownership and lead consistency.
    let quote: any = null;
    if (dto.quoteId) {
      quote = await this.prisma.quote.findUnique({ where: { id: dto.quoteId } });
      if (!quote) throw new NotFoundException('Quote not found');
      if (quote.companyId !== companyId) {
        throw new ForbiddenException('Quote does not belong to the same company');
      }
      if (leadId && quote.leadId && quote.leadId !== leadId) {
        throw new ForbiddenException('Quote belongs to a different lead');
      }
      // Inherit leadId from the quote when not explicitly provided.
      if (!leadId && quote.leadId) leadId = quote.leadId;
    }

    const stage: OrderStage =
      dto.stage && (ORDER_STAGES as readonly string[]).includes(dto.stage)
        ? (dto.stage as OrderStage)
        : 'won';

    const orderNo = await this.generateUniqueOrderNo();

    const currency = dto.currency || quote?.currency || 'USD';
    const totalAmount = dto.totalAmount ?? (quote ? Number(quote.totalAmount) : 0);
    const paidAmount = dto.paidAmount ?? 0;

    const initialHistory: any[] = [
      {
        stage,
        changedAt: new Date().toISOString(),
        changedBy: currentUser.id,
        note: quote ? `Converted from quote ${quote.referenceNo}` : 'Order created',
      },
    ];

    const order = await this.prisma.order.create({
      data: {
        companyId,
        orderNo,
        leadId,
        quoteId: dto.quoteId || null,
        assignedUserId: dto.assignedUserId || currentUser.id,
        stage,
        currency,
        totalAmount,
        paidAmount,
        deliveryDate: dto.deliveryDate ? new Date(dto.deliveryDate) : null,
        shippingTerms: dto.shippingTerms || quote?.tradeTerms || null,
        trackingNo: dto.trackingNo || null,
        notes: dto.notes || (quote ? `Converted from quote ${quote.referenceNo}` : null),
        stageHistory: initialHistory,
      },
      include: {
        lead: { select: { id: true, companyName: true, contactName: true, country: true } },
      },
    });

    // Log to the lead timeline
    if (leadId) {
      await this.prisma.leadActivity.create({
        data: {
          companyId,
          leadId,
          activityType: 'order_created',
          title: `订单已创建: ${orderNo}`,
          description: `阶段: ${STAGE_LABELS[stage] || stage}`,
          metadata: { orderId: order.id, orderNo, stage, quoteId: dto.quoteId || null },
          occurredAt: new Date(),
        },
      });
    }

    this.logger.log(`Order ${orderNo} created`);
    return order;
  }

  // ========== Update Stage ==========
  async updateStage(id: string, stage: string, currentUser: any) {
    if (!(ORDER_STAGES as readonly string[]).includes(stage)) {
      throw new ForbiddenException(`Invalid stage: ${stage}`);
    }

    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('Order not found');
    this.ensureAccess(currentUser, order.companyId);

    // Append a new entry to the stageHistory JSON array.
    const history: any[] = Array.isArray(order.stageHistory)
      ? [...(order.stageHistory as any[])]
      : [];
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
        lead: { select: { id: true, companyName: true, contactName: true, country: true } },
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
          metadata: { orderId: id, orderNo: order.orderNo, fromStage: order.stage, stage },
          occurredAt: new Date(),
        },
      });
    }

    this.logger.log(`Order ${order.orderNo} stage -> ${stage}`);
    return updated;
  }

  // ========== Customer Order History ==========
  async getCustomerOrderHistory(leadId: string, currentUser: any) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.ensureAccess(currentUser, lead.companyId);

    const orders = await this.prisma.order.findMany({
      where: { leadId },
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

    return {
      orders,
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
  private ensureAccess(currentUser: any, companyId: string) {
    try {
      ensureCompanyAccess(currentUser, companyId);
    } catch (err: any) {
      throw new ForbiddenException(err.message?.replace('FORBIDDEN: ', '') || 'Access denied');
    }
  }
}
