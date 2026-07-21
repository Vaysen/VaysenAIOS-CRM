/**
 * TASK-102E: EmailIdentityAdapter 单元测试 (RED)
 *
 * 接入点: 所有入站邮件身份通过 EmailIdentityAdapter.ingest()
 *   normalizeEmailIdentity -> IdentityResolutionService.resolve -> 持久化会话/消息
 *
 * 覆盖场景:
 * 1. 大小写邮箱归一: Sales@Example.COM -> resolve 调用时 normalizedValue='sales@example.com'
 * 2. 已有联系人邮箱匹配: resolve 返回 linked -> 消息 leadId 设为已有 leadId
 * 3. 手工姓名保护: displayNameCandidate 不覆盖 manual_confirmed (adapter 不直接写 Contact)
 * 4. review_required: resolve 返回 review_required -> 消息仍创建, leadId 为新建的 leadId
 * 5. 无效邮箱: normalizeEmailIdentity 返回 null -> 不调用 resolve, 邮件仍入库但 leadId=null
 * 6. 重复邮件幂等: 同一 messageId 重复调用 -> 不创建重复消息
 *
 * 说明: 入站邮件记录持久化为 Conversation + CommunicationMessage
 *   (EmailMessage.leadId 在 schema 中非空且绑定出站邮件账号, 无法表达 leadId=null,
 *    故入站消息走 CommunicationMessage; Conversation.leadId 可空, 满足"挂待关联状态")
 */
import { EmailIdentityAdapter } from './email-identity.adapter';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { ResolveIdentityResult } from './customer-identity.types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

interface MockPrismaService {
  communicationMessage: {
    findFirst: jest.Mock;
    create: jest.Mock;
  };
  conversation: {
    create: jest.Mock;
  };
  contact: {
    update: jest.Mock;
  };
}

function createMockPrisma(): MockPrismaService {
  const mock: MockPrismaService = {
    communicationMessage: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    conversation: { create: jest.fn() },
    contact: { update: jest.fn() },
  };
  // 默认: 无重复消息
  mock.communicationMessage.findFirst.mockResolvedValue(null);
  // conversation.create 回显传入的 leadId/contactPointId, 便于断言
  mock.conversation.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: 'conv-1',
    companyId: args.data.companyId,
    leadId: args.data.leadId ?? null,
    contactPointId: args.data.contactPointId ?? null,
  }));
  mock.communicationMessage.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: 'msg-1',
    conversationId: args.data.conversationId,
    externalMessageId: args.data.externalMessageId ?? null,
  }));
  return mock;
}

