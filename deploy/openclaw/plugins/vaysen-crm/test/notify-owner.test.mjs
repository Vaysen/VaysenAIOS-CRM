import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createNotifyOwnerRoute, notifyBoundOwner } from '../dist/notify-owner.js';

const rawOwner = 'wx-owner-private-target';
const ownerDigest = createHash('sha256').update(rawOwner, 'utf8').digest('hex');

function apiHarness(entries, providerReceipt = { messageId: 'wx-provider-message-1' }) {
  const sent = [];
  const api = {
    runtime: {
      agent: {
        session: {
          async listSessionEntries(input) {
            assert.deepEqual(input, { agentId: 'vaysen-crm' });
            return { entries };
          },
        },
      },
      channel: {
        outbound: {
          async loadAdapter(channel) {
            assert.equal(channel, 'openclaw-weixin');
            return {
              async sendText(input) {
                sent.push(input);
                return providerReceipt;
              },
            };
          },
        },
      },
      config: { async current() { return { marker: 'reviewed-config' }; } },
    },
  };
  return { api, sent };
}

function request(body, method = 'POST') {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = method;
  req.headers = { 'content-type': 'application/json' };
  return req;
}

function response() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value; },
    end(value = '') { this.body = String(value); },
  };
}

test('owner notification resolves exactly one hashed Weixin delivery target and requires a provider messageId', async () => {
  const { api, sent } = apiHarness([
    { deliveryContext: { channel: 'openclaw-weixin', to: 'another-owner', accountId: 'other' } },
    { deliveryContext: { channel: 'openclaw-weixin', to: rawOwner, accountId: 'vaysen-owner' } },
  ]);
  const result = await notifyBoundOwner(api, {
    ownerDigest,
    eventKey: 'mail.inbound:evt-1',
    text: 'You have a new customer email.',
  });
  assert.deepEqual(result, {
    schemaVersion: 1,
    status: 'SUCCEEDED',
    messageId: 'wx-provider-message-1',
  });
  assert.deepEqual(sent, [{
    cfg: { marker: 'reviewed-config' },
    to: rawOwner,
    accountId: 'vaysen-owner',
    text: 'You have a new customer email.',
  }]);
  assert.equal(JSON.stringify(result).includes(rawOwner), false);
});

test('owner notification reads the OpenClaw 2026.7.1 session wrapper contract', async () => {
  const { api, sent } = apiHarness([
    {
      sessionKey: 'agent:vaysen-crm:openclaw-weixin:direct:opaque',
      entry: {
        deliveryContext: {
          channel: 'openclaw-weixin',
          to: rawOwner,
          accountId: 'vaysen-owner',
        },
      },
    },
  ]);

  const result = await notifyBoundOwner(api, {
    ownerDigest,
    eventKey: 'whatsapp.inbound:wrapped-session',
    text: 'New WhatsApp message.',
  });

  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].accountId, 'vaysen-owner');
});

test('owner notification deduplicates repeated sessions for the same bound account and peer', async () => {
  const duplicate = { deliveryContext: {
    channel: 'openclaw-weixin',
    to: rawOwner,
    accountId: 'vaysen-owner',
  } };
  const { api, sent } = apiHarness([duplicate, duplicate, { ...duplicate }]);

  const result = await notifyBoundOwner(api, {
    ownerDigest,
    eventKey: 'whatsapp.inbound:duplicate-sessions',
    text: 'New WhatsApp message.',
  });

  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, rawOwner);
  assert.equal(sent[0].accountId, 'vaysen-owner');
});

test('owner notification ignores a stale account alias when the reviewed owner account is present', async () => {
  const { api, sent } = apiHarness([
    { deliveryContext: { channel: 'openclaw-weixin', to: rawOwner, accountId: 'legacy-owner' } },
    { deliveryContext: { channel: 'openclaw-weixin', to: rawOwner, accountId: 'vaysen-owner' } },
  ]);

  const result = await notifyBoundOwner(api, {
    ownerDigest,
    eventKey: 'whatsapp.inbound:stale-account-alias',
    text: 'New WhatsApp message.',
  });

  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].accountId, 'vaysen-owner');
});

