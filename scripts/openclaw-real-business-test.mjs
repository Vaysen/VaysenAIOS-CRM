#!/usr/bin/env node

/**
 * Real authenticated OpenClaw business acceptance.
 *
 * This test deliberately writes a background-research run and sends exactly
 * one clearly marked WhatsApp message to an explicitly selected CRM
 * conversation. It must never be called from the normal deploy smoke gate.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const baseUrl = new URL(required('OPENCLAW_E2E_BASE_URL'));
const companyId = required('OPENCLAW_E2E_COMPANY_ID');
const conversationId = required('OPENCLAW_E2E_TARGET_CONVERSATION_ID');
const confirmation = required('OPENCLAW_E2E_CONFIRM_REAL_WHATSAPP_SEND');
const whatsappText = required('OPENCLAW_E2E_WHATSAPP_TEXT');
const tokenFile = process.env.OPENCLAW_E2E_BEARER_TOKEN_FILE?.trim();
const directToken = process.env.OPENCLAW_E2E_BEARER_TOKEN?.trim();

if (!/^[0-9a-f-]{36}$/i.test(companyId) || !/^[0-9a-f-]{36}$/i.test(conversationId)) {
  throw new Error('company and conversation identifiers must be UUIDs');
}
if (confirmation !== `SEND_ONE_REAL_WHATSAPP_TO_${conversationId}`) {
  throw new Error('real WhatsApp confirmation does not match the exact target conversation');
}
if (!/^\[Vaysen 系统验收\]/.test(whatsappText) || whatsappText.length > 400) {
  throw new Error('test message must start with [Vaysen 系统验收] and be at most 400 characters');
}
if ((tokenFile && directToken) || (!tokenFile && !directToken)) {
  throw new Error('provide exactly one bearer token source');
}
if (!['http:', 'https:'].includes(baseUrl.protocol)
  || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
  throw new Error('invalid E2E base URL');
}
const privateHttp = baseUrl.protocol === 'http:' && (
  ['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname)
  || /^10\./.test(baseUrl.hostname)
  || /^192\.168\./.test(baseUrl.hostname)
  || /^172\.(1[6-9]|2\d|3[01])\./.test(baseUrl.hostname)
);
if (baseUrl.protocol !== 'https:' && !privateHttp) {
  throw new Error('HTTP is allowed only for an explicit private-LAN or loopback origin');
}

let token = directToken;
if (tokenFile) {
  const stat = statSync(tokenFile);
  if (!stat.isFile()) throw new Error('bearer token path is not a regular file');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('bearer token file must be owned by the current user');
  }
  const mode = stat.mode & 0o777;
  if (![0o400, 0o600].includes(mode)) throw new Error('bearer token file mode must be 0400 or 0600');
  token = readFileSync(tokenFile, 'utf8').trim();
}
if (!token || /[\r\n]/.test(token)) throw new Error('bearer token must be one non-empty line');

const apiUrl = (path) => new URL(
  path.replace(/^\//, ''),
  `${baseUrl.toString().replace(/\/$/, '')}/api/`,
);
const headers = {
  accept: 'application/json',
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
};
const fetchJson = async (path, options = {}, timeoutMs = 30_000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(apiUrl(path), {
      ...options,
      headers: { ...headers, ...(options.headers || {}) },
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { /* fail below */ }
    if (!response.ok) throw new Error(`CRM API ${response.status} ${response.statusText}`);
    if (payload === null) throw new Error('CRM API returned a non-JSON response');
    return payload?.data ?? payload;
  } finally {
    clearTimeout(timer);
  }
};

const detail = await fetchJson(`communications/conversations/${encodeURIComponent(conversationId)}`);
if (detail?.id !== conversationId || detail?.companyId !== companyId) {
  throw new Error('target conversation does not belong to the authenticated company');
}
if (String(detail?.channel || '').toLowerCase() !== 'whatsapp'
  || String(detail?.externalThreadId || '').endsWith('@g.us')
  || detail?.isGroup === true
  || !detail?.lead?.id) {
  throw new Error('target must be a linked direct WhatsApp customer conversation');
}
const phoneDigits = String(
  detail?.contactPoint?.normalizedValue
  || detail?.lead?.contactPhone
  || detail?.externalThreadId
  || '',
).replace(/\D/g, '');
if (!/^\d{7,15}$/.test(phoneDigits)) throw new Error('target conversation has no trusted phone identity');
const customerName = String(
  process.env.OPENCLAW_E2E_TARGET_CUSTOMER_QUERY?.trim()
  || detail?.lead?.companyName
  || detail?.lead?.contactName
  || '',
).trim();
if (customerName.length < 2 || customerName.length > 160) {
  throw new Error('target customer query is missing or invalid');
}
const whatsapp = {
  name: String(detail?.lead?.companyName || detail?.lead?.contactName || customerName).slice(0, 160),
  phone: `+${phoneDigits}`,
  conversationId,
  leadId: detail.lead.id,
  isGroup: false,
};

