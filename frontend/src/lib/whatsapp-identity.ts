const SYSTEM_TEXT_EXACT = new Set([
  '业务账户',
  '给自己发消息',
  '在线',
  'business account',
  'online',
  'unavailable',
  'messages',
]);

const SYSTEM_TEXT_PREFIXES = [
  '最后上线于',
  '点击此处查看联系人信息',
  '正在输入',
  'last seen',
  'click here to view',
  'typing',
] as const;

/** 状态文案绝不能成为 CRM 客户名。未知/过长输入也按不可信处理。 */
export function sanitizeWhatsAppDisplayName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length >= 100) return null;

  const lower = trimmed.toLowerCase();
  if (SYSTEM_TEXT_EXACT.has(lower)) return null;
  if (SYSTEM_TEXT_PREFIXES.some((prefix) => lower.startsWith(prefix))) return null;
  return trimmed;
}

/** 只保留可信 JID 提供的完整号码；不做尾号推断。 */
export function normalizeWhatsAppPhone(input: unknown): string {
  const digits = String(input ?? '').replace(/\D/g, '');
  return digits.startsWith('00') ? digits.slice(2) : digits;
}

export function normalizeWhatsAppName(input: unknown): string {
  const sanitized = sanitizeWhatsAppDisplayName(input);
  return sanitized ? sanitized.toLocaleLowerCase().replace(/\s+/g, ' ').trim() : '';
}

/**
 * 只有唯一精确命中才自动关联。重名或无命中均返回 undefined，交由人工确认。
 */
export function findUniqueExactMatch<T>(
  items: readonly T[],
  candidate: string,
  readValue: (item: T) => string,
): T | undefined {
  if (!candidate) return undefined;
  const matches = items.filter((item) => readValue(item) === candidate);
  return matches.length === 1 ? matches[0] : undefined;
}

type LeadWithWhatsAppIdentity = {
  contactPhone?: unknown;
  whatsapp?: unknown;
  contactPoints?: Array<{
    type?: unknown;
    normalizedValue?: unknown;
    originalValue?: unknown;
    isVerified?: unknown;
  }>;
};

/**
 * A verified WhatsApp ContactPoint is the canonical identity anchor. Legacy
 * lead phone fields are only a fallback when exactly one lead matches. This
 * prevents stale duplicate rows from hiding the already-bound customer.
 */
export function findLeadByTrustedWhatsAppIdentity<T extends LeadWithWhatsAppIdentity>(
  leads: readonly T[],
  candidate: string,
): T | undefined {
  const phone = normalizeWhatsAppPhone(candidate);
  if (!phone) return undefined;

  const verifiedMatches = leads.filter((lead) => lead.contactPoints?.some((point) => (
    String(point.type || '').toLowerCase() === 'whatsapp'
      && point.isVerified === true
      && normalizeWhatsAppPhone(point.normalizedValue || point.originalValue) === phone
  )));
  if (verifiedMatches.length === 1) return verifiedMatches[0];
  if (verifiedMatches.length > 1) return undefined;

  return findUniqueExactMatch(
    leads,
    phone,
    (lead) => normalizeWhatsAppPhone(lead.whatsapp || lead.contactPhone),
  );
}
