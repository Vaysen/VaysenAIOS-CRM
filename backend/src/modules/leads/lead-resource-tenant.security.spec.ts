import {
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { LeadsService } from './leads.service';
import { TagsService } from '../tags/tags.service';

const tenantAAdmin = {
  id: 'admin-a',
  activeCompanyId: 'A',
  activeCompany: { id: 'A', name: 'A', role: 'company_admin' },
  companies: [
    { id: 'A', name: 'A', role: 'company_admin' },
    { id: 'B', name: 'B', role: 'viewer' },
  ],
};

describe('lead UUID and tag tenant binding', () => {
  it('queries an attacker-supplied lead UUID only inside the active tenant', async () => {
    const prisma = {
      lead: { findFirst: jest.fn().mockResolvedValue(null) },
      leadActivity: { findFirst: jest.fn() },
    };
    const service: any = Object.create(LeadsService.prototype);
    service.prisma = prisma;

    await expect(service.findOne('uuid-from-tenant-b', tenantAAdmin))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.lead.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'uuid-from-tenant-b',
          companyId: 'A',
          deletedAt: null,
        },
      }),
    );
    expect(prisma.leadActivity.findFirst).not.toHaveBeenCalled();
  });

  it('rejects tag IDs that are not all owned by the lead tenant', async () => {
    const prisma = {
      tag: {
        findMany: jest.fn().mockResolvedValue([{ id: 'tag-a' }]),
      },
      leadTag: { createMany: jest.fn() },
    };
    const service = new TagsService(prisma as any);

    await expect(service.addTagsToLead(
      'lead-a',
      ['tag-a', 'tag-b-from-other-tenant'],
      'admin-a',
      'A',
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.tag.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['tag-a', 'tag-b-from-other-tenant'] },
        companyId: 'A',
      },
      select: { id: true },
    });
    expect(prisma.leadTag.createMany).not.toHaveBeenCalled();
  });
});