function createAdapter(
  overrides: { prisma?: MockPrismaService; resolver?: { resolve: jest.Mock } } = {},
) {
  const prisma = overrides.prisma ?? createMockPrisma();
  const resolver =
    overrides.resolver ??
    ({ resolve: jest.fn() } as unknown as {
      resolve: jest.Mock;
    });
  const adapter = new EmailIdentityAdapter(
    prisma as unknown as PrismaService,
    resolver as unknown as ConstructorParameters<typeof EmailIdentityAdapter>[1],
  );
  return { adapter, prisma, resolver };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TASK-102E EmailIdentityAdapter', () => {
  // ---- 1. 大小写邮箱归一 ----
  it('1. Sales@Example.COM -> resolve 调用时 normalizedValue=sales@example.com', async () => {
    const { adapter, resolver } = createAdapter({
      resolver: {
        resolve: jest.fn().mockResolvedValue({
          action: 'created',
          leadId: 'lead-1',
          contactId: 'c-1',
          contactPointId: 'cp-1',
        } as ResolveIdentityResult),
      },
    });

    await adapter.ingest({
      companyId: 'co-1',
      email: 'Sales@Example.COM',
      messageId: 'm1',
    });

    expect(resolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'co-1',
        channel: 'email',
        normalizedValue: 'sales@example.com',
        source: 'email_message',
      }),
    );
  });

  // ---- 2. 已有联系人邮箱匹配 -> linked ----
  it('2. resolve linked -> 消息 leadId 设为已有 leadId', async () => {
    const { adapter, prisma } = createAdapter({
      resolver: {
        resolve: jest.fn().mockResolvedValue({
          action: 'linked',
          leadId: 'lead-existing',
          contactId: 'contact-existing',
          contactPointId: 'cp-existing',
        } as ResolveIdentityResult),
      },
    });

    const result = await adapter.ingest({
      companyId: 'co-1',
      email: 'sales@example.com',
      messageId: 'm2',
    });

    expect(result.leadId).toBe('lead-existing');
    expect(result.contactPointId).toBe('cp-existing');
    expect(result.action).toBe('linked');
    // 会话关联到已有 lead + contactPoint
    expect(prisma.conversation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          leadId: 'lead-existing',
          contactPointId: 'cp-existing',
        }),
      }),
    );
  });

  // ---- 3. 手工姓名保护 ----
  it('3. displayNameCandidate 不覆盖 manual_confirmed (adapter 委托 resolver, 不直接写 Contact)', async () => {
    const { adapter, prisma, resolver } = createAdapter({
      resolver: {
        resolve: jest.fn().mockResolvedValue({
          action: 'linked',
          leadId: 'lead-8',
          contactId: 'contact-8',
          contactPointId: 'cp-8',
        } as ResolveIdentityResult),
      },
    });

    await adapter.ingest({
      companyId: 'co-1',
      email: 'john@example.com',
      messageId: 'm3',
      displayNameCandidate: 'John',
    });

    // adapter 将净化后的姓名作为 candidate 传递, 由 resolver 决定是否写入
    // (resolver 的 linked 路径不修改 manual_confirmed 字段, 见 TASK-102C #8)
    expect(resolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ contactNameCandidate: 'John' }),
    );
    // adapter 自身绝不直接更新 Contact (不绕过 resolver 的手工保护)
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  // ---- 4. review_required -> 消息仍创建, leadId 为新建 ----
  it('4. resolve review_required -> 消息仍入库, leadId 为新建 leadId', async () => {
    const { adapter, prisma } = createAdapter({
      resolver: {
        resolve: jest.fn().mockResolvedValue({
          action: 'review_required',
          candidateId: 'cand-1',
          leadId: 'lead-new',
        } as ResolveIdentityResult),
      },
    });

    const result = await adapter.ingest({
      companyId: 'co-1',
      email: 'review@example.com',
      messageId: 'm4',
    });

    expect(result.action).toBe('review_required');
    expect(result.leadId).toBe('lead-new');
    // 邮件照常入库 (挂待关联状态)
    expect(prisma.communicationMessage.create).toHaveBeenCalledTimes(1);
    expect(prisma.conversation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ leadId: 'lead-new' }),
      }),
    );
  });

  // ---- 5. 无效邮箱 -> 不调用 resolve, 邮件仍入库但 leadId=null ----
  it('5. 无效邮箱 -> 不调用 resolve, 邮件仍入库 leadId=null', async () => {
    const { adapter, prisma, resolver } = createAdapter();

    const result = await adapter.ingest({
      companyId: 'co-1',
      email: 'not-an-email',
      messageId: 'm5',
    });

    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(result.action).toBe('unresolved');
    expect(result.leadId).toBeNull();
    // 邮件仍入库 (leadId=null 挂待关联)
    expect(prisma.communicationMessage.create).toHaveBeenCalledTimes(1);
    expect(prisma.conversation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ leadId: null }),
      }),
    );
  });

  // ---- 6. 重复邮件幂等 ----
  it('6. 同一 messageId 重复调用 -> 不创建重复 EmailMessage', async () => {
    const { adapter, prisma, resolver } = createAdapter({
      resolver: {
        resolve: jest.fn().mockResolvedValue({
          action: 'created',
          leadId: 'lead-1',
          contactId: 'c-1',
          contactPointId: 'cp-1',
        } as ResolveIdentityResult),
      },
    });

    // 第一次调用: 入库
    const first = await adapter.ingest({
      companyId: 'co-1',
      email: 'dup@example.com',
      messageId: 'm6',
    });
    expect(prisma.communicationMessage.create).toHaveBeenCalledTimes(1);
    expect(first.leadId).toBe('lead-1');
    expect(prisma.communicationMessage.findFirst).toHaveBeenCalledWith({
      where: {
        externalMessageId: 'm6',
        conversation: { companyId: 'co-1' },
      },
      include: { conversation: true },
    });

    // 第二次调用: 命中已有消息 (按 externalMessageId 幂等)
    prisma.communicationMessage.findFirst.mockResolvedValue({
      id: 'msg-1',
      conversationId: 'conv-1',
      externalMessageId: 'm6',
      conversation: { id: 'conv-1', leadId: 'lead-1', contactPointId: 'cp-1' },
    });
    const second = await adapter.ingest({
      companyId: 'co-1',
      email: 'dup@example.com',
      messageId: 'm6',
    });

    // 不再调用 resolve, 不再创建重复消息
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(prisma.communicationMessage.create).toHaveBeenCalledTimes(1);
    expect(prisma.conversation.create).toHaveBeenCalledTimes(1);
    expect(second.leadId).toBe('lead-1');
    expect(second.emailMessageId).toBe('msg-1');
  });
});
