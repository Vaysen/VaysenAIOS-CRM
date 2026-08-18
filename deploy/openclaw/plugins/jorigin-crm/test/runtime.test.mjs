import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  actorForToolCall,
  callBroker,
  canonicalRequest,
  mapCustomerSearchReceipt,
  mapQuoteReceipt,
  mapResearchReceipt,
  normalizeAcceptanceMarker,
  normalizeSelectionToken,
  rememberCustomerSelection,
  resolveTrustedActor,
  resolveTrustedReadOnlyInvokeActor,
  signRequest,
  useExactSelectionToken,
} from '../dist/runtime.js';

const CRM_SESSION = `vaysen-crm:${'a'.repeat(64)}`;
const CRM_CONTEXT_SESSION = `agent:vaysen-crm:${CRM_SESSION}`;

test('trusted Weixin actor uses only canonical direct-owner context', () => {
  const actor = resolveTrustedActor({
    messageChannel: 'openclaw-weixin',
    requesterSenderId: 'wx-owner-1',
    sessionKey: 'agent:vaysen-crm:openclaw-weixin:direct:owner',
    agentAccountId: 'vaysen-crm-owner',
    senderIsOwner: true,
  });
  assert.deepEqual(actor, {
    channel: 'openclaw-weixin',
    source: 'openclaw-weixin',
    senderIsOwner: true,
    requesterSenderId: 'wx-owner-1',
    sessionKey: 'agent:vaysen-crm:openclaw-weixin:direct:owner',
    agentAccountId: 'vaysen-crm-owner',
  });
  assert.equal('agentId' in actor, false);
});

test('trusted CRM HTTP ingress accepts the fixed OpenClaw 2026.7.1 false owner bit', () => {
  const actor = resolveTrustedActor({
    messageChannel: 'webchat',
    agentId: 'vaysen-crm',
    sessionKey: CRM_CONTEXT_SESSION,
    senderIsOwner: false,
  });
  assert.deepEqual(actor, {
    channel: 'vaysen-crm',
    source: 'vaysen-crm',
    senderIsOwner: true,
    agentId: 'vaysen-crm',
    sessionKey: CRM_SESSION,
  });
  assert.equal('requesterSenderId' in actor, false);
  assert.equal('agentAccountId' in actor, false);
});

test('read-only shared-secret invoke accepts only the canonical CRM gateway context', () => {
  const actor = resolveTrustedReadOnlyInvokeActor({
    messageChannel: 'webchat',
    agentId: 'vaysen-crm',
    sessionKey: CRM_CONTEXT_SESSION,
    senderIsOwner: true,
  });
  assert.deepEqual(actor, {
    channel: 'vaysen-crm',
    source: 'vaysen-crm',
    senderIsOwner: true,
    agentId: 'vaysen-crm',
    sessionKey: CRM_SESSION,
  });
});

for (const invalid of [
  { messageChannel: 'webchat', agentId: 'main', sessionKey: CRM_CONTEXT_SESSION, senderIsOwner: true },
  { messageChannel: 'vaysen-crm', agentId: 'vaysen-crm', sessionKey: CRM_CONTEXT_SESSION, senderIsOwner: true },
  { messageChannel: 'webchat', agentId: 'vaysen-crm', sessionKey: CRM_SESSION, senderIsOwner: true },
  { messageChannel: 'webchat', agentId: 'vaysen-crm', sessionKey: CRM_CONTEXT_SESSION, senderIsOwner: false },
  { messageChannel: 'webchat', agentId: 'vaysen-crm', sessionKey: CRM_CONTEXT_SESSION, senderIsOwner: true, requesterSenderId: 'spoofed' },
  { messageChannel: 'webchat', agentId: 'vaysen-crm', sessionKey: CRM_CONTEXT_SESSION, senderIsOwner: true, agentAccountId: 'spoofed' },
]) {
  test(`spoofed read-only invoke context fails closed: ${JSON.stringify(invalid)}`, () => {
    assert.throws(() => resolveTrustedReadOnlyInvokeActor(invalid), /read-only invoke/);
  });
}

for (const invalid of [
  { messageChannel: 'webchat', requesterSenderId: 'owner', sessionKey: 'direct:s', agentAccountId: 'a', senderIsOwner: true },
  { messageChannel: 'openclaw-weixin', requesterSenderId: '', sessionKey: 'direct:s', agentAccountId: 'a', senderIsOwner: true },
  { messageChannel: 'openclaw-weixin', requesterSenderId: 'owner', sessionKey: 'group:s', agentAccountId: 'a', senderIsOwner: true },
  { messageChannel: 'openclaw-weixin', requesterSenderId: 'owner', sessionKey: 'direct:s', agentAccountId: '', senderIsOwner: true },
  { messageChannel: 'openclaw-weixin', requesterSenderId: 'owner', sessionKey: 'direct:s', agentAccountId: 'a', senderIsOwner: false },
]) {
  test(`untrusted Weixin context fails closed: ${JSON.stringify(invalid)}`, () => {
    assert.throws(() => resolveTrustedActor(invalid), /trusted owner channel/);
  });
}

