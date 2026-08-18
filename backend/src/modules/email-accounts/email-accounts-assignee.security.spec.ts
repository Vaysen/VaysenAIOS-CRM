import { BadRequestException } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { EmailAccountsService } from './email-accounts.service';
import { resolveSmtpEgress } from './smtp-egress.policy';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));
jest.mock('../../common/utils/crypto.util', () => ({
  encrypt: jest.fn((value: string) => `encrypted:${value}`),
  decrypt: jest.fn((value: string) => value),
}));
jest.mock('./smtp-egress.policy', () => ({
  resolveSmtpEgress: jest.fn(async (account: any) => ({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpSecure,
  })),
}));

describe('EmailAccountsService assignee security boundary', () => {
  const companyId = '11111111-1111-4111-8111-111111111111';
  const foreignCompanyId = '22222222-2222-4222-8222-222222222222';
  const adminId = '33333333-3333-4333-8333-333333333333';
  const activeUserId = '44444444-4444-4444-8444-444444444444';
  const existingAccount = {
    id: '55555555-5555-4555-8555-555555555555',
    companyId,
    userId: null,
    senderName: 'Example Trading Company',
    senderEmail: 'sales@example.org',
    replyToEmail: null,
    smtpHost: 'smtp.example.org',
    smtpPort: 465,
    smtpSecure: true,
    smtpUsername: 'sender',
    smtpPasswordEncrypted: 'encrypted:existing-password',
  };
  const admin = {
    id: adminId,
    activeCompanyId: companyId,
    activeCompany: { id: companyId, role: 'company_admin' },
    companies: [{ id: companyId, role: 'company_admin' }],
  };
  const createDto = {
    senderName: 'Example Trading Company',
    senderEmail: 'sales@example.org',
    smtpHost: 'smtp.example.org',
    smtpPort: 465,
    smtpSecure: true,
    smtpUsername: 'sender',
    smtpPassword: 'new-password',
  };

  type MembershipRecord = {
    id: string;
    userId: string;
    companyId: string;
    relationActive: boolean;
    userActive: boolean;
    deletedAt: Date | null;
    companyActive: boolean;
    roleName?: string;
  };

  const invalidMemberships: Array<{
    label: string;
    userId: string;
    record: MembershipRecord;
  }> = [
    {
      label: 'inactive user',
      userId: '60000000-0000-4000-8000-000000000001',
      record: {
        id: 'relation-inactive-user',
        userId: '60000000-0000-4000-8000-000000000001',
        companyId,
        relationActive: true,
        userActive: false,
        deletedAt: null,
        companyActive: true,
      },
    },
    {
      label: 'deleted user',
      userId: '60000000-0000-4000-8000-000000000002',
      record: {
        id: 'relation-deleted-user',
        userId: '60000000-0000-4000-8000-000000000002',
        companyId,
        relationActive: true,
        userActive: true,
        deletedAt: new Date('2026-01-01T00:00:00.000Z'),
        companyActive: true,
      },
    },
    {
      label: 'inactive company',
      userId: '60000000-0000-4000-8000-000000000003',
      record: {
        id: 'relation-inactive-company',
        userId: '60000000-0000-4000-8000-000000000003',
        companyId,
        relationActive: true,
        userActive: true,
        deletedAt: null,
        companyActive: false,
      },
    },
    {
      label: 'inactive relation',
      userId: '60000000-0000-4000-8000-000000000004',
      record: {
        id: 'relation-inactive',
        userId: '60000000-0000-4000-8000-000000000004',
        companyId,
        relationActive: false,
        userActive: true,
        deletedAt: null,
        companyActive: true,
      },
    },
    {
      label: 'foreign user',
      userId: '60000000-0000-4000-8000-000000000005',
      record: {
        id: 'relation-foreign-user',
        userId: '60000000-0000-4000-8000-000000000005',
        companyId: foreignCompanyId,
        relationActive: true,
        userActive: true,
        deletedAt: null,
        companyActive: true,
      },
    },
  ];

  function matchesMembership(where: any, record: MembershipRecord) {
    if (record.userId !== where.userId || record.companyId !== where.companyId) return false;
    if (where.isActive !== undefined && record.relationActive !== where.isActive) return false;

    const userWhere = where.user?.is;
    if (userWhere?.isActive !== undefined && record.userActive !== userWhere.isActive) return false;
    if (
      userWhere
      && Object.prototype.hasOwnProperty.call(userWhere, 'deletedAt')
      && record.deletedAt !== userWhere.deletedAt
    ) {
      return false;
    }

    const companyWhere = where.company?.is;
    if (
      companyWhere?.isActive !== undefined
      && record.companyActive !== companyWhere.isActive
    ) {
      return false;
    }
    return true;
  }

  function createHarness(targetRecord: MembershipRecord) {
    const adminRecord: MembershipRecord = {
      id: 'relation-admin',
      userId: adminId,
      companyId,
      relationActive: true,
      userActive: true,
      deletedAt: null,
      companyActive: true,
      roleName: 'company_admin',
    };
    const records = [adminRecord, targetRecord];
    const userCompanyRelationFindFirst = jest.fn(({ where }: any) => {
      const record = records.find((candidate) => matchesMembership(where, candidate));
      if (!record) return Promise.resolve(null);
      return Promise.resolve({
        id: record.id,
        role: record.roleName ? { name: record.roleName } : undefined,
      });
    });
    const emailAccountCreate = jest.fn().mockImplementation(({ data }: any) => (
      Promise.resolve({ ...existingAccount, ...data, id: existingAccount.id })
    ));
    const emailAccountUpdate = jest.fn().mockImplementation(({ data }: any) => (
      Promise.resolve({ ...existingAccount, ...data })
    ));
    const auditCreate = jest.fn().mockResolvedValue({ id: 'audit-1' });
    const outboundExecute = jest.fn();
    const prisma: any = {
      userCompanyRelation: { findFirst: userCompanyRelationFindFirst },
      emailAccount: {
        findFirst: jest.fn().mockResolvedValue(existingAccount),
        create: emailAccountCreate,
        update: emailAccountUpdate,
      },
      auditLog: { create: auditCreate },
    };

    return {
      service: new EmailAccountsService(prisma, { execute: outboundExecute } as any),
      userCompanyRelationFindFirst,
      emailAccountCreate,
      emailAccountUpdate,
      auditCreate,
      outboundExecute,
    };
  }

  beforeEach(() => {
    delete process.env.EMAIL_ACCOUNT_SHARED_POOL;
    jest.clearAllMocks();
  });

  it.each(invalidMemberships)(
    'rejects $label assignee before create/update, SMTP, provider, audit, or write side effects',
    async ({ userId, record }) => {
      const harness = createHarness(record);

      await expect(harness.service.create({
        ...createDto,
        userId,
      }, admin)).rejects.toBeInstanceOf(BadRequestException);
      await expect(harness.service.update(existingAccount.id, {
        userId,
        smtpHost: 'smtp.changed.example.org',
      }, admin)).rejects.toBeInstanceOf(BadRequestException);

      const assigneeLookups = harness.userCompanyRelationFindFirst.mock.calls
        .map(([query]) => query)
        .filter((query) => query.where.userId === userId);
      expect(assigneeLookups).toHaveLength(2);
      for (const query of assigneeLookups) {
        expect(query).toEqual({
          where: {
            userId,
            companyId,
            isActive: true,
            user: { is: { isActive: true, deletedAt: null } },
            company: { is: { isActive: true } },
          },
          select: { id: true },
        });
      }
      expect(harness.emailAccountCreate).not.toHaveBeenCalled();
      expect(harness.emailAccountUpdate).not.toHaveBeenCalled();
      expect(harness.auditCreate).not.toHaveBeenCalled();
      expect(resolveSmtpEgress).not.toHaveBeenCalled();
      expect(harness.outboundExecute).not.toHaveBeenCalled();
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
    },
  );

  it('allows an active member for both create and update assignment paths', async () => {
    const activeRecord: MembershipRecord = {
      id: 'relation-active-user',
      userId: activeUserId,
      companyId,
      relationActive: true,
      userActive: true,
      deletedAt: null,
      companyActive: true,
    };
    const harness = createHarness(activeRecord);

    await expect(harness.service.create({
      ...createDto,
      userId: activeUserId,
    }, admin)).resolves.toMatchObject({ userId: activeUserId });
    await expect(harness.service.update(existingAccount.id, {
      userId: activeUserId,
    }, admin)).resolves.toMatchObject({ userId: activeUserId });

    expect(harness.emailAccountCreate).toHaveBeenCalledTimes(1);
    expect(harness.emailAccountUpdate).toHaveBeenCalledTimes(1);
    expect(harness.auditCreate).toHaveBeenCalledTimes(2);
    expect(resolveSmtpEgress).toHaveBeenCalledTimes(2);
    expect(harness.outboundExecute).not.toHaveBeenCalled();
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });
});
