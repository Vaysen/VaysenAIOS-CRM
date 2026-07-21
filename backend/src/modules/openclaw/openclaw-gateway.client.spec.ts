import { OpenClawGatewayClient } from './openclaw-gateway.client';

function json(value: unknown, status = 200) {
  const body = JSON.stringify(value);
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
  });
}

function rpc(payload: Record<string, unknown>) {
  return json({ id: 'rpc-test-id', ok: true, payload });
}

function channelsStatus(
  accounts: Array<Record<string, unknown>> = [],
  defaultAccountId?: string,
  installed = true,
) {
  return {
    ts: Date.now(),
    channelOrder: installed ? ['openclaw-weixin'] : [],
    channelLabels: installed ? { 'openclaw-weixin': 'Weixin' } : {},
    channelMeta: installed
      ? [{ id: 'openclaw-weixin', label: 'Weixin', detailLabel: 'Tencent Weixin' }]
      : [],
    channels: installed ? { 'openclaw-weixin': { configured: accounts.some((item) => item.configured === true) } } : {},
    channelAccounts: installed ? { 'openclaw-weixin': accounts } : {},
    channelDefaultAccountId: installed && defaultAccountId
      ? { 'openclaw-weixin': defaultAccountId }
      : {},
  };
}

describe('OpenClawGatewayClient', () => {
  const originalFetch = global.fetch;
  let client: OpenClawGatewayClient;

  beforeEach(() => {
    process.env.OPENCLAW_ENABLED = 'true';
    process.env.OPENCLAW_GATEWAY_URL = 'http://openclaw-gateway:18789';
    process.env.OPENCLAW_GATEWAY_TOKEN = 't'.repeat(48);
    process.env.ZHIPU_MODEL = 'glm-4-flash-250414';
    client = new OpenClawGatewayClient();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    global.fetch = originalFetch;
    delete process.env.OPENCLAW_ENABLED;
    delete process.env.OPENCLAW_GATEWAY_URL;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.ZHIPU_MODEL;
  });

  it('does not call the gateway while the feature is disabled', async () => {
    process.env.OPENCLAW_ENABLED = 'false';
    global.fetch = jest.fn();
    await expect(client.probe()).resolves.toEqual(expect.objectContaining({
      enabled: false,
      gatewayReady: false,
      adapterReady: false,
      modelReady: false,
    }));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('treats a generic health 200 as gateway-only and fails adapter/model closed', async () => {
    global.fetch = jest.fn(async (url: any) => {
      const path = new URL(String(url)).pathname;
      if (path === '/healthz') return json({ status: 'ok', adapterReady: true, modelReady: true });
      return json({ error: 'not configured' }, 503);
    }) as any;

    const result = await client.probe();
    expect(result).toEqual(expect.objectContaining({
      gatewayReady: true,
      adapterReady: false,
      modelReady: false,
      errorCode: 'OPENCLAW_COMPONENT_DEGRADED',
    }));
  });

  it('coalesces concurrent probes and retries the cached failure after the TTL', async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    let healthy = false;
    global.fetch = jest.fn(async (url: any, init: any) => {
      const path = new URL(String(url)).pathname;
      if (path === '/healthz') {
        return healthy ? json({ status: 'ok' }) : json({ error: 'starting' }, 503);
      }
      if (path === '/api/v1/vaysen/health') {
        return json({
          schemaVersion: 1,
          pluginId: 'vaysen-crm',
          adapterReady: true,
          brokerConfigured: true,
        });
      }
      const method = JSON.parse(init.body).method;
      if (method === 'models.authStatus') return rpc({ ts: Date.now(), providers: [] });
      if (method === 'channels.status') return rpc(channelsStatus([], undefined, false));
      return rpc({
        models: [{ provider: 'zhipu-cn', id: 'glm-4-flash-250414', available: true }],
      });
    }) as any;

    const failed = await Promise.all([client.probe(), client.probe(), client.probe()]);
    expect(failed.every((item) => item.gatewayReady === false)).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    healthy = true;
    await expect(client.probe()).resolves.toEqual(expect.objectContaining({ gatewayReady: false }));
    expect(global.fetch).toHaveBeenCalledTimes(1);

    now += 5_001;
    const recovered = await Promise.all([client.probe(), client.probe()]);
    expect(recovered.every((item) => item.gatewayReady && item.adapterReady && item.modelReady)).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(6);
  });

  it('requires the fixed adapter health and allowlisted admin RPC attestations', async () => {
    global.fetch = jest.fn(async (url: any, init: any) => {
      const path = new URL(String(url)).pathname;
      if (path === '/healthz') return json({ status: 'ok', release: '2026.7.1' });
      if (path === '/api/v1/vaysen/health') {
        return json({
          schemaVersion: 1,
          pluginId: 'vaysen-crm',
          adapterReady: true,
          brokerConfigured: true,
          lastHeartbeatAt: '2026-07-14T12:00:00.000Z',
          wechatOwnerChannel: {
            binding: {
              displayName: '负责人微信',
              maskedAccount: 'wx***01',
              boundAt: '2026-07-14T11:00:00.000Z',
            },
          },
        });
      }
      const method = JSON.parse(init.body).method;
      if (method === 'channels.status') {
        return rpc(channelsStatus([
          { accountId: 'owner-account', configured: true, running: true, lastError: null },
        ], 'owner-account'));
      }
      if (method === 'models.authStatus') {
        return rpc({
          ts: Date.now(),
          providers: [{ provider: 'zhipu-cn', status: 'static', profiles: [] }],
        });
      }
      if (method === 'models.list') {
        return rpc({
          models: [{ provider: 'zhipu-cn', id: 'glm-4-flash-250414', available: true }],
        });
      }
      return json({}, 404);
    }) as any;

    const result = await client.probe();
    expect(result).toEqual(expect.objectContaining({
      gatewayReady: true,
      adapterReady: true,
      modelReady: true,
      errorCode: null,
      wechatOwnerChannel: expect.objectContaining({
        status: 'CONNECTED',
        pluginReady: true,
        binding: expect.objectContaining({ maskedAccount: 'wx***01' }),
      }),
    }));
    const rpcMethods = (global.fetch as jest.Mock).mock.calls
      .filter(([, init]) => init?.body)
      .map(([, init]) => JSON.parse(init.body).method)
      .filter(Boolean);
    expect(rpcMethods).toEqual(expect.arrayContaining(['channels.status', 'models.authStatus', 'models.list']));
  });

  it('rejects legacy, bare and failed admin RPC envelopes even when their payload claims readiness', async () => {
    const wrappers = [
      (payload: Record<string, unknown>) => ({ result: payload }),
      (payload: Record<string, unknown>) => ({ data: payload }),
      (payload: Record<string, unknown>) => payload,
      (payload: Record<string, unknown>) => ({ id: 'rpc-failed', ok: false, payload }),
    ];
    for (const wrap of wrappers) {
      client = new OpenClawGatewayClient();
      global.fetch = jest.fn(async (url: any, init: any) => {
        const path = new URL(String(url)).pathname;
        if (path === '/healthz') return json({ status: 'ok' });
        if (path === '/api/v1/vaysen/health') {
          return json({
            schemaVersion: 1,
            pluginId: 'vaysen-crm',
            adapterReady: true,
            brokerConfigured: true,
          });
        }
        const method = JSON.parse(init.body).method;
        const payload = method === 'channels.status'
          ? channelsStatus([{ accountId: 'owner', configured: true, running: true }], 'owner')
          : method === 'models.authStatus'
            ? { ts: Date.now(), providers: [{ provider: 'zhipu-cn', status: 'static' }] }
            : { models: [{ provider: 'zhipu-cn', id: 'glm-4-flash-250414', available: true }] };
        return json(wrap(payload));
      }) as any;

      await expect(client.probe()).resolves.toEqual(expect.objectContaining({
        gatewayReady: true,
        adapterReady: true,
        modelReady: false,
        errorCode: 'OPENCLAW_COMPONENT_DEGRADED',
        wechatOwnerChannel: expect.objectContaining({
          status: 'NOT_INSTALLED',
          pluginReady: false,
        }),
      }));
    }
  });

  it('maps the real channels.status account snapshot for installed, bound, running and default-account states', () => {
    const read = (payload: Record<string, unknown>) => (
      (client as any).findWeixinChannel(payload)
    );
    expect(read(channelsStatus([], undefined, false))).toEqual({
      status: 'NOT_INSTALLED',
      pluginReady: false,
    });
    expect(read(channelsStatus([{ accountId: 'owner', configured: false, running: false }]))).toEqual({
      status: 'UNBOUND',
      pluginReady: true,
    });
    expect(read(channelsStatus([{ accountId: 'owner', configured: true, running: true }]))).toEqual({
      status: 'CONNECTED',
      pluginReady: true,
    });
    expect(read(channelsStatus([{ accountId: 'owner', configured: true, running: false }]))).toEqual({
      status: 'DISCONNECTED',
      pluginReady: true,
    });
    expect(read(channelsStatus([
      { accountId: 'stopped', configured: true, running: false },
      { accountId: 'default-running', configured: true, running: true },
    ], 'default-running'))).toEqual({
      status: 'CONNECTED',
      pluginReady: true,
    });
    expect(read(channelsStatus([
      { accountId: 'owner', configured: true, running: true, lastError: 'transport failed' },
    ]))).toEqual({
      status: 'ERROR',
      pluginReady: true,
      errorCode: 'CHANNEL_RUNTIME_ERROR',
    });
  });

  it('fails a legacy adapter shape or an unconfigured broker closed', async () => {
    let brokerConfigured = false;
    global.fetch = jest.fn(async (url: any, init: any) => {
      const path = new URL(String(url)).pathname;
      if (path === '/healthz') return json({ status: 'ok' });
      if (path === '/api/v1/vaysen/health') {
        return json(brokerConfigured
          ? { status: 'ready', adapterReady: true }
          : {
              schemaVersion: 1,
              pluginId: 'vaysen-crm',
              adapterReady: true,
              brokerConfigured: false,
            });
      }
      const method = JSON.parse(init.body).method;
      if (method === 'models.authStatus') return rpc({ ts: Date.now(), providers: [] });
      if (method === 'channels.status') return rpc(channelsStatus([], undefined, false));
      return rpc({
        models: [{ provider: 'zhipu-cn', id: 'glm-4-flash-250414', available: true }],
      });
    }) as any;

    await expect(client.probe()).resolves.toEqual(expect.objectContaining({ adapterReady: false }));
    brokerConfigured = true;
    client = new OpenClawGatewayClient();
    await expect(client.probe()).resolves.toEqual(expect.objectContaining({ adapterReady: false }));
  });

  it('does not treat an available model from another provider as the configured Zhipu model', async () => {
    global.fetch = jest.fn(async (url: any, init: any) => {
      const path = new URL(String(url)).pathname;
      if (path === '/healthz') return json({ status: 'ok' });
      if (path === '/api/v1/vaysen/health') {
        return json({
          schemaVersion: 1,
          pluginId: 'vaysen-crm',
          adapterReady: true,
          brokerConfigured: true,
        });
      }
      const method = JSON.parse(init.body).method;
      if (method === 'models.authStatus') {
        return rpc({
          ts: Date.now(),
          providers: [{ provider: 'other-provider', status: 'ok', profiles: [] }],
        });
      }
      if (method === 'models.list') {
        return rpc({
          models: [{ provider: 'other-provider', id: 'glm-4-flash-250414', available: true }],
        });
      }
      return rpc(channelsStatus([], undefined, false));
    }) as any;

    await expect(client.probe()).resolves.toEqual(expect.objectContaining({
      gatewayReady: true,
      adapterReady: true,
      modelReady: false,
      errorCode: 'OPENCLAW_COMPONENT_DEGRADED',
    }));
  });

  it('uses only the fixed CRM agent target and irreversible session headers for chat', async () => {
    global.fetch = jest.fn(async (url: any, init: any) => {
      const path = new URL(String(url)).pathname;
      if (path === '/healthz') return json({ status: 'ok' });
      if (path === '/api/v1/vaysen/health') {
        return json({
          schemaVersion: 1,
          pluginId: 'vaysen-crm',
          adapterReady: true,
          brokerConfigured: true,
        });
      }
      if (path === '/api/v1/admin/rpc') {
        const method = JSON.parse(init.body).method;
        if (method === 'channels.status') return rpc(channelsStatus([], undefined, false));
        if (method === 'models.authStatus') {
          return rpc({
            ts: Date.now(),
            providers: [{ provider: 'zhipu-cn', status: 'static', profiles: [] }],
          });
        }
        return rpc({
          models: [{ provider: 'zhipu-cn', id: 'glm-4-flash-250414', available: true }],
        });
      }
      if (path === '/v1/chat/completions') {
        return json({ model: 'openclaw/vaysen-crm', choices: [{ message: { content: '安全草稿' } }] });
      }
      return json({}, 404);
    }) as any;

    const digest = 'a'.repeat(64);
    await expect(client.chat('system', 'user', digest)).resolves.toEqual(expect.objectContaining({
      success: true,
      content: '安全草稿',
      responseSource: 'openclaw_gateway',
    }));
    const chatCall = (global.fetch as jest.Mock).mock.calls.find(([url]) => (
      new URL(String(url)).pathname === '/v1/chat/completions'
    ));
    expect(chatCall).toBeDefined();
    const [, init] = chatCall!;
    expect(init.headers).toEqual(expect.objectContaining({
      'x-openclaw-agent-id': 'vaysen-crm',
      'x-openclaw-message-channel': 'webchat',
      'x-openclaw-session-key': `vaysen-crm:${digest}`,
    }));
    expect(JSON.parse(init.body)).toEqual(expect.objectContaining({
      model: 'openclaw/vaysen-crm',
      temperature: 0,
    }));
    expect(JSON.stringify(init)).not.toContain('companyId');
    expect(JSON.stringify(init)).not.toContain('operatorUserId');
  });

  it('rejects public HTTP gateway URLs and invalid session digests without sending chat', async () => {
    process.env.OPENCLAW_GATEWAY_URL = 'http://public.example.com';
    global.fetch = jest.fn();
    const probe = await client.probe();
    expect(probe.gatewayReady).toBe(false);
    expect(await client.chat('system', 'user', 'raw-user-id')).toEqual({
      success: false,
      reason: 'invalid_response',
    });
  });

  it('renders the exact Tencent HTTPS login URL as an in-app QR code and pins the owner account alias', async () => {
    global.fetch = jest.fn(async (_url: any, init: any) => {
      const { method } = JSON.parse(init.body);
      if (method === 'web.login.start') {
        return rpc({
          qrDataUrl: 'https://liteapp.weixin.qq.com/qrcode/owner-session?ticket=abc123',
          message: 'scan',
          sessionKey: 'opaque-owner-session-key',
        });
      }
      return rpc({
        connected: true,
        message: 'connected',
        ownerPeerDigest: 'a'.repeat(64),
      });
    }) as any;

    await expect(client.startWechatPairing()).resolves.toEqual(expect.objectContaining({
      connected: false,
      qrDataUrl: expect.stringMatching(/^data:image\/png;base64,/),
      sessionKey: 'opaque-owner-session-key',
    }));
    await expect(client.waitWechatPairing('opaque-owner-session-key')).resolves.toEqual({
      connected: true,
      qrDataUrl: null,
      message: 'connected',
      sessionKey: null,
      ownerPeerDigest: 'a'.repeat(64),
    });

    const requests = (global.fetch as jest.Mock).mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(requests).toEqual([
      expect.objectContaining({
        method: 'web.login.start',
        params: expect.objectContaining({ accountId: 'vaysen-owner' }),
      }),
      expect.objectContaining({
        method: 'web.login.wait',
        params: expect.objectContaining({
          accountId: 'vaysen-owner',
          timeoutMs: 90_000,
        }),
      }),
    ]);
    expect(requests[1].params).not.toHaveProperty('sessionKey');
  });

  it('does not render non-Tencent, HTTP or credential-bearing QR URLs', async () => {
    const parse = (value: string) => (client as any).parseWechatLoginResult({ qrDataUrl: value });
    await expect(parse('https://example.com/qr')).resolves.toEqual(expect.objectContaining({ qrDataUrl: null }));
    await expect(parse('http://liteapp.weixin.qq.com/qr')).resolves.toEqual(expect.objectContaining({ qrDataUrl: null }));
    await expect(parse('https://user:pass@liteapp.weixin.qq.com/qr')).resolves.toEqual(expect.objectContaining({ qrDataUrl: null }));
  });

  it('accepts only a lowercase SHA-256 owner digest and never forwards raw pairing identity fields', async () => {
    const parse = (value: Record<string, unknown>) => (client as any).parseWechatLoginResult(value);
    await expect(parse({
      connected: true,
      ownerPeerDigest: 'b'.repeat(64),
      userId: 'raw-owner@im.wechat',
      botToken: 'raw-token',
      accountId: 'raw-bot@im.bot',
    })).resolves.toEqual({
      connected: true,
      qrDataUrl: null,
      message: null,
      sessionKey: null,
      ownerPeerDigest: 'b'.repeat(64),
    });
    await expect(parse({ connected: true, ownerPeerDigest: 'B'.repeat(64) })).resolves.toEqual(
      expect.objectContaining({ ownerPeerDigest: null }),
    );
    await expect(parse({ connected: false, ownerPeerDigest: 'c'.repeat(64) })).resolves.toEqual(
      expect.objectContaining({ ownerPeerDigest: null }),
    );
  });

  it('sends an owner notification only through the fixed gateway-auth route and requires a real messageId', async () => {
    global.fetch = jest.fn(async (url: any, init: any) => {
      expect(new URL(String(url)).pathname).toBe('/api/v1/vaysen/notify-owner');
      expect(init.headers.authorization).toBe(`Bearer ${'t'.repeat(48)}`);
      expect(JSON.parse(init.body)).toEqual({
        ownerDigest: 'a'.repeat(64),
        eventKey: 'whatsapp.inbound:evt-1',
        text: 'New customer message.',
      });
      return json({ schemaVersion: 1, status: 'SUCCEEDED', messageId: 'wx-provider-message-1' });
    }) as any;

    await expect(client.notifyOwner({
      ownerDigest: 'a'.repeat(64),
      eventKey: 'whatsapp.inbound:evt-1',
      text: 'New customer message.',
    })).resolves.toEqual({
      success: true,
      messageId: 'wx-provider-message-1',
      reason: 'success',
    });
  });

  it('fails owner notifications closed on invalid input or an empty provider receipt', async () => {
    global.fetch = jest.fn(async () => json({ schemaVersion: 1, status: 'SUCCEEDED', messageId: '' })) as any;
    await expect(client.notifyOwner({
      ownerDigest: 'raw-wechat-id',
      eventKey: 'evt-1',
      text: 'message',
    })).resolves.toEqual({ success: false, reason: 'invalid_request' });
    expect(global.fetch).not.toHaveBeenCalled();

    await expect(client.notifyOwner({
      ownerDigest: 'b'.repeat(64),
      eventKey: 'mail.inbound:evt-2',
      text: 'New customer email.',
    })).resolves.toEqual({ success: false, reason: 'invalid_response' });
  });

  it('preserves only the safe rebind-required owner notification failure', async () => {
    global.fetch = jest.fn(async () => json({
      schemaVersion: 1,
      status: 'FAILED',
      code: 'OWNER_CHANNEL_REBIND_REQUIRED',
    }, 503)) as any;

    await expect(client.notifyOwner({
      ownerDigest: 'c'.repeat(64),
      eventKey: 'whatsapp.inbound:stale-owner-session',
      text: 'New customer message.',
    })).resolves.toEqual({ success: false, reason: 'rebind_required' });
  });
});
