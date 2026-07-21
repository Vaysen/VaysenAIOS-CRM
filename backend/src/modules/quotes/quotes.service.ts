import { Injectable, NotFoundException, ForbiddenException, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ensureCompanyAccess } from '../../common/utils/data-isolation';
import usdPriceCatalog from '../products/data/usd-price-catalog.json';
import { resolvePdfBrowserExecutable } from './pdf-browser';

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
  conversationId?: string;
  lineItems: CreateLineItemDto[];
  currency?: string;
  tradeTerms?: string;
  paymentTerms?: string;
  deliveryTime?: string;
  sampleFee?: number;
  discount?: number;
  taxRate?: number;
  notes?: string;
  validUntil?: string;
  aiExtracted?: boolean;
  aiArtifactId?: string;
}

@Injectable()
export class QuotesService {
  private readonly logger = new Logger(QuotesService.name);

  constructor(private prisma: PrismaService) {}

  // ========== CRUD ==========

  async findAll(currentUser: any, query?: { page?: number; limit?: number; type?: string; status?: string; leadId?: string }) {
    const companyIds = currentUser?.companies?.map((c: any) => c.id) || [];
    if (companyIds.length === 0) return { data: [], meta: { total: 0 } };

    const page = query?.page || 1;
    const limit = query?.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = { companyId: { in: companyIds } };
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

    return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async findOne(id: string, currentUser: any) {
    const quote = await this.prisma.quote.findUnique({
      where: { id },
      include: {
        lineItems: { orderBy: { sortOrder: 'asc' } },
        lead: { select: { id: true, companyName: true, contactName: true, country: true, contactEmail: true } },
      },
    });
    if (!quote) throw new NotFoundException('Quote not found');
    this.ensureAccess(currentUser, quote.companyId);
    return quote;
  }

  async createQuote(dto: CreateQuoteDto, currentUser: any) {
    let companyId = '';
    let leadId = dto.leadId || null;

    // Resolve company and lead
    if (dto.conversationId) {
      const conversation = await this.prisma.conversation.findUnique({
        where: { id: dto.conversationId },
        include: { lead: true },
      });
      if (!conversation) throw new NotFoundException('Conversation not found');
      this.ensureAccess(currentUser, conversation.companyId);
      companyId = conversation.companyId;
      if (!leadId) leadId = conversation.leadId || null;
    } else if (dto.leadId) {
      const lead = await this.prisma.lead.findUnique({ where: { id: dto.leadId } });
      if (!lead) throw new NotFoundException('Lead not found');
      this.ensureAccess(currentUser, lead.companyId);
      companyId = lead.companyId;
    } else {
      const userCompanies = currentUser?.companies || [];
      if (userCompanies.length === 0) throw new ForbiddenException('No company access');
      companyId = userCompanies[0].id;
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
        totalPrice: Number((item.quantity * unitPrice).toFixed(2)),
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
    const subtotal = lineItems.reduce((sum, item) => sum + Number(item.totalPrice), 0);
    const discount = Number(dto.discount) || 0;
    const taxRate = Number(dto.taxRate) || 0;
    const taxAmount = ((subtotal - discount) * taxRate) / 100;
    const totalAmount = subtotal - discount + taxAmount;

    // Create quote with line items in a transaction
    const quote = await this.prisma.$transaction(async (tx) => {
      const created = await tx.quote.create({
        data: {
          companyId,
          referenceNo: refNo,
          type: docType,
          status: 'draft',
          leadId,
          conversationId: dto.conversationId || null,
          assignedUserId: currentUser.id,
          currency: dto.currency || 'USD',
          tradeTerms: dto.tradeTerms || null,
          paymentTerms: dto.paymentTerms || null,
          deliveryTime: dto.deliveryTime || null,
          sampleFee: dto.sampleFee || null,
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

    this.logger.log(`Quote ${refNo} created with ${lineItems.length} line items`);
    return {
      id: quote.id,
      referenceNo: refNo,
      totalAmount,
      subtotal,
      taxAmount,
      itemCount: lineItems.length,
      status: 'draft',
    };
  }

  async updateQuote(id: string, dto: any, currentUser: any) {
    const quote = await this.findOne(id, currentUser);

    // Recalculate if line items changed
    let updateData: any = { ...dto };
    if (dto.lineItems) {
      // Delete old items and create new ones
      await this.prisma.quoteLineItem.deleteMany({ where: { quoteId: id } });
      const lineItems = dto.lineItems.map((item: any, i: number) => ({
        ...item,
        totalPrice: item.totalPrice || item.quantity * item.unitPrice,
        sortOrder: i,
      }));
      const subtotal = lineItems.reduce((sum: number, item: any) => sum + Number(item.totalPrice), 0);
      const discount = Number(dto.discount) || Number(quote.discount) || 0;
      const taxRate = Number(dto.taxRate) || Number(quote.taxRate) || 0;
      const taxAmount = ((subtotal - discount) * taxRate) / 100;
      const totalAmount = subtotal - discount + taxAmount;

      updateData = {
        ...dto,
        subtotal,
        taxAmount,
        totalAmount,
      };
      delete updateData.lineItems;

      // Create new line items
      await this.prisma.quoteLineItem.createMany({
        data: lineItems.map((item: any) => ({
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

    return this.prisma.quote.update({ where: { id }, data: updateData, include: { lineItems: true } });
  }

  async deleteQuote(id: string, currentUser: any) {
    const quote = await this.findOne(id, currentUser);
    return this.prisma.quote.delete({ where: { id: quote.id } });
  }

  // ========== Line Item CRUD ==========

  async addLineItem(quoteId: string, dto: CreateLineItemDto, currentUser: any) {
    const quote = await this.findOne(quoteId, currentUser);
    const totalPrice = dto.totalPrice || dto.quantity * dto.unitPrice;
    const sortOrder = await this.prisma.quoteLineItem.count({ where: { quoteId } });

    const item = await this.prisma.quoteLineItem.create({
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

    await this.recalculateQuote(quote.id);
    return item;
  }

  async updateLineItem(quoteId: string, itemId: string, dto: any, currentUser: any) {
    await this.findOne(quoteId, currentUser);
    const updateData = { ...dto };
    if (dto.quantity !== undefined || dto.unitPrice !== undefined) {
      const existing = await this.prisma.quoteLineItem.findFirst({ where: { id: itemId, quoteId } });
      if (!existing) throw new NotFoundException('Line item not found');
      const qty = dto.quantity ?? existing.quantity;
      const price = dto.unitPrice ?? existing.unitPrice;
      updateData.totalPrice = dto.totalPrice || qty * Number(price);
    }
    const item = await this.prisma.quoteLineItem.update({ where: { id: itemId }, data: updateData });
    await this.recalculateQuote(quoteId);
    return item;
  }

  async deleteLineItem(quoteId: string, itemId: string, currentUser: any) {
    await this.findOne(quoteId, currentUser);
    await this.prisma.quoteLineItem.delete({ where: { id: itemId } });
    await this.recalculateQuote(quoteId);
    return { success: true };
  }

  // ========== Calculate ==========

  async calculate(quoteId: string, currentUser: any) {
    const quote = await this.findOne(quoteId, currentUser);
    await this.recalculateQuote(quote.id);
    return this.findOne(quoteId, currentUser);
  }

  private async recalculateQuote(quoteId: string) {
    const items = await this.prisma.quoteLineItem.findMany({ where: { quoteId } });
    const subtotal = items.reduce((sum, item) => sum + Number(item.totalPrice), 0);
    const quote = await this.prisma.quote.findUnique({ where: { id: quoteId } });
    if (!quote) return;
    const discount = Number(quote.discount) || 0;
    const taxRate = Number(quote.taxRate) || 0;
    const taxAmount = ((subtotal - discount) * taxRate) / 100;
    const totalAmount = subtotal - discount + taxAmount;
    await this.prisma.quote.update({
      where: { id: quoteId },
      data: { subtotal, taxAmount, totalAmount },
    });
  }

  // ========== PI Generation ==========

  async generatePiHtml(quoteId: string, currentUser: any) {
    const quote = await this.findOne(quoteId, currentUser) as any;
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
    <h1>Example Trading Company</h1>
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
    <div class="grand">Total: ${currency} ${totalAmount}</div>
  </div>
  ${notes ? `<p style="margin-top:20px;"><strong>Notes:</strong> ${notes}</p>` : ''}
  ${isDraft ? '<p style="margin-top:20px; color:#b45309; font-weight:600;">This is a draft. Prices, terms, and delivery dates must be confirmed by a sales representative before becoming effective.</p>' : ''}
  <div class="footer">Example Trading Company · example.com · Generated by Trade System</div>
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
    const quote = await this.findOne(quoteId, currentUser);
    const updateData: any = { status };
    if (status === 'sent') updateData.sentAt = new Date();
    if (status === 'accepted') updateData.acceptedAt = new Date();
    return this.prisma.quote.update({ where: { id: quote.id }, data: updateData });
  }

  // ========== Convert to Order ==========

  async convertToOrder(quoteId: string, currentUser: any) {
    const quote = await this.findOne(quoteId, currentUser);

    const orderNo = `ORD-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(Date.now()).slice(-4)}`;

    const order = await this.prisma.order.create({
      data: {
        companyId: quote.companyId,
        orderNo,
        leadId: quote.leadId || null,
        quoteId: quote.id,
        assignedUserId: currentUser.id,
        stage: 'won',
        currency: quote.currency,
        totalAmount: quote.totalAmount,
        paidAmount: 0,
        shippingTerms: quote.tradeTerms,
        notes: `Converted from quote ${quote.referenceNo}`,
        stageHistory: JSON.stringify([
          { stage: 'won', changedAt: new Date().toISOString(), changedBy: currentUser.id, note: `Converted from ${quote.referenceNo}` },
        ]),
      },
    });

    // Update quote status
    await this.prisma.quote.update({
      where: { id: quote.id },
      data: { status: 'accepted', acceptedAt: new Date() },
    });

    // Log to timeline
    if (quote.leadId) {
      await this.prisma.leadActivity.create({
        data: {
          companyId: quote.companyId,
          leadId: quote.leadId,
          activityType: 'order_created',
          title: `订单已创建: ${orderNo}`,
          description: `From quote ${quote.referenceNo}, total ${quote.currency} ${Number(quote.totalAmount).toFixed(2)}`,
          metadata: { orderId: order.id, orderNo, quoteId: quote.id },
          occurredAt: new Date(),
        },
      });
    }

    this.logger.log(`Order ${orderNo} created from quote ${quote.referenceNo}`);
    return order;
  }

  // ========== List by Lead ==========

  async listByLead(leadId: string, currentUser: any) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new NotFoundException('Lead not found');
    this.ensureAccess(currentUser, lead.companyId);

    return this.prisma.quote.findMany({
      where: { leadId },
      include: { lineItems: true },
      orderBy: { createdAt: 'desc' },
    });
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
