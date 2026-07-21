/**
 * TASK-102C: IdentityResolutionService 单元测试
 *
 * 覆盖场景:
 * 1. 精确号码复用 (linked)
 * 2. 精确邮箱复用 (linked)
 * 3. 新建客户 (created) — Lead.companyName=null, Contact.firstName=null
 * 4. 尾号相同不自动归一 (review_required) — 创建 IdentityMatchCandidate
 * 5. 跨租户隔离 — companyId 始终在查询条件中
 * 6. 幂等重试 — 第二次返回 linked
 * 7. 并发唯一约束冲突恢复 (P2002) — 重新读取后 linked
 * 8. 手工字段保护 — 外部来源不覆盖 manual_confirmed
 */
import { IdentityResolutionService } from './identity-resolution.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { ResolveIdentityCommand } from './customer-identity.types';
import { Logger } from '@nestjs/common';

// ---------------------------------------------------------------------------
// Mock PrismaService
// ---------------------------------------------------------------------------

interface MockPrismaService {
  $transaction: jest.Mock;
  contactPoint: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  lead: {
    findFirst: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  contact: {
    findFirst: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  externalIdentity: {
    upsert: jest.Mock;
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    create: jest.Mock;
  };
  identityMatchCandidate: {
    upsert: jest.Mock;
    findFirst: jest.Mock;
    create: jest.Mock;
  };
  identityExclusion: {
    findFirst: jest.Mock;
  };
}

function createMockPrismaService(): MockPrismaService {
  const mock: MockPrismaService = {
    $transaction: jest.fn(),
    contactPoint: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    lead: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    contact: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    externalIdentity: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    identityMatchCandidate: {
      upsert: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    identityExclusion: { findFirst: jest.fn() },
  };
  // $transaction: 直接以 mock 自身作为事务客户端调用回调
  mock.$transaction.mockImplementation(
    async (fn: (tx: MockPrismaService) => Promise<unknown>) => fn(mock),
  );
  return mock;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TASK-102C IdentityResolutionService', () => {
  let service: IdentityResolutionService;
  let mockPrisma: MockPrismaService;

  beforeEach(() => {
    mockPrisma = createMockPrismaService();

    // ---- 默认 mock 返回值 ----
    mockPrisma.contactPoint.findFirst.mockResolvedValue(null);
    mockPrisma.contactPoint.findMany.mockResolvedValue([]);
    mockPrisma.contactPoint.create.mockResolvedValue({
      id: 'cp-new',
      companyId: 'co-1',
      type: 'whatsapp',
      normalizedValue: '',
      leadId: 'lead-new',
      contactId: 'contact-new',
    });
    mockPrisma.lead.create.mockResolvedValue({
      id: 'lead-new',
      companyId: 'co-1',
      companyName: null,
    });
    mockPrisma.contact.create.mockResolvedValue({
      id: 'contact-new',
      companyId: 'co-1',
      leadId: 'lead-new',
      firstName: null,
      lastName: null,
    });
    mockPrisma.externalIdentity.upsert.mockResolvedValue({ id: 'ext-1' });
    mockPrisma.externalIdentity.findUnique.mockResolvedValue(null);
    mockPrisma.externalIdentity.findFirst.mockResolvedValue(null);
    mockPrisma.identityMatchCandidate.upsert.mockResolvedValue({
      id: 'cand-1',
      companyId: 'co-1',
      sourceLeadId: 'lead-new',
      targetLeadId: 'lead-existing',
    });
    mockPrisma.identityExclusion.findFirst.mockResolvedValue(null);

    service = new IdentityResolutionService(
      mockPrisma as unknown as PrismaService,
    );
  });

  // ---- 1. 精确号码复用 (linked) ----
  it('1. 精确号码复用 -> linked', async () => {
    const existingPoint = {
      id: 'cp-1',
      companyId: 'co-1',
      type: 'whatsapp',
      normalizedValue: '+8613800001234',
      originalValue: '+8613800001234',
      leadId: 'lead-1',
      contactId: 'contact-1',
      lead: {
        id: 'lead-1',
        companyId: 'co-1',
        companyName: null,
        companyNameSource: null,
      },
      contact: {
        id: 'contact-1',
        companyId: 'co-1',
        firstName: null,
        nameSource: null,
      },
    };
    mockPrisma.contactPoint.findFirst.mockResolvedValue(existingPoint);

    const command: ResolveIdentityCommand = {
      companyId: 'co-1',
      channel: 'whatsapp',
      normalizedValue: '+8613800001234',
      source: 'whatsapp_message',
    };

    const result = await service.resolve(command);

    expect(result).toEqual({
      action: 'linked',
      leadId: 'lead-1',
      contactId: 'contact-1',
      contactPointId: 'cp-1',
    });
    // 验证查询携带 companyId (租户隔离)
    expect(mockPrisma.contactPoint.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyId: 'co-1',
          type: 'whatsapp',
          normalizedValue: '+8613800001234',
        }),
      }),
    );
  });

  // ---- 2. 精确邮箱复用 (linked) ----
  it('2. 精确邮箱复用 -> linked', async () => {
    const existingPoint = {
      id: 'cp-2',
      companyId: 'co-1',
      type: 'email',
      normalizedValue: 'sales@example.com',
      originalValue: 'sales@example.com',
      leadId: 'lead-2',
      contactId: 'contact-2',
      lead: { id: 'lead-2', companyId: 'co-1', companyName: null },
      contact: { id: 'contact-2', companyId: 'co-1', firstName: null },
    };
    mockPrisma.contactPoint.findFirst.mockResolvedValue(existingPoint);

    const command: ResolveIdentityCommand = {
      companyId: 'co-1',
      channel: 'email',
      normalizedValue: 'sales@example.com',
      source: 'email_message',
    };

    const result = await service.resolve(command);

    expect(result).toEqual({
      action: 'linked',
      leadId: 'lead-2',
      contactId: 'contact-2',
      contactPointId: 'cp-2',
    });
  });

  // ---- 3. 新建客户 (created) ----
  it('3. 新建客户 -> created (Lead.companyName=null, Contact.firstName=null)', async () => {
    // 无精确匹配, 无尾号匹配
    mockPrisma.contactPoint.findFirst.mockResolvedValue(null);
    mockPrisma.contactPoint.findMany.mockResolvedValue([]);

    const command: ResolveIdentityCommand = {
      companyId: 'co-1',
      channel: 'whatsapp',
      normalizedValue: '+8613800001234',
      source: 'whatsapp_sync',
    };

    const result = await service.resolve(command);

    expect(result).toEqual({
      action: 'created',
      leadId: 'lead-new',
      contactId: 'contact-new',
      contactPointId: 'cp-new',
    });

    // 验证 Lead 创建时 companyName=null
    expect(mockPrisma.lead.create).toHaveBeenCalledWith({
      data: { companyId: 'co-1', companyName: null },
    });

    // 验证 Contact 创建时 firstName=null
    expect(mockPrisma.contact.create).toHaveBeenCalledWith({
      data: {
        companyId: 'co-1',
        leadId: 'lead-new',
        firstName: null,
        lastName: null,
      },
    });

    // 验证 ContactPoint 创建
    expect(mockPrisma.contactPoint.create).toHaveBeenCalledWith({
      data: {
        companyId: 'co-1',
        type: 'whatsapp',
        originalValue: '+8613800001234',
        normalizedValue: '+8613800001234',
        leadId: 'lead-new',
        contactId: 'contact-new',
      },
    });
  });

  it('3a. 新建客户保留已净化姓名候选和推断国家', async () => {
    const command: ResolveIdentityCommand = {
      companyId: 'co-1',
      channel: 'whatsapp',
      normalizedValue: '+8613800001234',
      source: 'whatsapp_sync',
      contactNameCandidate: 'Elvis',
      countryIso2: 'CN',
    };

    await service.resolve(command);

    expect(mockPrisma.lead.create).toHaveBeenCalledWith({
      data: {
        companyId: 'co-1',
        companyName: null,
        country: 'CN',
      },
    });
    expect(mockPrisma.contact.create).toHaveBeenCalledWith({
      data: {
        companyId: 'co-1',
        leadId: 'lead-new',
        firstName: null,
        lastName: null,
        displayName: 'Elvis',
        nameSource: 'whatsapp_sync',
        nameConfidence: 'low',
      },
    });
  });

  it('3b. ExternalIdentity 精确锚点优先返回已有客户', async () => {
    mockPrisma.externalIdentity.findUnique.mockResolvedValue({
      id: 'ext-existing',
      companyId: 'co-1',
      provider: 'whatsapp',
      externalId: 'wa-123',
      leadId: 'lead-ext',
      contactId: 'contact-ext',
      contactPointId: 'cp-ext',
    });

    const result = await service.resolve({
      companyId: 'co-1',
      channel: 'whatsapp',
      normalizedValue: '+8613800001234',
      source: 'whatsapp_message',
      externalIdentity: {
        provider: 'whatsapp',
        externalId: 'wa-123',
      },
    });

    expect(result).toEqual({
      action: 'linked',
      leadId: 'lead-ext',
      contactId: 'contact-ext',
      contactPointId: 'cp-ext',
    });
    expect(mockPrisma.contactPoint.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.externalIdentity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ identityStatus: 'resolved' }),
      }),
    );
  });

  // ---- 4. 尾号相同不自动归一 (review_required) ----
  it('4. 尾号相同不自动归一 -> review_required (创建 IdentityMatchCandidate)', async () => {
    // 已有 ContactPoint 号码 +8613800001234 (末10位: 3800001234)
    // 新请求号码 +8523800001234 (末10位: 3800001234) — 尾号相同但 E.164 不同
    const existingPoint = {
      id: 'cp-existing',
      companyId: 'co-1',
      type: 'whatsapp',
      normalizedValue: '+8613800001234',
      leadId: 'lead-existing',
      contactId: 'contact-existing',
    };

    // 精确匹配: 无
    mockPrisma.contactPoint.findFirst.mockResolvedValue(null);
    // 尾号候选: 返回已有的 ContactPoint
    mockPrisma.contactPoint.findMany.mockResolvedValue([existingPoint]);

    // 新建 Lead/Contact/ContactPoint mock
    mockPrisma.lead.create.mockResolvedValue({
      id: 'lead-new',
      companyId: 'co-1',
      companyName: null,
    });
    mockPrisma.contact.create.mockResolvedValue({
      id: 'contact-new',
      companyId: 'co-1',
      leadId: 'lead-new',
      firstName: null,
      lastName: null,
    });
    mockPrisma.contactPoint.create.mockResolvedValue({
      id: 'cp-new',
      companyId: 'co-1',
      type: 'whatsapp',
      normalizedValue: '+8523800001234',
      leadId: 'lead-new',
      contactId: 'contact-new',
    });

    const command: ResolveIdentityCommand = {
      companyId: 'co-1',
      channel: 'whatsapp',
      normalizedValue: '+8523800001234',
      source: 'whatsapp_sync',
    };

    const result = await service.resolve(command);

    expect(result.action).toBe('review_required');
    if (result.action === 'review_required') {
      expect(result.candidateId).toBe('cand-1');
      expect(result.leadId).toBe('lead-new');
    }

    // 验证创建了 IdentityMatchCandidate (而非自动合并)
    expect(mockPrisma.identityMatchCandidate.upsert).toHaveBeenCalledTimes(1);
    const candidateCall = mockPrisma.identityMatchCandidate.upsert.mock
      .calls[0][0] as {
      create: { sourceLeadId: string; targetLeadId: string; score: number };
    };
    expect(candidateCall.create.targetLeadId).toBe('lead-existing');
    expect(candidateCall.create.sourceLeadId).toBe('lead-new');
    expect(candidateCall.create.score).toBe(30); // phoneSuffixOnly -> 30
  });

  // ---- 5. 跨租户隔离 ----
  it('5. 跨租户隔离 -> companyId=B 不返回 companyId=A 的记录', async () => {
    // companyId='A' 已有 ContactPoint, companyId='B' 查询相同值不应返回 A 的记录
    mockPrisma.contactPoint.findFirst.mockResolvedValue(null); // B 无精确匹配
    mockPrisma.contactPoint.findMany.mockResolvedValue([]); // B 无尾号候选

    mockPrisma.lead.create.mockResolvedValue({
      id: 'lead-b',
      companyId: 'B',
      companyName: null,
    });
    mockPrisma.contact.create.mockResolvedValue({
      id: 'contact-b',
      companyId: 'B',
      leadId: 'lead-b',
      firstName: null,
      lastName: null,
    });
    mockPrisma.contactPoint.create.mockResolvedValue({
      id: 'cp-b',
      companyId: 'B',
      type: 'whatsapp',
      normalizedValue: '+8613800001234',
      leadId: 'lead-b',
      contactId: 'contact-b',
    });

    const command: ResolveIdentityCommand = {
      companyId: 'B',
      channel: 'whatsapp',
      normalizedValue: '+8613800001234',
      source: 'whatsapp_sync',
    };

    const result = await service.resolve(command);

    expect(result.action).toBe('created');

    // 验证所有查询都携带 companyId='B' (租户隔离)
    expect(mockPrisma.contactPoint.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyId: 'B',
        }),
      }),
    );
    expect(mockPrisma.contactPoint.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyId: 'B',
        }),
      }),
    );
  });

  // ---- 6. 幂等重试 ----
  it('6. 幂等重试 -> 第二次返回 linked (第一次 created 的)', async () => {
    const normalizedValue = '+8613800001234';

    // 第一次调用: 无匹配 -> created
    mockPrisma.contactPoint.findFirst.mockResolvedValueOnce(null);
    mockPrisma.contactPoint.findMany.mockResolvedValueOnce([]);

    const command: ResolveIdentityCommand = {
      companyId: 'co-1',
      channel: 'whatsapp',
      normalizedValue,
      source: 'whatsapp_sync',
    };

    const firstResult = await service.resolve(command);
    expect(firstResult.action).toBe('created');

    // 第二次调用: 精确匹配到第一次创建的 ContactPoint -> linked
    const createdPoint = {
      id: 'cp-new',
      companyId: 'co-1',
      type: 'whatsapp',
      normalizedValue,
      leadId: 'lead-new',
      contactId: 'contact-new',
      lead: { id: 'lead-new', companyName: null },
      contact: { id: 'contact-new', firstName: null },
    };
    mockPrisma.contactPoint.findFirst.mockResolvedValueOnce(createdPoint);

    const secondResult = await service.resolve(command);
    expect(secondResult.action).toBe('linked');
    if (secondResult.action === 'linked') {
      expect(secondResult.contactPointId).toBe('cp-new');
      expect(secondResult.leadId).toBe('lead-new');
    }
  });

  // ---- 7. 并发唯一约束冲突恢复 (P2002) ----
  it('7. 并发唯一约束冲突 -> 事务回滚后用根客户端重新读取 -> linked', async () => {
    const normalizedValue = '+8613800009999';
    const warnSpy = jest.spyOn(Logger.prototype, 'warn');

    const p2002Error = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
    });
    mockPrisma.$transaction.mockRejectedValueOnce(p2002Error);

    const racePoint = {
      id: 'cp-race',
      companyId: 'co-1',
      type: 'whatsapp',
      normalizedValue,
      leadId: 'lead-other',
      contactId: 'contact-other',
      lead: { id: 'lead-other', companyName: null },
      contact: { id: 'contact-other', firstName: null },
    };
    mockPrisma.contactPoint.findFirst.mockResolvedValueOnce(racePoint);

    const command: ResolveIdentityCommand = {
      companyId: 'co-1',
      channel: 'whatsapp',
      normalizedValue,
      source: 'whatsapp_sync',
    };

    const result = await service.resolve(command);

    expect(result).toEqual({
      action: 'linked',
      leadId: 'lead-other',
      contactId: 'contact-other',
      contactPointId: 'cp-race',
    });

    expect(mockPrisma.contactPoint.findFirst).toHaveBeenCalledTimes(1);
    expect(mockPrisma.contactPoint.findFirst).toHaveBeenCalledWith({
      where: {
        companyId: 'co-1',
        type: 'whatsapp',
        normalizedValue,
      },
      include: { lead: true, contact: true },
    });
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining(normalizedValue),
    );
    warnSpy.mockRestore();
  });

  // ---- 8. 手工字段保护 ----
  it('8. 手工字段保护 -> 外部来源 resolve 不覆盖 manual_confirmed', async () => {
    const existingPoint = {
      id: 'cp-8',
      companyId: 'co-1',
      type: 'whatsapp',
      normalizedValue: '+8613800001234',
      leadId: 'lead-8',
      contactId: 'contact-8',
      lead: {
        id: 'lead-8',
        companyId: 'co-1',
        companyName: 'Acme Corp',
        companyNameSource: 'manual_confirmed',
      },
      contact: {
        id: 'contact-8',
        companyId: 'co-1',
        leadId: 'lead-8',
        firstName: 'John',
        nameSource: 'manual_confirmed',
      },
    };
    mockPrisma.contactPoint.findFirst.mockResolvedValue(existingPoint);

    const command: ResolveIdentityCommand = {
      companyId: 'co-1',
      channel: 'whatsapp',
      normalizedValue: '+8613800001234',
      source: 'whatsapp_sync', // 外部来源
      contactNameCandidate: 'Jane Doe',
      externalIdentity: {
        provider: 'whatsapp',
        externalId: '8613800001234',
        rawDisplayName: 'Jane Doe',
      },
    };

    const result = await service.resolve(command);

    expect(result.action).toBe('linked');

    // 验证: 外部来源未覆盖 manual_confirmed 字段
    expect(mockPrisma.lead.update).not.toHaveBeenCalled();
    expect(mockPrisma.contact.update).not.toHaveBeenCalled();
  });

  it('9. 链接外部身份时标记 resolved', async () => {
    const command: ResolveIdentityCommand = {
      companyId: 'co-1',
      channel: 'whatsapp',
      normalizedValue: '+8613800001234',
      source: 'whatsapp_sync',
      externalIdentity: {
        provider: 'whatsapp',
        externalId: 'wa-new',
        rawDisplayName: 'Elvis',
      },
    };

    await service.resolve(command);

    expect(mockPrisma.externalIdentity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ identityStatus: 'resolved' }),
        update: expect.objectContaining({ identityStatus: 'resolved' }),
      }),
    );
  });

  it('10. 精确 ContactPoint 缺少 contactId 时修复关联而不是抛错', async () => {
    mockPrisma.contactPoint.findFirst.mockResolvedValue({
      id: 'cp-legacy',
      companyId: 'co-1',
      type: 'whatsapp',
      normalizedValue: '+8613800001234',
      leadId: 'lead-legacy',
      contactId: null,
      lead: { id: 'lead-legacy', companyId: 'co-1' },
      contact: null,
    });
    mockPrisma.contact.create.mockResolvedValue({
      id: 'contact-repaired',
      companyId: 'co-1',
      leadId: 'lead-legacy',
    });
    mockPrisma.contactPoint.update.mockResolvedValue({
      id: 'cp-legacy',
      leadId: 'lead-legacy',
      contactId: 'contact-repaired',
    });

    const result = await service.resolve({
      companyId: 'co-1',
      channel: 'whatsapp',
      normalizedValue: '+8613800001234',
      source: 'whatsapp_message',
    });

    expect(result).toEqual({
      action: 'linked',
      leadId: 'lead-legacy',
      contactId: 'contact-repaired',
      contactPointId: 'cp-legacy',
    });
  });

  it('11. 只有 LID 外部身份而无真实号码时持久化为 unresolved', async () => {
    mockPrisma.externalIdentity.upsert.mockResolvedValue({
      id: 'ext-lid',
      identityStatus: 'unresolved',
    });

    const result = await service.resolve({
      companyId: 'co-1',
      channel: 'whatsapp',
      normalizedValue: null,
      source: 'whatsapp_message',
      externalIdentity: {
        provider: 'whatsapp',
        externalId: '1234567890@lid',
        rawDisplayName: 'Elvis',
      },
    });

    expect(result).toEqual({
      action: 'unresolved',
      externalIdentityId: 'ext-lid',
      reason: 'missing_normalized_identity',
    });
    expect(mockPrisma.externalIdentity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ identityStatus: 'unresolved' }),
        update: expect.objectContaining({ identityStatus: 'unresolved' }),
      }),
    );
    expect(mockPrisma.lead.create).not.toHaveBeenCalled();
  });
});
