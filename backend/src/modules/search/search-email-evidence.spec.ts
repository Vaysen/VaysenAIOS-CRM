import { SearchService } from './search.service';
import { emailAddressEvidenceHash } from '../outbound/email-verification-evidence';

describe('SearchService trusted Reacher evidence integration', () => {
  function harness(currentEmail = 'buyer@example.com') {
    const prisma: any = {
      lead: {
        findUnique: jest.fn().mockResolvedValue({ contactEmail: currentEmail }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma.$transaction = jest.fn((operation: any) => operation(prisma));
    const service: any = Object.create(SearchService.prototype);
    service.prisma = prisma;
    return { service, prisma };
  }

  it('binds exact-address Reacher evidence through the shared CAS writer', async () => {
    const { service, prisma } = harness();
    await expect(service.applySearchEmailEvidence(
      'lead-1',
      ' Buyer@Example.COM ',
      { status: 'smtp_verified', method: 'reacher' },
      'Reacher accepted the mailbox',
    )).resolves.toEqual({ updated: true, reason: null });
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { id: 'lead-1', contactEmail: 'buyer@example.com' },
      data: {
        emailVerificationStatus: 'smtp_verified',
        emailVerificationReason: 'Reacher accepted the mailbox',
        emailVerifiedAddressHash: emailAddressEvidenceHash('buyer@example.com'),
      },
    });
  });

  it('does not promote MX or public-page inference to sendable evidence', async () => {
    const { service, prisma } = harness();
    await service.applySearchEmailEvidence(
      'lead-1',
      'buyer@example.com',
      { status: 'domain_verified', method: 'mx' },
      'Domain has MX',
    );
    expect(prisma.lead.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        emailVerificationStatus: 'unverified',
        emailVerifiedAddressHash: null,
      }),
    }));
  });

  it('rejects a stale Reacher result after Search lead email changed', async () => {
    const { service, prisma } = harness('replacement@example.com');
    await expect(service.applySearchEmailEvidence(
      'lead-1',
      'old@example.com',
      { status: 'smtp_verified', method: 'reacher' },
      'Late Reacher result',
    )).resolves.toEqual({ updated: false, reason: 'ADDRESS_CHANGED' });
    expect(prisma.lead.updateMany).not.toHaveBeenCalled();
  });
});
