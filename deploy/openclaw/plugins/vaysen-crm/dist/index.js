import { Type } from 'typebox';
import { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin';
import { createNotifyOwnerRoute, ownerNotificationRuntimeReady } from './notify-owner.js';
import {
  actorForToolCall,
  callBroker,
  createToolResult,
  mapCustomerSearchReceipt,
  mapQuoteReceipt,
  mapResearchReceipt,
  normalizeAcceptanceMarker,
  normalizeSelectionToken,
  rememberCustomerSelection,
  resolveTrustedActor,
  useExactSelectionToken,
} from './runtime.js';

const configSchema = Type.Object({
  apiBaseUrl: Type.Literal('http://backend:4000'),
  keyId: Type.String({ minLength: 3, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' }),
  hmacSecret: Type.String({ minLength: 48, maxLength: 512 }),
  requestTimeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 30000 })),
}, { additionalProperties: false });

function ownerOnlyTool({ name, label, description, parameters, path, buildBody, mapResult }) {
  return {
    name,
    label,
    description,
    parameters,
    factory({ config, toolContext }) {
      let baseActor;
      try {
        baseActor = resolveTrustedActor(toolContext);
      } catch {
        return null;
      }
      return {
        name,
        label,
        description,
        parameters,
        executionMode: 'sequential',
        async execute(toolCallId, params, signal) {
          // The model must never be responsible for copying an opaque
          // capability correctly. Inject the exact tool-scoped token from the
          // latest unique search before normalization/building the request.
          // The backend still validates tenant, actor, session, tool, target,
          // expiry and one-use consumption.
          const trustedParams = useExactSelectionToken(baseActor, name, params);
          const input = buildBody(trustedParams);
          const payload = await callBroker({
            config,
            path,
            body: {
              actor: actorForToolCall(baseActor, toolCallId),
              ...(input === undefined ? {} : { input }),
            },
            signal,
          });
          if (name === 'crm_customer_search') {
            rememberCustomerSelection(baseActor, payload);
          }
          return createToolResult(mapResult ? mapResult(payload) : payload);
        },
      };
    },
  };
}

const selectionTokenProperty = () => Type.Optional(Type.String({ maxLength: 128 }));

const selectionParameters = (properties = {}) => Type.Object({
  selectionToken: selectionTokenProperty(),
  ...properties,
}, { additionalProperties: false });

const selectionBody = (params) => ({
  ...params,
  selectionToken: normalizeSelectionToken(params.selectionToken),
});

