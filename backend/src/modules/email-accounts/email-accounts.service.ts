import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  HttpException,
} from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateEmailAccountDto } from './dto/create-email-account.dto';
import { UpdateEmailAccountDto } from './dto/update-email-account.dto';
import { UpdateEmailAccountStatusDto } from './dto/update-email-account-status.dto';
import { encrypt, decrypt } from '../../common/utils/crypto.util';
import { findLegacyEmailBrandReference } from '../emails/email-content.guard';
import { assertBrevoReceivingConfig } from './brevo-email-account.policy';
import { OutboundComplianceService } from '../outbound/outbound-compliance.service';
import { TestEmailDto } from './dto/test-email.dto';
import { resolveSmtpEgress } from './smtp-egress.policy';
import {
  assertSmtpAcceptedTarget,
  createAbortableSmtpTransport,
} from './smtp-delivery';

@Injectable()
export class EmailAccountsService {
  constructor(
    private prisma: PrismaService,
    private readonly outbound: OutboundComplianceService,
  ) {}

  async findAll(currentUser: any, query: { page?: number; limit?: number; status?: string }) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const company = this.getCompany(currentUser);
    const role = await this.assertActiveMembership(currentUser, company.id);
    const where: any = this.buildCompanyWhere(currentUser, company.id, role);

    if (query.status) {
      where.status = query.status;
    }