for (const invalid of [
  { messageChannel: 'webchat', agentId: 'main', sessionKey: CRM_CONTEXT_SESSION, senderIsOwner: false },
  { messageChannel: 'webchat', agentId: 'vaysen-crm', sessionKey: 'agent:vaysen-crm:vaysen-crm:not-a-digest', senderIsOwner: false },
  { messageChannel: 'vaysen-crm', agentId: 'vaysen-crm', sessionKey: CRM_CONTEXT_SESSION, senderIsOwner: false },
  { messageChannel: undefined, agentId: 'vaysen-crm', sessionKey: CRM_CONTEXT_SESSION, senderIsOwner: false },
  { messageChannel: 'webchat', agentId: 'vaysen-crm', sessionKey: CRM_CONTEXT_SESSION, senderIsOwner: true },
  { messageChannel: 'webchat', agentId: 'vaysen-crm', sessionKey: CRM_CONTEXT_SESSION },
  { messageChannel: 'webchat', agentId: 'vaysen-crm', sessionKey: CRM_SESSION, senderIsOwner: false },
  { messageChannel: 'webchat', agentId: 'vaysen-crm', sessionKey: CRM_CONTEXT_SESSION, requesterSenderId: 'spoofed', senderIsOwner: false },
  { messageChannel: 'webchat', agentId: 'vaysen-crm', sessionKey: CRM_CONTEXT_SESSION, agentAccountId: 'spoofed', senderIsOwner: false },
]) {
  test(`spoofed CRM HTTP context fails closed: ${JSON.stringify(invalid)}`, () => {
    assert.throws(() => resolveTrustedActor(invalid), /trusted owner channel/);
  });
}

test('tool call id is injected by execute-time context, not by model input', () => {
  const actor = resolveTrustedActor({
    messageChannel: 'webchat',
    agentId: 'vaysen-crm',
    sessionKey: CRM_CONTEXT_SESSION,
    senderIsOwner: false,
  });
  assert.deepEqual(actorForToolCall(actor, ' call-123 '), { ...actor, toolCallId: 'call-123' });
  assert.throws(() => actorForToolCall(actor, ''), /tool call id/);
  assert.throws(() => actorForToolCall(actor, 'x'.repeat(257)), /tool call id/);
});

test('action target accepts only the one-use selection token from customer search', () => {
  const token = 'A'.repeat(42) + '_';
  assert.equal(normalizeSelectionToken(` ${token} `), token);
  assert.throws(() => normalizeSelectionToken('22222222-2222-4222-8222-222222222222'), /selectionToken/);
  assert.throws(() => normalizeSelectionToken('A'.repeat(42) + '!'), /selectionToken/);
});

test('customer search maps opaque action tokens to exact published tool names', () => {
  const customerGetToken = 'A'.repeat(43);
  const whatsappToken = 'W'.repeat(43);
  const emailToken = 'E'.repeat(43);
  const mapped = mapCustomerSearchReceipt({
    schemaVersion: 1,
    status: 'COMPLETED',
    result: {
      count: 1,
      uniqueMatch: true,
      selection: {
        expiresAt: '2026-07-20T02:00:00.000Z',
        tokens: {
          'customer-get': customerGetToken,
          'whatsapp-send-text': whatsappToken,
          'email-send': emailToken,
        },
      },
    },
  });

  assert.equal(
    mapped.result.selection.selectionTokenByTool.crm_customer_get,
    customerGetToken,
  );
  assert.equal(
    mapped.result.selection.selectionTokenByTool.crm_whatsapp_send_text,
    whatsappToken,
  );
  assert.equal(
    mapped.result.selection.selectionTokenByTool.crm_email_send,
    emailToken,
  );
  assert.equal('tokens' in mapped.result.selection, false);
  assert.match(mapped.result.instruction, /plugin injects the exact tool-scoped token/);
});