const toolEntry = defineToolPlugin({
  id: 'vaysen-crm',
  name: 'Vaysen AI CRM Tools',
  description: 'Fail-closed, HMAC-authenticated tools for the Vaysen AI CRM boundary.',
  configSchema,
  tools: () => [
    ownerOnlyTool({
      name: 'crm_work_brief',
      label: 'CRM Work Brief',
      description: 'Read the authenticated owner\'s current CRM work brief from real business data.',
      parameters: Type.Object({
        acceptanceMarker: Type.Optional(Type.String({
          minLength: 28,
          maxLength: 28,
          pattern: '^JYACC_OWNER_[a-f0-9]{16}$',
        })),
      }, { additionalProperties: false }),
      path: '/api/internal/openclaw/tools/work-brief',
      buildBody: ({ acceptanceMarker }) => {
        const marker = normalizeAcceptanceMarker(acceptanceMarker);
        return marker === undefined ? undefined : { acceptanceMarker: marker };
      },
    }),
    ownerOnlyTool({
      name: 'crm_customer_search',
      label: 'CRM Customer Search',
      description: 'Search CRM customers by a business clue; never auto-select an ambiguous customer.',
      parameters: Type.Object({
        query: Type.String({ minLength: 2, maxLength: 160 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      }, { additionalProperties: false }),
      path: '/api/internal/openclaw/tools/customer-search',
      buildBody: ({ query, limit }) => ({
        query: query.trim(),
        ...(limit === undefined ? {} : { limit }),
      }),
      mapResult: mapCustomerSearchReceipt,
    }),
    ownerOnlyTool({
      name: 'crm_customer_get',
      label: 'CRM Customer Detail',
      description: 'Read the uniquely selected customer from PostgreSQL. Requires the one-use customer-get token from a unique CRM search.',
      parameters: selectionParameters(),
      path: '/api/internal/openclaw/tools/customer-get',
      buildBody: selectionBody,
    }),
    ownerOnlyTool({
      name: 'crm_customer_add_note',
      label: 'Add CRM Customer Note',
      description: 'Write an audited note to the uniquely selected customer. This is a real CRM mutation governed by the assistant permission profile.',
      parameters: selectionParameters({
        note: Type.String({ minLength: 1, maxLength: 1200 }),
      }),
      path: '/api/internal/openclaw/tools/customer-add-note',
      buildBody: selectionBody,
    }),
    ownerOnlyTool({
      name: 'crm_customer_set_stage',
      label: 'Update CRM Customer Stage',
      description: 'Update the selected customer stage and write an audit activity. Never claim completion unless the broker receipt is SUCCEEDED.',
      parameters: selectionParameters({
        stage: Type.Union(['new', 'contacted', 'replied', 'interested', 'quoted', 'won', 'lost'].map((value) => Type.Literal(value))),
      }),
      path: '/api/internal/openclaw/tools/customer-set-stage',
      buildBody: selectionBody,
    }),
    ownerOnlyTool({
      name: 'crm_customer_update',
      label: 'Update CRM Customer Profile',
      description: 'Update reviewed non-identity profile fields for the uniquely selected customer and write an audit activity.',
      parameters: selectionParameters({
        companyName: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
        contactName: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
        country: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
        city: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
        industry: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
        productCategory: Type.Optional(Type.String({ minLength: 1, maxLength: 180 })),
        language: Type.Optional(Type.String({ pattern: '^[a-z]{2}(?:-[A-Z]{2})?$' })),
      }),
      path: '/api/internal/openclaw/tools/customer-update',
      buildBody: selectionBody,
    }),
    ownerOnlyTool({
      name: 'crm_task_create',
      label: 'Create CRM Follow-up Task',
      description: 'Create a real follow-up task for the selected customer under the configured permission policy.',
      parameters: selectionParameters({
        title: Type.String({ minLength: 1, maxLength: 180 }),
        dueAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$' }),
        priority: Type.Optional(Type.Union(['Low', 'Medium', 'High'].map((value) => Type.Literal(value)))),
        reason: Type.Optional(Type.String({ maxLength: 500 })),
      }),
      path: '/api/internal/openclaw/tools/task-create',
      buildBody: selectionBody,
    }),
    ownerOnlyTool({
      name: 'crm_order_list',
      label: 'List CRM Customer Orders',
      description: 'Read recent real orders belonging to the uniquely selected customer.',
      parameters: selectionParameters(),
      path: '/api/internal/openclaw/tools/order-list',
      buildBody: selectionBody,
    }),
    ownerOnlyTool({
      name: 'crm_order_create_draft',
      label: 'Create CRM Order Draft',
      description: 'Create a real draft order for the selected customer. High-value drafts stop for approval.',
      parameters: selectionParameters({
        currency: Type.Optional(Type.String({ pattern: '^[A-Z]{3}$' })),
        totalAmount: Type.Optional(Type.Number({ minimum: 0, maximum: 100000000 })),
        quoteReferenceNo: Type.Optional(Type.String({ maxLength: 80 })),
        deliveryDate: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
        shippingTerms: Type.Optional(Type.String({ maxLength: 160 })),
        notes: Type.Optional(Type.String({ maxLength: 1200 })),
      }),
      path: '/api/internal/openclaw/tools/order-create-draft',
      buildBody: selectionBody,
    }),
    ownerOnlyTool({
      name: 'crm_order_update_stage',
      label: 'Update CRM Order Stage',
      description: 'Update a selected customer order stage. Payment and completion transitions always require explicit human approval.',
      parameters: selectionParameters({
        orderNo: Type.String({ pattern: '^ORD-[A-Z0-9-]{6,40}$' }),
        stage: Type.Union(['draft', 'won', 'sampling', 'production', 'qc', 'shipping', 'payment', 'completed', 'after_sales'].map((value) => Type.Literal(value))),
      }),
      path: '/api/internal/openclaw/tools/order-update-stage',
      buildBody: selectionBody,
    }),
    ownerOnlyTool({
      name: 'crm_quote_list',
      label: 'List CRM Customer Quotes',
      description: 'Read recent real quotations belonging to the uniquely selected customer.',
      parameters: selectionParameters(),
      path: '/api/internal/openclaw/tools/quote-list',
      buildBody: selectionBody,
    }),
    ownerOnlyTool({
      name: 'crm_quote_create_draft',
      label: 'Create USD Quote Draft',
      description: 'Create a real USD quotation draft from the approved price catalog. The model cannot override catalog unit prices; high-value or excessive discounts require approval.',
      parameters: selectionParameters({
        lineItems: Type.Array(Type.Object({
          catalogItemId: Type.String({ pattern: '^JYM-\\d{4}$' }),
          quantity: Type.Integer({ minimum: 1, maximum: 100000000 }),
          notes: Type.Optional(Type.String({ maxLength: 300 })),
        }, { additionalProperties: false }), { minItems: 1, maxItems: 20 }),
        documentType: Type.Optional(Type.Union(['quote', 'pi'].map((value) => Type.Literal(value)))),
        currency: Type.Optional(Type.Literal('USD')),
        tradeTerms: Type.Optional(Type.String({ maxLength: 120 })),
        paymentTerms: Type.Optional(Type.String({ maxLength: 240 })),
        deliveryTime: Type.Optional(Type.String({ maxLength: 120 })),
        discount: Type.Optional(Type.Number({ minimum: 0, maximum: 1000000 })),
        notes: Type.Optional(Type.String({ maxLength: 1200 })),
      }),
      path: '/api/internal/openclaw/tools/quote-create-draft',
      buildBody: selectionBody,
    }),
    ownerOnlyTool({
      name: 'crm_whatsapp_messages_read',
      label: 'Read Customer WhatsApp Messages',
      description: 'Read a minimal redacted history for the uniquely selected direct WhatsApp customer. No target identifier can be supplied by the model.',
      parameters: selectionParameters({
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
      }),
      path: '/api/internal/openclaw/tools/whatsapp-messages-read',
      buildBody: selectionBody,
    }),
    ownerOnlyTool({
      name: 'crm_whatsapp_send_text',
      label: 'Send WhatsApp Text to Selected Customer',
      description: 'Send one real WhatsApp text to the uniquely selected direct customer through the connected server Baileys account. Call crm_customer_search first; the plugin injects its exact session-bound token automatically. Requires the supervisor policy and a provider receipt.',
      parameters: selectionParameters({
        text: Type.String({ minLength: 1, maxLength: 4000 }),
      }),
      path: '/api/internal/openclaw/tools/whatsapp-send-text',
      buildBody: selectionBody,
    }),
    ownerOnlyTool({
      name: 'crm_whatsapp_send_quote',
      label: 'Send Approved Quote PDF to Selected Customer',
      description: 'Generate and send one approved quote PDF to the uniquely selected direct WhatsApp customer. The backend derives the customer, Baileys account, target and PDF; the model may supply only a quote reference returned by crm_quote_list.',
      parameters: selectionParameters({
        referenceNo: Type.String({ pattern: '^(?:QT|PI)-[A-Z0-9-]{6,64}$' }),
      }),
      path: '/api/internal/openclaw/tools/whatsapp-send-quote',
      buildBody: selectionBody,
    }),
    ownerOnlyTool({
      name: 'crm_email_messages_read',
      label: 'Read Customer Email Messages',
      description: 'Read a minimal redacted email history for the uniquely selected customer. Recipient and account are resolved only by the backend.',
      parameters: selectionParameters({
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
      }),
      path: '/api/internal/openclaw/tools/email-messages-read',
      buildBody: selectionBody,
    }),
    ownerOnlyTool({
      name: 'crm_email_send',
      label: 'Send Email to Selected Customer',
      description: 'Send one real SMTP email to the uniquely selected customer trusted email through the company active account. Call crm_customer_search first; the plugin injects its exact session-bound token automatically. The model cannot choose an address or account.',
      parameters: selectionParameters({
        subject: Type.String({ minLength: 1, maxLength: 240 }),
        body: Type.String({ minLength: 1, maxLength: 12000 }),
      }),
      path: '/api/internal/openclaw/tools/email-send',
      buildBody: selectionBody,
    }),
    ownerOnlyTool({
      name: 'crm_email_reply',
      label: 'Reply to Selected Customer Email',
      description: 'Reply through the selected customer latest trusted business-email thread and company active account. The model cannot choose an address, account, or thread id.',
      parameters: selectionParameters({
        subject: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
        body: Type.String({ minLength: 1, maxLength: 12000 }),
      }),
      path: '/api/internal/openclaw/tools/email-reply',
      buildBody: selectionBody,
    }),
    ownerOnlyTool({
      name: 'crm_product_search',
      label: 'Search Approved USD Price Catalog',
      description: 'Search the versioned company product catalog and approved USD sale prices. This tool is read-only and never invents a price.',
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 120 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      }, { additionalProperties: false }),
      path: '/api/internal/openclaw/tools/product-search',
      buildBody: ({ query, limit }) => ({
        query: query.trim(),
        ...(limit === undefined ? {} : { limit }),
      }),
    }),
    ownerOnlyTool({
      name: 'crm_start_background_research',
      label: 'Start Background Research',
      description: 'Start an audited research run only with the one-use research selectionToken returned by a unique CRM customer search.',
      parameters: selectionParameters(),
      path: '/api/internal/openclaw/tools/start-background-research',
      buildBody: selectionBody,
      mapResult: mapResearchReceipt,
    }),
    ownerOnlyTool({
      name: 'crm_prepare_quote_delivery',
      label: 'Prepare Quote Delivery',
      description: 'Prepare, but never send, a quote proposal only with the one-use quote selectionToken returned by a unique CRM customer search.',
      parameters: selectionParameters(),
      path: '/api/internal/openclaw/tools/prepare-quote-delivery',
      buildBody: selectionBody,
      mapResult: mapQuoteReceipt,
    }),
  ],
});

export default {
  ...toolEntry,
  register(api) {
    toolEntry.register(api);
    api.registerHttpRoute(createNotifyOwnerRoute(api));
    api.registerHttpRoute({
      path: '/api/v1/vaysen/health',
      auth: 'gateway',
      match: 'exact',
      handler(req, res) {
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.setHeader('allow', 'GET');
          res.end();
          return true;
        }
        const config = api.pluginConfig ?? {};
        const brokerConfigured = config.apiBaseUrl === 'http://backend:4000'
          && typeof config.keyId === 'string'
          && /^[A-Za-z0-9._-]{3,64}$/.test(config.keyId)
          && typeof config.hmacSecret === 'string'
          && Buffer.byteLength(config.hmacSecret, 'utf8') >= 48;
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify({
          schemaVersion: 1,
          pluginId: 'vaysen-crm',
          pluginVersion: '1.3.2',
          adapterReady: true,
          brokerConfigured,
          ownerNotificationReady: ownerNotificationRuntimeReady(api),
        }));
        return true;
      },
    });
  },
};
