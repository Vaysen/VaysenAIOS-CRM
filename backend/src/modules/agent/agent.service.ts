import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AgentAuthorizationStatus,
  AssistantActionState,
  AssistantPolicyDecision,
  AgentRunKind,
  AgentRunStatus,
  AgentTaskStatus,
  OpenClawReceiptStatus,
  Prisma,
} from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { AiProviderService } from '../../common/ai/ai-provider.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateAgentRunDto, SafeAgentRunKind } from './dto/create-agent-run.dto';
import { digestAgentInput, equalAgentDigest, redactForExternalAi } from './agent-security';
import { AssistantChatDto } from './dto/assistant-chat.dto';
import { DeepResearchRunService } from '../deep-research/deep-research-run.service';
import { assessResearchSubject } from '../deep-research/research-subject-policy';
import { OpenClawGatewayClient } from '../openclaw/openclaw-gateway.client';
import { OpenClawCrmSessionService } from '../openclaw/openclaw-crm-session.service';
import { AssistantPermissionService } from './assistant-permission.service';
import usdPriceCatalog from '../products/data/usd-price-catalog.json';
import { isTrustedDirectWhatsappConversation } from '../whatsapp/whatsapp-conversation-trust';
import { buildAssistantConversationContext } from './assistant-conversation-context';

export type AuthenticatedUser = {
  id: string;
  email?: string;
  companies?: Array<{ id: string; role: string }>;
};

type AssistantQuoteDeliveryProposal = {
  kind: 'PREPARE_QUOTE_DELIVERY';
  status: 'REQUIRES_CONFIRMATION' | 'BLOCKED';
  expiresAt: string;
  reason?: string;
  quote?: {
    id: string;
    referenceNo: string;
    status: string;
    totalAmount: string;
    currency: string;
    updatedAt: string;
  };
  target?: {
    name: string;
    phone: string;
    conversationId?: string;
    leadId?: string;
  };
  safety: {
    automaticSend: false;
    requiresHumanConfirmation: true;
    requiresManualWhatsappSend: true;
  };
};

type AssistantWhatsappTextProposal = {
  kind: 'SEND_WHATSAPP_TEXT';
  status: 'REQUIRES_CONFIRMATION' | 'BLOCKED';
  expiresAt: string;
  reason?: string;
  text?: string;
  target?: {
    name: string;
    phone: string;
    conversationId?: string;
    leadId?: string;
  };
  safety: {
    automaticSend: false;
    requiresHumanConfirmation: true;
  };
};

type AssistantActionProposal = AssistantQuoteDeliveryProposal | AssistantWhatsappTextProposal;

type ConfirmableAssistantQuoteDeliveryProposal = AssistantQuoteDeliveryProposal & {
  status: 'REQUIRES_CONFIRMATION';
  quote: NonNullable<AssistantQuoteDeliveryProposal['quote']>;
  target: NonNullable<AssistantQuoteDeliveryProposal['target']>;
};

type AssistantResearchAction = {
  kind: 'BACKGROUND_RESEARCH';
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'BLOCKED';
  reason?: string;
  agentRunId?: string;
  conversationId?: string;
  leadId?: string;
};

type AssistantActionSource = 'CRM' | 'WECHAT_OWNER';

type AssistantOpenClawToolReceipt = {
  requestId: string;
  agentRunId: string;
  toolName:
    | 'crm.work_brief'
    | 'crm.customer_search'
    | 'crm.customer_get'
    | 'crm.customer_add_note'
    | 'crm.customer_update'
    | 'crm.customer_set_stage'
    | 'crm.task_create'
    | 'crm.order_list'
    | 'crm.order_create_draft'
    | 'crm.order_update_stage'
    | 'crm.quote_list'
    | 'crm.quote_create_draft'
    | 'crm.product_search'
    | 'crm.start_background_research'
    | 'crm.prepare_quote_delivery'
    | 'crm.whatsapp_messages_read'
    | 'crm.whatsapp_send_text'
    | 'crm.whatsapp_send_quote'
    | 'crm.email_messages_read'
    | 'crm.email_send'
    | 'crm.email_reply';
  status: 'PROCESSING' | 'COMPLETED' | 'FAILED';
  businessStatus: 'PROCESSING' | 'SUCCEEDED' | 'BLOCKED' | 'FAILED';
  errorCode: string | null;
  completedAt: string | null;
};

const OPENCLAW_TOOL_LABELS: Record<string, AssistantOpenClawToolReceipt['toolName']> = {
  'work-brief': 'crm.work_brief',
  'customer-search': 'crm.customer_search',
  'customer-get': 'crm.customer_get',
  'customer-add-note': 'crm.customer_add_note',
  'customer-update': 'crm.customer_update',
  'customer-set-stage': 'crm.customer_set_stage',
  'task-create': 'crm.task_create',
  'order-list': 'crm.order_list',
  'order-create-draft': 'crm.order_create_draft',
  'order-update-stage': 'crm.order_update_stage',
  'quote-list': 'crm.quote_list',
  'quote-create-draft': 'crm.quote_create_draft',
  'product-search': 'crm.product_search',
  'start-background-research': 'crm.start_background_research',
  'prepare-quote-delivery': 'crm.prepare_quote_delivery',
  'whatsapp-messages-read': 'crm.whatsapp_messages_read',
  'whatsapp-send-text': 'crm.whatsapp_send_text',
  'whatsapp-send-quote': 'crm.whatsapp_send_quote',
  'email-messages-read': 'crm.email_messages_read',
  'email-send': 'crm.email_send',
  'email-reply': 'crm.email_reply',
};

const ASSISTANT_ACTION_CLAIM_TTL_MS = 2 * 60_000;

