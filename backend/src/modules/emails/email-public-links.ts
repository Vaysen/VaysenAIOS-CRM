/**
 * 外发邮件 URL 策略。
 *
 * 业务系统本身仅在 ZeroTier 局域网开放；任何发给外部客户的 HTML 都不得包含
 * localhost、RFC1918 或 ZeroTier 地址。未配置公网回调时关闭像素与点击改写，
 * 保留原始 CTA，并提供可执行的“回复邮件退订”说明。
 */

const HTTP_URL = /https?:\/\/[^\s"'<>]+/gi;
const OPEN_PIXEL = /<img\b[^>]*email-track\/open[^>]*>/gi;
const TRACKED_LINK = /(<a\b[^>]*\bhref=["'])(https?:\/\/[^"']*email-track\/click\/[^"']*[?&]url=([^&"']+)[^"']*)(["'][^>]*>)/gi;
const UNSUBSCRIBE_PLACEHOLDER_ANCHOR = /<a\b[^>]*\bhref=["']\{\{unsubscribe_(?:link|url)\}\}["'][^>]*>[\s\S]*?<\/a>/gi;
const UNSUBSCRIBE_PLACEHOLDER = /\{\{unsubscribe_(?:link|url)\}\}/g;
const GENERATED_UNSUBSCRIBE_FOOTER = /(?:<br\s*\/?>\s*)?<hr\s*\/?>\s*<p\b[^>]*>[\s\S]*?unsubscribe[\s\S]*?<\/p>/gi;
const REPLY_MARKER = 'vaysen-crm:reply-unsubscribe';
const REPLY_TEXT = 'To unsubscribe, reply to this email with “Unsubscribe” in the subject.';

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const values = parts.map(Number);
  return values.some((value) => value > 255) ? null : values;
}

export function isPrivateOrLocalHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized
    || normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
    || normalized.endsWith('.lan')
    || normalized.endsWith('.internal')
    || normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('::ffff:')) return true;
  // Single-label DNS names are only resolvable through a local search domain.
  if (!normalized.includes('.') && !normalized.includes(':') && !/^\d+$/.test(normalized)) return true;
  const ipv4 = parseIpv4(normalized);
  if (ipv4) {
    const [a, b] = ipv4;
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19));
  }
  return /^(?:fc|fd)[0-9a-f:]*$/i.test(normalized)
    || /^fe[89ab][0-9a-f:]*$/i.test(normalized);
}

function publicHttpsUrl(raw: string | undefined): URL | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password
      || parsed.search || parsed.hash || isPrivateOrLocalHostname(parsed.hostname)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function getPublicTrackingBaseUrl(): string | null {
  const parsed = publicHttpsUrl(process.env.PUBLIC_TRACKING_BASE_URL);
  if (!parsed || (parsed.pathname !== '/' && parsed.pathname !== '')) return null;
  return parsed.origin;
}

export function getPublicUnsubscribeUrl(token: string): string | null {
  const configured = process.env.PUBLIC_UNSUBSCRIBE_URL?.trim();
  if (!configured) return null;
  const candidate = configured.includes('{token}')
    ? configured.replace(/\{token\}/g, encodeURIComponent(token))
    : `${configured.replace(/\/$/, '')}/unsubscribe/${encodeURIComponent(token)}`;
  return publicHttpsUrl(candidate)?.toString() || null;
}

export function isPublicTrackingEnabled(): boolean {
  return getPublicTrackingBaseUrl() !== null;
}

export function findPrivateNetworkUrl(bodyHtml: string): string | null {
  return findPrivateNetworkUrlRecursive(bodyHtml, 0);
}

function decodeUrlComponentRepeated(raw: string): string {
  let value = raw;
  for (let depth = 0; depth < 3; depth += 1) {
    try {
      const decoded = decodeURIComponent(value);
      if (decoded === value) break;
      value = decoded;
    } catch {
      break;
    }
  }
  return value;
}

function findPrivateNetworkUrlRecursive(value: string, depth: number): string | null {
  if (!value || depth > 3) return null;
  for (const raw of value.match(HTTP_URL) || []) {
    try {
      const parsed = new URL(raw.replace(/[),.;]+$/, ''));
      if (isPrivateOrLocalHostname(parsed.hostname)) return raw;

      for (const nestedValue of parsed.searchParams.values()) {
        const nestedPrivateUrl = findPrivateNetworkUrlRecursive(
          decodeUrlComponentRepeated(nestedValue),
          depth + 1,
        );
        if (nestedPrivateUrl) return nestedPrivateUrl;
      }
    } catch {
      // 交由其他内容校验处理；这里仅阻断能确认的内网 URL。
    }
  }
  return null;
}

