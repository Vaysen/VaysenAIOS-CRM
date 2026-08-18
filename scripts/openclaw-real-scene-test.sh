#!/usr/bin/env bash
# Real authenticated CRM -> OpenClaw -> signed broker -> CRM database E2E.
# This test performs no external customer-facing business action: it invokes
# crm_work_brief and verifies the persisted AgentRun/AgentTask audit receipt
# instead of trusting natural-language model output. It is intentionally not
# described as database-read-only because those receipts are durable writes.

set -euo pipefail

BASE_URL="${OPENCLAW_E2E_BASE_URL:-}"
TOKEN="${OPENCLAW_E2E_BEARER_TOKEN:-}"
TOKEN_FILE="${OPENCLAW_E2E_BEARER_TOKEN_FILE:-}"
COMPANY_ID="${OPENCLAW_E2E_COMPANY_ID:-}"
REQUIRE_WECHAT_BOUND="${OPENCLAW_E2E_REQUIRE_WECHAT_BOUND:-false}"

fail() { printf '[OPENCLAW E2E ERROR] %s\n' "$*" >&2; exit 1; }
ok() { printf '[OPENCLAW E2E OK] %s\n' "$*"; }

[ -n "$BASE_URL" ] || fail 'OPENCLAW_E2E_BASE_URL is required (for example http://127.0.0.1)'
if [ -n "$TOKEN" ] && [ -n "$TOKEN_FILE" ]; then
  fail 'provide exactly one of OPENCLAW_E2E_BEARER_TOKEN or OPENCLAW_E2E_BEARER_TOKEN_FILE'
fi
if [ -n "$TOKEN_FILE" ]; then
  [ -f "$TOKEN_FILE" ] || fail 'OPENCLAW_E2E_BEARER_TOKEN_FILE must be a regular file'
  [ "$(stat -c '%u' "$TOKEN_FILE")" = "$(id -u)" ] \
    || fail 'OPENCLAW_E2E_BEARER_TOKEN_FILE must be owned by the deployment user'
  token_mode="$(stat -c '%a' "$TOKEN_FILE")"
  [ "$token_mode" = '600' ] || [ "$token_mode" = '400' ] \
    || fail 'OPENCLAW_E2E_BEARER_TOKEN_FILE mode must be 600 or 400'
elif [ -z "$TOKEN" ]; then
  fail 'an authenticated company-admin token or mode-600 token file is required'
fi
case "$REQUIRE_WECHAT_BOUND" in true|false) ;; *) fail 'OPENCLAW_E2E_REQUIRE_WECHAT_BOUND must be true or false' ;; esac
printf '%s' "$COMPANY_ID" | grep -Eqi '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' \
    || fail 'OPENCLAW_E2E_COMPANY_ID must be a UUID'

OPENCLAW_E2E_BASE_URL="$BASE_URL" \
OPENCLAW_E2E_BEARER_TOKEN="$TOKEN" \
OPENCLAW_E2E_BEARER_TOKEN_FILE="$TOKEN_FILE" \
OPENCLAW_E2E_COMPANY_ID="$COMPANY_ID" \
OPENCLAW_E2E_REQUIRE_WECHAT_BOUND="$REQUIRE_WECHAT_BOUND" \
node --input-type=module - <<'NODE'
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const baseUrl = new URL(process.env.OPENCLAW_E2E_BASE_URL);
const token = process.env.OPENCLAW_E2E_BEARER_TOKEN
  || readFileSync(process.env.OPENCLAW_E2E_BEARER_TOKEN_FILE, 'utf8').trim();
const companyId = process.env.OPENCLAW_E2E_COMPANY_ID;
const requireWechatBound = process.env.OPENCLAW_E2E_REQUIRE_WECHAT_BOUND === 'true';
if (!token || /[\r\n]/.test(token)) {
  throw new Error('E2E bearer token must be one non-empty line');
}
const privateHttp = baseUrl.protocol === 'http:' && (
  baseUrl.hostname === 'localhost'
  || baseUrl.hostname === '127.0.0.1'
  || baseUrl.hostname === '::1'
  || /^10\./.test(baseUrl.hostname)
  || /^192\.168\./.test(baseUrl.hostname)
  || /^172\.(1[6-9]|2\d|3[01])\./.test(baseUrl.hostname)
);
if (baseUrl.protocol !== 'https:' && !privateHttp) {
  throw new Error('E2E base URL must be HTTPS or an explicit loopback/private-LAN HTTP origin');
}
if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
  throw new Error('E2E base URL must not contain credentials, query, or fragment');
}