test('trusted plugin injects the exact action token from the current customer search', () => {
  const actor = resolveTrustedActor({
    messageChannel: 'webchat',
    agentId: 'vaysen-crm',
    sessionKey: CRM_CONTEXT_SESSION,
    senderIsOwner: false,
  });
  const now = Date.parse('2026-07-20T02:00:00.000Z');
  const customerGetToken = 'A'.repeat(43);
  const whatsappReadToken = 'R'.repeat(43);
  const whatsappSendToken = 'W'.repeat(43);
  assert.equal(rememberCustomerSelection(actor, {
    result: {
      selection: {
        expiresAt: '2026-07-20T02:02:00.000Z',
        tokens: {
          'customer-get': customerGetToken,
          'whatsapp-messages-read': whatsappReadToken,
          'whatsapp-send-text': whatsappSendToken,
        },
      },
    },
  }, now), true);

  assert.deepEqual(
    useExactSelectionToken(
      actor,
      'crm_whatsapp_send_text',
      { selectionToken: '22222222-2222-4222-8222-222222222222', text: 'hello' },
      now + 1,
    ),
    { selectionToken: whatsappSendToken, text: 'hello' },
  );
  assert.deepEqual(
    useExactSelectionToken(
      actor,
      'crm_whatsapp_messages_read',
      { selectionToken: customerGetToken, limit: 5 },
      now + 1,
    ),
    { selectionToken: whatsappReadToken, limit: 5 },
  );
  assert.deepEqual(
    useExactSelectionToken(
      actor,
      'crm_whatsapp_send_text',
      { selectionToken: customerGetToken, text: 'hello' },
      now + 120_001,
    ),
    { selectionToken: customerGetToken, text: 'hello' },
  );
});

test('acceptance marker is optional and accepts only the reviewed correlation format', () => {
  const marker = 'JYACC_OWNER_0123456789abcdef';
  assert.equal(normalizeAcceptanceMarker(undefined), undefined);
  assert.equal(normalizeAcceptanceMarker(marker), marker);
  assert.throws(() => normalizeAcceptanceMarker('JYACC_OWNER_0123456789ABCDEF'), /marker/i);
  assert.throws(() => normalizeAcceptanceMarker('JYACC_OWNER_0123456789abcdef_extra'), /marker/i);
});

test('published action schemas allow broker-injected selection and expose no model-supplied conversation UUID', async () => {
  const source = await readFile(new URL('../dist/index.js', import.meta.url), 'utf8');
  assert.match(source, /name: 'crm_customer_update'/);
  assert.match(source, /path: '\/api\/internal\/openclaw\/tools\/customer-update'/);
  assert.match(source, /selectionTokenProperty = \(\) => Type\.Optional\(Type\.String\(\{ maxLength: 128 \}\)\)/);
  assert.match(source, /const trustedParams = useExactSelectionToken\(baseActor, name, params\)/);
  assert.doesNotMatch(source, /conversationId: Type\.String/);
  assert.doesNotMatch(source, /buildBody:\s*\(\{ conversationId \}\)/);
  assert.match(source, /pattern: '\^JYACC_OWNER_\[a-f0-9\]\{16\}\$'/);
  assert.equal(source.match(/allowSharedSecretReadOnlyInvoke: true/g)?.length, 1);
  assert.match(
    source,
    /name: 'crm_work_brief',\s+allowSharedSecretReadOnlyInvoke: true,/,
  );
});

test('HMAC canonical form includes the actual /api pathname byte-for-byte', () => {
  const input = {
    timestamp: '1784041200',
    nonce: '6cb73330-b710-4263-8055-96d26ee5a3c6',
    method: 'POST',
    path: '/api/internal/openclaw/tools/work-brief',
    rawBody: '{"actor":{"channel":"vaysen-crm"}}',
  };
  const canonical = canonicalRequest(input);
  assert.equal(canonical.split('\n').length, 5);
  const secret = 'x'.repeat(48);
  const expected = createHmac('sha256', secret).update(canonical).digest('hex');
  assert.equal(signRequest({ ...input, secret }), expected);
});