export function restoreOriginalTrackedLinks(bodyHtml: string): string {
  return bodyHtml.replace(TRACKED_LINK, (_match, prefix, _tracked, encoded, suffix) => {
    try {
      const original = decodeUrlComponentRepeated(encoded);
      const parsed = new URL(original);
      return `${prefix}${parsed.toString()}${suffix}`;
    } catch {
      return _match;
    }
  });
}

export function injectPublicTrackingPixel(bodyHtml: string, trackingId: string): string {
  const clean = bodyHtml.replace(OPEN_PIXEL, '');
  const baseUrl = getPublicTrackingBaseUrl();
  if (!baseUrl) return clean;
  const pixel = `<img src="${baseUrl}/api/email-track/open/${encodeURIComponent(trackingId)}" width="1" height="1" style="display:none;" alt="" />`;
  return clean.includes('</body>') ? clean.replace('</body>', `${pixel}</body>`) : `${clean}${pixel}`;
}

export function replaceLinksWithPublicTracking(bodyHtml: string, trackingId: string): string {
  const restored = restoreOriginalTrackedLinks(bodyHtml);
  const baseUrl = getPublicTrackingBaseUrl();
  if (!baseUrl) return restored;
  return restored.replace(/<a\s+[^>]*href="(https?:\/\/[^"#]+)"[^>]*>/gi, (match, url) => {
    if (/email-track\/(?:click|open)/i.test(url)) return match;
    // Do not conceal a private target inside an apparently public tracking URL.
    // The final content guard will reject the visible private target fail-closed.
    if (findPrivateNetworkUrl(url)) return match;
    const tracked = `${baseUrl}/api/email-track/click/${encodeURIComponent(trackingId)}?url=${encodeURIComponent(url)}`;
    return match.replace(url, tracked);
  });
}

function replyUnsubscribeFooter(): string {
  return `<br /><hr /><p data-${REPLY_MARKER}="true" style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6b7280;">${REPLY_TEXT}</p>`;
}

export function appendPublicUnsubscribe(bodyHtml: string, token: string): string {
  const publicUrl = getPublicUnsubscribeUrl(token);
  let clean = bodyHtml.replace(GENERATED_UNSUBSCRIBE_FOOTER, '');
  if (publicUrl) {
    const footer = `<br /><hr /><p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6b7280;">If you no longer wish to receive marketing emails, please <a href="${publicUrl}" style="color:#2563eb;">unsubscribe</a>.</p>`;
    clean = clean
      .replace(UNSUBSCRIBE_PLACEHOLDER_ANCHOR, `<a href="${publicUrl}">unsubscribe</a>`)
      .replace(UNSUBSCRIBE_PLACEHOLDER, publicUrl);
    return clean.includes('</body>') ? clean.replace('</body>', `${footer}</body>`) : `${clean}${footer}`;
  }

  clean = clean
    .replace(UNSUBSCRIBE_PLACEHOLDER_ANCHOR, REPLY_TEXT)
    .replace(UNSUBSCRIBE_PLACEHOLDER, REPLY_TEXT);
  if (clean.includes(REPLY_MARKER)) return clean;
  const footer = replyUnsubscribeFooter();
  return clean.includes('</body>') ? clean.replace('</body>', `${footer}</body>`) : `${clean}${footer}`;
}

/** 清理历史草稿中的内网跟踪/退订地址，供校验与 SMTP 发送前最后一道门禁。 */
export function prepareEmailForExternalDelivery(bodyHtml: string): string {
  const source = bodyHtml || '';
  const restored = restoreOriginalTrackedLinks(source);
  const privateUrl = findPrivateNetworkUrl(source) || findPrivateNetworkUrl(restored);
  const tokenMatch = source.match(/\/unsubscribe\/([^?"'<>\s/]+)/i);
  let unsubscribeToken = 'manual-reply';
  if (tokenMatch?.[1]) {
    try {
      unsubscribeToken = decodeURIComponent(tokenMatch[1]);
    } catch {
      // 历史坏 token 不应中断 SMTP 队列；退回可执行的回复退订说明。
    }
  }
  let clean = source;

  if (!isPublicTrackingEnabled() || privateUrl) {
    clean = restored.replace(OPEN_PIXEL, '');
  }
  if (privateUrl && /unsubscribe/i.test(privateUrl)) {
    clean = clean.replace(GENERATED_UNSUBSCRIBE_FOOTER, '');
  }
  if (!/unsubscribe/i.test(clean) || privateUrl) {
    clean = appendPublicUnsubscribe(clean, unsubscribeToken);
  }
  return clean;
}
