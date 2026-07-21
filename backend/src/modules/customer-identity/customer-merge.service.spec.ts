/**
 * TASK-102F: CustomerMergeService 单元测试
 *
 * 覆盖场景:
 *  1. 预览差异 — previewMerge 只返回不一致字段
 *  2. 人工字段优先 — trusted_defaults 下 manual_confirmed 胜过 inferred
 *  3. 渠道保留 — ContactPoint 仅迁移不删除, 不同号码/邮箱都保留
 *  4. 主联系人 — 合并后每公司最多一个 isPrimary=true 的 Contact
 *  5. 排除对称 — rejectCandidate 保存双向 IdentityExclusion, 候选标记 rejected
 *  6. 事务回滚 — 合并失败时整体回滚, 无半合并状态
 *  7. 乐观锁冲突 — targetUpdatedAt 不匹配时拒绝合并, 不进入事务
 *  8. 撤销 — undoMerge 成功恢复; 目标已变化时拒绝撤销
 *  9. 软删除 — source Lead 标记 merged/soft-deleted, 旧 ID 经 mergedToId 解析到 target
 */
import { CustomerMergeService } from './customer-merge.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { MergeCustomerCommand } from './dto/merge-customer.dto';
import type { RejectCandidateCommand } from './dto/reject-candidate.dto';

// ---------------------------------------------------------------------------
// Mock PrismaService
// ---------------------------------------------------------------------------

interface LeadFixture {
  id: string;
  companyId: string;
  companyName: string | null;
  companyNameSource: string | null;
  companyNameConfidence: string | null;
  country: string | null;
  website: string | null;
  industry: string | null;
  status: string;
  isMerged: boolean;
  mergedToId: string | null;
  deletedAt: Date | null;
  updatedAt: Date;
}

interface ContactFixture {
  id: string;
  companyId: string;
  leadId: string;
  isPrimary: boolean;
  createdAt: Date;
}

