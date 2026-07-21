import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { OpenClawBindingStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OpenClawGatewayClient } from './openclaw-gateway.client';
import type { AuthenticatedOpenClawUser, OpenClawRuntimeStatus } from './openclaw.types';

type WechatPairingSession = {
  companyId: string;
  operatorUserId: string;
  gatewaySessionKey: string;
  expiresAt: number;
  state: 'WAITING_SCAN' | 'PERSISTING' | 'CONNECTED' | 'EXPIRED';
};

@Injectable()
export class OpenClawRuntimeService {
  private readonly logger = new Logger(OpenClawRuntimeService.name);
  private readonly pairingSessions = new Map<string, WechatPairingSession>();
  private readonly pairingStarts = new Set<string>();
  private readonly activePairingByOwner = new Map<string, string>();

  constructor(
    private readonly gateway: OpenClawGatewayClient,
    private readonly prisma: PrismaService,
  ) {}

  async startWechatPairing(companyId: string, user: AuthenticatedOpenClawUser) {
    const snapshot = await this.getSnapshot(companyId, user);
    if (!snapshot.permissions.canManageChannel) {
      throw new ForbiddenException('Only the configured company owner may bind WeChat');
    }
    if (!snapshot.runtime.gatewayReady || !snapshot.wechatOwnerChannel.pluginReady) {
      throw new ServiceUnavailableException('OpenClaw WeChat channel is not ready');
    }
    const ownerKey = this.pairingOwnerKey(companyId, user.id);
    if (this.pairingStarts.has(ownerKey)) {
      throw new ConflictException('A WeChat pairing is already starting for this owner');
    }
    const previousPairingId = this.activePairingByOwner.get(ownerKey);
    if (previousPairingId) {
      const previous = this.pairingSessions.get(previousPairingId);
      if (previous?.state === 'PERSISTING' || (previous && previous.expiresAt > Date.now())) {
        throw new ConflictException('A WeChat pairing is already active for this owner');
      }
      this.pairingSessions.delete(previousPairingId);
      this.activePairingByOwner.delete(ownerKey);
    }

    this.pairingStarts.add(ownerKey);
    try {
      const result = await this.gateway.startWechatPairing();
      if ((!result.qrDataUrl || !result.sessionKey) && !result.connected) {
        throw new ServiceUnavailableException('WeChat QR code was not returned');
      }
      const pairingId = randomUUID();
      const expiresAt = Date.now() + (result.connected ? 10 * 60_000 : 2 * 60_000);
      const pairing: WechatPairingSession = {
        companyId,
        operatorUserId: user.id,
        gatewaySessionKey: result.sessionKey || '',
        expiresAt,
        state: result.connected ? 'PERSISTING' : 'WAITING_SCAN',
      };
      if (result.connected) {
        await this.persistWechatOwnerBinding(pairing, result.ownerPeerDigest);
        pairing.state = 'CONNECTED';
        pairing.gatewaySessionKey = '';
      }
      this.pairingSessions.set(pairingId, pairing);
      this.activePairingByOwner.set(ownerKey, pairingId);
      if (!result.connected) void this.monitorWechatPairing(pairingId, pairing);
      return {
        pairingId,
        status: result.connected ? 'CONNECTED_PENDING_MESSAGE' as const : 'WAITING_SCAN' as const,
        qrDataUrl: result.qrDataUrl,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    } finally {
      this.pairingStarts.delete(ownerKey);
    }
  }

  async waitWechatPairing(
    companyId: string,
    pairingId: string,
    user: AuthenticatedOpenClawUser,
  ) {
    const pairing = this.pairingSessions.get(pairingId);
    if (
      !pairing
      || pairing.companyId !== companyId
      || pairing.operatorUserId !== user.id
    ) throw new NotFoundException('WeChat pairing session was not found');
    if (pairing.state !== 'PERSISTING' && pairing.expiresAt <= Date.now()) {
      pairing.state = 'EXPIRED';
      this.deletePairing(pairingId, pairing);
      return { pairingId, status: 'EXPIRED' as const, expiresAt: new Date(pairing.expiresAt).toISOString() };
    }
    return {
      pairingId,
      status: pairing.state === 'CONNECTED'
        ? 'CONNECTED_PENDING_MESSAGE' as const
        : pairing.state === 'PERSISTING'
          ? 'AUTHENTICATING' as const
          : pairing.state === 'EXPIRED'
          ? 'EXPIRED' as const
          : 'WAITING_SCAN' as const,
      expiresAt: new Date(pairing.expiresAt).toISOString(),
    };
  }

  private async monitorWechatPairing(pairingId: string, pairing: WechatPairingSession) {
    try {
      const result = await this.gateway.waitWechatPairing(pairing.gatewaySessionKey);
      if (!this.isCurrentPairing(pairingId, pairing)) return;
      if (result.connected) {
        if (pairing.expiresAt <= Date.now()) {
          pairing.state = 'EXPIRED';
          this.deletePairing(pairingId, pairing);
          return;
        }
        pairing.state = 'PERSISTING';
        await this.persistWechatOwnerBinding(pairing, result.ownerPeerDigest);
        if (!this.isCurrentPairing(pairingId, pairing)) return;
        pairing.state = 'CONNECTED';
        pairing.gatewaySessionKey = '';
        pairing.expiresAt = Date.now() + 10 * 60_000;
      } else {
        pairing.state = 'EXPIRED';
        pairing.expiresAt = Date.now();
      }
    } catch (error) {
      if (this.isCurrentPairing(pairingId, pairing)) {
        pairing.state = 'EXPIRED';
        pairing.gatewaySessionKey = '';
        pairing.expiresAt = Date.now();
      }
      const timeout = error instanceof Error && error.name === 'AbortError';
      this.logger.warn(`WeChat pairing wait failed: ${timeout ? 'GATEWAY_TIMEOUT' : 'GATEWAY_ERROR'}`);
    }
  }

  private async persistWechatOwnerBinding(
    pairing: WechatPairingSession,
    ownerPeerDigest: string | null,
  ): Promise<void> {
    if (!ownerPeerDigest || !/^[a-f0-9]{64}$/.test(ownerPeerDigest)) {
      throw new ServiceUnavailableException('WeChat pairing did not return a trusted owner digest');
    }
    await this.prisma.$transaction(async (tx) => {
      const lockKey = `openclaw-weixin-owner-binding:${pairing.companyId}:${pairing.operatorUserId}`;
      await tx.$queryRaw<Array<{ locked: string }>>`
        SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text AS locked
      `;
      const ownerEmail = (process.env.OPENCLAW_OWNER_EMAIL || '').trim().toLowerCase();
      const ownerCompanySlug = (process.env.OPENCLAW_OWNER_COMPANY_SLUG || '').trim();
      if (!ownerEmail || !ownerCompanySlug) {
        throw new ServiceUnavailableException('OpenClaw owner is not configured');
      }
      const activeRelation = await tx.userCompanyRelation.findFirst({
        where: {
          userId: pairing.operatorUserId,
          companyId: pairing.companyId,
          isActive: true,
          user: {
            isActive: true,
            deletedAt: null,
            email: { equals: ownerEmail, mode: 'insensitive' },
          },
          company: { isActive: true, slug: ownerCompanySlug },
        },
        include: { role: { select: { name: true } } },
      });
      if (!activeRelation || !['company_admin', 'super_admin'].includes(activeRelation.role.name)) {
        throw new ForbiddenException('The configured owner lost permission during WeChat pairing');
      }
      const existing = await tx.openClawOperatorBinding.findUnique({
        where: {
          channel_senderDigest: {
            channel: 'openclaw-weixin',
            senderDigest: ownerPeerDigest,
          },
        },
        select: { companyId: true, operatorUserId: true },
      });
      if (
        existing
        && (existing.companyId !== pairing.companyId || existing.operatorUserId !== pairing.operatorUserId)
      ) {
        throw new ForbiddenException('The paired WeChat identity belongs to another CRM operator');
      }
      const now = new Date();
      await tx.openClawOperatorBinding.updateMany({
        where: {
          companyId: pairing.companyId,
          operatorUserId: pairing.operatorUserId,
          channel: 'openclaw-weixin',
          status: OpenClawBindingStatus.ACTIVE,
          senderDigest: { not: ownerPeerDigest },
        },
        data: {
          status: OpenClawBindingStatus.REVOKED,
          revokedAt: now,
        },
      });
      await tx.openClawOperatorBinding.upsert({
        where: {
          channel_senderDigest: {
            channel: 'openclaw-weixin',
            senderDigest: ownerPeerDigest,
          },
        },
        create: {
          companyId: pairing.companyId,
          operatorUserId: pairing.operatorUserId,
          channel: 'openclaw-weixin',
          senderDigest: ownerPeerDigest,
          displayName: '负责人微信',
          status: OpenClawBindingStatus.ACTIVE,
          boundAt: now,
        },
        update: {
          displayName: '负责人微信',
          status: OpenClawBindingStatus.ACTIVE,
          boundAt: now,
          lastSeenAt: null,
          revokedAt: null,
        },
      });
    });
  }

  private pairingOwnerKey(companyId: string, operatorUserId: string): string {
    return `${companyId}:${operatorUserId}`;
  }

  private isCurrentPairing(pairingId: string, pairing: WechatPairingSession): boolean {
    return this.pairingSessions.get(pairingId) === pairing
      && this.activePairingByOwner.get(this.pairingOwnerKey(pairing.companyId, pairing.operatorUserId)) === pairingId;
  }

  private deletePairing(pairingId: string, pairing: WechatPairingSession): void {
    this.pairingSessions.delete(pairingId);
    const ownerKey = this.pairingOwnerKey(pairing.companyId, pairing.operatorUserId);
    if (this.activePairingByOwner.get(ownerKey) === pairingId) this.activePairingByOwner.delete(ownerKey);
  }

  async getSnapshot(companyId: string, user: AuthenticatedOpenClawUser) {
    const membership = user?.companies?.find((company) => company.id === companyId);
    if (!user?.id || !membership) throw new ForbiddenException('No access to this company');
    const ownerEmail = (process.env.OPENCLAW_OWNER_EMAIL || '').trim().toLowerCase();
    const ownerCompanySlug = (process.env.OPENCLAW_OWNER_COMPANY_SLUG || '').trim();
    const ownerPeerDigest = (process.env.OPENCLAW_WECHAT_OWNER_PEER_SHA256 || '').trim().toLowerCase();
    const ownerPeerConfigured = /^[a-f0-9]{64}$/.test(ownerPeerDigest);

    const [probe, ownerBinding, latestOwnerBinding, activeRelation] = await Promise.all([
      this.gateway.probe(),
      ownerPeerConfigured
        ? this.prisma.openClawOperatorBinding.findFirst({
            where: {
              companyId,
              operatorUserId: user.id,
              channel: 'openclaw-weixin',
              status: OpenClawBindingStatus.ACTIVE,
              senderDigest: ownerPeerDigest,
            },
            select: {
              id: true,
              senderDigest: true,
              displayName: true,
              boundAt: true,
              lastSeenAt: true,
            },
          })
        : Promise.resolve(null),
      this.prisma.openClawOperatorBinding.findFirst({
        where: {
          companyId,
          operatorUserId: user.id,
          channel: 'openclaw-weixin',
          status: OpenClawBindingStatus.ACTIVE,
        },
        orderBy: [{ lastSeenAt: 'desc' }, { boundAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          senderDigest: true,
          displayName: true,
          boundAt: true,
          lastSeenAt: true,
        },
      }),
      this.prisma.userCompanyRelation.findFirst({
        where: {
          userId: user.id,
          companyId,
          isActive: true,
          user: { isActive: true, deletedAt: null },
          company: { isActive: true },
        },
        include: {
          role: { select: { name: true } },
          company: { select: { slug: true } },
        },
      }),
    ]);
    if (!activeRelation) throw new ForbiddenException('No active access to this company');
    const isAdmin = ['company_admin', 'super_admin'].includes(activeRelation.role.name);
    // A persisted in-app QR binding is the canonical owner. The environment
    // digest remains a migration fallback only when no ACTIVE DB binding exists.
    const effectiveOwnerBinding = latestOwnerBinding || ownerBinding;
    const ownerBindingConfigured = ownerPeerConfigured || !!effectiveOwnerBinding;
    const ownerBindingMatchesDigest = !!effectiveOwnerBinding
      && /^[a-f0-9]{64}$/.test(effectiveOwnerBinding.senderDigest);
    const inConfiguredOwnerCompany = !!ownerCompanySlug
      && activeRelation.company.slug === ownerCompanySlug;
    const emailMatchesOwner = !!ownerEmail
      && !!user.email
      && user.email.trim().toLowerCase() === ownerEmail;
    const isConfiguredOwner = isAdmin
      && inConfiguredOwnerCompany
      && emailMatchesOwner;
    const fullyReady = probe.gatewayReady && probe.adapterReady && probe.modelReady;
    const runtimeStatus: OpenClawRuntimeStatus = !probe.enabled
      ? 'DISABLED'
      : probe.starting
        ? 'STARTING'
        : fullyReady
          ? 'READY'
          : probe.gatewayReady
            ? 'DEGRADED'
            : 'OFFLINE';
    const rawChannel = probe.wechatOwnerChannel;
    const transportConnected = rawChannel.pluginReady
      && rawChannel.status === 'CONNECTED';
    const canIssueWechatCommands = isAdmin
      && isConfiguredOwner
      && ownerBindingMatchesDigest
      && transportConnected
      && fullyReady;
    // CRM chat authorization is deliberately independent from the singleton
    // owner WeChat channel. Every active company administrator can use the
    // bounded CRM tools when the execution runtime is healthy; the extra
    // owner/channel checks apply only to commands entering from WeChat.
    const canUseCrmTools = isAdmin && fullyReady;
    const sanitizedBinding = isConfiguredOwner && ownerBindingMatchesDigest && (rawChannel.binding || (effectiveOwnerBinding
      ? {
          displayName: effectiveOwnerBinding.displayName,
          maskedAccount: '***',
          boundAt: effectiveOwnerBinding.boundAt.toISOString(),
          lastSeenAt: effectiveOwnerBinding.lastSeenAt?.toISOString() || null,
        }
      : null));
    const visibleChannelStatus = !isConfiguredOwner
      ? 'DISCONNECTED' as const
      : !ownerBindingConfigured
        ? 'UNBOUND' as const
        : !effectiveOwnerBinding
          ? 'UNBOUND' as const
        : !ownerBindingMatchesDigest
          ? 'ERROR' as const
          : rawChannel.status;

    return {
      schemaVersion: 1 as const,
      observedAt: new Date().toISOString(),
      runtime: {
        engine: 'openclaw' as const,
        release: probe.release,
        status: runtimeStatus,
        gatewayReady: probe.gatewayReady,
        adapterReady: probe.adapterReady,
        modelReady: probe.modelReady,
        lastHeartbeatAt: probe.lastHeartbeatAt,
        errorCode: probe.errorCode,
      },
      wechatOwnerChannel: {
        status: visibleChannelStatus,
        pluginReady: isConfiguredOwner ? rawChannel.pluginReady : false,
        pairingExpiresAt: isConfiguredOwner ? rawChannel.pairingExpiresAt : null,
        ...(sanitizedBinding ? { binding: sanitizedBinding } : {}),
        errorCode: !isConfiguredOwner
          ? 'CHANNEL_NOT_AUTHORIZED'
          : !ownerBindingConfigured
            ? 'OWNER_DIGEST_NOT_CONFIGURED'
            : !effectiveOwnerBinding
              ? 'OWNER_BINDING_NOT_ESTABLISHED'
              : !ownerBindingMatchesDigest
                ? 'OWNER_DIGEST_MISMATCH'
                : rawChannel.errorCode,
      },
      permissions: {
        canUseAssistant: true,
        canIssueWechatCommands,
        canAdminApprove: isAdmin,
        canManageChannel: isConfiguredOwner,
      },
      capabilities: [
        {
          id: 'openclaw.crm_chat',
          // CRM chat sessions are scoped by the active database membership in
          // OpenClawCrmSessionService. They are available to every active
          // company administrator; only WeChat ownership remains singleton.
          status: canUseCrmTools ? 'ENABLED' as const : 'DISABLED' as const,
        },
        { id: 'crm.work_brief', status: canUseCrmTools ? 'ENABLED' as const : 'DISABLED' as const },
        { id: 'crm.customer_search', status: canUseCrmTools ? 'ENABLED' as const : 'DISABLED' as const },
        { id: 'crm.customer_get', status: canUseCrmTools ? 'ENABLED' as const : 'DISABLED' as const },
        { id: 'crm.customer_add_note', status: canUseCrmTools ? 'ENABLED' as const : 'DISABLED' as const },
        { id: 'crm.customer_set_stage', status: canUseCrmTools ? 'ENABLED' as const : 'DISABLED' as const },
        { id: 'crm.task_create', status: canUseCrmTools ? 'ENABLED' as const : 'DISABLED' as const },
        { id: 'crm.order_list', status: canUseCrmTools ? 'ENABLED' as const : 'DISABLED' as const },
        { id: 'crm.order_create_draft', status: canUseCrmTools ? 'ENABLED' as const : 'DISABLED' as const },
        { id: 'crm.order_update_stage', status: canUseCrmTools ? 'ENABLED' as const : 'DISABLED' as const },
        { id: 'crm.quote_list', status: canUseCrmTools ? 'ENABLED' as const : 'DISABLED' as const },
        { id: 'crm.quote_create_draft', status: canUseCrmTools ? 'ENABLED' as const : 'DISABLED' as const },
        { id: 'crm.product_search', status: canUseCrmTools ? 'ENABLED' as const : 'DISABLED' as const },
        { id: 'crm.start_background_research', status: canUseCrmTools ? 'ENABLED' as const : 'DISABLED' as const },
        {
          id: 'crm.prepare_quote_delivery',
          status: canUseCrmTools ? 'APPROVAL_REQUIRED' as const : 'DISABLED' as const,
        },
        {
          id: 'wechat.owner_control',
          status: canIssueWechatCommands ? 'ENABLED' as const : 'DISABLED' as const,
        },
        {
          id: 'external.confirmed_send',
          status: canUseCrmTools ? 'ENABLED' as const : 'DISABLED' as const,
        },
      ],
    };
  }
}
