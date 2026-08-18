export type AssistantToolName =
  | 'customer_asset_read'
  | 'customer_timeline_read'
  | 'task_follow_up_create'
  | 'quote_draft_create'
  | 'message_draft_prepare'
  | 'order_status_read'
  | 'quote_status_read';

export type AssistantToolDefinition = {
  name: AssistantToolName;
  description: string;
  confirmationRequired: boolean;
  schema: Record<string, unknown>;
};

const leadId = { type: 'string', format: 'uuid' };

export const ASSISTANT_TOOL_REGISTRY: readonly AssistantToolDefinition[] = [
  { name: 'customer_asset_read', description: 'Read the selected customer asset, contacts, conversations, quotes and orders.', confirmationRequired: false, schema: { type: 'object', required: ['leadId'], properties: { leadId } } },
  { name: 'customer_timeline_read', description: 'Read the selected customer timeline from the CRM timeline service.', confirmationRequired: false, schema: { type: 'object', required: ['leadId'], properties: { leadId, limit: { type: 'integer', minimum: 1, maximum: 100 } } } },
  { name: 'task_follow_up_create', description: 'Create one CRM follow-up task for a selected customer.', confirmationRequired: true, schema: { type: 'object', required: ['leadId', 'title', 'dueAt'], properties: { leadId, title: { type: 'string', minLength: 1, maxLength: 180 }, dueAt: { type: 'string', format: 'date-time' }, priority: { type: 'string', enum: ['Low', 'Medium', 'High'] }, reason: { type: 'string', maxLength: 500 } } } },
  { name: 'quote_draft_create', description: 'Create a CRM quote draft. It never sends the quote.', confirmationRequired: true, schema: { type: 'object', required: ['leadId', 'lineItems'], properties: { leadId, lineItems: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', required: ['productName', 'quantity', 'unitPrice'], properties: { productName: { type: 'string', minLength: 1, maxLength: 240 }, quantity: { type: 'number', minimum: 1 }, unitPrice: { type: 'number', minimum: 0 } } } }, currency: { type: 'string', enum: ['USD'] }, notes: { type: 'string', maxLength: 1200 } } } },
  { name: 'message_draft_prepare', description: 'Prepare a WhatsApp or email draft without sending it.', confirmationRequired: true, schema: { type: 'object', required: ['leadId', 'channel', 'body'], properties: { leadId, channel: { type: 'string', enum: ['whatsapp', 'email'] }, subject: { type: 'string', maxLength: 240 }, body: { type: 'string', minLength: 1, maxLength: 12000 } } } },
  { name: 'order_status_read', description: 'Read orders for a selected customer.', confirmationRequired: false, schema: { type: 'object', required: ['leadId'], properties: { leadId, stage: { type: 'string' } } } },
  { name: 'quote_status_read', description: 'Read quotes for a selected customer.', confirmationRequired: false, schema: { type: 'object', required: ['leadId'], properties: { leadId, status: { type: 'string' } } } },
];

const TOOL_BY_NAME = new Map(ASSISTANT_TOOL_REGISTRY.map((tool) => [tool.name, tool]));

export function getAssistantTool(name: string): AssistantToolDefinition | undefined {
  return TOOL_BY_NAME.get(name as AssistantToolName);
}

export function listAssistantTools(): readonly AssistantToolDefinition[] {
  return ASSISTANT_TOOL_REGISTRY;
}
