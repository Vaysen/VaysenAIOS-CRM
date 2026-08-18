import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CustomerAssetsService } from '../customer-assets/customer-assets.service';
import { TimelineService } from '../timeline/timeline.service';
import { QuotesService } from '../quotes/quotes.service';
import { OrdersService } from '../orders/orders.service';
import { AssistantToolExecutionState } from '@prisma/client';
import { getAssistantTool, listAssistantTools, AssistantToolName } from './assistant-tool.registry';

type CurrentUser = { id: string; activeCompanyId?: string; activeCompany?: { id: string; role: string }; companies?: Array<{ id: string; role: string }> };

const DEFAULT_RUNNING_LEASE_MS = 30_000;

@Injectable()
export class AssistantToolService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customerAssets: CustomerAssetsService,
    private readonly timeline: TimelineService,
    private readonly quotes: QuotesService,
    private readonly orders: OrdersService,
  ) {}

  registry() { return listAssistantTools(); }

  providerConfig() {
    const endpoint = process.env.AI_PROVIDER_ENDPOINT?.trim() || '';
    const model = process.env.AI_PROVIDER_MODEL?.trim() || '';
    return {
      configured: Boolean(endpoint && model),
      endpoint: endpoint ? endpoint.replace(/(https?:\/\/)[^/]+/i, '$1[configured]') : null,
      model: model || null,
      keyConfigured: Boolean(process.env.AI_PROVIDER_API_KEY?.trim()),
      deterministicPlannerAvailable: true,
      externalSendAvailable: false,
    };
  }

  async providerConnectionTest() {
    const endpoint = process.env.AI_PROVIDER_ENDPOINT?.trim() || '';
    const model = process.env.AI_PROVIDER_MODEL?.trim() || '';
    const key = process.env.AI_PROVIDER_API_KEY?.trim() || '';
    if (!endpoint || !model || !key) return { ok: false, status: 'not_configured', configured: false, deterministicPlannerAvailable: true, message: 'Local provider endpoint, model, and key are required.' };
    let parsed: URL;
    try { parsed = new URL(endpoint); } catch { return { ok: false, status: 'invalid_endpoint', configured: false, deterministicPlannerAvailable: true, message: 'Provider endpoint is invalid.' }; }
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) return { ok: false, status: 'local_only', configured: false, deterministicPlannerAvailable: true, message: 'Provider test only permits a local HTTP stub.' };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'healthcheck' }], max_tokens: 1 }), signal: controller.signal });
      const payload = await response.json().catch(() => null) as { model?: string; choices?: unknown[] } | null;
      if (!response.ok || payload?.model !== model || !Array.isArray(payload?.choices)) return { ok: false, status: 'provider_error', configured: true, deterministicPlannerAvailable: true, message: 'Local provider response did not match the expected model response.' };
      return { ok: true, status: 'ok', configured: true, deterministicPlannerAvailable: true, model };
    } catch (error) { return { ok: false, status: error instanceof DOMException && error.name === 'AbortError' ? 'timeout' : 'unreachable', configured: true, deterministicPlannerAvailable: true, message: 'Local provider test failed.' }; }
    finally { clearTimeout(timeout); }
  }

  async plan(input: { companyId: string; toolName: string; parameters: unknown; requestId?: string; idempotencyKey?: string }, user: CurrentUser) {
    this.assertCompany(input.companyId, user);
    const definition = getAssistantTool(input.toolName);
    if (!definition) throw new BadRequestException('Unknown assistant tool');
    const parameters = this.validateParameters(definition.name, input.parameters);
    const inputDigest = this.digest({ companyId: input.companyId, operatorUserId: user.id, toolName: definition.name, parameters });
    const idempotencyKey = input.idempotencyKey?.trim() || input.requestId?.trim() || inputDigest;
    const existing = await this.prisma.assistantToolExecution.findUnique({ where: { idempotencyKey } });
    if (existing) {
      if (existing.companyId !== input.companyId || existing.operatorUserId !== user.id || existing.inputDigest !== inputDigest) {
        throw new ConflictException('Idempotency key is already used for another assistant action');
      }
      return this.publicExecution(existing);
    }
    const leadId = typeof parameters.leadId === 'string' ? parameters.leadId : null;
    if (leadId) await this.assertLead(input.companyId, leadId);
    let execution: any;
    try { execution = await this.prisma.assistantToolExecution.create({
      data: {
        requestKey: input.requestId?.trim() || `lan-${inputDigest}`,
        idempotencyKey,
        companyId: input.companyId,
        operatorUserId: user.id,
        toolName: definition.name,
        state: definition.confirmationRequired ? AssistantToolExecutionState.AWAITING_CONFIRMATION : AssistantToolExecutionState.PLANNING,
        inputDigest,
        parameterSummary: this.safeSummary(parameters),
        confirmationRequired: definition.confirmationRequired,
      },
    }); } catch (error: any) {
      if (error?.code !== 'P2002') throw error;
      const raced = await this.prisma.assistantToolExecution.findUnique({ where: { idempotencyKey } });
      if (!raced) throw error;
      if (raced.companyId !== input.companyId || raced.operatorUserId !== user.id || raced.inputDigest !== inputDigest) throw new ConflictException('Idempotency key is already used for another assistant action');
      return this.publicExecution(raced);
    }
    if (definition.confirmationRequired) return this.publicExecution(execution);
    return this.execute(execution.id, user);
  }

  async confirm(id: string, user: CurrentUser) {
    const execution = await this.findOwned(id, user);
    if (!execution.confirmationRequired) return this.publicExecution(execution);
    if (execution.state === AssistantToolExecutionState.SUCCEEDED || execution.state === AssistantToolExecutionState.CANCELLED) {
      return this.publicExecution(execution);
    }

    const now = new Date();
    if (execution.state === AssistantToolExecutionState.AWAITING_CONFIRMATION || execution.state === AssistantToolExecutionState.FAILED) {
      const claimed = await this.prisma.assistantToolExecution.updateMany({
        where: { id, companyId: execution.companyId, operatorUserId: user.id, state: execution.state },
        data: { state: AssistantToolExecutionState.RUNNING, confirmedAt: execution.confirmedAt || now, startedAt: now, errorCode: null },
      });
      if (claimed.count !== 1) return this.publicExecution(await this.findOwned(id, user));
      return this.execute(id, user);
    }

    if (execution.state !== AssistantToolExecutionState.RUNNING) return this.publicExecution(execution);
    if (!this.runningLeaseExpired(execution)) return this.publicExecution(execution);

    // Recovery is a compare-and-set on the old lease. A healthy RUNNING
    // execution is never dispatched a second time, and concurrent recovery
    // requests can claim at most one new lease.
    const recovered = await this.prisma.assistantToolExecution.updateMany({
      where: { id, companyId: execution.companyId, operatorUserId: user.id, state: AssistantToolExecutionState.RUNNING, startedAt: execution.startedAt || null },
      data: { startedAt: now },
    });
    if (recovered.count !== 1) return this.publicExecution(await this.findOwned(id, user));
    return this.execute(id, user);
  }

  async cancel(id: string, user: CurrentUser) {
    const execution = await this.findOwned(id, user);
    const terminalStates: AssistantToolExecutionState[] = [AssistantToolExecutionState.SUCCEEDED, AssistantToolExecutionState.FAILED, AssistantToolExecutionState.CANCELLED];
    if (terminalStates.includes(execution.state)) return this.publicExecution(execution);
    const cancelled = await this.prisma.assistantToolExecution.updateMany({ where: { id, operatorUserId: user.id, state: { in: [AssistantToolExecutionState.AWAITING_CONFIRMATION, AssistantToolExecutionState.PLANNING] } }, data: { state: AssistantToolExecutionState.CANCELLED, completedAt: new Date(), errorCode: 'CANCELLED_BY_USER' } });
    return this.publicExecution(cancelled.count ? await this.findOwned(id, user) : execution);
  }

  async history(companyId: string, user: CurrentUser) {
    this.assertCompany(companyId, user);
    const rows = await this.prisma.assistantToolExecution.findMany({ where: { companyId, operatorUserId: user.id }, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map((row) => this.publicExecution(row));
  }

  private async execute(id: string, user: CurrentUser) {
    const execution = await this.findOwned(id, user);
    if (execution.state === AssistantToolExecutionState.SUCCEEDED || execution.state === AssistantToolExecutionState.CANCELLED) return this.publicExecution(execution);
    if (execution.state === AssistantToolExecutionState.PLANNING) {
      await this.prisma.assistantToolExecution.updateMany({ where: { id, state: AssistantToolExecutionState.PLANNING }, data: { state: AssistantToolExecutionState.RUNNING, startedAt: new Date() } });
    }
    const parameters = execution.parameterSummary as Record<string, any>;
    let result: unknown;
    try {
      result = await this.dispatch(execution.toolName as AssistantToolName, execution.companyId, parameters, user, id);
    } catch (error) {
      const errorCode = error instanceof BadRequestException || error instanceof ForbiddenException || error instanceof NotFoundException ? `TOOL_REJECTED_${error.getStatus()}` : 'TOOL_EXECUTION_FAILED';
      const updated = await this.prisma.assistantToolExecution.update({ where: { id }, data: { state: AssistantToolExecutionState.FAILED, errorCode, completedAt: new Date() } });
      return this.publicExecution(updated);
    }
    // Keep persistence failures visible. A completed side effect remains safely
    // retryable because each mutating tool uses the execution id as its ledger key.
    const updated = await this.prisma.assistantToolExecution.update({ where: { id }, data: { state: AssistantToolExecutionState.SUCCEEDED, result: result as any, resultRef: this.resultRef(execution.toolName, result) as any, completedAt: new Date(), startedAt: execution.startedAt || new Date() } });
    return this.publicExecution(updated);
  }

  private async dispatch(tool: AssistantToolName, companyId: string, p: Record<string, any>, user: CurrentUser, executionId = 'untracked') {
    const membership = this.membership(companyId, user);
    const actor = { ...user, activeCompanyId: companyId, activeCompany: membership };
    if (tool === 'customer_asset_read') return this.customerAssets.getCustomerAsset(companyId, p.leadId, actor);
    if (tool === 'customer_timeline_read') return this.timeline.findTimeline(p.leadId, { limit: p.limit || 50 }, actor);
    if (tool === 'order_status_read') return this.orders.findAll(actor, { page: 1, limit: 50, leadId: p.leadId, stage: p.stage });
    if (tool === 'quote_status_read') return this.quotes.findAll(actor, { page: 1, limit: 50, leadId: p.leadId, status: p.status });
    if (tool === 'message_draft_prepare') {
      const lead = await this.assertLead(companyId, p.leadId);
      this.assertWriteAllowed(membership, lead.ownerUserId, user.id);
      const channel = p.channel === 'email' ? 'business_email' : 'whatsapp';
      const ingestionKey = `assistant:${executionId}`;
      const existing = await this.prisma.communicationMessage.findUnique({ where: { ingestionKey } });
      if (existing) return { status: 'DRAFT_ONLY', channel: p.channel, subject: existing.subject || null, body: existing.content, leadId: p.leadId, draftId: existing.id, conversationId: existing.conversationId, sent: false };
      const conversation = await this.prisma.conversation.upsert({ where: { companyId_channel_threadKey: { companyId, channel, threadKey: `assistant:${p.leadId}` } }, update: { subject: p.subject || undefined, lastMessagePreview: p.body.slice(0, 200), updatedAt: new Date() }, create: { companyId, leadId: p.leadId, channel, threadKey: `assistant:${p.leadId}`, subject: p.subject || null, lastMessagePreview: p.body.slice(0, 200) } });
      const message = await this.prisma.communicationMessage.upsert({ where: { ingestionKey }, update: { content: p.body, subject: p.subject || null, deliveryStatus: 'draft' }, create: { conversationId: conversation.id, direction: 'outbound', content: p.body, subject: p.subject || null, deliveryStatus: 'draft', ingestionKey } });
      return { status: 'DRAFT_ONLY', channel: p.channel, subject: p.subject || null, body: p.body, leadId: p.leadId, draftId: message.id, conversationId: conversation.id, sent: false };
    }
    if (tool === 'task_follow_up_create') {
      const lead = await this.assertLead(companyId, p.leadId);
      this.assertWriteAllowed(membership, lead.ownerUserId, user.id);
      const marker = `assistant_execution:${executionId}`;
      const existing = await this.prisma.followUpReminder.findFirst({ where: { companyId, leadId: lead.id, reason: marker } });
      const row = existing || await this.prisma.followUpReminder.create({ data: { companyId, leadId: lead.id, userId: user.id, reminderType: 'assistant_follow_up', title: p.title, dueAt: new Date(p.dueAt), priority: p.priority || 'Medium', reason: marker } });
      return { status: 'SUCCEEDED', id: row.id, leadId: row.leadId, title: row.title, dueAt: row.dueAt.toISOString() };
    }
    if (tool === 'quote_draft_create') {
      const lead = await this.assertLead(companyId, p.leadId);
      this.assertWriteAllowed(membership, lead.ownerUserId, user.id);
      const referenceNo = `AI-${executionId}`;
      const existing = await this.prisma.quote.findUnique({ where: { referenceNo } });
      const quote = existing || await this.quotes.createQuote({ leadId: p.leadId, referenceNo, type: 'quote', currency: p.currency || 'USD', notes: p.notes, aiExtracted: true, lineItems: p.lineItems }, actor);
      return { status: 'SUCCEEDED', id: quote.id, referenceNo: quote.referenceNo, quoteStatus: quote.status, totalAmount: String(quote.totalAmount), sent: false };
    }
    throw new BadRequestException('Tool is not executable');
  }

  private validateParameters(tool: AssistantToolName, raw: unknown): Record<string, any> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('Tool parameters must be an object');
    const p = raw as Record<string, any>;
    const allowed: Record<AssistantToolName, string[]> = {
      customer_asset_read: ['leadId'], customer_timeline_read: ['leadId', 'limit'], task_follow_up_create: ['leadId', 'title', 'dueAt', 'priority', 'reason'], quote_draft_create: ['leadId', 'lineItems', 'currency', 'notes'], message_draft_prepare: ['leadId', 'channel', 'subject', 'body'], order_status_read: ['leadId', 'stage'], quote_status_read: ['leadId', 'status'],
    };
    if (Object.keys(p).some((key) => !allowed[tool].includes(key))) throw new BadRequestException('Tool parameters contain an unsupported field');
    if (typeof p.leadId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(p.leadId)) throw new BadRequestException('A valid leadId is required');
    if (tool === 'task_follow_up_create' && (typeof p.title !== 'string' || !p.title.trim() || !Number.isFinite(Date.parse(p.dueAt)))) throw new BadRequestException('Task title and dueAt are required');
    if (tool === 'message_draft_prepare' && (!['whatsapp', 'email'].includes(p.channel) || typeof p.body !== 'string' || !p.body.trim())) throw new BadRequestException('Draft channel and body are required');
    if (tool === 'quote_draft_create' && (!Array.isArray(p.lineItems) || p.lineItems.length < 1 || p.lineItems.length > 20)) throw new BadRequestException('Quote lineItems are required');
    this.validateSchema(getAssistantTool(tool)?.schema, p, '$');
    if (p.limit !== undefined && (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > 100)) throw new BadRequestException('Invalid limit');
    return p;
  }

  private async assertLead(companyId: string, leadId: string) { const lead = await this.prisma.lead.findFirst({ where: { id: leadId, companyId, deletedAt: null }, select: { id: true, ownerUserId: true } }); if (!lead) throw new NotFoundException('Customer is outside the active company scope'); return lead; }
  private async findOwned(id: string, user: CurrentUser) { const row = await this.prisma.assistantToolExecution.findFirst({ where: { id, operatorUserId: user.id } }); if (!row) throw new NotFoundException('Assistant execution not found'); this.assertCompany(row.companyId, user); return row; }
  private membership(companyId: string, user: CurrentUser) { if (user.activeCompanyId !== companyId || user.activeCompany?.id !== companyId) throw new ForbiddenException('Company must be the active company'); const membership = (user.companies || []).find((company) => company.id === companyId); if (!membership || !membership.role) throw new ForbiddenException('Active company membership or role is required'); return membership; }
  private assertCompany(companyId: string, user: CurrentUser) { this.membership(companyId, user); }
  private assertWriteAllowed(membership: { role: string }, ownerUserId: string | null | undefined, userId: string) {
    const role = membership.role;
    if (!['super_admin', 'company_admin', 'sales_manager', 'sales_user'].includes(role)) throw new ForbiddenException('This company role cannot execute write tools');
    if (role === 'sales_user' && ownerUserId !== userId) throw new ForbiddenException('Sales users may only write to owned customers');
  }
  private runningLeaseExpired(execution: { startedAt?: Date | null }) {
    const configured = Number(process.env.AI_TOOL_RUNNING_LEASE_MS || DEFAULT_RUNNING_LEASE_MS);
    const leaseMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_RUNNING_LEASE_MS;
    return !execution.startedAt || Date.now() - new Date(execution.startedAt).getTime() >= leaseMs;
  }
  private validateSchema(schema: any, value: any, path: string) { if (!schema) return; if (schema.type === 'object') { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException(`${path} must be an object`); for (const key of schema.required || []) if (value[key] === undefined) throw new BadRequestException(`${path}.${key} is required`); for (const [key, child] of Object.entries(schema.properties || {})) if (value[key] !== undefined) this.validateSchema(child, value[key], `${path}.${key}`); } else if (schema.type === 'array') { if (!Array.isArray(value)) throw new BadRequestException(`${path} must be an array`); if (schema.minItems !== undefined && value.length < schema.minItems) throw new BadRequestException(`${path} must contain at least ${schema.minItems} items`); if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new BadRequestException(`${path} must contain at most ${schema.maxItems} items`); value.forEach((item: any, index: number) => this.validateSchema(schema.items, item, `${path}[${index}]`)); } else if (schema.type === 'string') { if (typeof value !== 'string') throw new BadRequestException(`${path} must be a string`); if (schema.minLength !== undefined && value.length < schema.minLength) throw new BadRequestException(`${path} is too short`); if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new BadRequestException(`${path} is too long`); if (schema.enum && !schema.enum.includes(value)) throw new BadRequestException(`${path} has an invalid value`); } else if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value) || (schema.minimum !== undefined && value < schema.minimum))) throw new BadRequestException(`${path} has an invalid number`); }
  private safeSummary(value: Record<string, any>) { return JSON.parse(JSON.stringify(value, (_key, candidate) => typeof candidate === 'string' && candidate.length > 240 ? `${candidate.slice(0, 240)}…` : candidate)); }
  private digest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
  private resultRef(tool: string, result: any) { const ref = result && typeof result === 'object' ? { tool } : { tool }; if (result?.id) (ref as any).id = result.id; if (result?.referenceNo) (ref as any).referenceNo = result.referenceNo; return ref; }
  private publicExecution(row: any) { return { id: row.id, requestKey: row.requestKey, toolName: row.toolName, state: row.state, confirmationRequired: row.confirmationRequired, parameterSummary: row.parameterSummary, result: row.result, resultRef: row.resultRef, errorCode: row.errorCode, createdAt: row.createdAt, startedAt: row.startedAt, completedAt: row.completedAt }; }
}
