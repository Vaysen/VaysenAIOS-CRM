import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRuntimeRpcContracts, unwrapRpcEnvelope } from './openclaw-runtime-probe.mjs';

const modelId = 'glm-4-flash-250414';
const realFixture = (overrides = {}) => ({
  channelsEnvelope: {
    id: 'vaysen-probe:channels.status',
    ok: true,
    payload: { channels: [{ id: 'openclaw-weixin', status: 'UNBOUND' }] },
  },
  authEnvelope: {
    id: 'vaysen-probe:models.authStatus',
    ok: true,
    payload: { providers: [{ provider: 'zhipu-cn' }] },
  },
  modelsEnvelope: {
    id: 'vaysen-probe:models.list',
    ok: true,
    payload: { models: [{ provider: 'zhipu-cn', id: modelId, available: true }] },
  },
  modelId,
  ...overrides,
});

test('accepts the OpenClaw 2026.7.1 provider/model RPC shapes', () => {
  assert.deepEqual(assertRuntimeRpcContracts(realFixture()), {
    provider: 'zhipu-cn', modelId, available: true,
  });
});

test('accepts the real providers string variant without inventing ready fields', () => {
  assert.doesNotThrow(() => assertRuntimeRpcContracts(realFixture({
    authEnvelope: {
      id: 'vaysen-probe:models.authStatus', ok: true, payload: { providers: ['zhipu-cn'] },
    },
  })));
});

test('accepts custom provider absence when models.list has exact availability evidence', () => {
  assert.doesNotThrow(() => assertRuntimeRpcContracts(realFixture({
    authEnvelope: {
      id: 'vaysen-probe:models.authStatus', ok: true, payload: { providers: [] },
    },
  })));
});

test('rejects the former fabricated ok/ready payload', () => {
  assert.throws(() => assertRuntimeRpcContracts(realFixture({
    authEnvelope: { id: 'vaysen-probe:models.authStatus', ok: true, ready: true },
  })), /invalid envelope|payload is not an object/);
});

test('rejects an unavailable or wrong provider model', () => {
  assert.throws(() => assertRuntimeRpcContracts(realFixture({
    modelsEnvelope: {
      id: 'vaysen-probe:models.list',
      ok: true,
      payload: { models: [{ provider: 'zhipu-cn', id: modelId, available: false }] },
    },
  })), /does not mark/);
  assert.throws(() => assertRuntimeRpcContracts(realFixture({
    authEnvelope: {
      id: 'vaysen-probe:models.authStatus',
      ok: true,
      payload: { providers: [{ provider: 'zhipu-cn', status: 'expired' }] },
    },
  })), /missing or expired/);
});

test('requires the real payload object and rejects RPC error/result envelopes', () => {
  assert.throws(() => unwrapRpcEnvelope({
    id: 'vaysen-probe:models.list', ok: true, payload: [],
  }, 'models.list'), /not an object/);
  assert.throws(() => unwrapRpcEnvelope({
    id: 'vaysen-probe:models.list', ok: false, error: { code: 'UNAVAILABLE' },
  }, 'models.list'), /invalid envelope/);
  assert.throws(() => unwrapRpcEnvelope({
    id: 'wrong-id', ok: true, payload: {},
  }, 'models.list'), /invalid envelope/);
  assert.throws(() => unwrapRpcEnvelope({
    id: 'vaysen-probe:models.list', ok: true, result: {},
  }, 'models.list'), /payload/);
});
