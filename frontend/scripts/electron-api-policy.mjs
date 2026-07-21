const LOCAL_HOSTS = new Set(['localhost', '0.0.0.0', '::1']);

function normalizeHostname(hostname) {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function parseIpv4(hostname) {
  const parts = hostname.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet, index) => !/^\d{1,3}$/.test(parts[index]) || octet > 255)) {
    return null;
  }
  return octets;
}

export function isLocalHostname(hostname) {
  const normalized = normalizeHostname(hostname);
  if (LOCAL_HOSTS.has(normalized) || normalized.endsWith('.localhost')) return true;
  if (/^::ffff:7f[0-9a-f]{2}:/i.test(normalized)) return true;
  const ipv4Mapped = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (ipv4Mapped) return isLocalHostname(ipv4Mapped[1]);
  const ipv4 = parseIpv4(normalized);
  return Boolean(ipv4 && ipv4[0] === 127);
}

export function isPrivateHostname(hostname) {
  const normalized = normalizeHostname(hostname);
  if (isLocalHostname(normalized)) return true;
  const ipv4Mapped = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (ipv4Mapped) return isPrivateHostname(ipv4Mapped[1]);

  const ipv4 = parseIpv4(normalized);
  if (ipv4) {
    const [a, b] = ipv4;
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }

  if (/^(fc|fd)[0-9a-f:]*$/i.test(normalized)) return true;
  if (/^fe[89ab][0-9a-f:]*$/i.test(normalized)) return true;
  return (
    !normalized.includes('.') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.lan') ||
    normalized.endsWith('.internal') ||
    normalized.endsWith('.home')
  );
}

export function parseApprovedOrigins(raw = '') {
  const origins = new Set();
  for (const entry of raw.split(',')) {
    const value = entry.trim();
    if (!value) continue;
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol)) continue;
      if (parsed.username || parsed.password || parsed.search || parsed.hash) continue;
      if (parsed.pathname !== '/' && parsed.pathname !== '') continue;
      origins.add(parsed.origin);
    } catch {
      // Invalid allowlist entries are ignored; they never broaden access.
    }
  }
  return origins;
}

export function validateElectronApiUrl(
  raw,
  approvedOriginsRaw = process.env.APPROVED_ZEROTIER_API_ORIGINS || '',
) {
  if (!raw || !raw.trim()) {
    return {
      ok: false,
      reason: 'NEXT_PUBLIC_API_URL is required for the Electron build',
    };
  }

  // 局域网桌面版固定使用同源 /api，由 Electron 主进程代理到经过校验的
  // ZeroTier 后端。静态资源内不再包含服务器 IP，也不会触发随机本地端口 CORS。
  if (raw.trim() === '/api') {
    return {
      ok: true,
      normalizedUrl: '/api',
      origin: null,
      privateOrigin: false,
      localProxy: true,
    };
  }

  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'NEXT_PUBLIC_API_URL must be an absolute http(s) URL' };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, reason: 'NEXT_PUBLIC_API_URL must use http or https' };
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return {
      ok: false,
      reason: 'NEXT_PUBLIC_API_URL must not contain credentials, query parameters, or fragments',
    };
  }
  if (isLocalHostname(parsed.hostname)) {
    return { ok: false, reason: 'localhost and loopback API origins are forbidden' };
  }

  const approvedOrigins = parseApprovedOrigins(approvedOriginsRaw);
  const isPrivate = isPrivateHostname(parsed.hostname);
  if (isPrivate && !approvedOrigins.has(parsed.origin)) {
    return {
      ok: false,
      reason: `private/ZeroTier API origin ${parsed.origin} is not in APPROVED_ZEROTIER_API_ORIGINS`,
    };
  }
  if (!isPrivate && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'public Electron API origins must use HTTPS' };
  }

  return {
    ok: true,
    normalizedUrl: parsed.toString(),
    origin: parsed.origin,
    privateOrigin: isPrivate,
    localProxy: false,
  };
}