const api = (path) => new URL(path.replace(/^\//, ''), `${baseUrl.toString().replace(/\/$/, '')}/api/`);
const headers = {
  accept: 'application/json',
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
};
const fetchWithTimeout = async (url, options = {}, timeoutMs = 20_000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};
const getJson = async (url, options = {}) => {
  const response = await fetchWithTimeout(url, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  if (!response.ok) throw new Error(`CRM API ${response.status} ${response.statusText}`);
  return payload;
};

const postChatRaw = async (body) => {
  const response = await fetchWithTimeout(api('agent-runs/assistant/chat'), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  return { status: response.status, ok: response.ok, payload };
};

const listUrl = api(`agent-runs?companyId=${encodeURIComponent(companyId)}`);
const requestId = randomUUID();
const threadId = `openclaw-e2e-${requestId}`;
const profile = await getJson(api('auth/me'));
if (!profile || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(profile.id || '')) {
  throw new Error('authenticated admin profile did not return a valid operator id');
}
const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};
const gatewaySessionDigest = createHash('sha256').update(stableJson({
  namespace: 'vaysen-crm',
  companyId,
  operatorUserId: profile.id,
  threadId,
  requestId,
}), 'utf8').digest('hex');
const executionSessionDigest = createHash('sha256')
  .update(`vaysen-crm:${gatewaySessionDigest}`, 'utf8')
  .digest('hex');
const chatRequest = {
  requestId,
  companyId,
  threadId,
  pathname: '/ai-workbench',
  message: [
    '这是只读生产验收。',
    '必须调用 crm_work_brief 恰好一次，不得调用其他工具。',
    '只按工具真实回执汇报，不得编造已完成事项。',
  ].join(''),
};

// Exercise a real renderer/network retry race. Exactly one request may enter
// the Gateway; the loser may receive 409 while the lease is live, or the same
// completed artifact when the winner finishes first.
const concurrent = await Promise.all([
  postChatRaw(chatRequest),
  postChatRaw(chatRequest),
]);
if (!concurrent.some((item) => item.ok)) {
  throw new Error(`both concurrent assistant calls failed: ${concurrent.map((item) => item.status).join(',')}`);
}
if (concurrent.some((item) => !item.ok && item.status !== 409)) {
  throw new Error(`concurrent loser returned an unexpected status: ${concurrent.map((item) => item.status).join(',')}`);
}

// The durable frontend outbox retries with the same requestId. This serial
// retry must recover the winner and must not invoke a second tool.
const chat = await getJson(api('agent-runs/assistant/chat'), {
  method: 'POST',
  body: JSON.stringify(chatRequest),
});
if (!chat || typeof chat.id !== 'string' || typeof chat.output !== 'string' || !chat.output.trim()) {
  throw new Error('assistant chat did not persist the expected request artifact');
}
if (chat.responseKind !== 'OPENCLAW_TOOL_RESULT' || !Array.isArray(chat.toolReceipts)) {
  throw new Error('assistant response did not return the structured OpenClaw tool receipt contract');
}
const workBriefReceipts = chat.toolReceipts.filter((receipt) => (
  receipt
  && receipt.toolName === 'crm.work_brief'
  && /^[a-f0-9]{64}$/.test(receipt.requestId || '')
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(receipt.agentRunId || '')
));
if (workBriefReceipts.length !== 1 || chat.toolReceipts.length !== 1) {
  throw new Error('assistant response must contain exactly one structured work-brief receipt');
}
const [{ requestId: toolRequestId, agentRunId: receiptRunId }] = workBriefReceipts;
for (const item of concurrent.filter((entry) => entry.ok)) {
  if (item.payload?.id !== chat.id) {
    throw new Error('same requestId returned more than one assistant artifact');
  }
}
const history = await getJson(api(
  `agent-runs/assistant/chat?companyId=${encodeURIComponent(companyId)}&threadId=${encodeURIComponent(threadId)}`,
));
if (!Array.isArray(history) || !history.some((turn) => turn?.id === chat.id)) {
  throw new Error('assistant chat artifact is not readable from its authenticated thread');
}

const deadline = Date.now() + 45_000;
let evidence;
while (Date.now() < deadline) {
  const runs = await getJson(listUrl);
  evidence = Array.isArray(runs) ? runs.find((run) => (
    run
    && run.kind === 'OPENCLAW_TOOL'
    && run.id === receiptRunId
    && run.requestKey === `openclaw:${toolRequestId}`
    && Array.isArray(run.tasks)
    && run.tasks.some((task) => task?.toolName === 'openclaw.work-brief')
  )) : undefined;
  if (evidence && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(evidence.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
if (!evidence) {
  throw new Error('no persisted OPENCLAW_TOOL/work-brief AgentRun matched the reported requestId');
}
const finalRuns = await getJson(listUrl);
const duplicateRuns = Array.isArray(finalRuns) ? finalRuns.filter((run) => (
  run?.kind === 'OPENCLAW_TOOL'
  && run?.subjectType === 'openclaw_tool'
  && run?.subjectId === executionSessionDigest
)) : [];
if (duplicateRuns.length !== 1) {
  throw new Error(`same assistant execution produced ${duplicateRuns.length} matching OpenClaw runs`);
}
if (duplicateRuns[0]?.id !== receiptRunId
  || duplicateRuns[0]?.requestKey !== `openclaw:${toolRequestId}`) {
  throw new Error('assistant execution correlation does not match its structured receipt');
}
if (evidence.status !== 'COMPLETED') {
  throw new Error(`persisted OpenClaw work-brief run ended as ${String(evidence.status)}`);
}
const task = evidence.tasks.find((item) => item?.toolName === 'openclaw.work-brief');
if (!task || task.status !== 'COMPLETED') {
  throw new Error('persisted openclaw.work-brief AgentTask is not COMPLETED');
}
if (!evidence.result || typeof evidence.result !== 'object') {
  throw new Error('persisted OpenClaw work-brief run has no structured result evidence');
}
if (requireWechatBound) {
  const runtime = await getJson(api(
    `agent-runs/assistant/runtime?companyId=${encodeURIComponent(companyId)}`,
  ));
  if (runtime?.runtime?.status !== 'READY'
    || runtime?.wechatOwnerChannel?.status !== 'CONNECTED'
    || !runtime?.wechatOwnerChannel?.binding
    || runtime?.permissions?.canIssueWechatCommands !== true) {
    throw new Error('owner WeChat channel is not connected, bound, and authorized');
  }
}
console.log(JSON.stringify({
  schemaVersion: 1,
  requestId,
  toolRequestId,
  runStatus: evidence.status,
  taskStatus: task.status,
  toolName: task.toolName,
  wechatOwnerBound: requireWechatBound,
}));
NODE

ok 'authenticated admin chat, real OpenClaw tool call, HMAC broker, and persisted database receipt passed'
