import {
  emailAddressEvidenceHash,
  writeEmailVerificationEvidence,
} from './email-verification-evidence';

describe('trusted email verification evidence CAS', () => {
  it('binds trusted evidence to the exact normalized address', async () => {
    const prisma: any = {
      lead: {
        findUnique: jest.fn().mockResolvedValue({ contactEmail: ' Buyer@Example.COM ' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma.$transaction = jest.fn((operation: any) => operation(prisma));

    await expect(writeEmailVerificationEvidence(prisma, {
      leadId: 'lead-1',
      expectedEmail: 'buyer@example.com',
      status: 'smtp_verified',
      reason: 'Trusted verifier accepted mailbox',
      trustedEvidence: true,
    })).resolves.toEqual({ updated: true, reason: null });
    expect(prisma.lead.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'lead-1', contactEmail: ' Buyer@Example.COM ' },
      data: expect.objectContaining({
        emailVerificationStatus: 'smtp_verified',
        emailVerifiedAddressHash: emailAddressEvidenceHash('buyer@example.com'),
      }),
    }));
  });

  it('rejects a stale verifier result after the address changed', async () => {
    const prisma: any = {
      lead: {
        findUnique: jest.fn().mockResolvedValue({ contactEmail: 'new@example.com' }),
        updateMany: jest.fn(),
      },
    };
    prisma.$transaction = jest.fn((operation: any) => operation(prisma));

    await expect(writeEmailVerificationEvidence(prisma, {
      leadId: 'lead-1',
      expectedEmail: 'old@example.com',
      status: 'smtp_verified',
      reason: 'Late result',
      trustedEvidence: true,
    })).resolves.toEqual({ updated: false, reason: 'ADDRESS_CHANGED' });
    expect(prisma.lead.updateMany).not.toHaveBeenCalled();
  });

  it('never upgrades MX or user-supplied website evidence to a sendable status', async () => {
    const prisma: any = {
      lead: {
        findUnique: jest.fn().mockResolvedValue({ contactEmail: 'buyer@example.com' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma.$transaction = jest.fn((operation: any) => operation(prisma));

    await writeEmailVerificationEvidence(prisma, {
      leadId: 'lead-1',
      expectedEmail: 'buyer@example.com',
      status: 'official_page_verified',
      reason: 'User-supplied website matches MX',
      trustedEvidence: false,
    });
    expect(prisma.lead.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        emailVerificationStatus: 'unverified',
        emailVerifiedAddressHash: null,
      }),
    }));
  });
});
