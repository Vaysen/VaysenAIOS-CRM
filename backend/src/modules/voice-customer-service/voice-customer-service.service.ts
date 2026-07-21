import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { CreateVoiceTestSessionDto, EndVoiceCallDto, RequestVoiceHandoffDto } from './dto/voice-call.dto';

@Injectable()
export class VoiceCustomerServiceService {
  constructor(private readonly prisma: PrismaService) {}

  private companyIds(user: any): string[] {
    const ids = user?.companies?.map((company: any) => company.id).filter(Boolean) || [];
    if (ids.length === 0) throw new ForbiddenException('No company context');
    return ids;
  }

  async list(user: any, status?: string) {
    const companyIds = this.companyIds(user);
    return this.prisma.voiceCall.findMany({
      where: { companyId: { in: companyIds }, ...(status ? { status } : {}) },
      include: {
        lead: { select: { id: true, companyName: true, contactName: true, country: true } },
        events: { orderBy: { occurredAt: 'desc' }, take: 5 },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async findOne(user: any, id: string) {
    const companyIds = this.companyIds(user);
    const call = await this.prisma.voiceCall.findFirst({
      where: { id, companyId: { in: companyIds } },
      include: {
        lead: true,
        conversation: { include: { messages: { orderBy: { createdAt: 'asc' } } } },
        events: { orderBy: { occurredAt: 'asc' } },
      },
    });
    if (!call) throw new NotFoundException('Voice call not found');
    return call;
  }

  async createTestSession(user: any, dto: CreateVoiceTestSessionDto) {
    const companyId = this.companyIds(user)[0];
    if (dto.channel && dto.channel !== 'web_test') {
      throw new BadRequestException('PSTN and WhatsApp calls require provider credentials; use web_test until provisioned');
    }
    if (dto.recordingEnabled) {
      throw new BadRequestException('Recording is disabled until explicit customer consent is captured');
    }

    let lead: { id: string } | null = null;
    if (dto.leadId) {
      lead = await this.prisma.lead.findFirst({ where: { id: dto.leadId, companyId }, select: { id: true } });
      if (!lead) throw new NotFoundException('Lead not found');
    }

    return this.prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.create({
        data: {
          companyId,
          leadId: lead?.id || null,
          channel: 'voice_call',
          subject: 'AI 语音客服测试会话',
          status: 'active',
          assignedUserId: user.id,
        },
      });
      const call = await tx.voiceCall.create({
        data: {
          companyId,
          leadId: lead?.id || null,
          conversationId: conversation.id,
          channel: 'web_test',
          locale: dto.locale || 'zh-CN',
          customerNumber: dto.customerNumber || null,
          assignedUserId: user.id,
          status: 'queued',
          recordingEnabled: false,
          events: { create: { eventType: 'call_created', role: 'system', metadata: { source: 'crm_test_session' } } },
        },
        include: { events: true, lead: true },
      });
      await tx.auditLog.create({
        data: { companyId, userId: user.id, action: 'voice.call.create_test', entityType: 'VoiceCall', entityId: call.id, newValue: { channel: call.channel, recordingEnabled: false } },
      });
      if (lead) {
        await tx.leadActivity.create({
          data: { companyId, leadId: lead.id, userId: user.id, activityType: 'voice_call_created', title: 'AI 语音客服测试会话已创建', referenceType: 'VoiceCall', referenceId: call.id },
        });
      }
      return call;
    });
  }

  async requestHandoff(user: any, id: string, dto: RequestVoiceHandoffDto) {
    const call = await this.findOne(user, id);
    if (call.status === 'completed' || call.status === 'failed' || call.status === 'cancelled') {
      throw new BadRequestException('Completed calls cannot be handed off');
    }
    if (call.status === 'handoff_requested') return call;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.voiceCall.update({
        where: { id: call.id },
        data: { status: 'handoff_requested', handoffReason: dto.reason, handoffContext: (dto.context || {}) as Prisma.InputJsonValue, assignedUserId: user.id },
      });
      await tx.voiceCallEvent.create({ data: { voiceCallId: call.id, eventType: 'handoff_requested', role: 'system', content: dto.reason, metadata: (dto.context || {}) as Prisma.InputJsonValue } });
      await tx.auditLog.create({ data: { companyId: call.companyId, userId: user.id, action: 'voice.handoff.request', entityType: 'VoiceCall', entityId: call.id, newValue: { reason: dto.reason } } });
      if (call.leadId) await tx.leadActivity.create({
        data: { companyId: call.companyId, leadId: call.leadId, userId: user.id, activityType: 'voice_handoff_requested', title: 'AI 语音通话请求转人工', description: dto.reason, referenceType: 'VoiceCall', referenceId: call.id },
      });
      return updated;
    });
  }

  async end(user: any, id: string, dto: EndVoiceCallDto) {
    const call = await this.findOne(user, id);
    if (call.status === 'completed') return call;
    return this.prisma.$transaction(async (tx) => {
      const endedAt = new Date();
      const updated = await tx.voiceCall.update({ where: { id: call.id }, data: { status: 'completed', summary: dto.summary || null, endedAt } });
      await tx.voiceCallEvent.create({ data: { voiceCallId: call.id, eventType: 'call_completed', role: 'system', content: dto.summary || null, occurredAt: endedAt } });
      if (call.conversationId) await tx.conversation.update({ where: { id: call.conversationId }, data: { status: 'closed', lastMessageAt: endedAt, lastMessagePreview: dto.summary || '语音通话已结束' } });
      await tx.auditLog.create({ data: { companyId: call.companyId, userId: user.id, action: 'voice.call.end', entityType: 'VoiceCall', entityId: call.id } });
      return updated;
    });
  }
}