const runAssistantScene = async ({ label, message, expectedTools, pathname }) => {
  const requestId = randomUUID();
  const body = {
    requestId,
    companyId,
    threadId: `openclaw-real-${label}-${requestId}`.slice(0, 100),
    pathname,
    message,
    whatsapp,
  };
  const deadline = Date.now() + 120_000;
  let turn;
  while (Date.now() < deadline) {
    turn = await fetchJson('agent-runs/assistant/chat', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const receipts = Array.isArray(turn?.toolReceipts) ? turn.toolReceipts : [];
    const names = new Set(receipts.map((item) => item?.toolName));
    if (expectedTools.every((tool) => names.has(tool))
      && receipts.every((item) => item?.status !== 'PROCESSING')) break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (turn?.responseKind !== 'OPENCLAW_TOOL_RESULT') {
    throw new Error(`${label}: assistant did not return verified OpenClaw receipts`);
  }
  const receipts = Array.isArray(turn.toolReceipts) ? turn.toolReceipts : [];
  if (receipts.some((item) => !expectedTools.includes(item?.toolName))) {
    throw new Error(`${label}: assistant called an unexpected business tool`);
  }
  for (const toolName of expectedTools) {
    const receipt = receipts.find((item) => item?.toolName === toolName);
    if (!receipt || receipt.status !== 'COMPLETED' || receipt.businessStatus !== 'SUCCEEDED'
      || !/^[a-f0-9]{64}$/.test(receipt.requestId || '')) {
      throw new Error(`${label}: ${toolName} has no successful durable receipt`);
    }
  }
  return { requestId, turn, receipts };
};

const customerScene = await runAssistantScene({
  label: 'customer',
  pathname: '/ai-workbench',
  message: [
    `在当前公司客户库中搜索“${customerName}”。`,
    '必须先调用 crm_customer_search；只有唯一匹配时再调用 crm_customer_get。',
    '只根据真实工具回执汇报客户资料，不得猜测或补写。',
  ].join(''),
  expectedTools: ['crm.customer_search', 'crm.customer_get'],
});

const researchStartedAt = Date.now();
const researchScene = await runAssistantScene({
  label: 'research',
  pathname: '/ai-workbench',
  message: [
    `为客户“${customerName}”启动真实企业背调。`,
    '必须先调用 crm_customer_search 唯一匹配，再调用 crm_start_background_research。',
    '不得只生成背调方案或文案。',
  ].join(''),
  expectedTools: ['crm.customer_search', 'crm.start_background_research'],
});

const researchTimeoutMs = Math.min(
  Math.max(Number(process.env.OPENCLAW_E2E_RESEARCH_TIMEOUT_MS || 420_000), 60_000),
  900_000,
);
let researchRun;
const researchDeadline = Date.now() + researchTimeoutMs;
while (Date.now() < researchDeadline) {
  const runsPayload = await fetchJson(`agent-runs?companyId=${encodeURIComponent(companyId)}`);
  const runs = Array.isArray(runsPayload) ? runsPayload : [];
  researchRun = runs.find((run) => (
    run?.kind === 'BACKGROUND_RESEARCH'
    && run?.subjectId === detail.lead.id
    && Date.parse(run?.createdAt || '') >= researchStartedAt - 5_000
  ));
  if (researchRun && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(researchRun.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 3_000));
}
if (!researchRun || researchRun.status !== 'COMPLETED') {
  throw new Error(`research run did not complete successfully: ${researchRun?.status || 'not found'}`);
}

const beforeMessages = Array.isArray(detail.messages) ? detail.messages : [];
if (beforeMessages.some((item) => item?.content === whatsappText && item?.externalMessageId)) {
  throw new Error('the exact acceptance message already has a provider receipt; choose a new unique message');
}
const whatsappScene = await runAssistantScene({
  label: 'whatsapp',
  pathname: '/whatsapp/chat',
  message: [
    `给当前客户“${customerName}”发送下面这一条 WhatsApp 验收消息：${whatsappText}`,
    '必须先调用 crm_customer_search 唯一匹配，再调用 crm_whatsapp_send_text。',
    '不得改写文本，不得发送第二条，不得只返回文案。',
  ].join(''),
  expectedTools: ['crm.customer_search', 'crm.whatsapp_send_text'],
});

let outbound;
const messageDeadline = Date.now() + 60_000;
while (Date.now() < messageDeadline) {
  const refreshed = await fetchJson(`communications/conversations/${encodeURIComponent(conversationId)}`);
  outbound = Array.isArray(refreshed?.messages)
    ? refreshed.messages.find((item) => (
      item?.direction === 'outbound'
      && item?.content === whatsappText
      && typeof item?.externalMessageId === 'string'
      && item.externalMessageId.trim().length > 0
      && item?.deliveryStatus !== 'failed'
    ))
    : undefined;
  if (outbound) break;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
if (!outbound) throw new Error('WhatsApp message has no persisted provider message receipt');

console.log(JSON.stringify({
  schemaVersion: 1,
  companyId,
  conversationId,
  customerRequestId: customerScene.requestId,
  researchRequestId: researchScene.requestId,
  researchRunId: researchRun.id,
  researchStatus: researchRun.status,
  whatsappRequestId: whatsappScene.requestId,
  whatsappReceipt: whatsappScene.receipts.find((item) => item.toolName === 'crm.whatsapp_send_text')?.requestId,
  providerMessageId: outbound.externalMessageId,
  deliveryStatus: outbound.deliveryStatus,
  sentAt: outbound.sentAt || outbound.createdAt,
}));