@Injectable()
export class AgentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiProviderService,
    private readonly researchRuns: DeepResearchRunService,
    @Optional() private readonly openClaw?: OpenClawGatewayClient,
    @Optional() private readonly openClawSessions?: OpenClawCrmSessionService,
    @Optional() private readonly assistantPermissions?: AssistantPermissionService,
  ) {}

  private classifyActionWording(
    message: string,
  ): 'EXECUTE' | 'QUESTION' | 'NEGATED' | 'PAST_STATEMENT' {
    const value = message.trim();
    const negation = /(?:不要|别(?:再)?|不用|无需|不需要|暂不|先不|禁止|莫|don['’]?t|do\s+not|never|not\s+now)/i.exec(value);
    if (negation) {
      // A trailing constraint must not cancel an earlier affirmative action.
      // Example: “发送这条 WhatsApp，但不要改写正文” still authorizes the
      // send; only the rewrite is negated.  Treat the whole turn as negated
      // only when no supported execution verb appears before the first
      // negation marker.
      const beforeNegation = value.slice(0, negation.index);
      const affirmativeAction = /(?:发送|发给|发一条|回复|告诉|通知|查询|查找|搜索|读取|查看|列出|创建|新建|新增|生成|制作|开始|启动|执行|进行|调查|研究|修改|更新|补充|完善|安排|设置|send|deliver|reply|tell|message|search|read|list|create|start|run|research|update|schedule)/i;
      if (!affirmativeAction.test(beforeNegation)) return 'NEGATED';
    }

    // “发过去/寄过去”中的“过去”不是过去时；只有明确时间语义才归类为
    // 历史陈述，避免真实动作命令绕过确定性工具路由。
    const pastStatement = /(?:之前|刚才|上次|曾经|早先|先前|过去(?:曾经|已经|的|一段时间)|做过|完成了|(?:已经|已)\s*(?:做|开始|启动|进行|执行|发送|创建|修改|更新|完成|调查|背调)|\balready\b|\bpreviously\b|\bearlier\b|\blast\s+time\b|\bstarted\b|\bperformed\b|\bconducted\b|\bcompleted\b)/i.test(value);
    if (pastStatement) return 'PAST_STATEMENT';

    const questioned = /(?:是不是|要不要|该不该|应不应该|是否应该|能不能|可不可以|是否|能否|会不会|可否|怎么|如何|为什么|你能|可以(?:帮我)?吗|吗\s*[?？]?\s*$|[?？]\s*$|\b(?:can|could|would|should|may)\s+(?:you|we|i)\b|\bis\s+it\s+possible\b|\bdo\s+(?:we|i)\b|\bhow\s+(?:do|can|to)\b|\bwhat\s+if\b)/i.test(value);
    if (questioned) return 'QUESTION';
    return 'EXECUTE';
  }

  private isQuoteDeliveryIntent(message: string): boolean {
    const value = message.trim();
    if (this.classifyActionWording(value) !== 'EXECUTE') return false;
    const deliveryVerb = '(?:发送|发给|发过去|发过去给|寄给|寄过去|传给|传过去|交给|递给|转发|推送|send|share|deliver)';
    return new RegExp(
      `${deliveryVerb}.{0,24}(?:报价单|报价|quotation|quote)|(?:报价单|报价|quotation|quote).{0,24}${deliveryVerb}`,
      'i',
    ).test(value);
  }

  private isWhatsappTextSendIntent(
    message: string,
    hasTrustedWhatsappContext = false,
  ): boolean {
    const value = message.trim();
    if (this.classifyActionWording(value) !== 'EXECUTE' || this.isQuoteDeliveryIntent(value)) {
      return false;
    }
    const channel = /(?:WhatsApp|WA|瓦次普|当前客户|当前联系人)/i;
    const send = /(?:发送|发给|发一条|回复|告诉|通知|send|reply|tell|message)/i;
    return (hasTrustedWhatsappContext || channel.test(value)) && send.test(value);
  }

  private isBackgroundResearchIntent(message: string): boolean {
    const value = message.trim();
    if (this.classifyActionWording(value) !== 'EXECUTE') return false;
    // “请/帮我”只表达礼貌，不是执行授权；必须同时出现明确执行动词。
    // 这样“帮我起草背调方案/请说明背调流程”只会进入普通草稿/问答，
    // 不会静默触发联网检索、AI 费用和客户数据处理。
    const action = '(?:开始|启动|执行|进行|查(?:一)?下|调查|做|完成|run|start|perform|conduct|research|investigate)';
    const research = '(?:客户背调|背调|背景调查|客户调查|企业调查|公司调查|background\\s+check|due\\s+diligence|customer\\s+research|company\\s+research)';
    const explicitAction = new RegExp(`${action}.{0,40}${research}|${research}.{0,40}${action}`, 'i');
    const directChineseAction = new RegExp(`^(?:给|为).{0,40}(?:做|进行|查).{0,12}${research}`, 'i');
    return explicitAction.test(value) || directChineseAction.test(value);
  }

  private isUnsupportedOperationalIntent(message: string): boolean {
    const value = message.trim();
    if (this.classifyActionWording(value) !== 'EXECUTE') return false;
    // These operations have real, allowlisted OpenClaw tools and must reach
    // the tool router.  The previous broad guard intercepted every mutation
    // verb before OpenClaw could enforce the configured SUPERVISOR policy.
    const supportedBusinessTool = /(?:客户.{0,24}(?:查询|查找|详情|备注|阶段)|(?:查询|查找|读取).{0,24}客户|(?:创建|新增|安排).{0,24}(?:待办|任务)|(?:订单).{0,24}(?:查询|查看|列表|草稿|阶段)|(?:报价).{0,24}(?:查询|查看|列表|草稿)|(?:产品|价格).{0,24}(?:查询|查找|检索)|(?:开始|启动|进行).{0,24}(?:背调|背景调查)|customer.{0,24}(?:search|detail|note|stage)|(?:create|add).{0,24}task|order.{0,24}(?:list|draft|stage)|quote.{0,24}(?:list|draft)|product.{0,24}(?:search|price)|(?:start|run).{0,24}(?:research|background\s+check))/i;
    const prohibitedOrDestructive = /(?:删除客户|合并客户|取消订单|批量发送|群发|所有客户.{0,16}发送|全体客户.{0,16}发送|部署|安装|Shell|SQL|(?:读取|查看|显示|导出|泄露|告诉我|给我).{0,16}(?:密钥|密码|secret|token)|(?:密钥|密码|secret|token).{0,16}(?:读取|查看|显示|导出|泄露|告诉我|给我)|delete\s+customer|merge\s+customer|cancel\s+order|bulk\s+send|send.{0,16}(?:all|every)\s+customers?|(?:read|show|print|export|reveal|get|give\s+me).{0,16}(?:secret|token|password)|(?:secret|token|password).{0,16}(?:read|show|print|export|reveal|get|give\s+me)|deploy|install)/i;
    const supportedSingleCustomerMessaging = /(?:(?:发送|发出|寄出|回复|读取|查看|查询|send|deliver|reply|read|list).{0,40}(?:WhatsApp|WA|邮件|邮箱|收件箱|email|inbox)|(?:WhatsApp|WA|邮件|邮箱|收件箱|email|inbox).{0,40}(?:发送|发出|寄出|回复|读取|查看|查询|send|deliver|reply|read|list))/i;
    const supportedQuoteDelivery = /(?:(?:发送|发出|寄出|交付|send|deliver).{0,40}(?:报价|报价单|quotation|quote|\bPI\b)|(?:报价|报价单|quotation|quote|\bPI\b).{0,40}(?:发送|发出|寄出|交付|send|deliver))/i;
    const supportedTaskReminder = /(?:创建|新增|安排|添加|create|add|schedule).{0,32}(?:待办|任务|提醒|task|reminder)/i;
    const supportedCustomerStage = /(?:客户|线索|customer|lead).{0,32}(?:设为|改为|阶段|状态|成交|set|stage|status)/i;
    const supportedOrderDraft = /(?:创建|新建|新增|下|create|add).{0,24}(?:订单|order)|(?:订单|order).{0,24}(?:草稿|创建|新建|draft|create)/i;
    if (
      (
        supportedBusinessTool.test(value)
        || supportedTaskReminder.test(value)
        || supportedCustomerStage.test(value)
        || supportedOrderDraft.test(value)
        || supportedSingleCustomerMessaging.test(value)
        || supportedQuoteDelivery.test(value)
      )
      && !prohibitedOrDestructive.test(value)
    ) return false;
    if (prohibitedOrDestructive.test(value)) {
      return true;
    }
    // Fail closed on operational wording. These variants deliberately include
    // colloquial delivery commands such as “发过去/寄过去/交给”; otherwise a
    // model can turn an unimplemented action into a convincing fake receipt.
    const alwaysOperational = /(?:发送|发出|发(?:一下|过去|给)|寄(?:出|过去|给)|传(?:过去|给)|交(?:过去|给)|递(?:过去|给)|推送|转发|回复|联系|拨打|设为|下.{0,4}订单|下单|审批|同步|分配|导入|归档|取消任务|停止任务|恢复任务|重试任务|部署|安装|扫码登录|send|deliver|reply|contact|call|approve|sync|assign|import|archive|cancel|resume|retry|deploy|install)/i;
    // Do not block a broad instruction such as “整理客户” or “生成报价单”
    // before OpenClaw can either select an allowlisted tool or ask for missing
    // business fields. Any model that falsely claims a side effect is still
    // replaced by containsUnsupportedExecutionClaim below. Only an explicit,
    // unsupported operational verb reaches this deterministic block.
    return alwaysOperational.test(value);
  }

  private containsUnsupportedExecutionClaim(output: string): boolean {
    const completedAction = '(?:完成|处理|创建|新建|新增|添加|发送|回复|转发|修改|更新|更改|设为|下单|标记|删除|移除|安排|审批|审核|同步|分配|导入|导出|归档|取消|停止|暂停|恢复|重试|提交|确认|保存|登记|部署|安装|执行|发(?:出|给|过去)|寄(?:出|给|过去)|传(?:给|过去)|交给|递给|推送)';
    const claim = new RegExp(
      // A bare "已完成" is frequently a read-only status statement such as
      // "所有代理运行均已完成".  Treat it as an execution claim only when the
      // model explicitly says it acted for the operator (or reports success).
      // This keeps the anti-fabrication guard without turning greetings and
      // CRM status summaries into ACTION_BLOCKED responses.
      `(?:已经|已)(?:经)?(?:为你|为您|帮你|帮您|替你|替您|成功)${completedAction}`
        // “我已经准备好帮助你完成……” describes capability/readiness,
        // not a completed side effect. Do not turn normal assistant chat into
        // ACTION_BLOCKED merely because a later verb describes future help.
        + `|(?:我|这边)(?:已经|已|刚刚|刚才)(?!.{0,16}(?:准备|可以|能够|会|将|打算|计划|愿意|帮助)).{0,16}${completedAction}`
        + `|(?:任务|操作|报价|邮件|消息|客户|订单)(?:已经|已)(?:完成|处理|创建|发送|回复|修改|更新|删除|安排|同步|取消|提交|发(?:出|给|过去)|寄(?:出|给|过去))`
        + '|(?:搞定了|办好了|处理好了|发送成功|创建成功|更新成功|发过去了|寄出去了|已经交给)'
        + `|\\bI(?:'ve|\\s+have)\\s+(?:completed|processed|created|sent|replied|updated|changed|deleted|scheduled|approved|synced|assigned|imported|archived|cancelled|submitted|deployed|installed)\\b`,
      'i',
    );
    return claim.test(output);
  }

  private unsupportedOperationalMessage() {
    return [
      '这条指令中包含尚未接入的具体操作，本次没有执行，也没有把文案当作真实结果。',
      '当前已启用业务主管权限：客户、订单、报价/PI、美元产品价格、待办、背调、工作简报，以及单客户 WhatsApp 和邮件读取、发送、回复。请明确客户或业务对象，我会调用对应工具。',
      '单客户外发必须返回 WhatsApp 或 SMTP 的真实服务商消息编号；通道未登录、目标不唯一或发送失败时会明确报错，不会写成成功。报价 PDF 会生成真实交付件，外发前保留最后一次核对。',
      '服务器 Shell、任意 SQL、密钥读取、静默批量外发不属于业务权限，不通过聊天开放；界面会展示工具、权限决策和真实执行回执。',
    ].join('\n');
  }

  /**
   * OpenClaw exposes a bounded CRM tool set, but a natural-language request
   * can otherwise be answered as prose without selecting a tool.  This hint
   * does not execute anything or bypass the broker; it only gives the model a
   * deterministic tool name when the user's Chinese/English intent is clear.
   * The HMAC broker remains the authority for object scope, approval and
   * durable receipts.
   */
  private openClawToolRoutingHint(message: string): string {
    const value = message.trim();
    if (/(?:怎么|如何|该怎么|怎样).{0,24}(?:回复|回覆|回信|回应).{0,24}(?:客户|联系人|他|她|对方)|(?:客户|联系人).{0,24}(?:怎么|如何|怎样).{0,16}(?:回复|回覆|回信|回应)|(?:回复|回覆|回信|回应).{0,20}(?:建议|草稿)/i.test(value)) {
      return '使用 CRM 实时摘要 currentWhatsapp.customerName 调用 crm_customer_search 唯一定位当前客户，再调用 crm_whatsapp_messages_read 读取最近真实对话；然后只起草建议回复，不得自动发送。';
    }
    if (this.classifyActionWording(value) !== 'EXECUTE') return '无强制工具；按普通问答或草稿处理。';

    if (/(?:工作|CRM|今日|当天|当前).{0,16}(?:简报|汇报)|(?:简报|工作汇报|工作报告).{0,16}(?:生成|整理|查看|读取)|\bwork\s*(?:brief|report)\b/i.test(value)) {
      return '必须调用 crm_work_brief 恰好一次，并只按真实工具结果汇报。';
    }
    if (/(?:(?:发送|发出|寄出|交付|send|deliver).{0,40}(?:报价|报价单|quotation|quote|\bPI\b)|(?:报价|报价单|quotation|quote|\bPI\b).{0,40}(?:发送|发出|寄出|交付|send|deliver))/i.test(value)) {
      return '先调用 crm_customer_search 唯一定位客户，再调用 crm_quote_list 读取该客户报价；只可把已审核报价的 referenceNo 交给 crm_whatsapp_send_quote。成功必须返回真实 WhatsApp messageId 与 PDF 接受时间，不得只生成文案。';
    }
    if (/(?:发送|发出|回复|告诉|通知|send|reply|tell|message).{0,40}(?:WhatsApp|WA|当前客户|当前联系人)|(?:WhatsApp|WA).{0,40}(?:发送|发出|回复|send|reply)/i.test(value)) {
      return '先调用 crm_customer_search 唯一定位客户并取得一次性选择令牌，再调用 crm_whatsapp_send_text；只能使用 CRM 中该客户的可信直接会话，成功必须有真实 WhatsApp messageId。';
    }
    if (/(?:发送|发出|寄出|回复|send|deliver|reply).{0,40}(?:邮件|邮箱|email)|(?:邮件|邮箱|email).{0,40}(?:发送|发出|寄出|回复|send|deliver|reply)/i.test(value)) {
      return '先调用 crm_customer_search 唯一定位客户；新邮件调用 crm_email_send，回复已收邮件调用 crm_email_reply。收件地址和发件账号由 broker 从 CRM 解析，成功必须有真实 SMTP messageId。';
    }
    if (/(?:读取|查看|查询|列出|read|list|show).{0,32}(?:WhatsApp|WA).{0,16}(?:消息|对话|messages?)|(?:WhatsApp|WA).{0,32}(?:消息|对话|messages?).{0,16}(?:读取|查看|查询|列出|read|list|show)/i.test(value)) {
      return '先调用 crm_customer_search 唯一定位客户，再调用 crm_whatsapp_messages_read；只展示工具返回的最小化真实消息。';
    }
    if (/(?:读取|查看|查询|列出|read|list|show).{0,32}(?:邮件|收件箱|email|inbox)|(?:邮件|收件箱|email|inbox).{0,32}(?:读取|查看|查询|列出|read|list|show)/i.test(value)) {
      return '先调用 crm_customer_search 唯一定位客户，再调用 crm_email_messages_read；只展示工具返回的最小化真实邮件。';
    }
    if (/(?:查询|查找|搜索|检索|查看).{0,24}(?:客户|联系人)|(?:客户|联系人).{0,24}(?:查询|查找|搜索|检索)/i.test(value)) {
      return '调用 crm_customer_search；需要完整详情时再调用 crm_customer_get，不得编造客户资料。';
    }
    if (/(?:订单).{0,24}(?:查询|查看|列表)|(?:查询|查看|列出).{0,24}(?:订单)/i.test(value)) {
      return '调用 crm_order_list，并只展示工具返回的真实订单。';
    }
    if (/(?:报价).{0,24}(?:查询|查看|列表)|(?:查询|查看|列出).{0,24}(?:报价)/i.test(value)) {
      return '调用 crm_quote_list，并只展示工具返回的真实报价。';
    }
    if (/(?:产品|价格).{0,24}(?:查询|查找|搜索|检索)|(?:查询|查找|搜索|检索).{0,24}(?:产品|价格)/i.test(value)) {
      return '调用 crm_product_search，并以工具返回的美元产品目录为准。';
    }
    if (/(?:创建|新增|安排|添加).{0,24}(?:待办|任务|提醒)/i.test(value)) {
      return '调用 crm_task_create；缺少客户、标题或时间时先向用户补问，不得假报已创建。';
    }
    if (/(?:修改|更新|补充|完善).{0,24}(?:客户|联系人).{0,16}(?:资料|信息|公司名|联系人|国家|城市|行业|产品|语言)|(?:客户|联系人).{0,24}(?:资料|信息|公司名|联系人|国家|城市|行业|产品|语言).{0,16}(?:修改|更新|补充|完善)/i.test(value)) {
      return '先调用 crm_customer_search 唯一定位客户，再调用 crm_customer_update；只能修改非身份资料字段，不得改写电话、WhatsApp 身份锚点或邮箱。';
    }
    if (/(?:客户|线索).{0,24}(?:备注|阶段|状态)/i.test(value)) {
      return '按意图调用 crm_customer_add_note 或 crm_customer_set_stage；缺少可信客户对象时先补问。';
    }
    if (/(?:创建|新建|新增).{0,24}(?:订单)|(?:订单).{0,24}(?:草稿|创建|新建)/i.test(value)) {
      return '调用 crm_order_create_draft；只创建草稿，缺少客户或明细时先补问。';
    }
    if (/(?:创建|新建|新增|生成|制作).{0,24}(?:报价|报价单|形式发票|\bPI\b)|(?:报价|报价单|形式发票|\bPI\b).{0,24}(?:草稿|创建|新建|生成|制作)/i.test(value)) {
      return '调用 crm_quote_create_draft；报价使用 documentType=quote，形式发票/PI 使用 documentType=pi；缺少客户或产品明细时先补问。';
    }
    if (/(?:开始|启动|执行|进行|调查|研究|research|investigate).{0,40}(?:客户背调|背调|背景调查|客户调查|企业调查|公司调查|background\s+check|due\s+diligence)|(?:客户背调|背调|背景调查|客户调查|企业调查|公司调查|background\s+check|due\s+diligence).{0,40}(?:开始|启动|执行|进行|调查|研究|research|investigate)/i.test(value)) {
      return '先调用 crm_customer_search 唯一定位客户，再调用 crm_start_background_research；是否已创建任务必须以工具回执为准。';
    }
    return '优先使用与请求匹配的 CRM 工具；没有匹配工具时明确说明，不得伪造执行结果。';
  }

  private requiresOpenClawToolReceipt(routingHint: string): boolean {
    return !routingHint.startsWith('无强制工具')
      && !routingHint.startsWith('优先使用与请求匹配的 CRM 工具');
  }

  private isUnhelpfulOpenClawReply(message: string, output: string): boolean {
    const input = message.trim();
    const content = output.trim();
    if (!input || !content) return true;

    const boilerplate = /(?:我在这里[，,]?已经准备好帮助你|请告诉我你需要哪方面的帮助|比如客户查询[、,].*订单管理[、,].*报价处理|有什么可以帮到你的吗|当前 CRM 实时摘要显示|由于没有明确的动作提案)/i.test(content);
    const needsSpecificAnswer = /(?:你是谁|介绍(?:一下|下)?你自己|用一句话介绍你自己|你能干什么|有哪些能力|能做什么|怎么回复|如何回复|回复建议|who are you|what can you do)/i.test(input);
    return boilerplate && needsSpecificAnswer;
  }

  private async resolveTrustedAssistantWhatsappContext(
    dto: AssistantChatDto,
    user: AuthenticatedUser,
  ): Promise<{ customerName: string; verifiedDirectConversation: true } | null> {
    if (dto.pathname !== '/whatsapp/chat' || !dto.whatsapp?.conversationId) return null;
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: dto.whatsapp.conversationId,
        companyId: dto.companyId,
        channel: 'whatsapp',
        status: 'active',
        ...(this.isCompanyAdmin(user, dto.companyId)
          ? {}
          : { OR: [{ assignedUserId: user.id }, { lead: { ownerUserId: user.id } }] }),
      },
      select: {
        subject: true,
        isGroup: true,
        externalThreadId: true,
        contactPoint: {
          select: {
            type: true,
            originalValue: true,
            normalizedValue: true,
            isVerified: true,
          },
        },
        lead: { select: { companyName: true, contactName: true } },
      },
    });
    if (!conversation || !isTrustedDirectWhatsappConversation(conversation)) return null;
    const customerName = conversation.lead?.contactName
      || conversation.lead?.companyName
      || conversation.subject;
    const safeName = customerName ? redactForExternalAi(customerName).trim() : '';
    return safeName
      ? { customerName: safeName, verifiedDirectConversation: true }
      : null;
  }

  private assistantRequestKey(dto: AssistantChatDto, user: AuthenticatedUser) {
    return `assistant-chat:${digestAgentInput({
      companyId: dto.companyId,
      operatorUserId: user.id,
      requestId: dto.requestId,
    })}`;
  }

  private assistantRequestContextDigest(dto: AssistantChatDto, user: AuthenticatedUser) {
    return digestAgentInput({
      companyId: dto.companyId,
      operatorUserId: user.id,
      message: dto.message.trim(),
      threadId: dto.threadId || 'default',
      pathname: dto.pathname || '/',
      conversationLocator: dto.whatsapp?.conversationId || null,
    });
  }

  private isPrismaUniqueConstraintOn(error: unknown, field: string): boolean {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as { code?: unknown; meta?: { target?: unknown } };
    if (candidate.code !== 'P2002') return false;
    const target = candidate.meta?.target;
    const values = Array.isArray(target) ? target : [target];
    return values.some((value) => (
      typeof value === 'string'
      && (value === field || value.endsWith(`_${field}_key`))
    ));
  }

  private assertAssistantArtifactContext(
    artifact: { companyId: string; extraData: Prisma.JsonValue | null },
    dto: AssistantChatDto,
    user: AuthenticatedUser,
  ) {
    const extra = (artifact.extraData || {}) as Record<string, unknown>;
    if (
      artifact.companyId !== dto.companyId
      || extra.operatorUserId !== user.id
      || extra.requestContextDigest !== this.assistantRequestContextDigest(dto, user)
    ) {
      throw new ConflictException('requestId was already used for a different assistant request');
    }
    return extra;
  }

  /**
   * Reserve the assistant request ledger before creating a durable AgentRun.
   * This closes the crash window where a queued research job existed but the
   * chat artifact had not yet been written. A retry with the same context can
   * safely resume; another context using the same requestId is rejected before
   * any side effect.
   */
  private async reserveBackgroundResearchTurn(
    dto: AssistantChatDto,
    user: AuthenticatedUser,
    requestKey: string,
  ) {
    const requestContextDigest = this.assistantRequestContextDigest(dto, user);
    const artifact = await this.prisma.aiArtifact.upsert({
      where: { requestKey },
      create: {
        requestKey,
        companyId: dto.companyId,
        artifactType: 'assistant_chat',
        assistantOperatorUserId: user.id,
        assistantThreadId: dto.threadId || 'default',
        inputContent: dto.message.trim(),
        outputContent: '正在创建可审计的客户背调任务。',
        provider: 'system',
        model: 'deterministic-action-reservation',
        status: 'processing',
        extraData: {
          operatorUserId: user.id,
          threadId: dto.threadId || 'default',
          pathname: dto.pathname || '/',
          requestContextDigest,
          permission: 'verified_read_only_background_research',
          actionKind: 'BACKGROUND_RESEARCH',
          actionStatus: 'RESERVED',
          responseKind: 'TASK_RESERVATION',
        },
      },
      update: {},
    });
    const extra = this.assertAssistantArtifactContext(artifact, dto, user);
    if (
      artifact.status !== 'processing'
      || extra.actionKind !== 'BACKGROUND_RESEARCH'
      || extra.actionStatus !== 'RESERVED'
    ) {
      throw new ConflictException('requestId was already completed by another assistant action');
    }
    return artifact;
  }

  private assistantTurnFromArtifact(artifact: {
    id: string;
    companyId: string;
    inputContent: string;
    outputContent: string;
    model: string | null;
    status: string;
    acceptedAt: Date | null;
    createdAt: Date;
    extraData: Prisma.JsonValue | null;
  }) {
    const extra = (artifact.extraData || {}) as Record<string, unknown>;
    const actionProposal = extra.actionProposal as AssistantActionProposal | null | undefined;
    const toolReceipts = this.parseAssistantToolReceipts(extra.toolReceipts);
    const declaredResponseKind = typeof extra.responseKind === 'string' ? extra.responseKind : 'CHAT';
    const invalidOpenClawClaim = declaredResponseKind === 'OPENCLAW_TOOL_RESULT'
      && toolReceipts.length === 0;
    const responseKind = toolReceipts.length
      ? 'OPENCLAW_TOOL_RESULT'
      : invalidOpenClawClaim
        ? 'ACTION_BLOCKED'
        : declaredResponseKind;
    const actionStatus = toolReceipts.length
      ? this.openClawToolReceiptStatus(toolReceipts)
      : invalidOpenClawClaim
        ? 'BLOCKED'
        : typeof extra.actionStatus === 'string'
          ? extra.actionStatus
          : artifact.status === 'accepted'
            ? 'PREPARATION_CONFIRMED'
            : actionProposal?.status || null;
    const businessStatus = toolReceipts.length
      ? this.openClawToolBusinessStatus(toolReceipts)
      : invalidOpenClawClaim
        ? 'BLOCKED'
        : this.assistantBusinessStatus(extra.businessStatus, actionStatus);
    const agentRunId = toolReceipts.length === 1
      ? toolReceipts[0].agentRunId
      : toolReceipts.length > 1 || invalidOpenClawClaim
        ? null
        : typeof extra.agentRunId === 'string'
          ? extra.agentRunId
          : null;
    return {
      id: artifact.id,
      input: artifact.inputContent,
      output: invalidOpenClawClaim
        ? 'OpenClaw 工具回执校验失败，系统未将该结果视为已执行。请重试或联系管理员。'
        : artifact.outputContent,
      createdAt: artifact.createdAt,
      model: artifact.model,
      actionProposal: actionProposal || null,
      accepted: artifact.status === 'accepted',
      acceptedAt: artifact.acceptedAt,
      actionStatus,
      businessStatus,
      responseKind,
      agentRunId,
      toolReceipts,
    };
  }

  private parseAssistantToolReceipts(value: unknown): AssistantOpenClawToolReceipt[] {
    if (!Array.isArray(value)) return [];
    const allowedStatuses = new Set(['PROCESSING', 'COMPLETED', 'FAILED']);
    const allowedBusinessStatuses = new Set(['PROCESSING', 'SUCCEEDED', 'BLOCKED', 'FAILED']);
    return value.slice(0, 8).flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const raw = item as Record<string, unknown>;
      const toolName = typeof raw.toolName === 'string'
        && Object.values(OPENCLAW_TOOL_LABELS).includes(raw.toolName as AssistantOpenClawToolReceipt['toolName'])
        ? raw.toolName as AssistantOpenClawToolReceipt['toolName']
        : null;
      const requestId = typeof raw.requestId === 'string' && /^[a-f0-9]{64}$/.test(raw.requestId)
        ? raw.requestId
        : null;
      const agentRunId = typeof raw.agentRunId === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw.agentRunId)
        ? raw.agentRunId
        : null;
      const status = typeof raw.status === 'string' && allowedStatuses.has(raw.status)
        ? raw.status as AssistantOpenClawToolReceipt['status']
        : null;
      const businessStatus = typeof raw.businessStatus === 'string'
        && allowedBusinessStatuses.has(raw.businessStatus)
        ? raw.businessStatus as AssistantOpenClawToolReceipt['businessStatus']
        : null;
      const errorCode = raw.errorCode === null
        ? null
        : typeof raw.errorCode === 'string' && /^[A-Z0-9_.-]{1,64}$/.test(raw.errorCode)
          ? raw.errorCode
          : null;
      const completedAt = raw.completedAt === null
        ? null
        : typeof raw.completedAt === 'string' && Number.isFinite(Date.parse(raw.completedAt))
          ? new Date(raw.completedAt).toISOString()
          : null;
      if (!toolName || !requestId || !agentRunId || !status || !businessStatus) return [];
      if (
        status === 'PROCESSING'
        && (businessStatus !== 'PROCESSING' || completedAt !== null || errorCode !== null)
      ) return [];
      if (
        status === 'COMPLETED'
        && (!['SUCCEEDED', 'BLOCKED', 'FAILED'].includes(businessStatus) || completedAt === null || errorCode !== null)
      ) return [];
      if (
        status === 'FAILED'
        && (businessStatus !== 'FAILED' || completedAt === null || errorCode === null)
      ) return [];
      return [{ requestId, agentRunId, toolName, status, businessStatus, errorCode, completedAt }];
    });
  }

  private async loadOpenClawToolReceipts(
    companyId: string,
    operatorUserId: string,
    sessionDigest: string,
  ): Promise<AssistantOpenClawToolReceipt[]> {
    if (!/^[a-f0-9]{64}$/.test(sessionDigest)) return [];
    const rows = await this.prisma.openClawToolReceipt.findMany({
      where: { companyId, operatorUserId, sessionDigest },
      select: {
        requestKey: true,
        runId: true,
        toolName: true,
        status: true,
        businessStatus: true,
        errorCode: true,
        completedAt: true,
      },
      orderBy: { createdAt: 'asc' },
      take: 9,
    });
    if (rows.length > 8) {
      throw new ServiceUnavailableException('OpenClaw receipt set exceeds the per-request safety limit');
    }
    return rows.flatMap((row) => {
      const toolName = OPENCLAW_TOOL_LABELS[row.toolName];
      if (!toolName || !/^[a-f0-9]{64}$/.test(row.requestKey)) return [];
      return [{
        requestId: row.requestKey,
        agentRunId: row.runId,
        toolName,
        status: row.status,
        businessStatus: row.businessStatus,
        errorCode: row.errorCode && /^[A-Z0-9_.-]{1,64}$/.test(row.errorCode)
          ? row.errorCode
          : null,
        completedAt: row.completedAt?.toISOString() || null,
      }];
    });
  }

  private async reconcileAssistantArtifactToolReceipts(artifact: any) {
    const extra = (artifact.extraData || {}) as Record<string, unknown>;
    const sessionDigest = typeof extra.executionSessionDigest === 'string'
      && /^[a-f0-9]{64}$/.test(extra.executionSessionDigest)
      ? extra.executionSessionDigest
      : null;
    const operatorUserId = typeof extra.operatorUserId === 'string' ? extra.operatorUserId : null;
    if (!sessionDigest || !operatorUserId) return artifact;

    const receipts = await this.loadOpenClawToolReceipts(
      artifact.companyId,
      operatorUserId,
      sessionDigest,
    );
    if (!receipts.length) return artifact;

    const expectedStatus = this.openClawToolReceiptStatus(receipts);
    const expectedBusinessStatus = this.openClawToolBusinessStatus(receipts);
    const expectedRunId = receipts.length === 1 ? receipts[0].agentRunId : null;
    const storedReceipts = this.parseAssistantToolReceipts(extra.toolReceipts);
    const alreadyCurrent = JSON.stringify(storedReceipts) === JSON.stringify(receipts)
      && extra.responseKind === 'OPENCLAW_TOOL_RESULT'
      && extra.actionStatus === expectedStatus
      && extra.businessStatus === expectedBusinessStatus
      && (extra.agentRunId ?? null) === expectedRunId;
    if (alreadyCurrent) return artifact;

    return this.prisma.aiArtifact.update({
      where: { id: artifact.id },
      data: {
        outputContent: this.openClawToolReceiptSummary(receipts),
        provider: 'openclaw',
        model: 'openclaw/verified-tool-receipt',
        status: expectedStatus === 'RUNNING' ? 'processing' : 'generated',
        extraData: {
          ...extra,
          permission: 'verified_openclaw_tool_receipt',
          actionStatus: expectedStatus,
          businessStatus: expectedBusinessStatus,
          responseKind: 'OPENCLAW_TOOL_RESULT',
          agentRunId: expectedRunId,
          toolReceipts: receipts,
          responseSource: 'openclaw_gateway',
        },
      },
    });
  }

  private openClawToolReceiptStatus(receipts: AssistantOpenClawToolReceipt[]) {
    if (receipts.some((receipt) => receipt.status === OpenClawReceiptStatus.FAILED)) return 'FAILED';
    if (receipts.some((receipt) => receipt.status === OpenClawReceiptStatus.PROCESSING)) return 'RUNNING';
    return receipts.length ? 'COMPLETED' : null;
  }

  private openClawToolBusinessStatus(receipts: AssistantOpenClawToolReceipt[]) {
    if (receipts.some((receipt) => receipt.businessStatus === 'FAILED')) return 'FAILED' as const;
    if (receipts.some((receipt) => receipt.businessStatus === 'BLOCKED')) return 'BLOCKED' as const;
    if (receipts.some((receipt) => receipt.businessStatus === 'PROCESSING')) return 'PROCESSING' as const;
    return receipts.length ? 'SUCCEEDED' as const : null;
  }

  private assistantBusinessStatus(value: unknown, actionStatus: string | null) {
    if (typeof value === 'string' && ['PROCESSING', 'SUCCEEDED', 'BLOCKED', 'FAILED'].includes(value)) {
      return value as AssistantOpenClawToolReceipt['businessStatus'];
    }
    if (actionStatus === 'BLOCKED') return 'BLOCKED' as const;
    if (['FAILED', 'CANCELLED'].includes(actionStatus || '')) return 'FAILED' as const;
    if (['RUNNING', 'QUEUED', 'RESERVED'].includes(actionStatus || '')) return 'PROCESSING' as const;
    if (['REQUIRES_CONFIRMATION', 'COMPLETED', 'PREPARATION_CONFIRMED'].includes(actionStatus || '')) {
      return 'SUCCEEDED' as const;
    }
    return null;
  }

  private openClawToolReceiptSummary(receipts: AssistantOpenClawToolReceipt[]) {
    const labels: Record<AssistantOpenClawToolReceipt['toolName'], string> = {
      'crm.work_brief': '工作简报读取',
      'crm.customer_search': '客户检索',
      'crm.customer_get': '客户详情读取',
      'crm.customer_add_note': '客户备注新增',
      'crm.customer_update': '客户资料更新',
      'crm.customer_set_stage': '客户阶段更新',
      'crm.task_create': '客户待办创建',
      'crm.order_list': '客户订单读取',
      'crm.order_create_draft': '订单草稿创建',
      'crm.order_update_stage': '订单阶段更新',
      'crm.quote_list': '客户报价读取',
      'crm.quote_create_draft': '美元报价草稿创建',
      'crm.product_search': '美元产品价格检索',
      'crm.start_background_research': '客户背调任务创建',
      'crm.prepare_quote_delivery': '报价交付提案准备',
      'crm.whatsapp_messages_read': 'WhatsApp 消息读取',
      'crm.whatsapp_send_text': 'WhatsApp 单客户消息发送',
      'crm.whatsapp_send_quote': '发送已审核 WhatsApp 报价',
      'crm.email_messages_read': '客户邮件读取',
      'crm.email_send': '客户邮件发送',
      'crm.email_reply': '客户邮件回复',
    };
    const lines = receipts.map((receipt) => {
      const status = receipt.businessStatus === 'SUCCEEDED'
        ? '已完成'
        : receipt.businessStatus === 'BLOCKED'
          ? '已阻止（未执行业务动作）'
          : receipt.businessStatus === 'PROCESSING'
            ? '处理中'
            : `失败${receipt.errorCode ? `（${receipt.errorCode}）` : ''}`;
      return `- ${labels[receipt.toolName]}：${status}；回执 ${receipt.requestId.slice(0, 12)}…`;
    });
    const quoteSafety = receipts.some((receipt) => receipt.toolName === 'crm.prepare_quote_delivery')
      ? '\n报价工具只准备待确认提案，未向客户自动发送；请在 CRM 核对后手动交付。'
      : '';
    return `系统已核对真实工具回执：\n${lines.join('\n')}${quoteSafety}`;
  }

  private normalizeWhatsappPhone(value: string | undefined): string {
    const digits = (value || '').replace(/\D/g, '');
    return /^\d{7,15}$/.test(digits) ? digits : '';
  }

  private parsePendingQuoteProposal(
    value: unknown,
    now: Date,
  ): AssistantQuoteDeliveryProposal | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    if (raw.kind !== 'PREPARE_QUOTE_DELIVERY' || raw.status !== 'REQUIRES_CONFIRMATION') {
      return null;
    }
    const expiresAtMs = typeof raw.expiresAt === 'string' ? Date.parse(raw.expiresAt) : Number.NaN;
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) return null;
    const quote = raw.quote && typeof raw.quote === 'object' && !Array.isArray(raw.quote)
      ? raw.quote as Record<string, unknown>
      : null;
    const target = raw.target && typeof raw.target === 'object' && !Array.isArray(raw.target)
      ? raw.target as Record<string, unknown>
      : null;
    const safety = raw.safety && typeof raw.safety === 'object' && !Array.isArray(raw.safety)
      ? raw.safety as Record<string, unknown>
      : null;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const quoteId = typeof quote?.id === 'string' && uuid.test(quote.id) ? quote.id : '';
    const conversationId = typeof target?.conversationId === 'string' && uuid.test(target.conversationId)
      ? target.conversationId
      : '';
    const leadId = typeof target?.leadId === 'string' && uuid.test(target.leadId)
      ? target.leadId
      : undefined;
    const phone = this.normalizeWhatsappPhone(
      typeof target?.phone === 'string' ? target.phone : undefined,
    );
    const name = typeof target?.name === 'string' ? target.name.trim().slice(0, 160) : '';
    const referenceNo = typeof quote?.referenceNo === 'string'
      ? quote.referenceNo.trim().slice(0, 80)
      : '';
    const quoteStatus = typeof quote?.status === 'string' ? quote.status.trim().slice(0, 40) : '';
    const totalAmount = typeof quote?.totalAmount === 'string' ? quote.totalAmount.trim() : '';
    const currency = typeof quote?.currency === 'string' ? quote.currency.trim().toUpperCase() : '';
    const updatedAtMs = typeof quote?.updatedAt === 'string' ? Date.parse(quote.updatedAt) : Number.NaN;
    if (
      !quoteId
      || !conversationId
      || !phone
      || !name
      || !referenceNo
      || !quoteStatus
      || !/^-?\d{1,12}(?:\.\d{1,6})?$/.test(totalAmount)
      || !/^[A-Z]{3}$/.test(currency)
      || !Number.isFinite(updatedAtMs)
      || safety?.automaticSend !== false
      || safety?.requiresHumanConfirmation !== true
      || safety?.requiresManualWhatsappSend !== true
    ) {
      return null;
    }
    return {
      kind: 'PREPARE_QUOTE_DELIVERY',
      status: 'REQUIRES_CONFIRMATION',
      expiresAt: new Date(expiresAtMs).toISOString(),
      ...(typeof raw.reason === 'string' && raw.reason.trim()
        ? { reason: raw.reason.trim().slice(0, 500) }
        : {}),
      quote: {
        id: quoteId,
        referenceNo,
        status: quoteStatus,
        totalAmount,
        currency,
        updatedAt: new Date(updatedAtMs).toISOString(),
      },
      target: {
        name,
        phone,
        conversationId,
        ...(leadId ? { leadId } : {}),
      },
      safety: {
        automaticSend: false,
        requiresHumanConfirmation: true,
        requiresManualWhatsappSend: true,
      },
    };
  }

  private blockedQuoteDelivery(reason: string): AssistantQuoteDeliveryProposal {
    return {
      kind: 'PREPARE_QUOTE_DELIVERY',
      status: 'BLOCKED',
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      reason,
      safety: {
        automaticSend: false,
        requiresHumanConfirmation: true,
        requiresManualWhatsappSend: true,
      },
    };
  }

  private async buildQuoteDeliveryProposal(
    dto: AssistantChatDto,
    user: AuthenticatedUser,
  ): Promise<AssistantQuoteDeliveryProposal | null> {
    if (!this.isQuoteDeliveryIntent(dto.message)) return null;
    if (dto.pathname !== '/whatsapp/chat' || !dto.whatsapp) {
      return this.blockedQuoteDelivery('请先在 WhatsApp 聊天页选择客户，再让助理准备报价单');
    }
    if (!dto.whatsapp.conversationId) {
      return this.blockedQuoteDelivery('当前 WhatsApp 客户尚未关联可信 CRM 会话');
    }

    // Renderer 传入的姓名、号码、leadId 都不属于权限边界。必须以 JWT 公司范围内
    // 的 WhatsApp 会话和 verified ContactPoint 为可信身份源。
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: dto.whatsapp.conversationId,
        companyId: dto.companyId,
        channel: 'whatsapp',
        status: 'active',
        ...(this.isCompanyAdmin(user, dto.companyId)
          ? {}
          : {
              OR: [
                { assignedUserId: user.id },
                { lead: { ownerUserId: user.id } },
              ],
            }),
      },
      select: {
        id: true,
        isGroup: true,
        externalThreadId: true,
        leadId: true,
        subject: true,
        contactPoint: {
          select: {
            type: true,
            originalValue: true,
            normalizedValue: true,
            isVerified: true,
          },
        },
        lead: {
          select: {
            id: true,
            companyName: true,
            contactName: true,
          },
        },
      },
    });
    if (!conversation) {
      return this.blockedQuoteDelivery('当前 WhatsApp 会话不属于本公司或无权访问');
    }
    if (!isTrustedDirectWhatsappConversation(conversation)) {
      return this.blockedQuoteDelivery('群聊不允许由业务助理准备客户报价单');
    }
    const phone = conversation.contactPoint?.type === 'whatsapp'
      && conversation.contactPoint.isVerified
      ? this.normalizeWhatsappPhone(
          conversation.contactPoint.normalizedValue || conversation.contactPoint.originalValue,
        )
      : '';
    if (!phone) {
      return this.blockedQuoteDelivery('当前会话没有已验证的 WhatsApp 完整号码，不能准备外发文件');
    }

    const relationScope: Prisma.QuoteWhereInput[] = [{ conversationId: conversation.id }];
    if (conversation.leadId) relationScope.push({ leadId: conversation.leadId });

    const quote = await this.prisma.quote.findFirst({
      where: {
        companyId: dto.companyId,
        type: 'quote',
        status: { notIn: ['rejected', 'expired'] },
        ...(this.isCompanyAdmin(user, dto.companyId) ? {} : { assignedUserId: user.id }),
        OR: relationScope,
      },
      select: {
        id: true,
        referenceNo: true,
        status: true,
        totalAmount: true,
        currency: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (!quote) {
      return this.blockedQuoteDelivery('当前客户没有可发送的报价单，请先生成并确认报价');
    }

    return {
      kind: 'PREPARE_QUOTE_DELIVERY',
      status: 'REQUIRES_CONFIRMATION',
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      quote: {
        id: quote.id,
        referenceNo: quote.referenceNo,
        status: quote.status,
        totalAmount: quote.totalAmount.toString(),
        currency: quote.currency,
        updatedAt: quote.updatedAt.toISOString(),
      },
      target: {
        name: conversation.lead?.contactName
          || conversation.lead?.companyName
          || conversation.subject
          || `WhatsApp +${phone}`,
        phone,
        conversationId: conversation.id,
        leadId: conversation.leadId || undefined,
      },
      safety: {
        automaticSend: false,
        requiresHumanConfirmation: true,
        requiresManualWhatsappSend: true,
      },
    };
  }

  private async buildWhatsappTextProposal(
    dto: AssistantChatDto,
    user: AuthenticatedUser,
  ): Promise<AssistantWhatsappTextProposal | null> {
    if (!this.isWhatsappTextSendIntent(
      dto.message,
      dto.pathname === '/whatsapp/chat' && !!dto.whatsapp?.conversationId,
    )) return null;
    const blocked = (reason: string): AssistantWhatsappTextProposal => ({
      kind: 'SEND_WHATSAPP_TEXT',
      status: 'BLOCKED',
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      reason,
      safety: { automaticSend: false, requiresHumanConfirmation: true },
    });
    if (dto.pathname !== '/whatsapp/chat' || !dto.whatsapp?.conversationId) {
      return blocked('请先在 WhatsApp 聊天页选中目标客户，再让助理拟稿并发送');
    }
    if (dto.whatsapp.isGroup) return blocked('群聊暂不允许由业务助理发送客户消息');

    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: dto.whatsapp.conversationId,
        companyId: dto.companyId,
        channel: 'whatsapp',
        status: 'active',
        ...(this.isCompanyAdmin(user, dto.companyId)
          ? {}
          : { OR: [{ assignedUserId: user.id }, { lead: { ownerUserId: user.id } }] }),
      },
      select: {
        id: true,
        isGroup: true,
        externalThreadId: true,
        leadId: true,
        subject: true,
        contactPoint: {
          select: {
            type: true,
            originalValue: true,
            normalizedValue: true,
            isVerified: true,
          },
        },
        lead: { select: { companyName: true, contactName: true } },
      },
    });
    if (!conversation) return blocked('当前 WhatsApp 会话不属于本公司或无权访问');
    if (!isTrustedDirectWhatsappConversation(conversation)) {
      return blocked('群聊暂不允许由业务助理发送客户消息');
    }
    const phone = conversation.contactPoint?.type === 'whatsapp'
      && conversation.contactPoint.isVerified
      ? this.normalizeWhatsappPhone(
          conversation.contactPoint.normalizedValue || conversation.contactPoint.originalValue,
        )
      : '';
    if (!phone) return blocked('当前会话缺少已验证的完整 WhatsApp 号码');
    const targetName = conversation.lead?.contactName
      || conversation.lead?.companyName
      || conversation.subject
      || `WhatsApp +${phone}`;
    const safeInstruction = redactForExternalAi(dto.message.trim());
    const draft = await this.ai.chat(
      [
        '你是示例贸易公司的外贸业务助理。',
        '把用户指令改写成一条可以直接发送给客户的专业 WhatsApp 消息。',
        '按用户指定语言输出；未指定时默认使用自然、简洁的商务英语。',
        '只输出消息正文，不要标题、解释、Markdown、引号或执行结果。',
        '不得虚构价格、订单状态、付款到账或交期；用户明确提供的事实可以原样表达。',
      ].join(''),
      `客户称呼：${redactForExternalAi(targetName)}\n用户指令：${safeInstruction}`,
      { task: 'assistant_whatsapp_draft', maxTokens: 500, temperature: 0.25 },
    );
    if (!draft.success || !draft.content?.trim()) {
      return blocked('智谱暂时未能生成可靠的客户消息草稿，请稍后重试');
    }
    const text = draft.content
      .replace(/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 4_000);
    if (!text) return blocked('生成的消息正文为空，未创建发送提案');
    return {
      kind: 'SEND_WHATSAPP_TEXT',
      status: 'REQUIRES_CONFIRMATION',
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      text,
      target: {
        name: targetName,
        phone,
        conversationId: conversation.id,
        leadId: conversation.leadId || undefined,
      },
      safety: { automaticSend: false, requiresHumanConfirmation: true },
    };
  }

  private async buildBackgroundResearchAction(
    dto: AssistantChatDto,
    user: AuthenticatedUser,
    requestKey: string,
  ): Promise<AssistantResearchAction | null> {
    if (!this.isBackgroundResearchIntent(dto.message)) return null;
    if (dto.pathname !== '/whatsapp/chat' || !dto.whatsapp?.conversationId) {
      return {
        kind: 'BACKGROUND_RESEARCH',
        status: 'BLOCKED',
        reason: '请先在 WhatsApp 聊天页选择一个已建档客户，再交代背调任务。',
      };
    }

    // Renderer 只提供会话定位符；姓名、phone、leadId、isGroup 均不作为授权或客户身份依据。
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: dto.whatsapp.conversationId,
        companyId: dto.companyId,
        channel: 'whatsapp',
        status: 'active',
        ...(this.isCompanyAdmin(user, dto.companyId)
          ? {}
          : {
              OR: [
                { assignedUserId: user.id },
                { lead: { ownerUserId: user.id } },
              ],
            }),
      },
      select: {
        id: true,
        companyId: true,
        leadId: true,
        isGroup: true,
        externalThreadId: true,
        contactPoint: {
          select: {
            type: true,
            originalValue: true,
            normalizedValue: true,
            isVerified: true,
          },
        },
        lead: {
          select: {
            id: true,
            companyId: true,
            companyName: true,
            companyNameSource: true,
            companyNameConfidence: true,
            ownerUserId: true,
            deletedAt: true,
          },
        },
      },
    });
    if (!conversation) {
      return {
        kind: 'BACKGROUND_RESEARCH',
        status: 'BLOCKED',
        reason: '当前 WhatsApp 会话不属于本公司，或未分配给当前操作者。',
      };
    }
    if (!isTrustedDirectWhatsappConversation(conversation)) {
      return {
        kind: 'BACKGROUND_RESEARCH',
        status: 'BLOCKED',
        reason: conversation.isGroup === null && !conversation.externalThreadId?.endsWith('@g.us')
          ? '该历史会话的群聊属性尚未由新版 WhatsApp 连接确认；只有与已验证 E.164 完整号码完全一致的直聊才能启动背调。'
          : '群聊没有唯一客户主体，不能创建客户背调任务。',
        conversationId: conversation.id,
      };
    }
    if (!conversation.leadId || !conversation.lead) {
      return {
        kind: 'BACKGROUND_RESEARCH',
        status: 'BLOCKED',
        reason: '当前会话尚未关联 CRM 客户档案，不能自动背调。',
        conversationId: conversation.id,
      };
    }
    if (
      conversation.lead.companyId !== dto.companyId
      || conversation.lead.deletedAt
      || (!this.isCompanyAdmin(user, dto.companyId) && conversation.lead.ownerUserId !== user.id)
    ) {
      return {
        kind: 'BACKGROUND_RESEARCH',
        status: 'BLOCKED',
        reason: '当前客户不属于本公司或未分配给当前操作者。',
        conversationId: conversation.id,
      };
    }
    const subject = assessResearchSubject(conversation.lead);
    if (!subject.trusted) {
      const reason = subject.code === 'MISSING_COMPANY_NAME'
        ? '当前客户缺少公司名称；请先在客户档案填写并确认真实公司名后再启动背调。'
        : `当前客户公司名“${subject.companyName}”尚未人工确认，不能把 WhatsApp 昵称当作调查主体；请先在客户档案确认真实公司名。`;
      return {
        kind: 'BACKGROUND_RESEARCH',
        status: 'BLOCKED',
        reason,
        conversationId: conversation.id,
        leadId: conversation.lead.id,
      };
    }

    const run = await this.researchRuns.enqueueForLead({
      companyId: dto.companyId,
      leadId: conversation.lead.id,
      type: 'full',
      source: 'assistant_chat',
      conversationId: conversation.id,
      requestKey,
    }, user);
    const statusByRun: Partial<Record<AgentRunStatus, AssistantResearchAction['status']>> = {
      [AgentRunStatus.PENDING]: 'QUEUED',
      [AgentRunStatus.RUNNING]: 'RUNNING',
      [AgentRunStatus.COMPLETED]: 'COMPLETED',
      [AgentRunStatus.FAILED]: 'FAILED',
      [AgentRunStatus.CANCELLED]: 'CANCELLED',
    };
    const actionStatus = statusByRun[run.status as AgentRunStatus];
    if (!actionStatus) {
      throw new ConflictException(`Background research run is in unsupported state: ${run.status}`);
    }
    return {
      kind: 'BACKGROUND_RESEARCH',
      status: actionStatus,
      agentRunId: run.id,
      conversationId: conversation.id,
      leadId: conversation.lead.id,
    };
  }

  private async persistBackgroundResearchTurn(
    dto: AssistantChatDto,
    user: AuthenticatedUser,
    action: AssistantResearchAction,
    requestKey: string,
    actionSource: AssistantActionSource = 'CRM',
  ) {
    const outputByStatus: Record<AssistantResearchAction['status'], string> = {
      QUEUED: '已创建真实客户背调任务并交给后台执行。你可以在“事务”页查看进度；报告完成后会写回当前客户档案。',
      RUNNING: '同一请求对应的客户背调任务正在执行，没有重复创建任务。',
      COMPLETED: '同一请求对应的客户背调任务已经完成，请打开下方任务卡查看客户档案与报告。',
      FAILED: '同一请求对应的客户背调任务此前已经失败，系统没有伪装成重新排队；请查看失败原因后使用新指令重试。',
      CANCELLED: '同一请求对应的客户背调任务已经取消，系统没有重新排队。',
      BLOCKED: `未创建背调任务：${action.reason || '当前客户不满足安全执行条件'}`,
    };
    const outputContent = outputByStatus[action.status];
    const responseKind = action.status === 'QUEUED'
      ? 'TASK_CREATED'
      : action.status === 'BLOCKED'
        ? 'ACTION_BLOCKED'
        : 'TASK_STATUS';
    const finalData = {
      companyId: dto.companyId,
      conversationId: action.conversationId,
      leadId: action.leadId,
      artifactType: 'assistant_chat',
      assistantOperatorUserId: user.id,
      assistantThreadId: dto.threadId || 'default',
      inputContent: dto.message.trim(),
      outputContent,
      provider: 'system',
      model: 'deterministic-action',
      status: 'generated',
      extraData: {
        operatorUserId: user.id,
        threadId: dto.threadId || 'default',
        pathname: dto.pathname || '/',
        requestContextDigest: this.assistantRequestContextDigest(dto, user),
        permission: 'verified_read_only_background_research',
        actionKind: 'BACKGROUND_RESEARCH',
        responseKind,
        actionStatus: action.status,
        agentRunId: action.agentRunId || null,
        actionSource,
      },
    } satisfies Prisma.AiArtifactUncheckedCreateInput;
    const artifact = await this.prisma.aiArtifact.upsert({
      where: { requestKey },
      create: {
        requestKey,
        ...finalData,
      },
      update: finalData,
    });
    this.assertAssistantArtifactContext(artifact, dto, user);
    return this.assistantTurnFromArtifact(artifact);
  }

  private async persistUnsupportedOperationalTurn(
    dto: AssistantChatDto,
    user: AuthenticatedUser,
    requestKey: string,
  ) {
    const outputContent = this.unsupportedOperationalMessage();
    const artifact = await this.prisma.aiArtifact.upsert({
      where: { requestKey },
      create: {
        requestKey,
        companyId: dto.companyId,
        artifactType: 'assistant_chat',
        assistantOperatorUserId: user.id,
        assistantThreadId: dto.threadId || 'default',
        inputContent: dto.message.trim(),
        outputContent,
        provider: 'system',
        model: 'deterministic-action-guard',
        status: 'generated',
        extraData: {
          operatorUserId: user.id,
          threadId: dto.threadId || 'default',
          pathname: dto.pathname || '/',
          requestContextDigest: this.assistantRequestContextDigest(dto, user),
          permission: 'unsupported_operation_blocked',
          responseKind: 'ACTION_BLOCKED',
          actionStatus: 'BLOCKED',
          agentRunId: null,
        },
      },
      update: {},
    });
    const persistedExtra = (artifact.extraData || {}) as Record<string, unknown>;
    if (
      artifact.companyId !== dto.companyId
      || persistedExtra.operatorUserId !== user.id
      || persistedExtra.requestContextDigest !== this.assistantRequestContextDigest(dto, user)
    ) {
      throw new ConflictException('requestId was concurrently used for a different assistant request');
    }
    return this.assistantTurnFromArtifact(artifact);
  }

  async create(dto: CreateAgentRunDto, user: AuthenticatedUser) {
    this.assertCompanyMembership(user, dto.companyId);
    if (dto.kind === SafeAgentRunKind.DRAFT_FOLLOW_UP && !dto.brief?.trim()) {
      throw new BadRequestException('brief is required for a follow-up draft');
    }

    const lead = await this.prisma.lead.findFirst({
      where: { id: dto.leadId, companyId: dto.companyId, deletedAt: null },
      select: {
        id: true,
        leadName: true,
        companyName: true,
        country: true,
        productCategory: true,
        status: true,
        ownerUserId: true,
      },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    if (!this.isCompanyAdmin(user, dto.companyId) && lead.ownerUserId !== user.id) {
      throw new ForbiddenException('Lead is not assigned to this operator');
    }

    const inputDigest = digestAgentInput({
      companyId: dto.companyId,
      kind: dto.kind,
      leadId: dto.leadId,
      brief: dto.brief?.trim() || null,
      language: dto.language || null,
    });
    const toolName = dto.kind === SafeAgentRunKind.READ_LEAD_SUMMARY
      ? 'crm.read_lead_summary'
      : 'draft.follow_up';

    const run = await this.prisma.$transaction(async (tx) => {
      const created = await tx.agentRun.create({
        data: {
          companyId: dto.companyId,
          operatorUserId: user.id,
          kind: dto.kind as AgentRunKind,
          inputDigest,
          subjectType: 'lead',
          subjectId: dto.leadId,
          tasks: { create: { companyId: dto.companyId, toolName, inputDigest } },
        },
      });
      await tx.agentAuditLog.create({
        data: {
          companyId: dto.companyId,
          runId: created.id,
          actorUserId: user.id,
          eventType: 'RUN_CREATED',
          inputDigest,
          metadata: { kind: dto.kind, toolName },
        },
      });
      return created;
    });

    return this.executeSafeRun(run.id, dto, lead, user);
  }

  async list(companyId: string, user: AuthenticatedUser) {
    this.assertCompanyMembership(user, companyId);
    const runs = await this.prisma.agentRun.findMany({
      where: {
        companyId,
        ...(this.isCompanyAdmin(user, companyId) ? {} : { operatorUserId: user.id }),
      },
      include: {
        tasks: true,
        authorizations: { select: this.authorizationPublicSelect() },
        researchReport: { select: { id: true, title: true, type: true, createdAt: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return runs.map((run) => ({
      ...run,
      researchReport: run.status === AgentRunStatus.COMPLETED ? run.researchReport : null,
    }));
  }

  async getBrief(companyId: string, user: AuthenticatedUser) {
    this.assertCompanyMembership(user, companyId);
    const isAdmin = this.isCompanyAdmin(user, companyId);
    const leadWhere = {
      companyId,
      deletedAt: null,
      ...(isAdmin ? {} : { ownerUserId: user.id }),
    };
    const reminderWhere = {
      companyId,
      deletedAt: null,
      status: 'Pending',
      ...(isAdmin ? {} : { userId: user.id }),
    };
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setHours(24, 0, 0, 0);
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const [leads, reminders, quotes, runs] = await Promise.all([
      this.prisma.lead.findMany({
        where: leadWhere,
        select: { status: true, createdAt: true, lastContactedAt: true },
        orderBy: { createdAt: 'desc' },
        take: 1000,
      }),
      this.prisma.followUpReminder.findMany({
        where: reminderWhere,
        select: { id: true, title: true, reason: true, priority: true, dueAt: true, leadId: true },
        orderBy: [{ dueAt: 'asc' }, { priority: 'desc' }],
        take: 50,
      }),
      this.prisma.quote.findMany({
        where: { companyId, ...(isAdmin ? {} : { assignedUserId: user.id }) },
        select: { id: true, status: true, referenceNo: true, totalAmount: true, currency: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
        take: 50,
      }),
      this.prisma.agentRun.findMany({
        where: { companyId, ...(isAdmin ? {} : { operatorUserId: user.id }) },
        select: { id: true, kind: true, status: true, result: true, errorCode: true, createdAt: true, completedAt: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    const statusCounts = leads.reduce<Record<string, number>>((acc, lead) => {
      const key = lead.status || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    return {
      generatedAt: now.toISOString(),
      ai: {
        enabled: this.ai.isEnabled() && this.ai.hasKey(),
        provider: 'zhipu',
        model: this.ai.getModel(),
      },
      metrics: {
        leads: leads.length,
        newLeads: leads.filter((lead) => lead.createdAt >= todayStart).length,
        pendingReminders: reminders.length,
        overdueReminders: reminders.filter((item) => item.dueAt < now).length,
        todayReminders: reminders.filter((item) => item.dueAt >= todayStart && item.dueAt < tomorrow).length,
        draftQuotes: quotes.filter((quote) => ['draft', 'pending'].includes(quote.status)).length,
        activeAgentRuns: runs.filter((run) => ['PENDING', 'RUNNING', 'AWAITING_APPROVAL'].includes(run.status)).length,
      },
      leadStatusCounts: statusCounts,
      reminders: reminders.slice(0, 12),
      quotes: quotes.slice(0, 8),
      runs,
    };
  }

  async getChatHistory(companyId: string, threadId: string | undefined, user: AuthenticatedUser) {
    this.assertCompanyMembership(user, companyId);
    const artifacts = await this.prisma.aiArtifact.findMany({
      where: {
        companyId,
        artifactType: 'assistant_chat',
        assistantOperatorUserId: user.id,
        ...(threadId ? { assistantThreadId: threadId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    const reconciled = await Promise.all(
      artifacts.reverse().map((artifact) => this.reconcileAssistantArtifactToolReceipts(artifact)),
    );
    return reconciled.map((artifact) => this.assistantTurnFromArtifact(artifact));
  }

  async getPendingAssistantActions(companyId: string, user: AuthenticatedUser) {
    this.assertCompanyMembership(user, companyId);
    const isAdmin = this.isCompanyAdmin(user, companyId);
    const now = new Date();
    const artifacts = await this.prisma.aiArtifact.findMany({
      where: {
        companyId,
        artifactType: 'assistant_chat',
        status: { not: 'accepted' },
        acceptedAt: null,
        ...(isAdmin ? {} : { assistantOperatorUserId: user.id }),
        extraData: {
          path: ['actionProposal', 'kind'],
          equals: 'PREPARE_QUOTE_DELIVERY',
        },
      },
      select: {
        id: true,
        createdAt: true,
        status: true,
        acceptedAt: true,
        assistantOperatorUserId: true,
        extraData: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return artifacts.flatMap((artifact) => {
      if (artifact.status === 'accepted' || artifact.acceptedAt) return [];
      const extra = (artifact.extraData || {}) as Record<string, unknown>;
      const operatorUserId = artifact.assistantOperatorUserId
        || (typeof extra.operatorUserId === 'string' ? extra.operatorUserId : null);
      if (!isAdmin && operatorUserId !== user.id) return [];
      const actionProposal = this.parsePendingQuoteProposal(extra.actionProposal, now);
      if (!actionProposal) return [];
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(artifact.id)) {
        return [];
      }
      const source = extra.actionSource === 'WECHAT_OWNER'
        ? 'WECHAT_OWNER' as const
        : extra.actionSource === 'CRM' || extra.responseSource !== 'openclaw_tool_broker'
          ? 'CRM' as const
          : null;
      // A broker proposal without an explicit authenticated source is not
      // guessed as WeChat. The channel label is security/audit metadata and
      // must come from the trusted broker actor context.
      if (!source) return [];
      return [{
        id: artifact.id,
        createdAt: artifact.createdAt.toISOString(),
        source,
        actionProposal,
      }];
    }).slice(0, 50);
  }

  async chat(dto: AssistantChatDto, user: AuthenticatedUser) {
    this.assertCompanyMembership(user, dto.companyId);
    const requestKey = this.assistantRequestKey(dto, user);
    const requestContextDigest = this.assistantRequestContextDigest(dto, user);
    const existing = await this.prisma.aiArtifact.findUnique({ where: { requestKey } });
    const backgroundResearchIntent = this.isBackgroundResearchIntent(dto.message);
    const supervisorToolMode = this.isCompanyAdmin(user, dto.companyId)
      && !!this.openClaw
      && this.openClaw.isEnabled()
      && (await this.assistantPermissions?.getProfile(dto.companyId, user))?.preset === 'SUPERVISOR';
    if (existing) {
      const extra = this.assertAssistantArtifactContext(existing, dto, user);
      const resumableResearchReservation = backgroundResearchIntent
        && existing.status === 'processing'
        && extra.actionKind === 'BACKGROUND_RESEARCH'
        && extra.actionStatus === 'RESERVED';
      if (!resumableResearchReservation) {
        const reconciled = await this.reconcileAssistantArtifactToolReceipts(existing);
        return this.assistantTurnFromArtifact(reconciled);
      }
    }
    if (backgroundResearchIntent && !supervisorToolMode) {
      if (!existing) await this.reserveBackgroundResearchTurn(dto, user, requestKey);
      const researchAction = await this.buildBackgroundResearchAction(dto, user, requestKey);
      if (!researchAction) {
        throw new ConflictException('Background research intent lost during deterministic routing');
      }
      return this.persistBackgroundResearchTurn(dto, user, researchAction, requestKey);
    }
    // In SUPERVISOR mode quotation delivery must reach the reviewed OpenClaw
    // tool chain. The legacy proposal path only prepared a PDF and forced a
    // manual drag, so running it first silently prevented crm_whatsapp_send_quote
    // from ever being selected even though the tool and permission existed.
    const quoteDeliveryProposal = supervisorToolMode
      ? null
      : await this.buildQuoteDeliveryProposal(dto, user);
    const whatsappTextProposal = quoteDeliveryProposal
      ? null
      : supervisorToolMode
        ? null
        : await this.buildWhatsappTextProposal(dto, user);
    const actionProposal: AssistantActionProposal | null = quoteDeliveryProposal || whatsappTextProposal;
    const brief = await this.getBrief(dto.companyId, user);
    const history = await this.getChatHistory(dto.companyId, dto.threadId, user);
    const trustedWhatsappContext = supervisorToolMode
      ? await this.resolveTrustedAssistantWhatsappContext(dto, user)
      : null;
    // The owner-facing system chat is a transparent conversation channel.
    // Classifiers may inspect a normalized copy, but the model receives the
    // exact text typed by the user. Tool authorization remains enforced by the
    // broker and is deliberately independent from chat content filtering.
    const chatMessage = dto.message;
    const conversationContext = buildAssistantConversationContext(history);
    const compressedContext = redactForExternalAi(conversationContext.compressedSummary);
    const recentContext = redactForExternalAi(conversationContext.recentContext);
    const snapshot = JSON.stringify({
      metrics: brief.metrics,
      leadStatusCounts: brief.leadStatusCounts,
      currentPage: dto.pathname || '/',
      reminders: brief.reminders.slice(0, 8).map((item) => ({
        title: redactForExternalAi(item.title),
        reason: item.reason ? redactForExternalAi(item.reason) : null,
        priority: item.priority,
        dueAt: item.dueAt,
      })),
      // 发送意图已经由服务端确定性匹配到当前会话；不要再把全公司的
      // 最近报价交给模型，避免它像旧版一样列出其他客户的报价。
      quotes: actionProposal ? [] : brief.quotes.slice(0, 5).map((item) => ({
        referenceNo: redactForExternalAi(item.referenceNo),
        status: item.status,
        totalAmount: item.totalAmount,
        currency: item.currency,
      })),
      agentRuns: brief.runs.slice(0, 8).map((item) => ({ kind: item.kind, status: item.status })),
      currentWhatsapp: trustedWhatsappContext,
    });
    const actionPrompt = actionProposal
      ? {
          kind: actionProposal.kind,
          status: actionProposal.status,
          reason: actionProposal.reason ? redactForExternalAi(actionProposal.reason) : undefined,
          quoteMatchedByServer: actionProposal.kind === 'PREPARE_QUOTE_DELIVERY'
            ? !!actionProposal.quote
            : undefined,
          messageDraftedByServer: actionProposal.kind === 'SEND_WHATSAPP_TEXT'
            ? !!actionProposal.text
            : undefined,
          // 报价编号/金额/target name/phone/IDs 永不发送给外部模型；
          // 真实数据只进入本地结构化确认卡。
          targetVerifiedByServer: !!actionProposal.target,
        }
      : { kind: 'NONE' };
    const openClawToolRoutingHint = this.openClawToolRoutingHint(dto.message);
    // 报价外发属于确定性业务动作：识别、授权说明和确认文案均由本地代码生成，
    // 不把电话号码、报价编号、内部 ID 或原始“发送”指令交给任何模型。
    const systemPrompt = [
      '你是示例贸易公司的 AI 业务助理，也是可以自然连续交流的通用 Agent。直接理解并回答用户，不要用固定欢迎语、权限说明或安全模板替代正常对话。',
      '你可以自由解释、分析、讨论、整理工作、提出下一步、起草内容，并使用当前会话实际提供的 CRM 工具完成业务工作。',
      '可用业务工具包括 crm_work_brief、crm_customer_search、crm_customer_get、crm_customer_add_note、crm_customer_update、crm_customer_set_stage、crm_task_create、crm_order_list、crm_order_create_draft、crm_order_update_stage、crm_quote_list、crm_quote_create_draft、crm_product_search、crm_start_background_research、crm_prepare_quote_delivery、crm_whatsapp_messages_read、crm_whatsapp_send_text、crm_whatsapp_send_quote、crm_email_messages_read、crm_email_send 和 crm_email_reply。',
      '用户明确要求某个可用 CRM 工具或受支持业务动作时，必须调用对应工具，不得只生成一段看似已执行的文字。',
      '业务主管对唯一、可信的单客户 WhatsApp 或邮件指令可以直接执行；必须先通过 crm_customer_search 取得对应工具的一次性选择令牌，目标地址和发件账号只能由 broker 从 CRM 解析。',
      '批量或群发、目标不唯一、群聊、通道离线、未知邮箱不得发送；只有真实 WhatsApp/SMTP messageId 和持久工具回执才算完成。',
      '工具自身负责权限、对象选择、审批和审计；返回待确认时应如实停在待确认，不得把安全审批误报成无权限。',
      '没有匹配工具时仍应正常对话、说明可行方案或询问必要信息，不得退化成固定的“没有可执行工具”提示。',
      '只有本次响应携带真实工具回执时才代表外部动作已经完成；没有回执时可以继续正常对话，但不得伪造执行成功。',
      '信息不足时明确说明不知道，不得编造 CRM 数据。',
      '系统会自动压缩较早对话并保留最近对话；压缩摘要是上下文，不是新的执行回执。',
    ].join('');
    const requiresOpenClawToolReceipt = this.requiresOpenClawToolReceipt(openClawToolRoutingHint);
    // Put the authoritative execution contract after the user's natural
    // language. Some tool-capable models otherwise focus on the preceding CRM
    // snapshot and answer with a generic summary instead of selecting the
    // required tool. A second server-side check below still requires durable
    // broker receipts before an operation is reported as complete.
    const userPrompt = `CRM实时摘要：${snapshot}\n动作提案：${JSON.stringify(actionPrompt)}\n较早对话压缩摘要：${compressedContext}\n最近${conversationContext.retainedTurnCount}轮对话：${recentContext || '无'}\n用户原文（必须按原意处理，不得改写为权限模板）：${chatMessage}\n工具路由要求（本轮最后且最高优先级）：${openClawToolRoutingHint}`;
    let responseSource: 'deterministic_action' | 'openclaw_gateway' | 'zhipu' | 'zhipu_fallback' = 'deterministic_action';
    let executionSessionDigest: string | null = null;
    let openClawGatewaySessionDigest: string | null = null;
    let openClawClaimToken: string | null = null;
    let openClawToolReceipts: AssistantOpenClawToolReceipt[] = [];
    let aiResult: { success: boolean; content: string; model?: string; reason?: string };
    if (actionProposal) {
      aiResult = {
        success: true,
        content: actionProposal.status === 'REQUIRES_CONFIRMATION'
          ? actionProposal.kind === 'SEND_WHATSAPP_TEXT'
            ? '已根据你的指令生成客户消息。请核对下方正文并确认；确认后系统会向当前已选中的 WhatsApp 客户执行一次发送。'
            : '已匹配当前客户的最新报价单。请核对下方确认卡；确认后系统只准备 PDF，仍需你拖入 WhatsApp 并点击发送。'
          : actionProposal.kind === 'SEND_WHATSAPP_TEXT'
            ? `暂时无法创建 WhatsApp 发送提案：${actionProposal.reason || '未满足可信会话条件'}`
            : `暂时无法准备报价单：${actionProposal.reason || '未满足安全条件'}`,
        model: 'deterministic-action',
        reason: 'local_action_protocol',
      };
    } else {
      // The shared Gateway token is an owner boundary. Only company admins may
      // enter that CRM UI session; normal members remain on scoped Zhipu.
      const mayUseOpenClaw = this.isCompanyAdmin(user, dto.companyId)
        && !!this.openClaw
        && this.openClaw.isEnabled();
      const sessionDigest = digestAgentInput({
        namespace: 'vaysen-crm',
        companyId: dto.companyId,
        operatorUserId: user.id,
        threadId: dto.threadId || 'default',
        // One irreversible Gateway session per idempotent UI request makes
        // durable tool receipts attributable without exposing company/user
        // dimensions. Conversation context is supplied explicitly above.
        requestId: dto.requestId,
      });
      openClawGatewaySessionDigest = sessionDigest;
      if (mayUseOpenClaw) {
        // Match the broker's SHA-256(sessionKey) without persisting the raw
        // namespaced Gateway session or its reversible CRM dimensions.
        executionSessionDigest = createHash('sha256')
          .update(`vaysen-crm:${sessionDigest}`, 'utf8')
          .digest('hex');
        if (!this.openClawSessions) {
          throw new ServiceUnavailableException('OpenClaw CRM session mapping is unavailable');
        }
        await this.openClawSessions.register(sessionDigest, dto.companyId, user);
        // Recover a completed/in-flight tool operation after a backend crash
        // or a lost client response. Reusing the same UI requestId reaches the
        // same irreversible session and must never invoke the tool twice.
        openClawToolReceipts = await this.loadOpenClawToolReceipts(
          dto.companyId,
          user.id,
          executionSessionDigest,
        );
        if (openClawToolReceipts.length === 0) {
          openClawClaimToken = await this.openClawSessions.claimExecution(
            sessionDigest,
            dto.companyId,
            user,
          );
          if (!openClawClaimToken) {
            // A receipt may commit between the first read and a concurrent
            // renderer winning the execution lease. Reconcile once more
            // before reporting that the request is still in progress.
            openClawToolReceipts = await this.loadOpenClawToolReceipts(
              dto.companyId,
              user.id,
              executionSessionDigest,
            );
            if (openClawToolReceipts.length === 0) {
              throw new ConflictException('Assistant request is already processing; retry with the same requestId');
            }
          }
        }
      }
      let gatewayResult = mayUseOpenClaw
        && openClawToolReceipts.length === 0
        && !!openClawClaimToken
        ? await this.openClaw!.chat(systemPrompt, userPrompt, sessionDigest, 900)
        : { success: false as const, reason: openClawToolReceipts.length ? 'receipt_recovered' : 'disabled' };
      if (mayUseOpenClaw && openClawToolReceipts.length === 0) {
        openClawToolReceipts = await this.loadOpenClawToolReceipts(
          dto.companyId,
          user.id,
          executionSessionDigest!,
        );
      }
      if (
        mayUseOpenClaw
        && gatewayResult.success
        && gatewayResult.content
        && requiresOpenClawToolReceipt
        && openClawToolReceipts.length === 0
        && !!openClawClaimToken
      ) {
        // A successful prose response is not success for an operational turn.
        // Retry once in the same leased/idempotent session with an explicit
        // correction. No receipt exists at this point, so the first turn did
        // not commit a brokered side effect. Never retry after a timeout/error,
        // where an in-flight tool might still be settling.
        gatewayResult = await this.openClaw!.chat(
          systemPrompt,
          `${userPrompt}\n上一次响应没有调用必需工具。现在必须严格执行上述工具路由；不得返回欢迎语、CRM 总览或纯文案。`,
          sessionDigest,
          900,
        );
        openClawToolReceipts = await this.loadOpenClawToolReceipts(
          dto.companyId,
          user.id,
          executionSessionDigest!,
        );
      }
      if (gatewayResult.success && gatewayResult.content) {
        aiResult = {
          success: true,
          content: gatewayResult.content,
          model: gatewayResult.model,
          reason: gatewayResult.reason,
        };
        responseSource = 'openclaw_gateway';
      } else if (openClawToolReceipts.length) {
        // The natural-language response may be lost after the tool committed.
        // Return the database-backed receipt instead of falling back to a
        // second model or replaying the side effect.
        aiResult = {
          success: true,
          content: this.openClawToolReceiptSummary(openClawToolReceipts),
          model: 'openclaw/verified-tool-receipt',
          reason: 'verified_tool_receipt',
        };
        responseSource = 'openclaw_gateway';
      } else {
        aiResult = await this.ai.chat(systemPrompt, userPrompt, {
          task: 'assistant_chat',
          maxTokens: 900,
          temperature: 0.35,
        });
        responseSource = mayUseOpenClaw ? 'zhipu_fallback' : 'zhipu';
      }
    }
    if (!aiResult.success && !actionProposal) {
      if (openClawClaimToken && openClawGatewaySessionDigest && this.openClawSessions) {
        await this.openClawSessions.releaseExecution(openClawGatewaySessionDigest, openClawClaimToken);
        openClawClaimToken = null;
      }
      throw new ServiceUnavailableException('AI 业务助理暂时不可用，请检查智谱 API 配置');
    }
    // Keep the conversation payload byte-for-byte as returned by the model.
    // Verified tool receipts are separate structured fields rendered beside
    // the message; they must never rewrite, truncate, or append to chat text.
    const outputContent = aiResult.success
      ? aiResult.content
      : actionProposal?.status === 'REQUIRES_CONFIRMATION'
        ? '已匹配当前客户的最新报价单。请核对下方确认卡；确认后系统只准备 PDF，仍需你拖入 WhatsApp 并点击发送。'
        : `暂时无法准备报价单：${actionProposal?.reason || '未满足安全条件'}`;
    const artifact = await (async () => {
      try {
        let persisted;
        try {
          persisted = await this.prisma.aiArtifact.upsert({
            where: { requestKey },
            create: {
              requestKey,
              companyId: dto.companyId,
              conversationId: actionProposal?.target?.conversationId,
              leadId: actionProposal?.target?.leadId,
              artifactType: 'assistant_chat',
              assistantOperatorUserId: user.id,
              assistantThreadId: dto.threadId || 'default',
              inputContent: dto.message,
              outputContent,
              provider: actionProposal
                ? 'system'
                : aiResult.success
                ? (responseSource === 'openclaw_gateway' ? 'openclaw' : 'zhipu')
                : 'system',
              model: actionProposal
                ? 'deterministic-action'
                : aiResult.success
                ? (aiResult.model || this.ai.getModel())
                : 'deterministic-action',
              status: 'generated',
              extraData: {
                operatorUserId: user.id,
                threadId: dto.threadId || 'default',
                pathname: dto.pathname || '/',
                requestContextDigest,
                permission: actionProposal
                  ? actionProposal.kind === 'SEND_WHATSAPP_TEXT'
                    ? 'human_confirmed_whatsapp_send'
                    : 'human_confirmed_quote_preparation'
                  : openClawToolReceipts.length
                    ? 'verified_openclaw_tool_receipt'
                  : 'transparent_chat',
                actionProposal,
                actionStatus: actionProposal?.status || this.openClawToolReceiptStatus(openClawToolReceipts),
                responseKind: openClawToolReceipts.length
                    ? 'OPENCLAW_TOOL_RESULT'
                    : 'CHAT',
                agentRunId: openClawToolReceipts.length === 1
                  ? openClawToolReceipts[0].agentRunId
                  : null,
                toolReceipts: openClawToolReceipts,
                responseSource,
                ...(actionProposal ? { actionSource: 'CRM' as const } : {}),
                ...(executionSessionDigest ? { executionSessionDigest } : {}),
              },
            },
            update: {},
          });
        } catch (error) {
          if (!this.isPrismaUniqueConstraintOn(error, 'requestKey')) throw error;
          // Prisma can surface a concurrent empty-update upsert as P2002
          // instead of returning the row inserted by the other renderer.
          // Re-read that durable winner and apply the same context checks
          // below; never turn a normal idempotency race into HTTP 500.
          persisted = await this.prisma.aiArtifact.findUnique({ where: { requestKey } });
          if (!persisted) {
            throw new ConflictException('Assistant request completed concurrently; retry with the same requestId');
          }
        }
        const persistedExtra = (persisted.extraData || {}) as Record<string, unknown>;
        if (
          persisted.companyId !== dto.companyId
          || persistedExtra.operatorUserId !== user.id
          || persistedExtra.requestContextDigest !== requestContextDigest
        ) {
          // Concurrent upsert with the same idempotency key but a different
          // context returns the winning row. Never reinterpret that old customer
          // artifact as the current request.
          throw new ConflictException('requestId was concurrently used for a different assistant request');
        }
        return persisted;
      } catch (error) {
        if (openClawClaimToken && openClawGatewaySessionDigest && this.openClawSessions) {
          // Persistence or context validation failed after this request had
          // claimed the Gateway. Best-effort release prevents a false RUNNING
          // lease; do not mask the original database/security exception.
          try {
            await this.openClawSessions.releaseExecution(openClawGatewaySessionDigest, openClawClaimToken);
          } catch {
            // The short lease still expires fail-closed if the release store is unavailable.
          }
        }
        throw error;
      }
    })();
    if (openClawClaimToken && openClawGatewaySessionDigest && this.openClawSessions) {
      await this.openClawSessions.settleExecution(openClawGatewaySessionDigest, openClawClaimToken);
    }
    return this.assistantTurnFromArtifact(artifact);
  }

  private async resolveOpenClawCustomer(
    companyId: string,
    leadId: string,
    user: AuthenticatedUser,
  ) {
    this.assertCompanyMembership(user, companyId);
    const lead = await this.prisma.lead.findFirst({
      where: {
        id: leadId,
        companyId,
        deletedAt: null,
        isMerged: false,
      },
      include: {
        conversations: {
          where: { channel: 'whatsapp', status: 'active' },
          include: {
            contactPoint: {
              select: {
                type: true,
                originalValue: true,
                normalizedValue: true,
                isVerified: true,
              },
            },
          },
          orderBy: { updatedAt: 'desc' },
        },
      },
    });
    if (!lead) {
      throw new ConflictException('The selected CRM customer is no longer active');
    }
    if (
      !this.isCompanyAdmin(user, companyId)
      && lead.ownerUserId !== user.id
      && !lead.conversations.some((conversation) => conversation.assignedUserId === user.id)
    ) {
      throw new ForbiddenException('The selected customer is outside the operator scope');
    }
    const trustedDirectConversations = lead.conversations.filter(
      isTrustedDirectWhatsappConversation,
    );
    const conversation = trustedDirectConversations.length === 1
      ? trustedDirectConversations[0]
      : null;
    return { conversation, lead };
  }

  private async evaluateOpenClawCapability(
    companyId: string,
    capability: string,
    scope: Record<string, unknown>,
    user: AuthenticatedUser,
  ) {
    if (!this.assistantPermissions) {
      return {
        decision: 'DENY' as const,
        reason: 'PERMISSION_SERVICE_UNAVAILABLE',
        profile: null,
      };
    }
    return this.assistantPermissions.evaluate(companyId, user, capability, scope);
  }

  private async runOpenClawBusinessAction<T extends Record<string, unknown>>(input: {
    companyId: string;
    requestKey: string;
    capability: string;
    targetType: string;
    targetId: string;
    scope: Record<string, unknown>;
    payload: Record<string, unknown>;
    forceApproval?: boolean;
    user: AuthenticatedUser;
    execute: () => Promise<T>;
  }): Promise<T | { status: 'APPROVAL_REQUIRED' | 'BLOCKED'; reason: string }> {
    const evaluation = await this.evaluateOpenClawCapability(
      input.companyId,
      input.capability,
      input.scope,
      input.user,
    );
    const decision = input.forceApproval && evaluation.decision === 'ALLOW'
      ? 'APPROVAL_REQUIRED'
      : evaluation.decision;
    const requestKey = `assistant-business:${input.requestKey}:${input.capability}`;
    const contextDigest = digestAgentInput({
      companyId: input.companyId,
      operatorUserId: input.user.id,
      capability: input.capability,
      scope: input.scope,
      targetType: input.targetType,
      targetId: input.targetId,
    });
    const payloadDigest = digestAgentInput(input.payload);
    const existing = await this.prisma.assistantBusinessAction.findUnique({
      where: { requestKey },
    });
    if (existing) {
      if (
        existing.companyId !== input.companyId
        || existing.operatorUserId !== input.user.id
        || existing.contextDigest !== contextDigest
        || existing.payloadDigest !== payloadDigest
      ) {
        throw new ConflictException('Assistant business action request key was reused in another context');
      }
      if (existing.state === AssistantActionState.SUCCEEDED && existing.result) {
        return existing.result as T;
      }
      if (existing.state === AssistantActionState.AWAITING_APPROVAL) {
        return { status: 'APPROVAL_REQUIRED', reason: 'EXISTING_APPROVAL_REQUIRED' };
      }
      if (
        existing.state === AssistantActionState.EXECUTING
        || existing.state === AssistantActionState.CLAIMED
      ) {
        throw new ConflictException('Assistant business action is already executing');
      }
      throw new ConflictException(`Assistant business action is terminal: ${existing.state}`);
    }

    const state = decision === 'ALLOW'
      ? AssistantActionState.POLICY_CHECKED
      : decision === 'APPROVAL_REQUIRED'
        ? AssistantActionState.AWAITING_APPROVAL
        : AssistantActionState.FAILED;
    const action = await this.prisma.assistantBusinessAction.create({
      data: {
        requestKey,
        idempotencyKey: digestAgentInput({ requestKey, contextDigest, payloadDigest }),
        companyId: input.companyId,
        operatorUserId: input.user.id,
        capability: input.capability,
        state,
        decision: decision as AssistantPolicyDecision,
        contextDigest,
        payloadDigest,
        targetType: input.targetType,
        targetId: input.targetId,
        policySnapshot: this.toJsonValue({
          preset: evaluation.profile?.preset || null,
          thresholds: evaluation.profile?.thresholds || null,
          reason: evaluation.reason,
          grantId: 'grantId' in evaluation ? evaluation.grantId || null : null,
        }),
        ...(decision === 'DENY' ? { errorCode: 'ASSISTANT_POLICY_DENIED', completedAt: new Date() } : {}),
      },
    });
    if (decision !== 'ALLOW') {
      return {
        status: decision === 'APPROVAL_REQUIRED' ? 'APPROVAL_REQUIRED' : 'BLOCKED',
        reason: input.forceApproval ? 'BUSINESS_THRESHOLD_REQUIRES_APPROVAL' : evaluation.reason,
      };
    }

    await this.prisma.assistantBusinessAction.update({
      where: { id: action.id },
      data: { state: AssistantActionState.EXECUTING, startedAt: new Date() },
    });
    try {
      const result = await input.execute();
      const completedAt = new Date();
      await this.prisma.assistantBusinessAction.update({
        where: { id: action.id },
        data: {
          state: AssistantActionState.SUCCEEDED,
          result: this.toJsonValue(result),
          receipt: this.toJsonValue({ source: 'postgresql', completedAt: completedAt.toISOString() }),
          completedAt,
        },
      });
      return result;
    } catch (error) {
      await this.prisma.assistantBusinessAction.update({
        where: { id: action.id },
        data: {
          state: AssistantActionState.FAILED,
          errorCode: error instanceof Error ? error.name : 'ASSISTANT_ACTION_FAILED',
          completedAt: new Date(),
        },
      });
      throw error;
    }
  }

  async getCustomerForOpenClaw(
    companyId: string,
    conversationId: string,
    user: AuthenticatedUser,
  ) {
    const { lead } = await this.resolveOpenClawCustomer(companyId, conversationId, user);
    const policy = await this.evaluateOpenClawCapability(
      companyId,
      'crm.customer.read',
      { customerId: lead.id },
      user,
    );
    if (policy.decision !== 'ALLOW') return { status: 'BLOCKED', reason: policy.reason };
    return {
      status: 'SUCCEEDED',
      customer: {
        name: this.redactOpenClawCustomerText(lead.companyName || lead.leadName || lead.contactName || '未命名客户'),
        country: lead.country ? this.redactOpenClawCustomerText(lead.country) : null,
        productCategory: lead.productCategory ? this.redactOpenClawCustomerText(lead.productCategory) : null,
        stage: lead.status,
        grade: lead.leadGrade,
        hasEmail: !!lead.contactEmail,
        hasWhatsapp: !!lead.whatsapp,
        nextFollowUpAt: lead.nextFollowUpAt?.toISOString() || null,
        updatedAt: lead.updatedAt.toISOString(),
      },
    };
  }

  async addCustomerNoteForOpenClaw(
    companyId: string,
    conversationId: string,
    note: string,
    requestKey: string,
    user: AuthenticatedUser,
  ) {
    const { lead } = await this.resolveOpenClawCustomer(companyId, conversationId, user);
    const normalizedNote = redactForExternalAi(note).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 1200);
    if (!normalizedNote) throw new BadRequestException('Customer note is empty after sanitization');
    return this.runOpenClawBusinessAction({
      companyId,
      requestKey,
      capability: 'crm.customer.note.write',
      targetType: 'lead',
      targetId: lead.id,
      scope: { customerId: lead.id },
      payload: { note: normalizedNote },
      user,
      execute: async () => {
        const activity = await this.prisma.leadActivity.create({
          data: {
            companyId,
            leadId: lead.id,
            userId: user.id,
            activityType: 'assistant_note',
            title: 'AI 业务助理新增备注',
            description: normalizedNote,
            occurredAt: new Date(),
          },
        });
        return { status: 'SUCCEEDED', activityId: activity.id, customerName: lead.companyName || lead.leadName || lead.contactName || '未命名客户' };
      },
    });
  }

  async setCustomerStageForOpenClaw(
    companyId: string,
    conversationId: string,
    stage: string,
    requestKey: string,
    user: AuthenticatedUser,
  ) {
    const allowedStages = ['new', 'contacted', 'replied', 'interested', 'quoted', 'won', 'lost'];
    if (!allowedStages.includes(stage)) throw new BadRequestException('Customer stage is invalid');
    const { lead } = await this.resolveOpenClawCustomer(companyId, conversationId, user);
    return this.runOpenClawBusinessAction({
      companyId,
      requestKey,
      capability: 'crm.customer.stage.write',
      targetType: 'lead',
      targetId: lead.id,
      scope: { customerId: lead.id },
      payload: { fromStage: lead.status, stage },
      user,
      execute: async () => this.prisma.$transaction(async (tx) => {
        await tx.lead.update({ where: { id: lead.id }, data: { status: stage } });
        await tx.leadActivity.create({
          data: {
            companyId,
            leadId: lead.id,
            userId: user.id,
            activityType: stage === 'won' ? 'won' : stage === 'lost' ? 'lost' : 'stage_changed',
            title: `AI 业务助理更新客户阶段：${stage}`,
            description: `${lead.status} → ${stage}`,
            metadata: { fromStage: lead.status, stage, source: 'openclaw' },
            occurredAt: new Date(),
          },
        });
        return { status: 'SUCCEEDED', customerName: lead.companyName || lead.leadName || lead.contactName || '未命名客户', previousStage: lead.status, stage };
      }),
    });
  }

  async updateCustomerForOpenClaw(
    companyId: string,
    conversationId: string,
    input: {
      companyName?: string;
      contactName?: string;
      country?: string;
      city?: string;
      industry?: string;
      productCategory?: string;
      language?: string;
    },
    requestKey: string,
    user: AuthenticatedUser,
  ) {
    const { lead } = await this.resolveOpenClawCustomer(companyId, conversationId, user);
    const limits: Record<keyof typeof input, number> = {
      companyName: 240,
      contactName: 160,
      country: 100,
      city: 100,
      industry: 160,
      productCategory: 180,
      language: 12,
    };
    const update: Record<string, string> = {};
    for (const [field, limit] of Object.entries(limits)) {
      const raw = input[field as keyof typeof input];
      if (typeof raw !== 'string') continue;
      const value = redactForExternalAi(raw)
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, limit);
      if (!value) throw new BadRequestException(`Customer ${field} is empty after sanitization`);
      update[field] = value;
    }
    if (!Object.keys(update).length) {
      throw new BadRequestException('At least one supported customer field is required');
    }
    if (update.language && !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(update.language)) {
      throw new BadRequestException('Customer language must be an ISO language code');
    }
    const userUpdatedFields = Object.keys(update);
    // Keep the OpenClaw customer-maintenance path consistent with the normal
    // authenticated CRM edit path. A company name written through this tool is
    // an explicit operator-directed edit, not an inferred WhatsApp display
    // name, so it is eligible to become the reviewed research subject.
    if (update.companyName) {
      update.companyNameSource = 'manual_confirmed';
      update.companyNameConfidence = 'high';
    }
    return this.runOpenClawBusinessAction({
      companyId,
      requestKey,
      capability: 'crm.customer.update',
      targetType: 'lead',
      targetId: lead.id,
      scope: { customerId: lead.id },
      payload: update,
      user,
      execute: async () => this.prisma.$transaction(async (tx) => {
        const updated = await tx.lead.update({ where: { id: lead.id }, data: update });
        await tx.leadActivity.create({
          data: {
            companyId,
            leadId: lead.id,
            userId: user.id,
            activityType: 'assistant_customer_update',
            title: 'AI 业务助理更新客户资料',
            description: `已更新字段：${userUpdatedFields.join('、')}`,
            metadata: { fields: userUpdatedFields, source: 'openclaw' },
            occurredAt: new Date(),
          },
        });
        return {
          status: 'SUCCEEDED',
          customerName: updated.companyName || updated.leadName || updated.contactName || '未命名客户',
          updatedFields: userUpdatedFields,
          updatedAt: updated.updatedAt.toISOString(),
        };
      }),
    });
  }

  async createTaskForOpenClaw(
    companyId: string,
    conversationId: string,
    input: { title: string; dueAt: string; priority?: string; reason?: string },
    requestKey: string,
    user: AuthenticatedUser,
  ) {
    const { lead } = await this.resolveOpenClawCustomer(companyId, conversationId, user);
    const dueAt = new Date(input.dueAt);
    if (!Number.isFinite(dueAt.getTime()) || dueAt <= new Date()) {
      throw new BadRequestException('Task dueAt must be a future UTC timestamp');
    }
    return this.runOpenClawBusinessAction({
      companyId,
      requestKey,
      capability: 'crm.task.write',
      targetType: 'lead',
      targetId: lead.id,
      scope: { customerId: lead.id },
      payload: input,
      user,
      execute: async () => {
        const reminder = await this.prisma.followUpReminder.create({
          data: {
            companyId,
            leadId: lead.id,
            userId: lead.ownerUserId || user.id,
            reminderType: 'assistant_follow_up',
            title: input.title.trim().slice(0, 180),
            reason: input.reason?.trim().slice(0, 500) || null,
            dueAt,
            status: 'Pending',
            priority: input.priority || 'Medium',
          },
        });
        return { status: 'SUCCEEDED', taskId: reminder.id, title: reminder.title, dueAt: reminder.dueAt.toISOString() };
      },
    });
  }

  async listOrdersForOpenClaw(companyId: string, conversationId: string, user: AuthenticatedUser) {
    const { lead } = await this.resolveOpenClawCustomer(companyId, conversationId, user);
    const policy = await this.evaluateOpenClawCapability(companyId, 'crm.order.read', { customerId: lead.id }, user);
    if (policy.decision !== 'ALLOW') return { status: 'BLOCKED', reason: policy.reason, orders: [] };
    const orders = await this.prisma.order.findMany({
      where: { companyId, leadId: lead.id },
      orderBy: { updatedAt: 'desc' },
      take: 12,
    });
    return {
      status: 'SUCCEEDED',
      orders: orders.map((order) => ({
        orderNo: order.orderNo,
        stage: order.stage,
        currency: order.currency,
        totalAmount: order.totalAmount.toString(),
        paidAmount: order.paidAmount.toString(),
        deliveryDate: order.deliveryDate?.toISOString() || null,
        updatedAt: order.updatedAt.toISOString(),
      })),
    };
  }

  async createOrderDraftForOpenClaw(
    companyId: string,
    conversationId: string,
    input: {
      currency?: string;
      totalAmount?: number;
      quoteReferenceNo?: string;
      deliveryDate?: string;
      shippingTerms?: string;
      notes?: string;
    },
    requestKey: string,
    user: AuthenticatedUser,
  ) {
    const { lead } = await this.resolveOpenClawCustomer(companyId, conversationId, user);
    const quote = input.quoteReferenceNo
      ? await this.prisma.quote.findFirst({
          where: { companyId, leadId: lead.id, referenceNo: input.quoteReferenceNo },
        })
      : null;
    if (input.quoteReferenceNo && !quote) throw new ConflictException('Quote reference does not belong to the selected customer');
    const totalAmount = input.totalAmount ?? (quote ? Number(quote.totalAmount) : 0);
    const profile = await this.assistantPermissions?.getProfile(companyId, user);
    const highValue = totalAmount > Number(profile?.thresholds.highValueUsd || 10_000);
    const orderNo = `ORD-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${requestKey.slice(0, 8).toUpperCase()}`;
    return this.runOpenClawBusinessAction({
      companyId,
      requestKey,
      capability: 'crm.order.draft.write',
      targetType: 'lead',
      targetId: lead.id,
      scope: { customerId: lead.id },
      payload: { ...input, totalAmount, quoteReferenceNo: quote?.referenceNo || null },
      forceApproval: highValue,
      user,
      execute: async () => {
        const order = await this.prisma.order.create({
          data: {
            companyId,
            orderNo,
            leadId: lead.id,
            quoteId: quote?.id || null,
            assignedUserId: lead.ownerUserId || user.id,
            stage: 'draft',
            currency: input.currency || quote?.currency || 'USD',
            totalAmount,
            paidAmount: 0,
            deliveryDate: input.deliveryDate ? new Date(`${input.deliveryDate}T00:00:00.000Z`) : null,
            shippingTerms: input.shippingTerms || quote?.tradeTerms || null,
            notes: input.notes?.trim().slice(0, 1200) || 'AI 业务助理创建的订单草稿',
            stageHistory: [{ stage: 'draft', changedAt: new Date().toISOString(), changedBy: user.id }],
          },
        });
        return { status: 'SUCCEEDED', orderNo: order.orderNo, stage: order.stage, currency: order.currency, totalAmount: order.totalAmount.toString() };
      },
    });
  }

  async updateOrderStageForOpenClaw(
    companyId: string,
    conversationId: string,
    orderNo: string,
    stage: string,
    requestKey: string,
    user: AuthenticatedUser,
  ) {
    const allowedStages = ['draft', 'won', 'sampling', 'production', 'qc', 'shipping', 'payment', 'completed', 'after_sales'];
    if (!allowedStages.includes(stage)) throw new BadRequestException('Order stage is invalid');
    const { lead } = await this.resolveOpenClawCustomer(companyId, conversationId, user);
    const order = await this.prisma.order.findFirst({ where: { companyId, leadId: lead.id, orderNo } });
    if (!order) throw new ConflictException('Order reference does not belong to the selected customer');
    const critical = ['payment', 'completed'].includes(stage);
    return this.runOpenClawBusinessAction({
      companyId,
      requestKey,
      capability: critical ? 'crm.order.status.critical' : 'crm.order.status.write',
      targetType: 'order',
      targetId: order.id,
      scope: { customerId: lead.id, orderNo },
      payload: { fromStage: order.stage, stage },
      user,
      execute: async () => {
        const history = Array.isArray(order.stageHistory) ? [...order.stageHistory as any[]] : [];
        history.push({ fromStage: order.stage, stage, changedAt: new Date().toISOString(), changedBy: user.id });
        const updated = await this.prisma.order.update({
          where: { id: order.id },
          data: { stage, stageHistory: history },
        });
        return { status: 'SUCCEEDED', orderNo: updated.orderNo, previousStage: order.stage, stage: updated.stage };
      },
    });
  }

  async listQuotesForOpenClaw(companyId: string, conversationId: string, user: AuthenticatedUser) {
    const { lead } = await this.resolveOpenClawCustomer(companyId, conversationId, user);
    const policy = await this.evaluateOpenClawCapability(companyId, 'crm.quote.read', { customerId: lead.id }, user);
    if (policy.decision !== 'ALLOW') return { status: 'BLOCKED', reason: policy.reason, quotes: [] };
    const quotes = await this.prisma.quote.findMany({
      where: { companyId, leadId: lead.id },
      orderBy: { updatedAt: 'desc' },
      take: 12,
    });
    return {
      status: 'SUCCEEDED',
      quotes: quotes.map((quote) => ({
        referenceNo: quote.referenceNo,
        type: quote.type,
        status: quote.status,
        currency: quote.currency,
        totalAmount: quote.totalAmount.toString(),
        updatedAt: quote.updatedAt.toISOString(),
      })),
    };
  }

  async searchProductsForOpenClaw(
    companyId: string,
    query: string,
    limit: number,
    user: AuthenticatedUser,
  ) {
    const policy = await this.evaluateOpenClawCapability(companyId, 'crm.product.read', {}, user);
    if (policy.decision !== 'ALLOW') return { status: 'BLOCKED', reason: policy.reason, products: [] };
    const needle = query.trim().toLowerCase();
    const effectiveLimit = Math.max(1, Math.min(20, Math.trunc(limit || 10)));
    const items = usdPriceCatalog.items.filter((item) => [
      item.catalogItemId,
      item.categoryCn,
      item.categoryEn,
      item.size,
      item.thickness,
    ].some((value) => String(value || '').toLowerCase().includes(needle))).slice(0, effectiveLimit);
    return {
      status: 'SUCCEEDED',
      priceVersion: usdPriceCatalog.priceVersion,
      currency: 'USD',
      requiresHumanApproval: usdPriceCatalog.pricingPolicy.requiresHumanApproval,
      products: items.map((item) => ({
        catalogItemId: item.catalogItemId,
        name: item.categoryEn || item.categoryCn,
        size: item.size,
        thickness: item.thickness,
        unit: item.unit,
        saleUsd: item.saleUsd,
      })),
    };
  }

  async createQuoteDraftForOpenClaw(
    companyId: string,
    conversationId: string,
    input: {
      lineItems: Array<{ catalogItemId: string; quantity: number; notes?: string }>;
      documentType?: 'quote' | 'pi';
      currency?: string;
      tradeTerms?: string;
      paymentTerms?: string;
      deliveryTime?: string;
      discount?: number;
      notes?: string;
    },
    requestKey: string,
    user: AuthenticatedUser,
  ) {
    const { lead, conversation } = await this.resolveOpenClawCustomer(companyId, conversationId, user);
    const catalogItems = input.lineItems.map((line) => {
      const item = usdPriceCatalog.items.find((candidate) => candidate.catalogItemId === line.catalogItemId);
      if (!item) throw new BadRequestException(`Unknown pricing catalog item: ${line.catalogItemId}`);
      return { line, item };
    });
    const subtotal = catalogItems.reduce((sum, { line, item }) => sum + line.quantity * item.saleUsd, 0);
    const discount = Number(input.discount || 0);
    if (discount > subtotal) throw new BadRequestException('Quote discount cannot exceed subtotal');
    const totalAmount = Number((subtotal - discount).toFixed(2));
    const profile = await this.assistantPermissions?.getProfile(companyId, user);
    const thresholds = profile?.thresholds || { highValueUsd: 10_000, maxAutoDiscountPercent: 5 };
    const discountPercent = subtotal > 0 ? discount / subtotal * 100 : 0;
    const forceApproval = totalAmount > Number(thresholds.highValueUsd)
      || discountPercent > Number(thresholds.maxAutoDiscountPercent);
    const documentType = input.documentType === 'pi' ? 'pi' : 'quote';
    const referencePrefix = documentType === 'pi' ? 'PI' : 'QT';
    const referenceNo = `${referencePrefix}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${requestKey.slice(0, 8).toUpperCase()}`;
    return this.runOpenClawBusinessAction({
      companyId,
      requestKey,
      capability: 'crm.quote.draft.write',
      targetType: 'lead',
      targetId: lead.id,
      scope: { customerId: lead.id },
      payload: { ...input, documentType, subtotal, totalAmount, priceVersion: usdPriceCatalog.priceVersion },
      forceApproval,
      user,
      execute: async () => {
        const quote = await this.prisma.quote.create({
          data: {
            companyId,
            referenceNo,
            type: documentType,
            status: 'draft',
            leadId: lead.id,
            conversationId: conversation?.id || null,
            assignedUserId: lead.ownerUserId || user.id,
            currency: 'USD',
            tradeTerms: input.tradeTerms?.trim().slice(0, 120) || 'FOB Shenzhen',
            paymentTerms: input.paymentTerms?.trim().slice(0, 240) || null,
            deliveryTime: input.deliveryTime?.trim().slice(0, 120) || null,
            discount,
            subtotal,
            taxAmount: 0,
            totalAmount,
            notes: input.notes?.trim().slice(0, 1200) || 'AI 业务助理创建的报价草稿',
            aiExtracted: true,
            lineItems: {
              create: catalogItems.map(({ line, item }, index) => ({
                productCode: item.catalogItemId,
                productName: item.categoryEn || item.categoryCn,
                size: item.size,
                thickness: item.thickness,
                quantity: line.quantity,
                unit: item.unit || 'pc',
                unitPrice: item.saleUsd,
                totalPrice: Number((line.quantity * item.saleUsd).toFixed(2)),
                catalogItemId: item.catalogItemId,
                costPriceCny: item.costCny,
                sourceCurrency: usdPriceCatalog.pricingPolicy.sourceCurrency,
                fxRate: usdPriceCatalog.pricingPolicy.protectionFxRateCnyPerUsd,
                markup: usdPriceCatalog.pricingPolicy.markup,
                priceVersion: usdPriceCatalog.priceVersion,
                priceSource: usdPriceCatalog.source,
                sortOrder: index,
                notes: line.notes?.trim().slice(0, 300) || null,
              })),
            },
          },
        });
        return { status: 'SUCCEEDED', documentType: quote.type, referenceNo: quote.referenceNo, quoteStatus: quote.status, currency: quote.currency, subtotal: quote.subtotal.toString(), totalAmount: quote.totalAmount.toString(), priceVersion: usdPriceCatalog.priceVersion };
      },
    });
  }

  async searchCustomersForOpenClaw(
    companyId: string,
    query: string,
    limit: number,
    user: AuthenticatedUser,
  ) {
    this.assertCompanyMembership(user, companyId);
    const value = query.trim();
    if (!value) throw new BadRequestException('customer search query is required');
    const contains = { contains: value, mode: 'insensitive' as const };
    const digits = value.replace(/\D/g, '');
    const requestedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 5;
    const effectiveLimit = Math.max(1, Math.min(10, requestedLimit));
    // Fetch one extra lead so a small presentation limit can never be
    // mistaken for proof that the CRM search itself resolved uniquely.
    const leadCandidates = await this.prisma.lead.findMany({
      where: {
        companyId,
        deletedAt: null,
        ...(this.isCompanyAdmin(user, companyId) ? {} : { ownerUserId: user.id }),
        OR: [
          { companyName: contains },
          { leadName: contains },
          { contactName: contains },
          ...(digits.length >= 7
            ? [{ contactPhone: { contains: digits } }, { whatsapp: { contains: digits } }]
            : []),
        ],
      },
      select: {
        id: true,
        companyName: true,
        leadName: true,
        contactName: true,
        country: true,
        productCategory: true,
        status: true,
        leadGrade: true,
        updatedAt: true,
        conversations: {
          where: { channel: 'whatsapp', status: 'active' },
          select: {
            id: true,
            whatsappSessionId: true,
            isGroup: true,
            externalThreadId: true,
            contactPoint: {
              select: {
                type: true,
                originalValue: true,
                normalizedValue: true,
                isVerified: true,
              },
            },
          },
          orderBy: { updatedAt: 'desc' },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: effectiveLimit + 1,
    });
    const hasMore = leadCandidates.length > effectiveLimit;
    const leads = leadCandidates.slice(0, effectiveLimit);
    const uniqueMatch = !hasMore && leads.length === 1;
    return {
      count: leads.length,
      hasMore,
      uniqueMatch,
      customers: leads.map(({ id: trustedLeadId, conversations, ...lead }) => {
        const trustedDirectConversations = conversations.filter(
          isTrustedDirectWhatsappConversation,
        );
        const trustedTargets = new Set(
          trustedDirectConversations
            .map((conversation) => String(conversation.externalThreadId || '')
              .replace(/@s\.whatsapp\.net$/i, '')
              .replace(/\D/g, ''))
            .filter((target) => /^\d{7,15}$/.test(target)),
        );
        // Electron and server Baileys may each persist a conversation for the
        // same verified E.164 customer. That is one delivery target, not an
        // ambiguity. Prefer the newest conversation backed by a persisted
        // server session; keep fail-closed behavior when the customer truly
        // has different direct phone targets.
        const trustedConversation = trustedDirectConversations.length === 1
          ? trustedDirectConversations[0]
          : trustedTargets.size === 1
            ? trustedDirectConversations.find((conversation) => !!conversation.whatsappSessionId)
              || trustedDirectConversations[0]
            : null;
        return {
          trustedLeadId,
          customerName: this.redactOpenClawCustomerText(
            lead.companyName || lead.leadName || lead.contactName || '未命名客户',
          ),
          country: lead.country,
          productCategory: lead.productCategory
            ? this.redactOpenClawCustomerText(lead.productCategory)
            : null,
          status: lead.status,
          leadGrade: lead.leadGrade,
          updatedAt: lead.updatedAt,
          whatsappConversationId: trustedConversation?.id || null,
        };
      }),
    };
  }

  private redactOpenClawCustomerText(value: string): string {
    return redactForExternalAi(value)
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[ID_REDACTED]')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 240);
  }

  async prepareQuoteDeliveryForOpenClaw(
    companyId: string,
    leadId: string,
    requestKey: string,
    sessionDigest: string,
    user: AuthenticatedUser,
    actionSource: AssistantActionSource,
  ) {
    this.assertCompanyMembership(user, companyId);
    const { conversation } = await this.resolveOpenClawCustomer(companyId, leadId, user);
    const dto: AssistantChatDto = {
      requestId: '00000000-0000-4000-8000-000000000000',
      companyId,
      message: '发送当前客户的最新报价单',
      pathname: '/whatsapp/chat',
      threadId: `openclaw:${sessionDigest.slice(0, 64)}`,
      whatsapp: { name: '', phone: '', conversationId: conversation?.id },
    };
    const actionProposal = await this.buildQuoteDeliveryProposal(dto, user);
    if (!actionProposal) throw new ConflictException('No quote preparation proposal was produced');
    const outputContent = actionProposal.status === 'REQUIRES_CONFIRMATION'
      ? '已创建报价交付提案。请在 CRM 核对确认后，手动把 PDF 拖入 WhatsApp 并点击发送。'
      : `未创建报价交付提案：${actionProposal.reason || '当前客户不满足安全条件'}`;
    const artifactKey = `openclaw:quote-proposal:${requestKey}`;
    const artifact = await this.prisma.aiArtifact.upsert({
      where: { requestKey: artifactKey },
      create: {
        requestKey: artifactKey,
        companyId,
        conversationId: actionProposal.target?.conversationId,
        leadId: actionProposal.target?.leadId,
        artifactType: 'assistant_chat',
        assistantOperatorUserId: user.id,
        assistantThreadId: dto.threadId,
        inputContent: dto.message,
        outputContent,
        provider: 'system',
        model: 'deterministic-action',
        status: 'generated',
        extraData: {
          operatorUserId: user.id,
          threadId: dto.threadId,
          pathname: dto.pathname,
          requestContextDigest: this.assistantRequestContextDigest(dto, user),
          permission: 'human_confirmed_quote_preparation',
          actionProposal,
          actionStatus: actionProposal.status,
          responseKind: actionProposal.status === 'BLOCKED' ? 'ACTION_BLOCKED' : 'CHAT',
          responseSource: 'openclaw_tool_broker',
          actionSource,
        },
      },
      update: {},
    });
    this.assertAssistantArtifactContext(artifact, dto, user);
    return this.assistantTurnFromArtifact(artifact);
  }

  async startBackgroundResearchForOpenClaw(
    companyId: string,
    leadId: string,
    requestKey: string,
    sessionDigest: string,
    user: AuthenticatedUser,
    actionSource: AssistantActionSource,
  ) {
    this.assertCompanyMembership(user, companyId);
    const { conversation, lead } = await this.resolveOpenClawCustomer(companyId, leadId, user);
    const dto: AssistantChatDto = {
      requestId: '00000000-0000-4000-8000-000000000000',
      companyId,
      message: '开始对当前客户进行背景调查',
      pathname: '/ai-workbench',
      threadId: `openclaw:${sessionDigest.slice(0, 64)}`,
      ...(conversation
        ? { whatsapp: { name: '', phone: '', conversationId: conversation.id } }
        : {}),
    };
    const researchRequestKey = `openclaw-research:${requestKey}`;
    const subject = assessResearchSubject(lead);
    let action: AssistantResearchAction;
    if (!subject.trusted) {
      action = {
        kind: 'BACKGROUND_RESEARCH',
        status: 'BLOCKED',
        reason: subject.code === 'MISSING_COMPANY_NAME'
          ? '客户缺少已确认的公司名称，无法启动企业背调。'
          : '客户公司名称尚未经过人工确认，无法启动企业背调。',
        conversationId: conversation?.id,
        leadId: lead.id,
      };
    } else {
      const run = await this.researchRuns.enqueueForLead({
        companyId,
        leadId: lead.id,
        type: 'full',
        source: 'assistant_chat',
        conversationId: conversation?.id,
        requestKey: researchRequestKey,
      }, user);
      const statusByRun: Partial<Record<AgentRunStatus, AssistantResearchAction['status']>> = {
        [AgentRunStatus.PENDING]: 'QUEUED',
        [AgentRunStatus.RUNNING]: 'RUNNING',
        [AgentRunStatus.COMPLETED]: 'COMPLETED',
        [AgentRunStatus.FAILED]: 'FAILED',
        [AgentRunStatus.CANCELLED]: 'CANCELLED',
      };
      const status = statusByRun[run.status as AgentRunStatus];
      if (!status) {
        throw new ConflictException(`Background research run is in unsupported state: ${run.status}`);
      }
      action = {
        kind: 'BACKGROUND_RESEARCH',
        status,
        agentRunId: run.id,
        conversationId: conversation?.id,
        leadId: lead.id,
      };
    }
    return this.persistBackgroundResearchTurn(
      dto,
      user,
      action,
      `openclaw:research-chat:${requestKey}`,
      actionSource,
    );
  }

  private async readAssistantQuoteAction(id: string, user: AuthenticatedUser) {
    const artifact = await this.prisma.aiArtifact.findFirst({
      where: { id, artifactType: 'assistant_chat' },
    });
    if (!artifact) throw new NotFoundException('Assistant action proposal not found');
    this.assertCompanyMembership(user, artifact.companyId);
    const extra = (artifact.extraData || {}) as Record<string, unknown>;
    if (extra.operatorUserId !== user.id && !this.isCompanyAdmin(user, artifact.companyId)) {
      throw new ForbiddenException('Only the proposal owner or company administrator may confirm it');
    }
    const proposal = extra.actionProposal as AssistantQuoteDeliveryProposal | null | undefined;
    if (
      !proposal
      || proposal.kind !== 'PREPARE_QUOTE_DELIVERY'
      || proposal.status !== 'REQUIRES_CONFIRMATION'
      || !proposal.quote
      || !proposal.target
    ) {
      throw new ConflictException('This assistant turn has no confirmable quote action');
    }
    return {
      artifact,
      extra,
      proposal: proposal as ConfirmableAssistantQuoteDeliveryProposal,
    };
  }

  private assistantActionClaimDigest(claimToken: string) {
    return createHash('sha256').update(claimToken, 'utf8').digest('hex');
  }

  async confirmAssistantAction(id: string, user: AuthenticatedUser) {
    const { artifact, extra, proposal } = await this.readAssistantQuoteAction(id, user);
    // Recovery probe after a lost /complete HTTP response. This is JWT-scoped
    // state reconciliation, not claim-token replay: no token is returned and
    // only the exact user recorded as acceptedBy receives the terminal result.
    if (artifact.status === 'accepted' || artifact.acceptedAt) {
      if (artifact.status === 'accepted' && artifact.acceptedBy === user.id) {
        return {
          proposalId: artifact.id,
          actionProposal: proposal,
          status: 'PREPARATION_CONFIRMED',
          accepted: true,
          actionStatus: 'PREPARATION_CONFIRMED',
        };
      }
      throw new ConflictException('This quote preparation proposal was already completed');
    }
    const expiresAt = typeof proposal.expiresAt === 'string'
      ? Date.parse(proposal.expiresAt)
      : Number.NaN;
    if (!Number.isFinite(expiresAt)) {
      throw new ConflictException('This quote preparation proposal has an invalid expiry');
    }
    if (expiresAt <= Date.now()) {
      throw new ConflictException('This quote preparation proposal has expired');
    }

    const conversationId = typeof proposal.target.conversationId === 'string'
      ? proposal.target.conversationId.trim()
      : '';
    if (!conversationId) {
      throw new ConflictException('This quote preparation proposal has no trusted conversation');
    }
    const proposedPhone = this.normalizeWhatsappPhone(proposal.target.phone);
    if (!proposedPhone) {
      throw new ConflictException('This quote preparation proposal has no trusted WhatsApp number');
    }

    const isAdmin = this.isCompanyAdmin(user, artifact.companyId);
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        companyId: artifact.companyId,
        channel: 'whatsapp',
        ...(isAdmin
          ? {}
          : {
              OR: [
                { assignedUserId: user.id },
                { lead: { ownerUserId: user.id } },
              ],
            }),
      },
      select: {
        id: true,
        leadId: true,
        assignedUserId: true,
        isGroup: true,
        externalThreadId: true,
        contactPoint: {
          select: {
            type: true,
            originalValue: true,
            normalizedValue: true,
            isVerified: true,
          },
        },
        lead: {
          select: {
            id: true,
            ownerUserId: true,
          },
        },
      },
    });
    if (!conversation) {
      throw new ForbiddenException('The WhatsApp conversation is no longer accessible');
    }
    if (!isTrustedDirectWhatsappConversation(conversation)) {
      throw new ConflictException('The WhatsApp conversation group status is not verified as private');
    }

    const currentPhone = conversation.contactPoint?.type === 'whatsapp'
      && conversation.contactPoint.isVerified
      ? this.normalizeWhatsappPhone(
          conversation.contactPoint.normalizedValue || conversation.contactPoint.originalValue,
        )
      : '';
    if (!currentPhone || currentPhone !== proposedPhone) {
      throw new ConflictException('The verified WhatsApp recipient no longer matches this proposal');
    }
    if (proposal.target.leadId && proposal.target.leadId !== conversation.leadId) {
      throw new ConflictException('The CRM customer linked to this conversation has changed');
    }
    if (artifact.conversationId && artifact.conversationId !== conversation.id) {
      throw new ConflictException('The proposal is no longer linked to the same conversation');
    }
    if (artifact.leadId && artifact.leadId !== conversation.leadId) {
      throw new ConflictException('The proposal is no longer linked to the same customer');
    }

    // 确认时重新核对报价仍在同一公司/客户范围，防止旧卡在报价归属或状态变化后继续使用。
    const quoteStillValid = await this.prisma.quote.findFirst({
      where: {
        id: proposal.quote.id,
        companyId: artifact.companyId,
        type: 'quote',
        status: { notIn: ['rejected', 'expired'] },
        ...(isAdmin ? {} : { assignedUserId: user.id }),
        OR: [
          { conversationId: conversation.id },
          ...(conversation.leadId ? [{ leadId: conversation.leadId }] : []),
        ],
      },
      select: { id: true },
    });
    if (!quoteStillValid) {
      throw new ConflictException('The quotation is no longer valid for this customer');
    }

    const claimedAt = new Date();
    const claimExpiresAt = new Date(Math.min(
      claimedAt.getTime() + ASSISTANT_ACTION_CLAIM_TTL_MS,
      expiresAt,
    ));
    const claimToken = randomBytes(32).toString('base64url');
    const claimDigest = this.assistantActionClaimDigest(claimToken);
    const claim = await this.prisma.aiArtifact.updateMany({
      where: {
        id: artifact.id,
        acceptedAt: null,
        OR: [
          {
            status: 'generated',
            actionClaimDigest: null,
          },
          {
            status: 'processing',
            actionClaimExpiresAt: { lte: claimedAt },
          },
        ],
      },
      data: {
        status: 'processing',
        actionClaimDigest: claimDigest,
        actionClaimedBy: user.id,
        actionClaimExpiresAt: claimExpiresAt,
        extraData: {
          ...extra,
          actionStatus: 'PREPARATION_IN_PROGRESS',
          preparationClaimedAt: claimedAt.toISOString(),
          preparationClaimExpiresAt: claimExpiresAt.toISOString(),
        } as Prisma.InputJsonValue,
      },
    });
    if (claim.count !== 1) {
      const refreshed = await this.prisma.aiArtifact.findUnique({ where: { id: artifact.id } });
      if (refreshed?.status === 'accepted' && refreshed.acceptedBy === user.id) {
        return {
          proposalId: artifact.id,
          actionProposal: proposal,
          status: 'PREPARATION_CONFIRMED',
          accepted: true,
          actionStatus: 'PREPARATION_CONFIRMED',
        };
      }
      throw new ConflictException('This quote preparation proposal is already being prepared');
    }
    return {
      proposalId: artifact.id,
      actionProposal: proposal,
      status: 'PREPARATION_CLAIMED',
      accepted: false,
      actionStatus: 'PREPARATION_IN_PROGRESS',
      claimToken,
      claimExpiresAt: claimExpiresAt.toISOString(),
    };
  }

  async completeAssistantAction(
    id: string,
    claimToken: string,
    user: AuthenticatedUser,
  ) {
    const { artifact, extra, proposal } = await this.readAssistantQuoteAction(id, user);
    const now = new Date();
    const claimDigest = this.assistantActionClaimDigest(claimToken);
    const completed = await this.prisma.aiArtifact.updateMany({
      where: {
        id: artifact.id,
        status: 'processing',
        acceptedAt: null,
        actionClaimDigest: claimDigest,
        actionClaimedBy: user.id,
        actionClaimExpiresAt: { gt: now },
      },
      data: {
        status: 'accepted',
        acceptedBy: user.id,
        acceptedAt: now,
        // Keep only the one-way digest as an audit marker. The terminal status
        // prevents token reuse; no raw claim secret is persisted or logged.
        actionClaimExpiresAt: null,
        extraData: {
          ...extra,
          actionStatus: 'PREPARATION_CONFIRMED',
          confirmedBy: user.id,
          confirmedAt: now.toISOString(),
        } as Prisma.InputJsonValue,
      },
    });
    if (completed.count !== 1) {
      throw new ConflictException('Quote preparation claim is invalid, expired, or already consumed');
    }
    return {
      proposalId: artifact.id,
      actionProposal: proposal,
      status: 'PREPARATION_CONFIRMED',
      accepted: true,
      actionStatus: 'PREPARATION_CONFIRMED',
    };
  }

  async releaseAssistantAction(
    id: string,
    claimToken: string,
    failureCode: string | undefined,
    user: AuthenticatedUser,
  ) {
    const { artifact, extra, proposal } = await this.readAssistantQuoteAction(id, user);
    const claimDigest = this.assistantActionClaimDigest(claimToken);
    const releasedAt = new Date();
    const released = await this.prisma.aiArtifact.updateMany({
      where: {
        id: artifact.id,
        status: 'processing',
        acceptedAt: null,
        actionClaimDigest: claimDigest,
        actionClaimedBy: user.id,
      },
      data: {
        status: 'generated',
        actionClaimDigest: null,
        actionClaimedBy: null,
        actionClaimExpiresAt: null,
        extraData: {
          ...extra,
          actionStatus: 'REQUIRES_CONFIRMATION',
          preparationReleasedAt: releasedAt.toISOString(),
          ...(failureCode ? { preparationFailureCode: failureCode } : {}),
        } as Prisma.InputJsonValue,
      },
    });
    if (released.count !== 1) {
      throw new ConflictException('Quote preparation claim is invalid or already consumed');
    }
    return {
      proposalId: artifact.id,
      actionProposal: proposal,
      status: 'PREPARATION_RELEASED',
      accepted: false,
      actionStatus: 'REQUIRES_CONFIRMATION',
    };
  }

  async findOne(id: string, user: AuthenticatedUser) {
    const run = await this.prisma.agentRun.findUnique({
      where: { id },
      include: {
        tasks: true,
        authorizations: { select: this.authorizationPublicSelect() },
        auditLogs: { orderBy: { createdAt: 'asc' } },
        researchReport: { select: { id: true, title: true, type: true, createdAt: true } },
      },
    });
    if (!run) throw new NotFoundException('Agent run not found');
    this.assertRunAccess(run, user);
    return {
      ...run,
      researchReport: run.status === AgentRunStatus.COMPLETED ? run.researchReport : null,
    };
  }

  async cancel(id: string, user: AuthenticatedUser) {
    const run = await this.prisma.agentRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException('Agent run not found');
    this.assertRunAccess(run, user);
    if (
      run.status !== AgentRunStatus.PENDING
      && run.status !== AgentRunStatus.RUNNING
      && run.status !== AgentRunStatus.AWAITING_APPROVAL
    ) {
      throw new ConflictException('Only pending or running runs can be cancelled');
    }
    return this.prisma.$transaction(async (tx) => {
      const completedAt = new Date();
      const claimed = await tx.agentRun.updateMany({
        where: {
          id,
          companyId: run.companyId,
          status: {
            in: [
              AgentRunStatus.PENDING,
              AgentRunStatus.RUNNING,
              AgentRunStatus.AWAITING_APPROVAL,
            ],
          },
        },
        data: {
          status: AgentRunStatus.CANCELLED,
          completedAt,
          executionClaimId: null,
          executionLeaseExpiresAt: null,
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException('Run completed or was cancelled concurrently');
      }
      await tx.agentTask.updateMany({
        where: { runId: id, status: { in: [AgentTaskStatus.PENDING, AgentTaskStatus.RUNNING] } },
        data: { status: AgentTaskStatus.CANCELLED, completedAt },
      });
      // A report created just before cancellation must not appear as a valid
      // customer report. The worker also repeats this scoped cleanup after a
      // cancel/complete race, covering reports written just after this delete.
      await tx.deepResearchReport.deleteMany({
        where: { agentRunId: id, companyId: run.companyId },
      });
      await tx.agentAuditLog.create({
        data: { companyId: run.companyId, runId: id, actorUserId: user.id, eventType: 'RUN_CANCELLED' },
      });
      return tx.agentRun.findUniqueOrThrow({ where: { id } });
    });
  }

  async confirmAuthorization(id: string, user: AuthenticatedUser) {
    return this.prisma.$transaction(async (tx) => {
      const authorization = await tx.agentAuthorization.findUnique({
        where: { id }, include: { run: true },
      });
      if (!authorization) throw new NotFoundException('Authorization not found');
      this.assertCompanyMembership(user, authorization.companyId);
      if (!this.isCompanyAdmin(user, authorization.companyId)) {
        throw new ForbiddenException('Company administrator approval is required');
      }
      if (authorization.status !== AgentAuthorizationStatus.PENDING) {
        throw new ConflictException('Authorization is not pending');
      }
      const now = new Date();
      if (authorization.expiresAt <= now) {
        await tx.agentAuthorization.update({
          where: { id }, data: { status: AgentAuthorizationStatus.EXPIRED },
        });
        throw new ConflictException('Authorization expired');
      }
      const claimed = await tx.agentAuthorization.updateMany({
        where: { id, status: AgentAuthorizationStatus.PENDING, expiresAt: { gt: now } },
        data: {
          status: AgentAuthorizationStatus.CONFIRMED,
          confirmedByUserId: user.id,
          confirmedAt: now,
        },
      });
      if (claimed.count !== 1) throw new ConflictException('Authorization was already handled');
      await tx.agentAuditLog.create({
        data: {
          companyId: authorization.companyId,
          runId: authorization.runId,
          actorUserId: user.id,
          eventType: 'AUTHORIZATION_CONFIRMED',
          inputDigest: authorization.authorizationHash,
          metadata: { actionType: authorization.actionType },
        },
      });
      return tx.agentAuthorization.findUnique({ where: { id } });
    });
  }

  /** Internal-only atomic gate for future high-risk tools. No public execution endpoint exists. */
  async consumeAuthorization(id: string, expectedHash: string) {
    return this.prisma.$transaction(async (tx) => {
      const authorization = await tx.agentAuthorization.findUnique({ where: { id } });
      if (!authorization) throw new NotFoundException('Authorization not found');
      const now = new Date();
      if (
        authorization.status !== AgentAuthorizationStatus.CONFIRMED ||
        authorization.expiresAt <= now ||
        !equalAgentDigest(authorization.authorizationHash, expectedHash) ||
        !authorization.confirmedByUserId
      ) {
        throw new ForbiddenException('Authorization is invalid, expired, or unconfirmed');
      }
      const consumed = await tx.agentAuthorization.updateMany({
        where: { id, status: AgentAuthorizationStatus.CONFIRMED, expiresAt: { gt: now } },
        data: { status: AgentAuthorizationStatus.CONSUMED, consumedAt: now },
      });
      if (consumed.count !== 1) throw new ConflictException('Authorization was already consumed');
      await tx.agentAuditLog.create({
        data: {
          companyId: authorization.companyId,
          runId: authorization.runId,
          actorUserId: authorization.confirmedByUserId,
          eventType: 'AUTHORIZATION_CONSUMED',
          inputDigest: expectedHash,
          metadata: { actionType: authorization.actionType },
        },
      });
      return true;
    });
  }

  private async executeSafeRun(runId: string, dto: CreateAgentRunDto, lead: any, user: AuthenticatedUser) {
    const startedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.agentRun.update({ where: { id: runId }, data: { status: AgentRunStatus.RUNNING, startedAt } }),
      this.prisma.agentTask.updateMany({ where: { runId }, data: { status: AgentTaskStatus.RUNNING, startedAt } }),
    ]);

    try {
      let result: Prisma.InputJsonValue;
      if (dto.kind === SafeAgentRunKind.READ_LEAD_SUMMARY) {
        result = {
          leadId: lead.id,
          leadName: lead.leadName,
          companyName: lead.companyName,
          country: lead.country,
          productCategory: lead.productCategory,
          status: lead.status,
        };
      } else {
        const safeBrief = redactForExternalAi(dto.brief!.trim());
        const aiResult = await this.ai.chat(
          'Draft a professional B2B follow-up. Return draft text only. Never send it.',
          `Language: ${dto.language || 'English'}\nBrief: ${safeBrief}`,
          { task: 'agent_draft_follow_up', maxTokens: 600, temperature: 0.4 },
        );
        if (!aiResult.success) throw new Error(`AI_UNAVAILABLE:${aiResult.reason || 'unknown'}`);
        result = { draft: aiResult.content, language: dto.language || 'English', sent: false };
      }

      const completedAt = new Date();
      return await this.prisma.$transaction(async (tx) => {
        await tx.agentTask.updateMany({
          where: { runId, status: AgentTaskStatus.RUNNING },
          data: { status: AgentTaskStatus.COMPLETED, result, completedAt },
        });
        const completed = await tx.agentRun.update({
          where: { id: runId },
          data: { status: AgentRunStatus.COMPLETED, result, completedAt },
          include: { tasks: true, authorizations: { select: this.authorizationPublicSelect() } },
        });
        await tx.agentAuditLog.create({
          data: {
            companyId: dto.companyId,
            runId,
            actorUserId: user.id,
            eventType: 'RUN_COMPLETED',
            metadata: { kind: dto.kind, externalSideEffect: false },
          },
        });
        return completed;
      });
    } catch (error) {
      const errorCode = error instanceof Error && error.message.startsWith('AI_UNAVAILABLE:')
        ? 'AI_UNAVAILABLE'
        : 'SAFE_TOOL_FAILED';
      const completedAt = new Date();
      return this.prisma.$transaction(async (tx) => {
        await tx.agentTask.updateMany({
          where: { runId, status: AgentTaskStatus.RUNNING },
          data: { status: AgentTaskStatus.FAILED, errorCode, completedAt },
        });
        const failed = await tx.agentRun.update({
          where: { id: runId },
          data: { status: AgentRunStatus.FAILED, errorCode, completedAt },
          include: { tasks: true, authorizations: { select: this.authorizationPublicSelect() } },
        });
        await tx.agentAuditLog.create({
          data: {
            companyId: dto.companyId,
            runId,
            actorUserId: user.id,
            eventType: 'RUN_FAILED',
            metadata: { kind: dto.kind, errorCode },
          },
        });
        return failed;
      });
    }
  }

  private assertRunAccess(run: { companyId: string; operatorUserId: string }, user: AuthenticatedUser) {
    this.assertCompanyMembership(user, run.companyId);
    if (run.operatorUserId !== user.id && !this.isCompanyAdmin(user, run.companyId)) {
      throw new ForbiddenException('Agent run belongs to another operator');
    }
  }

  private authorizationPublicSelect() {
    return {
      id: true,
      actionType: true,
      status: true,
      expiresAt: true,
      confirmedAt: true,
      consumedAt: true,
      createdAt: true,
    } as const;
  }

  private assertCompanyMembership(user: AuthenticatedUser, companyId: string) {
    if (!user?.id || !user.companies?.some((company) => company.id === companyId)) {
      throw new ForbiddenException('No access to this company');
    }
  }

  private isCompanyAdmin(user: AuthenticatedUser, companyId: string) {
    return user.companies?.some(
      (company) => company.id === companyId && ['company_admin', 'super_admin'].includes(company.role),
    ) ?? false;
  }

  private toJsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