test('owner notification rejects missing, ambiguous and empty-receipt delivery contexts', async () => {
  const none = apiHarness([]);
  await assert.rejects(
    () => notifyBoundOwner(none.api, { ownerDigest, eventKey: 'evt-1', text: 'one' }),
    /OWNER_CHANNEL_NOT_UNIQUE/,
  );
  const ambiguous = apiHarness([
    { deliveryContext: { channel: 'openclaw-weixin', to: rawOwner, accountId: 'one' } },
    { deliveryContext: { channel: 'openclaw-weixin', to: rawOwner, accountId: 'two' } },
  ]);
  await assert.rejects(
    () => notifyBoundOwner(ambiguous.api, { ownerDigest, eventKey: 'evt-2', text: 'two' }),
    /OWNER_CHANNEL_NOT_UNIQUE/,
  );
  const empty = apiHarness([
    { deliveryContext: { channel: 'openclaw-weixin', to: rawOwner, accountId: 'one' } },
  ], { messageId: '' });
  await assert.rejects(
    () => notifyBoundOwner(empty.api, { ownerDigest, eventKey: 'evt-3', text: 'three' }),
    /OWNER_NOTIFICATION_NO_RECEIPT/,
  );
});

test('gateway-auth route accepts only digest/eventKey/text and deduplicates one event without exposing target', async () => {
  const { api, sent } = apiHarness([
    { deliveryContext: { channel: 'openclaw-weixin', to: rawOwner, accountId: 'vaysen-owner' } },
  ]);
  const route = createNotifyOwnerRoute(api);
  assert.equal(route.auth, 'gateway');
  assert.equal(route.path, '/api/v1/vaysen/notify-owner');
  const body = { ownerDigest, eventKey: 'whatsapp.inbound:evt-4', text: 'New WhatsApp message.' };
  for (let index = 0; index < 2; index += 1) {
    const res = response();
    await route.handler(request(body), res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).messageId, 'wx-provider-message-1');
    assert.equal(res.body.includes(rawOwner), false);
  }
  assert.equal(sent.length, 1);

  const reused = response();
  await route.handler(request({ ...body, text: 'Different payload.' }), reused);
  assert.equal(reused.statusCode, 409);
  assert.equal(JSON.parse(reused.body).code, 'EVENT_KEY_REUSED');

  const spoofed = response();
  await route.handler(request({ ...body, eventKey: 'evt-5', to: rawOwner }), spoofed);
  assert.equal(spoofed.statusCode, 400);
  assert.equal(spoofed.body.includes(rawOwner), false);
});

test('gateway-auth route returns only a safe adapter failure code', async () => {
  const { api } = apiHarness([
    { deliveryContext: { channel: 'openclaw-weixin', to: rawOwner, accountId: 'vaysen-owner' } },
  ]);
  api.runtime.channel.outbound.loadAdapter = async () => ({
    async sendText() {
      throw new Error('Weixin session is not active for a private target');
    },
  });
  const route = createNotifyOwnerRoute(api);
  const res = response();

  await route.handler(request({
    ownerDigest,
    eventKey: 'whatsapp.inbound:safe-adapter-error',
    text: 'New WhatsApp message.',
  }), res);

  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body), {
    schemaVersion: 1,
    status: 'FAILED',
    code: 'OWNER_CHANNEL_SESSION_INACTIVE',
  });
  assert.equal(res.body.includes(rawOwner), false);
});

test('gateway-auth route identifies a stale Weixin session that must be rebound', async () => {
  const { api } = apiHarness([
    { deliveryContext: { channel: 'openclaw-weixin', to: rawOwner, accountId: 'vaysen-owner' } },
  ]);
  api.runtime.channel.outbound.loadAdapter = async () => ({
    async sendText() {
      throw new Error('sendMessage ret=-2 errmsg=prepare failed');
    },
  });
  const route = createNotifyOwnerRoute(api);
  const res = response();

  await route.handler(request({
    ownerDigest,
    eventKey: 'whatsapp.inbound:stale-weixin-session',
    text: 'New WhatsApp message.',
  }), res);

  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body), {
    schemaVersion: 1,
    status: 'FAILED',
    code: 'OWNER_CHANNEL_REBIND_REQUIRED',
  });
  assert.equal(res.body.includes(rawOwner), false);
});
