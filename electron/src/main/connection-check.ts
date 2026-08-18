import http from 'node:http';
import https from 'node:https';
import { validateApiUrl } from '../shared/runtime-config';
import {
  ConnectionCheckResult,
  connectionErrorMessage,
  isHealthyPayload,
  releaseVersionFromHealth,
} from '../shared/connection-check';

const HEALTH_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 128 * 1024;

function healthUrl(raw: string): URL {
  const parsed = new URL(raw);
  parsed.pathname = '/health';
  parsed.search = '';
  parsed.hash = '';
  return parsed;
}

function result(code: ConnectionCheckResult['code'], url: string, startedAt: number, extra: Partial<ConnectionCheckResult> = {}): ConnectionCheckResult {
  return {
    ok: code === 'ok',
    code,
    url,
    latencyMs: Date.now() - startedAt,
    message: extra.message || connectionErrorMessage(code, extra.status),
    ...extra,
  };
}

export function checkApiConnection(raw: string, expectedVersion?: string): Promise<ConnectionCheckResult> {
  const startedAt = Date.now();
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return Promise.resolve(result('not_configured', value, startedAt));
  const validationError = validateApiUrl(value);
  if (validationError) return Promise.resolve(result('invalid_url', value, startedAt, { message: validationError }));

  let target: URL;
  try {
    target = healthUrl(value);
  } catch {
    return Promise.resolve(result('invalid_url', value, startedAt));
  }

  return new Promise((resolve) => {
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: target.pathname,
      method: 'GET',
      headers: { accept: 'application/json' },
      timeout: HEALTH_TIMEOUT_MS,
      agent: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
      });
      response.on('end', () => {
        const status = response.statusCode || 0;
        if (status < 200 || status >= 300) {
          resolve(result('http_status', value, startedAt, { status }));
          return;
        }
        let payload: any;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          resolve(result('invalid_response', value, startedAt, { status }));
          return;
        }
        if (!isHealthyPayload(payload)) {
          resolve(result('invalid_response', value, startedAt, { status }));
          return;
        }
        const serverVersion = releaseVersionFromHealth(payload);
        const declaredClientVersion = payload?.clientVersion ?? payload?.compatibility?.clientVersion;
        const incompatibleServer = expectedVersion
          && serverVersion
          && serverVersion !== 'unknown'
          && serverVersion !== expectedVersion;
        if (expectedVersion && (incompatibleServer || (declaredClientVersion && declaredClientVersion !== expectedVersion))) {
          resolve(result('version_mismatch', value, startedAt, { status, serverVersion }));
          return;
        }
        resolve(result('ok', value, startedAt, {
          status,
          serverVersion,
          release: payload?.release,
          message: '服务器连接正常。',
        }));
      });
    });

    request.on('timeout', () => {
      request.destroy(Object.assign(new Error('health probe timed out'), { code: 'ETIMEDOUT' }));
    });
    request.on('error', (error: NodeJS.ErrnoException) => {
      const code = error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN'
        ? 'dns'
        : error.code === 'ETIMEDOUT'
          ? 'timeout'
          : error.code === 'ECONNREFUSED'
            ? 'unreachable'
            : 'network_error';
      resolve(result(code, value, startedAt));
    });
    request.end();
  });
}
