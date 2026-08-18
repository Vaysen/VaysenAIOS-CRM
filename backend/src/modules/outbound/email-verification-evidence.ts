import { createHash } from 'crypto';

export function normalizeVerifiedEmailAddress(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

export function emailAddressEvidenceHash(value: unknown) {
  return createHash('sha256')
    .update(normalizeVerifiedEmailAddress(value))
    .digest('hex');
}

const SENDABLE_STATUSES = new Set([
  'smtp_verified',
  'official_page_verified',
  'verified_public_source',
]);

export async function writeEmailVerificationEvidence(
  prisma: any,
  input: {
    leadId: string;
    expectedEmail: string;
    status: string;
    reason: string;
    trustedEvidence: boolean;
  },
) {
  const expected = normalizeVerifiedEmailAddress(input.expectedEmail);
  const operation = async (tx: any) => {
    const current = await tx.lead.findUnique({
      where: { id: input.leadId },
      select: { contactEmail: true },
    });
    const currentRaw = current?.contactEmail;
    if (!currentRaw || normalizeVerifiedEmailAddress(currentRaw) !== expected) {
      return { updated: false, reason: 'ADDRESS_CHANGED' as const };
    }
    const mayBindEvidence = input.trustedEvidence && SENDABLE_STATUSES.has(input.status);
    const status = SENDABLE_STATUSES.has(input.status) && !mayBindEvidence
      ? 'unverified'
      : input.status;
    const result = await tx.lead.updateMany({
      where: { id: input.leadId, contactEmail: currentRaw },
      data: {
        emailVerificationStatus: status,
        emailVerificationReason: mayBindEvidence
          ? input.reason
          : SENDABLE_STATUSES.has(input.status)
            ? 'Trusted mailbox verification evidence is required'
            : input.reason,
        emailVerifiedAddressHash: mayBindEvidence
          ? emailAddressEvidenceHash(expected)
          : null,
      },
    });
    return {
      updated: result.count === 1,
      reason: result.count === 1 ? null : 'ADDRESS_CHANGED' as const,
    };
  };
  return prisma.$transaction
    ? prisma.$transaction(operation)
    : operation(prisma);
}