for (const [label, actor] of [
  ['Weixin', actorForToolCall(resolveTrustedActor({
    messageChannel: 'openclaw-weixin',
    requesterSenderId: 'wx-owner-1',
    sessionKey: 'agent:vaysen-crm:openclaw-weixin:direct:owner',
    agentAccountId: 'vaysen-crm-owner',
    senderIsOwner: true,
  }), 'wx-call-1')],
  ['CRM', actorForToolCall(resolveTrustedActor({
    messageChannel: 'webchat',
    agentId: 'vaysen-crm',
    sessionKey: CRM_CONTEXT_SESSION,
    senderIsOwner: false,
  }), 'crm-call-1')],
]) {
  test(`${label} broker request preserves canonical actor and signature`, async () => {
    const previousFetch = globalThis.fetch;
    const secret = 's'.repeat(48);
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'http://backend:4000/api/internal/openclaw/tools/work-brief');
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), { actor });
      const timestamp = init.headers['x-openclaw-timestamp'];
      const nonce = init.headers['x-openclaw-nonce'];
      const expected = signRequest({
        secret,
        timestamp,
        nonce,
        method: 'POST',
        path: '/api/internal/openclaw/tools/work-brief',
        rawBody: init.body,
      });
      assert.equal(init.headers['x-openclaw-signature'], expected);
      return new Response(JSON.stringify({ schemaVersion: 1, requestId: 'receipt-1', status: 'COMPLETED' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    try {
      const payload = await callBroker({
        config: {
          apiBaseUrl: 'http://backend:4000',
          keyId: 'vaysen-openclaw-v1',
          hmacSecret: secret,
          requestTimeoutMs: 1000,
        },
        path: '/api/internal/openclaw/tools/work-brief',
        body: { actor },
      });
      assert.equal(payload.requestId, 'receipt-1');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
}

test('broker rejects an undersized HMAC secret before network access', async () => {
  await assert.rejects(() => callBroker({
    config: {
      apiBaseUrl: 'http://backend:4000',
      keyId: 'vaysen-openclaw-v1',
      hmacSecret: 'x'.repeat(47),
    },
    path: '/api/internal/openclaw/tools/work-brief',
    body: {},
  }), /HMAC secret/);
});

test('customer-update uses the reviewed broker path instead of failing at the plugin allowlist', async () => {
  const previousFetch = globalThis.fetch;
  const secret = 'u'.repeat(48);
  globalThis.fetch = async (url) => {
    assert.equal(url, 'http://backend:4000/api/internal/openclaw/tools/customer-update');
    return new Response(JSON.stringify({ schemaVersion: 1, requestId: 'receipt-update', status: 'COMPLETED' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const payload = await callBroker({
      config: {
        apiBaseUrl: 'http://backend:4000',
        keyId: 'vaysen-openclaw-v1',
        hmacSecret: secret,
        requestTimeoutMs: 1000,
      },
      path: '/api/internal/openclaw/tools/customer-update',
      body: { actor: { channel: 'vaysen-crm' }, input: { contactName: 'Elvis' } },
    });
    assert.equal(payload.requestId, 'receipt-update');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('quote receipt unwraps only an explicitly confirmable nested proposal', () => {
  assert.deepEqual(mapQuoteReceipt({
    status: 'COMPLETED',
    requestId: 'receipt-quote',
    result: {
      status: 'REQUIRES_CONFIRMATION',
      proposalId: 'proposal-1',
      quote: { referenceNo: 'QT-1', currency: 'USD' },
      targetName: 'Verified Buyer',
    },
  }), {
    status: 'PREPARED_NOT_SENT',
    prepared: true,
    requiresHumanConfirmation: true,
    requiresManualWhatsappSend: true,
    requestId: 'receipt-quote',
    quote: { referenceNo: 'QT-1', currency: 'USD' },
    targetName: 'Verified Buyer',
    automaticSend: false,
    instruction: 'The quote proposal is prepared but not sent. Review it in CRM, then confirm and send manually.',
  });
});

for (const payload of [
  { status: 'COMPLETED', requestId: 'r1', result: { status: 'BLOCKED', proposalId: 'must-not-leak' } },
  { status: 'FAILED', requestId: 'r2', errorCode: 'OPENCLAW_TOOL_FAILED', result: null },
  { status: 'COMPLETED', requestId: 'r3', result: null },
]) {
  test(`quote receipt never converts blocked/failed/missing result into prepared: ${payload.requestId}`, () => {
    const mapped = mapQuoteReceipt(payload);
    assert.equal(mapped.prepared, false);
    assert.equal(mapped.requiresHumanConfirmation, false);
    assert.equal('proposalId' in mapped, false);
    assert.notEqual(mapped.status, 'PREPARED_NOT_SENT');
  });
}

test('research receipt reads nested AgentRun status and completion evidence', () => {
  const queued = mapResearchReceipt({
    status: 'COMPLETED',
    requestId: 'research-1',
    runId: 'broker-run',
    result: { status: 'RUNNING', agentRunId: 'agent-run-1', reportReady: false },
  });
  assert.equal('agentRunId' in queued, false);
  assert.equal(queued.status, 'RUNNING');
  assert.equal(queued.completed, false);

  const ready = mapResearchReceipt({
    status: 'COMPLETED',
    requestId: 'research-2',
    result: { status: 'COMPLETED', agentRunId: 'agent-run-2', reportReady: true },
  });
  assert.equal(ready.completed, true);
  assert.equal(ready.reportReady, true);

  const failed = mapResearchReceipt({
    status: 'FAILED',
    requestId: 'research-3',
    errorCode: 'BROKER_FAILED',
    result: { status: 'COMPLETED', agentRunId: 'agent-run-3', reportReady: true },
  });
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.completed, false);
  assert.equal(failed.reportReady, false);
});