interface MockPrismaService {
  $transaction: jest.Mock;
  identityMatchCandidate: {
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  lead: {
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  contact: {
    findMany: jest.Mock;
    updateMany: jest.Mock;
    count: jest.Mock;
  };
  contactPoint: {
    findMany: jest.Mock;
    updateMany: jest.Mock;
    count: jest.Mock;
  };
  conversation: {
    findMany: jest.Mock;
    updateMany: jest.Mock;
    count: jest.Mock;
  };
  leadActivity: { updateMany: jest.Mock };
  emailMessage: { updateMany: jest.Mock };
  quote: { updateMany: jest.Mock };
  order: { updateMany: jest.Mock };
  followUpReminder: { updateMany: jest.Mock };
  customerMergeAudit: {
    create: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  identityExclusion: {
    create: jest.Mock;
    findFirst: jest.Mock;
  };
}

function createMockPrismaService(): MockPrismaService {
  const mock: MockPrismaService = {
    $transaction: jest.fn(),
    identityMatchCandidate: { findUnique: jest.fn(), update: jest.fn() },
    lead: { findUnique: jest.fn(), update: jest.fn() },
    contact: { findMany: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
    contactPoint: { findMany: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
    conversation: { findMany: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
    leadActivity: { updateMany: jest.fn() },
    emailMessage: { updateMany: jest.fn() },
    quote: { updateMany: jest.fn() },
    order: { updateMany: jest.fn() },
    followUpReminder: { updateMany: jest.fn() },
    customerMergeAudit: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    identityExclusion: { create: jest.fn(), findFirst: jest.fn() },
  };
  // $transaction: 以 mock 自身作为事务客户端调用回调, 模拟单事务
  mock.$transaction.mockImplementation(
    async (fn: (tx: MockPrismaService) => Promise<unknown>) => fn(mock),
  );
  return mock;
}

function makeLead(overrides: Partial<LeadFixture>): LeadFixture {
  return {
    id: 'lead-x',
    companyId: 'co-1',
    companyName: null,
    companyNameSource: null,
    companyNameConfidence: null,
    country: null,
    website: null,
    industry: null,
    status: 'new',
    isMerged: false,
    mergedToId: null,
    deletedAt: null,
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TASK-102F CustomerMergeService', () => {
  let service: CustomerMergeService;
  let mockPrisma: MockPrismaService;

  beforeEach(() => {
    mockPrisma = createMockPrismaService();

    // 默认: 计数返回 0
    mockPrisma.contact.count.mockResolvedValue(0);
    mockPrisma.contactPoint.count.mockResolvedValue(0);
    mockPrisma.conversation.count.mockResolvedValue(0);
    // 默认: contact.findMany 按 leadId 返回空
    mockPrisma.contact.findMany.mockImplementation((args: { where: { leadId?: string } }) =>
      Promise.resolve([]),
    );
    mockPrisma.contactPoint.findMany.mockResolvedValue([]);
    mockPrisma.conversation.findMany.mockResolvedValue([]);
    // 默认: 迁移 updateMany 返回 { count: 0 }
    mockPrisma.contact.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.contactPoint.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.conversation.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.leadActivity.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.emailMessage.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.quote.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.order.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.followUpReminder.updateMany.mockResolvedValue({ count: 0 });

    service = new CustomerMergeService(mockPrisma as unknown as PrismaService);
  });

  // ---- 1. 预览差异 ----
  it('1. previewMerge 只返回不一致字段', async () => {
    const source = makeLead({
      id: 'lead-s',
      companyName: 'Acme',
      country: 'CN',
      website: 'a.com',
      industry: 'X',
    });
    const target = makeLead({
      id: 'lead-t',
      companyName: 'Acme', // 一致
      country: 'US', // 不一致
      website: 'a.com', // 一致
      industry: 'Y', // 不一致
    });
    mockPrisma.identityMatchCandidate.findUnique.mockResolvedValue({
      id: 'cand-1',
      companyId: 'co-1',
      sourceLeadId: 'lead-s',
      targetLeadId: 'lead-t',
      status: 'pending',
      sourceLead: source,
      targetLead: target,
    });
    mockPrisma.contact.count.mockImplementation((args: { where: { leadId?: string } }) =>
      Promise.resolve(args.where.leadId === 'lead-s' ? 1 : 2),
    );
    mockPrisma.contactPoint.count.mockImplementation((args: { where: { leadId?: string } }) =>
      Promise.resolve(args.where.leadId === 'lead-s' ? 1 : 1),
    );
    mockPrisma.conversation.count.mockImplementation((args: { where: { leadId?: string } }) =>
      Promise.resolve(args.where.leadId === 'lead-s' ? 0 : 3),
    );

    const preview = await service.previewMerge({
      companyId: 'co-1',
      candidateId: 'cand-1',
    });

    const diffFields = preview.fieldDiffs.map((d) => d.field).sort();
    expect(diffFields).toEqual(['country', 'industry']);
    // companyName / website 一致, 不应出现
    expect(diffFields).not.toContain('companyName');
    expect(diffFields).not.toContain('website');
    expect(preview.contactCount).toEqual({ source: 1, target: 2 });
    expect(preview.contactPointCount).toEqual({ source: 1, target: 1 });
    expect(preview.conversationCount).toEqual({ source: 0, target: 3 });
  });

  // ---- 2. 人工字段优先 ----
  it('2. trusted_defaults: manual_confirmed 胜过 inferred, 保留 target', async () => {
    const targetUpdatedAt = new Date('2026-06-10T00:00:00.000Z');
    const source = makeLead({
      id: 'lead-s',
      companyName: 'Acme Inferred',
      companyNameSource: 'inferred', // 优先级 2
      country: 'CN',
    });
    const target = makeLead({
      id: 'lead-t',
      companyName: 'Acme Corp',
      companyNameSource: 'manual_confirmed', // 优先级 5
      country: 'US',
      updatedAt: targetUpdatedAt,
    });
    mockPrisma.identityMatchCandidate.findUnique.mockResolvedValue({
      id: 'cand-2',
      companyId: 'co-1',
      sourceLeadId: 'lead-s',
      targetLeadId: 'lead-t',
      status: 'pending',
      sourceLead: source,
      targetLead: target,
    });
    mockPrisma.lead.update.mockImplementation((args: { data: Record<string, unknown> }) =>
      // 返回合并后的 target (updatedAt 推进)
      Promise.resolve({
        ...target,
        ...args.data,
        updatedAt: new Date('2026-06-10T00:00:01.000Z'),
      }),
    );
    mockPrisma.customerMergeAudit.create.mockResolvedValue({ id: 'audit-2' });

    const command: MergeCustomerCommand = {
      companyId: 'co-1',
      actorId: 'user-1',
      candidateId: 'cand-2',
      targetUpdatedAt: targetUpdatedAt.toISOString(),
      mode: 'trusted_defaults',
      fieldChoices: [],
    };

    const result = await service.merge(command);

    expect(result.auditId).toBe('audit-2');
    expect(result.targetLeadId).toBe('lead-t');

    // 找到对 target 的 lead.update 调用
    const targetUpdateCall = mockPrisma.lead.update.mock.calls.find(
      (c: [{ where: { id: string }; data: Record<string, unknown> }]) =>
        c[0].where.id === 'lead-t',
    );
    expect(targetUpdateCall).toBeDefined();
    const targetData = targetUpdateCall![0].data;
    // manual_confirmed (5) > inferred (2) -> 保留 target 的 'Acme Corp', 不被推断值覆盖
    expect(targetData.companyName).toBe('Acme Corp');
    expect(targetData.companyName).not.toBe('Acme Inferred');
    // target 胜出时不改写 companyNameSource
    expect(targetData).not.toHaveProperty('companyNameSource');

    // 审计 afterState 应记录 target.companyName = 'Acme Corp'
    const auditCreateArgs = mockPrisma.customerMergeAudit.create.mock.calls[0][0] as {
      data: { afterState: { targetLead: { companyName: string } }; fieldChoices: unknown };
    };
    expect(auditCreateArgs.data.afterState.targetLead.companyName).toBe('Acme Corp');
  });

  // ---- 3. 渠道保留 ----
  it('3. 合并后不同号码/邮箱的 ContactPoint 都保留 (仅迁移 leadId, 不删除)', async () => {
    const targetUpdatedAt = new Date('2026-06-10T00:00:00.000Z');
    const source = makeLead({ id: 'lead-s', companyName: 'S' });
    const target = makeLead({ id: 'lead-t', companyName: 'T', updatedAt: targetUpdatedAt });
    mockPrisma.identityMatchCandidate.findUnique.mockResolvedValue({
      id: 'cand-3',
      companyId: 'co-1',
      sourceLeadId: 'lead-s',
      targetLeadId: 'lead-t',
      status: 'pending',
      sourceLead: source,
      targetLead: target,
    });
    mockPrisma.lead.update.mockResolvedValue({
      ...target,
      updatedAt: new Date('2026-06-10T00:00:01.000Z'),
    });
    mockPrisma.customerMergeAudit.create.mockResolvedValue({ id: 'audit-3' });

    await service.merge({
      companyId: 'co-1',
      actorId: 'user-1',
      candidateId: 'cand-3',
      targetUpdatedAt: targetUpdatedAt.toISOString(),
      mode: 'trusted_defaults',
      fieldChoices: [],
    });

    // ContactPoint 仅 updateMany 迁移 leadId, 不应出现 delete / deleteMany
    const cpCalls = mockPrisma.contactPoint.updateMany.mock.calls;
    expect(cpCalls.length).toBeGreaterThanOrEqual(1);
    const migrationCall = cpCalls.find(
      (c: [{ where: { leadId: string }; data: { leadId: string } }]) =>
        c[0].where.leadId === 'lead-s' && c[0].data.leadId === 'lead-t',
    );
    expect(migrationCall).toBeDefined();
    // 没有 delete 接口被调用 (mock 上不存在 delete, 此处验证迁移语义即可)
    expect((mockPrisma.contactPoint as unknown as Record<string, unknown>).delete).toBeUndefined();
    expect(
      (mockPrisma.contactPoint as unknown as Record<string, unknown>).deleteMany,
    ).toBeUndefined();
  });

  // ---- 4. 主联系人 ----
  it('4. 合并后每公司最多一个 isPrimary=true 的 Contact (多余降级)', async () => {
    const targetUpdatedAt = new Date('2026-06-10T00:00:00.000Z');
    const source = makeLead({ id: 'lead-s', companyName: 'S' });
    const target = makeLead({ id: 'lead-t', companyName: 'T', updatedAt: targetUpdatedAt });

    const sourceContact: ContactFixture = {
      id: 'c-source-p',
      companyId: 'co-1',
      leadId: 'lead-s',
      isPrimary: true,
      createdAt: new Date('2026-06-05T00:00:00.000Z'),
    };
    const targetContact: ContactFixture = {
      id: 'c-target-p',
      companyId: 'co-1',
      leadId: 'lead-t',
      isPrimary: true,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    };
    mockPrisma.identityMatchCandidate.findUnique.mockResolvedValue({
      id: 'cand-4',
      companyId: 'co-1',
      sourceLeadId: 'lead-s',
      targetLeadId: 'lead-t',
      status: 'pending',
      sourceLead: source,
      targetLead: target,
    });
    // contact.findMany 按 leadId 返回对应联系人
    mockPrisma.contact.findMany.mockImplementation((args: { where: { leadId?: string } }) => {
      if (args.where.leadId === 'lead-s') return Promise.resolve([sourceContact]);
      if (args.where.leadId === 'lead-t') return Promise.resolve([targetContact]);
      return Promise.resolve([]);
    });
    mockPrisma.lead.update.mockResolvedValue({
      ...target,
      updatedAt: new Date('2026-06-10T00:00:01.000Z'),
    });
    mockPrisma.customerMergeAudit.create.mockResolvedValue({ id: 'audit-4' });

    await service.merge({
      companyId: 'co-1',
      actorId: 'user-1',
      candidateId: 'cand-4',
      targetUpdatedAt: targetUpdatedAt.toISOString(),
      mode: 'trusted_defaults',
      fieldChoices: [],
    });

    // 应有一次 contact.updateMany 将多余的 source 主联系人降级为 isPrimary=false
    const demoteCall = mockPrisma.contact.updateMany.mock.calls.find(
      (c: [{ where: { id?: { in?: string[] } }; data: { isPrimary: boolean } }]) =>
        c[0].data.isPrimary === false && c[0].where.id?.in?.includes('c-source-p'),
    );
    expect(demoteCall).toBeDefined();
    // 保留的 target 主联系人不应被降级
    const demoteTarget = mockPrisma.contact.updateMany.mock.calls.find(
      (c: [{ where: { id?: { in?: string[] } }; data: { isPrimary: boolean } }]) =>
        c[0].data.isPrimary === false && c[0].where.id?.in?.includes('c-target-p'),
    );
    expect(demoteTarget).toBeUndefined();
  });

  // ---- 5. 排除对称 ----
  it('5. rejectCandidate 保存双向 IdentityExclusion 并标记候选 rejected', async () => {
    mockPrisma.identityMatchCandidate.findUnique.mockResolvedValue({
      id: 'cand-5',
      companyId: 'co-1',
      sourceLeadId: 'lead-s',
      targetLeadId: 'lead-t',
      status: 'pending',
    });
    mockPrisma.identityExclusion.findFirst.mockResolvedValue(null);

    const command: RejectCandidateCommand = {
      companyId: 'co-1',
      actorId: 'user-1',
      candidateId: 'cand-5',
      reason: 'different companies',
    };

    await service.rejectCandidate(command);

    // 应保存两个方向 (leftLeadId/rightLeadId 互换)
    const exclusionCreates = mockPrisma.identityExclusion.create.mock.calls.map(
      (c: [{ data: { leftLeadId: string; rightLeadId: string; reason?: string } }]) => ({
        left: c[0].data.leftLeadId,
        right: c[0].data.rightLeadId,
      }),
    );
    expect(exclusionCreates).toContainEqual({ left: 'lead-s', right: 'lead-t' });
    expect(exclusionCreates).toContainEqual({ left: 'lead-t', right: 'lead-s' });
    expect(exclusionCreates.length).toBe(2);

    // 候选标记为 rejected
    expect(mockPrisma.identityMatchCandidate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cand-5' },
        data: expect.objectContaining({ status: 'rejected' }),
      }),
    );
  });

  // ---- 6. 事务回滚 ----
  it('6. 合并失败 -> 整体回滚, 无半合并状态 (候选未被标记 merged)', async () => {
    const targetUpdatedAt = new Date('2026-06-10T00:00:00.000Z');
    const source = makeLead({ id: 'lead-s', companyName: 'S' });
    const target = makeLead({ id: 'lead-t', companyName: 'T', updatedAt: targetUpdatedAt });
    mockPrisma.identityMatchCandidate.findUnique.mockResolvedValue({
      id: 'cand-6',
      companyId: 'co-1',
      sourceLeadId: 'lead-s',
      targetLeadId: 'lead-t',
      status: 'pending',
      sourceLead: source,
      targetLead: target,
    });
    // 审计写入失败, 模拟事务内异常
    mockPrisma.lead.update.mockResolvedValue({
      ...target,
      updatedAt: new Date('2026-06-10T00:00:01.000Z'),
    });
    mockPrisma.customerMergeAudit.create.mockRejectedValue(new Error('audit write failed'));

    await expect(
      service.merge({
        companyId: 'co-1',
        actorId: 'user-1',
        candidateId: 'cand-6',
        targetUpdatedAt: targetUpdatedAt.toISOString(),
        mode: 'trusted_defaults',
        fieldChoices: [],
      }),
    ).rejects.toThrow('audit write failed');

    // 事务未完成: 候选未被标记为 merged (最后一步未执行)
    const mergedUpdate = mockPrisma.identityMatchCandidate.update.mock.calls.find(
      (c: [{ data: { status: string } }]) => c[0].data.status === 'merged',
    );
    expect(mergedUpdate).toBeUndefined();
  });

  // ---- 7. 乐观锁冲突 ----
  it('7. targetUpdatedAt 不匹配 -> 拒绝合并, 不进入事务', async () => {
    const targetUpdatedAt = new Date('2026-06-10T00:00:00.000Z');
    const source = makeLead({ id: 'lead-s', companyName: 'S' });
    const target = makeLead({ id: 'lead-t', companyName: 'T', updatedAt: targetUpdatedAt });
    mockPrisma.identityMatchCandidate.findUnique.mockResolvedValue({
      id: 'cand-7',
      companyId: 'co-1',
      sourceLeadId: 'lead-s',
      targetLeadId: 'lead-t',
      status: 'pending',
      sourceLead: source,
      targetLead: target,
    });

    // 调用方传入的版本与目标当前版本不一致
    await expect(
      service.merge({
        companyId: 'co-1',
        actorId: 'user-1',
        candidateId: 'cand-7',
        targetUpdatedAt: new Date('2026-06-09T00:00:00.000Z').toISOString(),
        mode: 'trusted_defaults',
        fieldChoices: [],
      }),
    ).rejects.toThrow(/optimistic|conflict|version/i);

    // 乐观锁检查在事务之前, 事务不应被调用
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    // 不应有任何写操作
    expect(mockPrisma.lead.update).not.toHaveBeenCalled();
    expect(mockPrisma.customerMergeAudit.create).not.toHaveBeenCalled();
  });

  // ---- 8. 撤销 ----
  it('8a. undoMerge 成功恢复 (标记 undoneAt, 还原 target 字段与 source 联系人)', async () => {
    const mergeTime = new Date('2026-06-10T00:00:01.000Z');
    const audit = {
      id: 'audit-8',
      companyId: 'co-1',
      sourceLeadId: 'lead-s',
      targetLeadId: 'lead-t',
      actorId: 'user-1',
      status: 'completed',
      targetVersion: mergeTime,
      undoneAt: null,
      undoneById: null,
      beforeState: {
        sourceLead: {
          id: 'lead-s',
          companyName: 'S Original',
          country: 'CN',
          website: 's.com',
          industry: 'X',
          companyNameSource: 'inferred',
          companyNameConfidence: 'low',
          status: 'new',
          isMerged: false,
          mergedToId: null,
          deletedAt: null,
        },
        targetLead: {
          id: 'lead-t',
          companyName: 'T Original',
          country: 'US',
          website: 't.com',
          industry: 'Y',
          companyNameSource: 'manual_confirmed',
          companyNameConfidence: 'high',
        },
        sourceContactIds: ['c-source-p'],
        targetContactIds: ['c-target-p'],
        sourceContactPointIds: ['cp-s'],
        sourceConversationIds: ['conv-s'],
        contactPrimaryMap: { 'c-source-p': true, 'c-target-p': true },
      },
      afterState: {},
      fieldChoices: [],
    };
    mockPrisma.customerMergeAudit.findUnique.mockResolvedValue(audit);
    // 目标未变化: updatedAt === targetVersion
    mockPrisma.lead.findUnique.mockResolvedValue(makeLead({ id: 'lead-t', updatedAt: mergeTime }));

    await service.undoMerge({
      companyId: 'co-1',
      auditId: 'audit-8',
      actorId: 'user-2',
    });

    // target 字段从 beforeState 还原
    const targetRestore = mockPrisma.lead.update.mock.calls.find(
      (c: [{ where: { id: string }; data: Record<string, unknown> }]) =>
        c[0].where.id === 'lead-t',
    );
    expect(targetRestore).toBeDefined();
    expect(targetRestore![0].data.companyName).toBe('T Original');
    expect(targetRestore![0].data.country).toBe('US');

    // source 联系人迁回 source
    const contactBack = mockPrisma.contact.updateMany.mock.calls.find(
      (c: [{ where: { id?: { in?: string[] } }; data: { leadId: string } }]) =>
        c[0].data.leadId === 'lead-s',
    );
    expect(contactBack).toBeDefined();
    expect(contactBack![0].where.id?.in).toContain('c-source-p');

    // source Lead 恢复为 active
    const sourceRestore = mockPrisma.lead.update.mock.calls.find(
      (c: [{ where: { id: string }; data: Record<string, unknown> }]) =>
        c[0].where.id === 'lead-s',
    );
    expect(sourceRestore).toBeDefined();
    expect(sourceRestore![0].data.status).toBe('new');
    expect(sourceRestore![0].data.isMerged).toBe(false);
    expect(sourceRestore![0].data.mergedToId).toBeNull();
    expect(sourceRestore![0].data.deletedAt).toBeNull();

    // 审计标记 undone
    expect(mockPrisma.customerMergeAudit.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'audit-8' },
        data: expect.objectContaining({
          status: 'undone',
          undoneById: 'user-2',
        }),
      }),
    );
    expect(
      (mockPrisma.customerMergeAudit.update.mock.calls[0][0] as { data: { undoneAt: Date } }).data
        .undoneAt,
    ).toBeInstanceOf(Date);
  });

  it('8b. undoMerge: 目标已变化 -> 拒绝撤销 (不安全)', async () => {
    const mergeTime = new Date('2026-06-10T00:00:01.000Z');
    const laterTime = new Date('2026-06-20T00:00:00.000Z'); // 目标在合并后被修改
    mockPrisma.customerMergeAudit.findUnique.mockResolvedValue({
      id: 'audit-8b',
      companyId: 'co-1',
      sourceLeadId: 'lead-s',
      targetLeadId: 'lead-t',
      actorId: 'user-1',
      status: 'completed',
      targetVersion: mergeTime,
      undoneAt: null,
      undoneById: null,
      beforeState: {},
      afterState: {},
      fieldChoices: [],
    });
    mockPrisma.lead.findUnique.mockResolvedValue(makeLead({ id: 'lead-t', updatedAt: laterTime }));

    await expect(
      service.undoMerge({
        companyId: 'co-1',
        auditId: 'audit-8b',
        actorId: 'user-2',
      }),
    ).rejects.toThrow(/changed|unsafe|undo/i);

    // 不应进入事务 / 不应修改任何数据
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.lead.update).not.toHaveBeenCalled();
    expect(mockPrisma.customerMergeAudit.update).not.toHaveBeenCalled();
  });

  // ---- 9. 软删除 ----
  it('9. 合并后 source Lead 软删除 (merged/soft-deleted), 旧 ID 经 mergedToId 解析到 target', async () => {
    const targetUpdatedAt = new Date('2026-06-10T00:00:00.000Z');
    const source = makeLead({ id: 'lead-s', companyName: 'S' });
    const target = makeLead({ id: 'lead-t', companyName: 'T', updatedAt: targetUpdatedAt });
    mockPrisma.identityMatchCandidate.findUnique.mockResolvedValue({
      id: 'cand-9',
      companyId: 'co-1',
      sourceLeadId: 'lead-s',
      targetLeadId: 'lead-t',
      status: 'pending',
      sourceLead: source,
      targetLead: target,
    });
    mockPrisma.lead.update.mockResolvedValue({
      ...target,
      updatedAt: new Date('2026-06-10T00:00:01.000Z'),
    });
    mockPrisma.customerMergeAudit.create.mockResolvedValue({ id: 'audit-9' });

    await service.merge({
      companyId: 'co-1',
      actorId: 'user-1',
      candidateId: 'cand-9',
      targetUpdatedAt: targetUpdatedAt.toISOString(),
      mode: 'trusted_defaults',
      fieldChoices: [],
    });

    // source Lead: status=merged, isMerged=true, mergedToId=target, deletedAt 设置
    const sourceSoftDelete = mockPrisma.lead.update.mock.calls.find(
      (c: [{ where: { id: string }; data: Record<string, unknown> }]) =>
        c[0].where.id === 'lead-s',
    );
    expect(sourceSoftDelete).toBeDefined();
    const sd = sourceSoftDelete![0].data;
    expect(sd.status).toBe('merged');
    expect(sd.isMerged).toBe(true);
    expect(sd.mergedToId).toBe('lead-t');
    expect(sd.deletedAt).toBeInstanceOf(Date);
    // 禁止硬删除: 没有 delete 调用
    expect((mockPrisma.lead as unknown as Record<string, unknown>).delete).toBeUndefined();
    expect((mockPrisma.lead as unknown as Record<string, unknown>).deleteMany).toBeUndefined();
  });

  // ---- 10. 外部合并入口授权 ----
  it('10a. mergeAuthorized 拒绝候选或 Lead 跨公司穿透', async () => {
    mockPrisma.identityMatchCandidate.findUnique.mockResolvedValue({
      id: 'cand-cross-company',
      companyId: 'co-1',
      sourceLead: { companyId: 'co-1', ownerUserId: 'user-1' },
      targetLead: { companyId: 'co-2', ownerUserId: 'user-1' },
    });
    const mergeSpy = jest.spyOn(service, 'merge');

    await expect(service.mergeAuthorized({
      companyId: 'co-1',
      candidateId: 'cand-cross-company',
      targetUpdatedAt: new Date().toISOString(),
      mode: 'trusted_defaults',
      fieldChoices: [],
    }, {
      id: 'user-1',
      companies: [{ id: 'co-1', role: 'company_admin' }],
    })).rejects.toThrow(/not found/i);

    expect(mergeSpy).not.toHaveBeenCalled();
  });

  it('10b. mergeAuthorized 要求普通业务员同时拥有源客户和目标客户', async () => {
    mockPrisma.identityMatchCandidate.findUnique.mockResolvedValue({
      id: 'cand-owner-check',
      companyId: 'co-1',
      sourceLead: { companyId: 'co-1', ownerUserId: 'user-1' },
      targetLead: { companyId: 'co-1', ownerUserId: 'other-user' },
    });
    const mergeSpy = jest.spyOn(service, 'merge');

    await expect(service.mergeAuthorized({
      companyId: 'co-1',
      candidateId: 'cand-owner-check',
      targetUpdatedAt: new Date().toISOString(),
      mode: 'trusted_defaults',
      fieldChoices: [],
    }, {
      id: 'user-1',
      companies: [{ id: 'co-1', role: 'sales_user' }],
    })).rejects.toThrow(/both customers/i);

    expect(mergeSpy).not.toHaveBeenCalled();
  });

  it('10c. mergeAuthorized 使用当前登录用户作为审计 actor', async () => {
    mockPrisma.identityMatchCandidate.findUnique.mockResolvedValue({
      id: 'cand-admin',
      companyId: 'co-1',
      sourceLead: { companyId: 'co-1', ownerUserId: 'other-user' },
      targetLead: { companyId: 'co-1', ownerUserId: 'another-user' },
    });
    const mergeSpy = jest.spyOn(service, 'merge').mockResolvedValue({
      auditId: 'audit-authorized',
      targetLeadId: 'lead-target',
    });

    await expect(service.mergeAuthorized({
      companyId: 'co-1',
      candidateId: 'cand-admin',
      targetUpdatedAt: new Date().toISOString(),
      mode: 'trusted_defaults',
      fieldChoices: [],
    }, {
      id: 'admin-1',
      companies: [{ id: 'co-1', role: 'company_admin' }],
    })).resolves.toEqual({ auditId: 'audit-authorized', targetLeadId: 'lead-target' });

    expect(mergeSpy).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'admin-1' }));
  });
});
