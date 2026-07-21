const PROVIDER_ID = 'zhipu-cn';

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function unwrapRpcEnvelope(value, method) {
  const envelope = asRecord(value);
  const expectedId = `vaysen-probe:${method}`;
  if (!envelope
    || envelope.id !== expectedId
    || envelope.ok !== true
    || Object.prototype.hasOwnProperty.call(envelope, 'error')) {
    throw new Error(`admin RPC returned an invalid envelope: ${method}`);
  }
  const payload = asRecord(envelope.payload);
  if (!payload) throw new Error(`admin RPC payload is not an object: ${method}`);
  return payload;
}

function providerId(value) {
  if (typeof value === 'string') return value;
  const record = asRecord(value);
  if (!record) return '';
  for (const key of ['provider', 'id', 'name']) {
    if (typeof record[key] === 'string') return record[key];
  }
  return '';
}

export function assertRuntimeRpcContracts({ channelsEnvelope, authEnvelope, modelsEnvelope, modelId }) {
  if (!modelId || !/^[A-Za-z0-9._:-]{1,120}$/.test(modelId)) {
    throw new Error('ZHIPU_MODEL is missing or invalid');
  }
  // channels.status is still unwrapped to prove the real RPC envelope. QR
  // pairing may legitimately be incomplete during first deployment, so this
  // probe does not turn an UNBOUND owner channel into a release failure.
  unwrapRpcEnvelope(channelsEnvelope, 'channels.status');
  const auth = unwrapRpcEnvelope(authEnvelope, 'models.authStatus');
  const models = unwrapRpcEnvelope(modelsEnvelope, 'models.list');
  if (!Array.isArray(auth.providers)) {
    throw new Error('models.authStatus providers is not an array');
  }
  // A custom API-key provider can legitimately be absent from authStatus in
  // 2026.7.1. models.list is the positive readiness evidence. authStatus only
  // vetoes that evidence when it explicitly reports this provider missing or
  // expired; generic absence/configuration fields must not create a false red.
  for (const value of auth.providers.filter((provider) => providerId(provider) === PROVIDER_ID)) {
    const provider = asRecord(value);
    if (!provider) continue;
    const explicitState = [provider.status, provider.authStatus, provider.state, provider.errorCode]
      .filter((item) => typeof item === 'string')
      .join(' ');
    if (/\b(?:missing|expired)\b/i.test(explicitState)) {
      throw new Error(`models.authStatus reports ${PROVIDER_ID} credentials missing or expired`);
    }
  }
  if (!Array.isArray(models.models)
    || !models.models.some((value) => {
      const model = asRecord(value);
      return model?.provider === PROVIDER_ID
        && model.id === modelId
        && model.available === true;
    })) {
    throw new Error(`models.list does not mark ${PROVIDER_ID}/${modelId} available`);
  }
  return { provider: PROVIDER_ID, modelId, available: true };
}

async function run() {
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  const modelId = process.env.ZHIPU_MODEL;
  if (!token) throw new Error('gateway token missing');
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const requestJson = async (path, init = {}) => {
    const response = await fetch(`http://127.0.0.1:18789${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers || {}) },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
    try { return JSON.parse(text); } catch { throw new Error(`${path} returned invalid JSON`); }
  };
  const adapter = await requestJson('/api/v1/vaysen/health');
  if (adapter?.schemaVersion !== 1
    || adapter?.pluginId !== 'vaysen-crm'
    || adapter?.pluginVersion !== '1.3.2'
    || adapter?.adapterReady !== true
    || adapter?.brokerConfigured !== true
    || adapter?.ownerNotificationReady !== true) {
    throw new Error('Vaysen AI CRM adapter health contract failed');
  }
  const rpc = (method) => requestJson('/api/v1/admin/rpc', {
    method: 'POST',
    body: JSON.stringify({ id: `vaysen-probe:${method}`, method, params: {} }),
  });
  const [channelsEnvelope, authEnvelope, modelsEnvelope] = await Promise.all([
    rpc('channels.status'),
    rpc('models.authStatus'),
    rpc('models.list'),
  ]);
  const evidence = assertRuntimeRpcContracts({
    channelsEnvelope,
    authEnvelope,
    modelsEnvelope,
    modelId,
  });
  console.log(JSON.stringify({ schemaVersion: 1, adapterReady: true, ...evidence }));
}

if (process.env.OPENCLAW_RUNTIME_PROBE_RUN === '1') {
  await run();
}
