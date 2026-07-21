export type WhatsappConversationTrustCandidate = {
  isGroup: boolean | null;
  externalThreadId?: string | null;
  contactPoint?: {
    type?: string | null;
    originalValue?: string | null;
    normalizedValue?: string | null;
    isVerified?: boolean | null;
  } | null;
};

const E164_PATTERN = /^\+[1-9]\d{6,14}$/;
const DIRECT_THREAD_PATTERN = /^\+?[1-9]\d{6,14}(?:@s\.whatsapp\.net)?$/i;

const phoneDigits = (value: string | null | undefined) => {
  const digits = String(value || '').replace(/\D/g, '');
  return /^\d{7,15}$/.test(digits) ? digits : '';
};

/**
 * Treats an explicitly classified direct conversation as trusted. A legacy
 * NULL group flag is accepted only when the thread itself is a phone JID and
 * exactly matches a verified E.164 WhatsApp ContactPoint. LIDs, display names,
 * group JIDs and suffix-only phone matches remain fail-closed.
 */
export function isTrustedDirectWhatsappConversation(
  conversation: WhatsappConversationTrustCandidate,
): boolean {
  const externalThreadId = String(conversation.externalThreadId || '').trim();
  if (conversation.isGroup === true || /@g\.us$/i.test(externalThreadId)) return false;
  if (conversation.isGroup === false) return true;
  if (conversation.isGroup !== null || !DIRECT_THREAD_PATTERN.test(externalThreadId)) return false;

  const contactPoint = conversation.contactPoint;
  const normalizedValue = String(
    contactPoint?.normalizedValue || contactPoint?.originalValue || '',
  ).trim();
  if (
    contactPoint?.type !== 'whatsapp'
    || contactPoint.isVerified !== true
    || !E164_PATTERN.test(normalizedValue)
  ) return false;

  const threadPhone = phoneDigits(externalThreadId.replace(/@s\.whatsapp\.net$/i, ''));
  const verifiedPhone = phoneDigits(normalizedValue);
  return !!threadPhone && threadPhone === verifiedPhone;
}