    const [data, total] = await Promise.all([
      this.prisma.emailAccount.findMany({
        where,
        select: this.safeSelect(),
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.emailAccount.count({ where }),
    ]);

    return {
      data: data.map((account) => this.decorateSharedPoolAccount(account)),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string, currentUser: any) {
    const company = this.getCompany(currentUser);
    const account = await this.prisma.emailAccount.findFirst({
      where: { id, companyId: company.id },
      select: this.safeSelect(),
    });
    if (!account) throw new NotFoundException('Email account not found');
    const role = await this.assertActiveMembership(currentUser, account.companyId);
    this.checkCompanyAccess(currentUser, account, role);
    return this.decorateSharedPoolAccount(account);
  }

  async create(dto: CreateEmailAccountDto, currentUser: any) {
    this.blockSharedPoolMutation();
    const company = this.getCompany(currentUser);
    const role = await this.assertActiveMembership(currentUser, company.id);
    this.checkAdminAccess(role);
    const assignedUserId = dto.userId || null;
    if (assignedUserId) {
      await this.ensureUserInCompany(assignedUserId, company.id);
    }
    this.assertSenderBranding(dto.senderName, dto.senderEmail, dto.replyToEmail);
    assertBrevoReceivingConfig(dto.smtpHost, dto.replyToEmail);
    await resolveSmtpEgress(dto);

    const encryptedPassword = encrypt(dto.smtpPassword);

    const account = await this.prisma.emailAccount.create({
      data: {
        companyId: company.id,
        userId: assignedUserId,
        senderName: dto.senderName,
        senderEmail: dto.senderEmail,
        accountRole: dto.accountRole ?? 'CORE',
        tags: dto.tags ?? [],
        smtpHost: dto.smtpHost,
        smtpPort: dto.smtpPort,
        smtpSecure: dto.smtpSecure,
        smtpUsername: dto.smtpUsername,
        smtpPasswordEncrypted: encryptedPassword,
        replyToEmail: dto.replyToEmail,
        imapHost: dto.imapHost ?? null,
        imapPort: dto.imapPort ?? null,
        imapSecure: dto.imapSecure ?? null,
        imapUsername: dto.imapUsername ?? null,
        imapPasswordEncrypted: dto.imapPassword ? encrypt(dto.imapPassword) : null,
        inboundEnabled: dto.inboundEnabled ?? false,
        inboundPollIntervalSeconds: dto.inboundPollIntervalSeconds ?? 300,
        dailySendLimit: dto.dailySendLimit ?? 50,
        hourlySendLimit: dto.hourlySendLimit ?? 10,
        sendIntervalSeconds: dto.sendIntervalSeconds ?? 60,
        warmupEnabled: dto.warmupEnabled ?? false,
        status: 'active',
      },
      select: this.safeSelect(),
    });

    await this.prisma.auditLog.create({
      data: {
        companyId: company.id,
        userId: currentUser.id,
        action: 'create_email_account',
        entityType: 'EmailAccount',
        entityId: account.id,
        newValue: { senderEmail: dto.senderEmail, smtpHost: dto.smtpHost },
      },
    });

    return account;
  }

  async update(id: string, dto: UpdateEmailAccountDto, currentUser: any) {
    this.blockSharedPoolMutation();
    const company = this.getCompany(currentUser);
    const existing = await this.prisma.emailAccount.findFirst({
      where: { id, companyId: company.id },
    });
    if (!existing) throw new NotFoundException('Email account not found');
    const role = await this.assertActiveMembership(currentUser, existing.companyId);
    this.checkCompanyAccess(currentUser, existing, role);
    this.checkAdminAccess(role);
    if (dto.userId) {
      await this.ensureUserInCompany(dto.userId, existing.companyId);
    }
    this.assertSenderBranding(
      dto.senderName ?? existing.senderName,
      dto.senderEmail ?? existing.senderEmail,
      dto.replyToEmail ?? existing.replyToEmail,
    );
    assertBrevoReceivingConfig(
      dto.smtpHost ?? existing.smtpHost,
      dto.replyToEmail ?? existing.replyToEmail,
    );
    await resolveSmtpEgress({
      smtpHost: dto.smtpHost ?? existing.smtpHost,
      smtpPort: dto.smtpPort ?? existing.smtpPort,
      smtpSecure: dto.smtpSecure ?? existing.smtpSecure,
    });

    const data: any = {};
    if (dto.senderName !== undefined) data.senderName = dto.senderName;
    if (dto.senderEmail !== undefined) data.senderEmail = dto.senderEmail;
    if (dto.smtpHost !== undefined) data.smtpHost = dto.smtpHost;
    if (dto.smtpPort !== undefined) data.smtpPort = dto.smtpPort;
    if (dto.smtpSecure !== undefined) data.smtpSecure = dto.smtpSecure;
    if (dto.smtpUsername !== undefined) data.smtpUsername = dto.smtpUsername;
    if (dto.replyToEmail !== undefined) data.replyToEmail = dto.replyToEmail;
    if (dto.smtpPassword !== undefined) {
      data.smtpPasswordEncrypted = encrypt(dto.smtpPassword);
    }
    if (dto.imapHost !== undefined) data.imapHost = dto.imapHost;
    if (dto.imapPort !== undefined) data.imapPort = dto.imapPort;
    if (dto.imapSecure !== undefined) data.imapSecure = dto.imapSecure;
    if (dto.imapUsername !== undefined) data.imapUsername = dto.imapUsername;
    if (dto.imapPassword !== undefined) {
      data.imapPasswordEncrypted = encrypt(dto.imapPassword);
    }
    if (dto.inboundEnabled !== undefined) data.inboundEnabled = dto.inboundEnabled;
    if (dto.inboundPollIntervalSeconds !== undefined) {
      data.inboundPollIntervalSeconds = dto.inboundPollIntervalSeconds;
    }
    if (dto.accountRole !== undefined) data.accountRole = dto.accountRole;
    if (dto.tags !== undefined) data.tags = dto.tags;
    if (dto.dailySendLimit !== undefined) data.dailySendLimit = dto.dailySendLimit;
    if (dto.hourlySendLimit !== undefined) data.hourlySendLimit = dto.hourlySendLimit;
    if (dto.sendIntervalSeconds !== undefined) data.sendIntervalSeconds = dto.sendIntervalSeconds;
    if (dto.warmupEnabled !== undefined) data.warmupEnabled = dto.warmupEnabled;
    if (dto.userId !== undefined) {
      data.userId = dto.userId || null;
    }

    const account = await this.prisma.emailAccount.update({
      where: { id },
      data,
      select: this.safeSelect(),
    });

    await this.prisma.auditLog.create({
      data: {
        companyId: existing.companyId,
        userId: currentUser.id,
        action: 'update_email_account',
        entityType: 'EmailAccount',
        entityId: account.id,
        newValue: { senderEmail: account.senderEmail },
      },
    });

    return account;
  }

  async remove(id: string, currentUser: any) {
    this.blockSharedPoolMutation();
    const existing = await this.prisma.emailAccount.findFirst({
      where: { id, companyId: this.getCompany(currentUser).id },
    });
    if (!existing) throw new NotFoundException('Email account not found');
    const role = await this.assertActiveMembership(currentUser, existing.companyId);
    this.checkCompanyAccess(currentUser, existing, role);
    this.checkAdminAccess(role);

    // Check if account is used by any campaigns
    const campaignCount = await this.prisma.campaign.count({
      where: { senderAccountId: id },
    });
    if (campaignCount > 0) {
      throw new BadRequestException(
        `Cannot delete: this account is used by ${campaignCount} campaign(s). Please deactivate it instead.`,
      );
    }

    const account = await this.prisma.emailAccount.update({
      where: { id },
      data: { status: 'inactive' },
      select: this.safeSelect(),
    });

    await this.prisma.auditLog.create({
      data: {
        companyId: existing.companyId,
        userId: currentUser.id,
        action: 'delete_email_account',
        entityType: 'EmailAccount',
        entityId: id,
        oldValue: { senderEmail: existing.senderEmail },
      },
    });

    return account;
  }

  async updateStatus(id: string, dto: UpdateEmailAccountStatusDto, currentUser: any) {
    this.blockSharedPoolMutation();
    const existing = await this.prisma.emailAccount.findFirst({
      where: { id, companyId: this.getCompany(currentUser).id },
    });
    if (!existing) throw new NotFoundException('Email account not found');
    const role = await this.assertActiveMembership(currentUser, existing.companyId);
    this.checkCompanyAccess(currentUser, existing, role);
    this.checkAdminAccess(role);

    const account = await this.prisma.emailAccount.update({
      where: { id },
      data: { status: dto.status },
      select: this.safeSelect(),
    });

    await this.prisma.auditLog.create({
      data: {
        companyId: existing.companyId,
        userId: currentUser.id,
        action: 'update_email_account_status',
        entityType: 'EmailAccount',
        entityId: id,
        oldValue: { status: existing.status },
        newValue: { status: dto.status },
      },
    });

    return account;
  }

  async testConnection(id: string, currentUser: any) {
    const existing = await this.prisma.emailAccount.findFirst({
      where: { id, companyId: this.getCompany(currentUser).id },
    });
    if (!existing) throw new NotFoundException('Email account not found');
    const role = await this.assertActiveMembership(currentUser, existing.companyId);
    this.checkCompanyAccess(currentUser, existing, role);
    this.checkAdminAccess(role);

    try {
      const transporter = await this.createTransporter(existing);
      await transporter.verify();

      await this.prisma.emailAccount.update({
        where: { id },
        data: { lastTestedAt: new Date(), failureCount: 0 },
      });

      return { success: true, code: 'SMTP_CONNECTION_OK', message: 'SMTP connection successful' };
    } catch (err: any) {
      await this.prisma.emailAccount.update({
        where: { id },
        data: {
          lastTestedAt: new Date(),
          failureCount: { increment: 1 },
        },
      });

      return { success: false, code: 'SMTP_CONNECTION_FAILED', message: 'SMTP connection failed' };
    }
  }

  async sendTest(id: string, dto: TestEmailDto, currentUser: any) {
    const company = this.getCompany(currentUser);
    const existing = await this.prisma.emailAccount.findFirst({
      where: { id, companyId: company.id },
    });
    if (!existing) throw new NotFoundException('Email account not found');
    const role = await this.assertActiveMembership(currentUser, existing.companyId);
    this.checkCompanyAccess(currentUser, existing, role);
    this.checkAdminAccess(role);

    const legacyEnvelope = findLegacyEmailBrandReference(
      existing.senderName,
      existing.senderEmail,
      existing.replyToEmail,
    );
    if (legacyEnvelope) {
      throw new BadRequestException(`Email sender contains a retired brand or domain: ${legacyEnvelope}`);
    }

    // Safety switch: block test email send in preview
    if (process.env.EMAIL_SEND_ENABLED === 'false' || process.env.EMAIL_SEND_DISABLED === 'true') {
      return { success: true, previewBlocked: true, message: 'Preview mode: test email blocked by safety switch' };
    }

    const subject = `Test Email from Vaysen Trade OS - ${existing.senderEmail}`;
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Test Email</h2>
        <p>This is a test email from your Vaysen Trade OS email account.</p>
        <hr />
        <p><strong>Account:</strong> ${existing.senderName} (${existing.senderEmail})</p>
        <p><strong>SMTP Server:</strong> ${existing.smtpHost}:${existing.smtpPort}</p>
      </div>
    `;
    try {
      const action = await this.outbound.execute({
        companyId: existing.companyId,
        operatorUser: currentUser,
        actorType: 'HUMAN',
        channel: 'EMAIL',
        actionType: 'RAW_SMTP_TEST',
        idempotencyKey: dto.idempotencyKey || '',
        leadId: dto.leadId,
        targetAddress: dto.recipientEmail,
        emailAccountId: existing.id,
        subject,
        body: html,
        requireAdmin: true,
      }, async (_outboundArtifacts, envelope) => {
        const egress = await resolveSmtpEgress(existing);
        const { transporter, close } = createAbortableSmtpTransport(
          egress,
          {
            user: existing.smtpUsername,
            pass: decrypt(existing.smtpPasswordEncrypted),
          },
          envelope.signal,
        );
        let info: any;
        try {
          info = await transporter.sendMail({
            from: `"${existing.senderName}" <${existing.senderEmail}>`,
            to: envelope.targetAddress,
            replyTo: existing.replyToEmail || undefined,
            subject: envelope.subject,
            html: envelope.body,
          });
        } finally {
          close();
        }
        if (!info?.messageId) throw new Error('SMTP provider did not return a message id');
        const accepted = assertSmtpAcceptedTarget(info, envelope.targetAddress);
        return {
          provider: 'smtp',
          receiptId: info.messageId,
          metadata: { accepted },
        };
      });

      await this.prisma.emailAccount.update({
        where: { id },
        data: { lastTestedAt: new Date(), failureCount: 0 },
      });

      return {
        success: true,
        code: 'SMTP_TEST_ACCEPTED',
        message: 'Test email accepted',
        outboxId: action.outboxId,
        deduplicated: action.deduplicated,
        providerReceiptId: action.receipt.receiptId,
      };
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      await this.prisma.emailAccount.update({
        where: { id },
        data: {
          lastTestedAt: new Date(),
          failureCount: { increment: 1 },
        },
      });

      return { success: false, code: 'SMTP_TEST_SEND_FAILED', message: 'Failed to send test email' };
    }
  }

  // ========== Access Control ==========

  /**
   * 营销动作强制校验（可复用）：仅允许 accountRole=MARKETING 的邮箱账号。
   * 三处调用：send-batch（营销批量发送）、send-single(source=marketing)（营销面板单发）、
   * 营销活动 campaign（创建/更新指定 senderAccountId 或渠道账号就绪检查）。
   * 非 MARKETING 账号抛 BadRequestException，带明确中文原因。
   */
  assertMarketingRole(
    account: { senderEmail?: string | null; accountRole?: string | null } | null | undefined,
    actionLabel = '该营销操作',
  ) {
    const role = account?.accountRole || 'CORE';
    if (role !== 'MARKETING') {
      const senderEmail = account?.senderEmail || '<unknown>';
      throw new BadRequestException(
        `${actionLabel}仅允许使用营销邮箱（accountRole=MARKETING），当前账号 ${senderEmail} 角色为 ${role}`,
      );
    }
  }

  private isSharedMailboxPool() {
    return process.env.EMAIL_ACCOUNT_SHARED_POOL === 'true';
  }

  private assertSenderBranding(
    senderName: string,
    senderEmail: string,
    replyToEmail?: string | null,
  ) {
    const legacyReference = findLegacyEmailBrandReference(senderName, senderEmail, replyToEmail);
    if (legacyReference) {
      throw new BadRequestException(`Email sender contains a retired brand or domain: ${legacyReference}`);
    }
  }

  private blockSharedPoolMutation() {
    if (this.isSharedMailboxPool()) {
      throw new ForbiddenException('This deployment uses a shared sender mailbox pool. Sender account settings are managed centrally.');
    }
  }

  private decorateSharedPoolAccount<T extends Record<string, any>>(account: T): T & { sharedPool?: boolean; editable?: boolean } {
    if (!this.isSharedMailboxPool()) return account;
    return { ...account, sharedPool: true, editable: false };
  }

  private getCompany(currentUser: any) {
    const companyId = String(currentUser?.activeCompanyId || '').trim();
    if (!companyId) throw new ForbiddenException('An authenticated active company is required');
    if (currentUser?.activeCompany?.id && currentUser.activeCompany.id !== companyId) {
      throw new ForbiddenException('Authenticated active company claims are inconsistent');
    }
    return { id: companyId };
  }

  private buildCompanyWhere(currentUser: any, companyId: string, databaseRole: string): any {
    if (['super_admin', 'company_admin'].includes(databaseRole)) {
      return { companyId };
    }

    // Isolated users see their own + unassigned accounts
    return {
      companyId,
      OR: [{ userId: currentUser.id }, { userId: null }],
    };
  }

  private checkCompanyAccess(currentUser: any, account: any, databaseRole: string) {
    if (['super_admin', 'company_admin'].includes(databaseRole)) return;

    // Isolated users can only access assigned accounts
    if (account.userId && account.userId !== currentUser.id) {
      throw new ForbiddenException('You can only access your assigned email accounts');
    }
  }

  private checkAdminAccess(databaseRole: string) {
    if (!['super_admin', 'company_admin'].includes(databaseRole)) {
      throw new ForbiddenException('Company administrator role is required for sender account deletion or status changes');
    }
  }

  private async assertActiveMembership(currentUser: any, companyId: string) {
    const activeCompanyId = String(currentUser?.activeCompanyId || '').trim();
    if (
      !activeCompanyId
      || activeCompanyId !== companyId
      || (currentUser?.activeCompany?.id && currentUser.activeCompany.id !== activeCompanyId)
    ) {
      throw new ForbiddenException('Target company is not the authenticated active company');
    }
    const relation = currentUser.id
      ? await this.prisma.userCompanyRelation.findFirst({
          where: {
            userId: currentUser.id,
            companyId,
            isActive: true,
            user: { is: { isActive: true, deletedAt: null } },
            company: { is: { isActive: true } },
          },
          include: { role: { select: { name: true } } },
        })
      : null;
    const databaseRole = String(relation?.role?.name || '').trim();
    if (!databaseRole) {
      throw new ForbiddenException('Tenant membership or role is no longer active');
    }
    return databaseRole;
  }

  private async ensureUserInCompany(userId: string, companyId: string) {
    const relation = await this.prisma.userCompanyRelation.findFirst({
      where: {
        userId,
        companyId,
        isActive: true,
        user: { is: { isActive: true, deletedAt: null } },
        company: { is: { isActive: true } },
      },
      select: { id: true },
    });
    if (!relation) throw new BadRequestException('Assigned user is not an active company member');
  }

  private async createTransporter(account: any) {
    const egress = await resolveSmtpEgress(account);
    return nodemailer.createTransport({
      ...egress,
      auth: {
        user: account.smtpUsername,
        pass: decrypt(account.smtpPasswordEncrypted),
      },
    } as any);
  }

  private safeSelect() {
    return {
      id: true,
      companyId: true,
      userId: true,
      senderName: true,
      senderEmail: true,
      accountRole: true,
      tags: true,
      smtpHost: true,
      smtpPort: true,
      smtpSecure: true,
      smtpUsername: true,
      replyToEmail: true,
      dailySendLimit: true,
      hourlySendLimit: true,
      sendIntervalSeconds: true,
      warmupEnabled: true,
      dailySentCount: true,
      hourlySentCount: true,
      lastSentAt: true,
      status: true,
      failureCount: true,
      maxFailuresBeforePause: true,
      lastTestedAt: true,
      spfConfigured: true,
      dkimConfigured: true,
      dmarcConfigured: true,
      createdAt: true,
      updatedAt: true,
    };
  }

}
