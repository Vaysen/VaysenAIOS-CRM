# Vaysen CRM OpenClaw tools

Version 1.3.2 exposes 21 owner-scoped CRM tools. They cover work briefs, customer search/detail/maintenance, follow-up tasks, orders, quotations, the approved USD catalog, background research, WhatsApp history/text/approved-quote delivery, and email history/send/reply. Action capabilities are injected by the trusted plugin from the current unique customer search before parameter normalization, so opaque one-use tokens cannot be mistyped or confused across tools.

`crm_customer_search` is the mandatory gate for every customer-scoped tool. Only an exactly-one customer with one trusted direct WhatsApp conversation receives independent, short-lived, one-use `selectionToken` capabilities. Tokens are bound to tenant, owner, account, assistant session, source request/message, target tool and trusted conversation. Wrong-context, expired, stale, cross-tool or replayed tokens fail closed.

The model cannot choose a tenant, user, sender, CRM UUID, WhatsApp JID, phone number, email address, email account, thread, file path or URL. The backend derives those values from the authenticated context and trusted CRM data.

Supervisor mode may send one WhatsApp text, one approved quote PDF, or one email/reply to the uniquely selected customer. Quote delivery accepts only a `referenceNo` returned by that customer's quote list; the backend re-resolves the quote by company and lead, requires `approved`, regenerates the PDF, selects one connected server-side Baileys account and requires a real provider receipt. Bulk, group and arbitrary-target sends remain unavailable.

Every broker request uses timestamped, nonce-bound HMAC-SHA256 over the exact `/api/internal/openclaw/tools/*` path and raw JSON body. Mutating calls use durable idempotency receipts. The backend remains the authorization, tenant, RBAC, scope, rate-limit and audit boundary.

The gateway-auth fixed route `/api/v1/vaysen/notify-owner` is not a model tool. It accepts only `ownerDigest`, `eventKey` and `text`, resolves exactly one bound `openclaw-weixin` target inside Gateway, and requires a real channel `messageId`. Raw Weixin identifiers never leave the Gateway response boundary.
