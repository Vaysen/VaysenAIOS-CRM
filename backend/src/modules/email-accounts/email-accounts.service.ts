import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateEmailAccountDto } from './dto/create-email-account.dto';
import { UpdateEmailAccountDto } from './dto/update-email-account.dto';
import { UpdateEmailAccountStatusDto } from './dto/update-email-account-status.dto';
import { encrypt, decrypt } from '../../common/utils/crypto.util';
import { findLegacyEmailBrandReference } from '../emails/email-content.guard';
import { assertBrevoReceivingConfig } from './brevo-email-account.policy';

@Injectable()
export class EmailAccountsService {
  constructor(private prisma: PrismaService) {}

  async findAll(currentUser: any, query: { page?: number; limit?: number; status?: string }) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = this.buildCompanyWhere(currentUser);

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
    const account = await this.prisma.emailAccount.findUnique({
      where: { id },
      select: this.safeSelect(),
    });
    if (!account) throw new NotFoundException('Email account not found');
    this.checkCompanyAccess(currentUser, account);
    return this.decorateSharedPoolAccount(account);
  }

  async create(dto: CreateEmailAccountDto, currentUser: any) {
    this.blockSharedPoolMutation();
    const company = this.getCompany(currentUser);
    this.checkManagerAccess(currentUser, company.id);
    this.assertSenderBranding(dto.senderName, dto.senderEmail, dto.replyToEmail);
    assertBrevoReceivingConfig(dto.smtpHost, dto.replyToEmail);
    const assignedUserId = dto.userId || null;
    if (assignedUserId) {
      await this.ensureUserInCompany(assignedUserId, company.id);
    }

    const encryptedPassword = encrypt(dto.smtpPassword);

    const account = await this.prisma.emailAccount.create({
      data: {
        companyId: company.id,
        userId: assignedUserId,
        senderName: dto.senderName,
        senderEmail: dto.senderEmail,
        smtpHost: dto.smtpHost,
        smtpPort: dto.smtpPort,
        smtpSecure: dto.smtpSecure,
        smtpUsername: dto.smtpUsername,
        smtpPasswordEncrypted: encryptedPassword,
        replyToEmail: dto.replyToEmail,
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
    const existing = await this.prisma.emailAccount.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Email account not found');
    this.checkCompanyAccess(currentUser, existing);
    this.checkManagerAccess(currentUser, existing.companyId);
    this.assertSenderBranding(
      dto.senderName ?? existing.senderName,
      dto.senderEmail ?? existing.senderEmail,
      dto.replyToEmail ?? existing.replyToEmail,
    );
    assertBrevoReceivingConfig(
      dto.smtpHost ?? existing.smtpHost,
      dto.replyToEmail ?? existing.replyToEmail,
    );

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
    if (dto.dailySendLimit !== undefined) data.dailySendLimit = dto.dailySendLimit;
    if (dto.hourlySendLimit !== undefined) data.hourlySendLimit = dto.hourlySendLimit;
    if (dto.sendIntervalSeconds !== undefined) data.sendIntervalSeconds = dto.sendIntervalSeconds;
    if (dto.warmupEnabled !== undefined) data.warmupEnabled = dto.warmupEnabled;
    if (dto.userId !== undefined) {
      if (dto.userId) await this.ensureUserInCompany(dto.userId, existing.companyId);
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
    const existing = await this.prisma.emailAccount.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Email account not found');
    this.checkCompanyAccess(currentUser, existing);
    this.checkManagerAccess(currentUser, existing.companyId);

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
    const existing = await this.prisma.emailAccount.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Email account not found');
    this.checkCompanyAccess(currentUser, existing);
    this.checkManagerAccess(currentUser, existing.companyId);

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
    const existing = await this.prisma.emailAccount.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Email account not found');
    this.checkCompanyAccess(currentUser, existing);
    this.checkManagerAccess(currentUser, existing.companyId);

    try {
      const transporter = this.createTransporter(existing);
      await transporter.verify();

      await this.prisma.emailAccount.update({
        where: { id },
        data: { lastTestedAt: new Date(), failureCount: 0 },
      });

      return { success: true, message: 'SMTP connection successful' };
    } catch (err: any) {
      await this.prisma.emailAccount.update({
        where: { id },
        data: {
          lastTestedAt: new Date(),
          failureCount: { increment: 1 },
        },
      });

      return { success: false, message: `SMTP connection failed: ${err.message}` };
    }
  }

  async sendTest(id: string, recipientEmail: string, currentUser: any) {
    const existing = await this.prisma.emailAccount.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Email account not found');
    this.checkCompanyAccess(currentUser, existing);
    this.checkWriteAccess(currentUser, existing.companyId);

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

    try {
      const transporter = this.createTransporter(existing);
      await transporter.sendMail({
        from: `"${existing.senderName}" <${existing.senderEmail}>`,
        to: recipientEmail,
        replyTo: existing.replyToEmail || undefined,
        subject: `Test Email from Vaysen AI CRM - ${existing.senderEmail}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Test Email</h2>
            <p>This is a test email from your Vaysen AI CRM email account.</p>
            <hr />
            <p><strong>Account:</strong> ${existing.senderName} (${existing.senderEmail})</p>
            <p><strong>SMTP Server:</strong> ${existing.smtpHost}:${existing.smtpPort}</p>
            <p><strong>Sent at:</strong> ${new Date().toISOString()}</p>
          </div>
        `,
      });

      await this.prisma.emailAccount.update({
        where: { id },
        data: { lastTestedAt: new Date(), failureCount: 0 },
      });

      return { success: true, message: `Test email sent to ${recipientEmail}` };
    } catch (err: any) {
      await this.prisma.emailAccount.update({
        where: { id },
        data: {
          lastTestedAt: new Date(),
          failureCount: { increment: 1 },
        },
      });

      return { success: false, message: `Failed to send test email: ${err.message}` };
    }
  }

  // ========== Access Control ==========

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
    const companyId = currentUser.companies?.[0]?.id;
    if (!companyId) throw new ForbiddenException('No company associated');
    return currentUser.companies[0];
  }

  private buildCompanyWhere(currentUser: any): any {
    const isFullAccess = currentUser.companies?.some(
      (c: any) => ['super_admin', 'company_admin'].includes(c.role),
    );
    const companyIds = currentUser.companies?.map((c: any) => c.id) || [];

    if (isFullAccess) {
      return companyIds.length ? { companyId: { in: companyIds } } : {};
    }

    // Isolated users see their own + unassigned accounts
    return {
      companyId: { in: companyIds },
      OR: [{ userId: currentUser.id }, { userId: null }],
    };
  }

  private checkCompanyAccess(currentUser: any, account: any) {
    const isFullAccess = currentUser.companies?.some(
      (c: any) => ['super_admin', 'company_admin'].includes(c.role),
    );
    if (isFullAccess) return;

    const userCompanyIds = currentUser.companies?.map((c: any) => c.id) || [];
    if (!userCompanyIds.includes(account.companyId)) {
      throw new ForbiddenException('Cannot access email accounts from another company');
    }

    // Isolated users can only access assigned accounts
    if (account.userId && account.userId !== currentUser.id) {
      throw new ForbiddenException('You can only access your assigned email accounts');
    }
  }

  private checkWriteAccess(currentUser: any, companyId: string) {
    const isFullAccess = currentUser.companies?.some(
      (c: any) => ['super_admin', 'company_admin'].includes(c.role),
    );
    if (isFullAccess) return;

    const company = currentUser.companies?.find((c: any) => c.id === companyId);
    if (!company) throw new ForbiddenException('Not a member of this company');

    if (company.role === 'viewer') {
      throw new ForbiddenException('Viewer cannot modify email accounts');
    }
  }

  private checkManagerAccess(currentUser: any, companyId: string) {
    const isFullAccess = currentUser.companies?.some(
      (c: any) => ['super_admin', 'company_admin'].includes(c.role),
    );
    if (isFullAccess) return;

    const company = currentUser.companies?.find((c: any) => c.id === companyId);
    if (!company) throw new ForbiddenException('Not a member of this company');

    if (company.role !== 'sales_manager') {
      throw new ForbiddenException('Only admin or manager can manage sender accounts');
    }
  }

  private async ensureUserInCompany(userId: string, companyId: string) {
    const relation = await this.prisma.userCompanyRelation.findFirst({
      where: { userId, companyId, isActive: true },
    });
    if (!relation) throw new BadRequestException('Assigned user is not an active company member');
  }

  private createTransporter(account: any) {
    return nodemailer.createTransport({
      host: account.smtpHost,
      port: account.smtpPort,
      secure: account.smtpSecure,
      auth: {
        user: account.smtpUsername,
        pass: decrypt(account.smtpPasswordEncrypted),
      },
    });
  }

  private safeSelect() {
    return {
      id: true,
      companyId: true,
      userId: true,
      senderName: true,
      senderEmail: true,
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

  // Used internally (e.g., by campaign sender) to get decrypted password
  async getDecryptedPassword(id: string): Promise<string> {
    const account = await this.prisma.emailAccount.findUnique({
      where: { id },
      select: { smtpPasswordEncrypted: true },
    });
    if (!account) throw new NotFoundException('Email account not found');
    return decrypt(account.smtpPasswordEncrypted);
  }
}
