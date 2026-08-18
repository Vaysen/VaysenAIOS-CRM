import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'crypto';
import { v4 as uuid } from 'uuid';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { InitializeAdminDto } from './dto/initialize-admin.dto';

const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INITIALIZATION_ID = 'initial-admin';

type TokenPair = {
  accessToken: string;
  refreshToken: string;
};

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  async login(dto: LoginDto) {
    const normalizedLoginName = dto.email.toLowerCase().trim();

    const user = await this.prisma.user.findUnique({
      where: { email: normalizedLoginName },
      include: {
        companies: {
          where: { isActive: true, company: { isActive: true } },
          include: { company: true, role: true },
        },
      },
    });

    if (!user || user.deletedAt || !user.isActive) {
      throw new UnauthorizedException('Invalid username or password');
    }

    const passwordValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordValid) {
      throw new UnauthorizedException('Invalid username or password');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const tokens = await this.generateTokens(user.id, user.email);
    return this.authResult(user, tokens);
  }

  async register(dto: RegisterDto) {
    if (process.env.ALLOW_PUBLIC_REGISTRATION !== 'true') {
      throw new ForbiddenException(
        'Public registration is disabled; ask a company administrator to create your account',
      );
    }
    return this.createCompanyAdministrator(dto);
  }

  async initialize(dto: InitializeAdminDto) {
    this.assertSetupKey(dto.setupKey);

    const normalizedEmail = dto.email.toLowerCase().trim();
    const passwordHash = await bcrypt.hash(dto.password, 12);

    let created: Awaited<ReturnType<AuthService['createInitialAdministrator']>>;
    try {
      created = await this.prisma.$transaction(
        (tx) => this.createInitialAdministrator(
          tx,
          dto,
          normalizedEmail,
          passwordHash,
        ),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === 'P2002') {
        throw new ConflictException('Initial administrator setup has already completed');
      }
      throw error;
    }

    const tokens = await this.generateTokens(
      created.user.id,
      created.user.email,
    );
    return this.authResult(
      {
        ...created.user,
        companies: [{
          company: created.company,
          role: created.role,
          isDefault: true,
        }],
      },
      tokens,
    );
  }

  async refresh(refreshToken: string) {
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token required');
    }

    const tokenHash = this.hashRefreshToken(refreshToken);
    const nextRefreshToken = this.newRefreshToken();
    const nextTokenHash = this.hashRefreshToken(nextRefreshToken);
    const now = new Date();

    const rotate = () => this.prisma.$transaction(async (tx) => {
      const stored = await tx.refreshToken.findUnique({
        where: { tokenHash },
      });
      if (!stored) return { status: 'invalid' as const };

      if (stored.consumedAt || stored.revokedAt) {
        await tx.refreshToken.updateMany({
          where: { familyId: stored.familyId, revokedAt: null },
          data: { revokedAt: now },
        });
        return { status: 'reused' as const };
      }

      if (stored.expiresAt <= now) {
        await tx.refreshToken.updateMany({
          where: { familyId: stored.familyId, revokedAt: null },
          data: { revokedAt: now },
        });
        return { status: 'expired' as const };
      }

      const claimed = await tx.refreshToken.updateMany({
        where: {
          id: stored.id,
          consumedAt: null,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: { consumedAt: now },
      });
      if (claimed.count !== 1) {
        await tx.refreshToken.updateMany({
          where: { familyId: stored.familyId, revokedAt: null },
          data: { revokedAt: now },
        });
        return { status: 'reused' as const };
      }

      const user = await tx.user.findUnique({
        where: { id: stored.userId },
      });
      if (!user || !user.isActive || user.deletedAt) {
        await tx.refreshToken.updateMany({
          where: { familyId: stored.familyId, revokedAt: null },
          data: { revokedAt: now },
        });
        return { status: 'invalid' as const };
      }

      const replacement = await tx.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: nextTokenHash,
          familyId: stored.familyId,
          expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
        },
      });
      await tx.refreshToken.update({
        where: { id: stored.id },
        data: { replacedById: replacement.id },
      });

      return { status: 'ok' as const, user };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    let outcome: Awaited<ReturnType<typeof rotate>>;
    try {
      outcome = await rotate();
    } catch (error) {
      if ((error as { code?: string })?.code !== 'P2034') throw error;
      // A concurrent refresh won the claim. Retrying observes consumedAt and
      // revokes the complete family as a replay response.
      outcome = await rotate();
    }

    if (outcome.status !== 'ok') {
      throw new UnauthorizedException(
        outcome.status === 'reused'
          ? 'Refresh token reuse detected; session revoked'
          : 'Invalid or expired refresh token',
      );
    }

    return {
      accessToken: this.signAccessToken(outcome.user.id, outcome.user.email),
      refreshToken: nextRefreshToken,
      expiresIn: 900,
    };
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        companies: {
          where: { isActive: true, company: { isActive: true } },
          include: { company: true, role: true },
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      avatar: user.avatar,
      isEmailVerified: user.isEmailVerified,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      companies: this.mapCompanies(user.companies),
    };
  }

  async logout(userId: string, refreshToken?: string) {
    if (refreshToken) {
      const stored = await this.prisma.refreshToken.findUnique({
        where: { tokenHash: this.hashRefreshToken(refreshToken) },
        select: { familyId: true, userId: true },
      });
      if (stored?.userId === userId) {
        await this.prisma.refreshToken.updateMany({
          where: { familyId: stored.familyId, userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
    }
    return { message: 'Logged out successfully' };
  }

  private async createCompanyAdministrator(dto: RegisterDto) {
    const normalizedEmail = dto.email.toLowerCase().trim();
    const existing = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existing) {
      throw new ConflictException('Username already registered');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const created = await this.prisma.$transaction(async (tx) => {
      const role = await tx.role.findUnique({ where: { name: 'company_admin' } });
      if (!role) throw new BadRequestException('Default role not found');

      const user = await tx.user.create({
        data: {
          email: normalizedEmail,
          passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone,
        },
      });
      const company = await tx.company.create({
        data: {
          name: dto.companyName
            || `${dto.firstName} ${dto.lastName}'s Workspace`,
          slug: this.companySlug(dto.companyName || 'personal', user.id),
        },
      });
      await tx.userCompanyRelation.create({
        data: {
          userId: user.id,
          companyId: company.id,
          roleId: role.id,
          isDefault: true,
        },
      });
      return { user, company, role };
    });

    const tokens = await this.generateTokens(
      created.user.id,
      created.user.email,
    );
    return this.authResult(
      {
        ...created.user,
        companies: [{
          company: created.company,
          role: created.role,
          isDefault: true,
        }],
      },
      tokens,
    );
  }

  private async createInitialAdministrator(
    tx: Prisma.TransactionClient,
    dto: InitializeAdminDto,
    normalizedEmail: string,
    passwordHash: string,
  ) {
    await tx.deploymentInitialization.create({
      data: {
        id: INITIALIZATION_ID,
        companyId: 'pending',
        initializedByUserId: 'pending',
      },
    });

    const [userCount, companyCount] = await Promise.all([
      tx.user.count(),
      tx.company.count(),
    ]);
    if (userCount !== 0 || companyCount !== 0) {
      throw new ConflictException(
        'Initialization requires a new database with no users or companies',
      );
    }

    const role = await tx.role.findUnique({ where: { name: 'company_admin' } });
    if (!role) throw new BadRequestException('Default role not found');

    const user = await tx.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
      },
    });
    const company = await tx.company.create({
      data: {
        name: dto.companyName,
        slug: this.companySlug(dto.companyName, user.id),
      },
    });
    await tx.userCompanyRelation.create({
      data: {
        userId: user.id,
        companyId: company.id,
        roleId: role.id,
        isDefault: true,
      },
    });
    await tx.deploymentInitialization.update({
      where: { id: INITIALIZATION_ID },
      data: {
        companyId: company.id,
        initializedByUserId: user.id,
      },
    });
    await tx.auditLog.create({
      data: {
        companyId: company.id,
        userId: user.id,
        action: 'deployment:initialize_admin',
        entityType: 'DeploymentInitialization',
        entityId: INITIALIZATION_ID,
        newValue: {
          companyId: company.id,
          administratorUserId: user.id,
        },
      },
    });
    return { user, company, role };
  }

  private async generateTokens(
    userId: string,
    email: string,
  ): Promise<TokenPair> {
    const refreshToken = this.newRefreshToken();
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.hashRefreshToken(refreshToken),
        familyId: uuid(),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
    });
    return {
      accessToken: this.signAccessToken(userId, email),
      refreshToken,
    };
  }

  private signAccessToken(userId: string, email: string) {
    return this.jwtService.sign(
      { sub: userId, email },
      { expiresIn: process.env.JWT_EXPIRATION || '15m' },
    );
  }

  private newRefreshToken() {
    return randomBytes(48).toString('base64url');
  }

  private hashRefreshToken(token: string) {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  private assertSetupKey(provided: string) {
    const configured = String(process.env.INITIAL_ADMIN_SETUP_KEY || '');
    if (
      configured.length < 32
      || /change-me|replace-with|example|placeholder/i.test(configured)
    ) {
      throw new ServiceUnavailableException(
        'Initial administrator setup is not securely configured',
      );
    }
    const expected = createHash('sha256').update(configured).digest();
    const actual = createHash('sha256').update(provided || '').digest();
    if (!timingSafeEqual(expected, actual)) {
      throw new UnauthorizedException('Invalid initialization credentials');
    }
  }

  private companySlug(name: string, userId: string) {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      || 'workspace';
    return `${base}-${userId.substring(0, 8)}`;
  }

  private authResult(user: any, tokens: TokenPair) {
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: 900,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        companies: this.mapCompanies(user.companies),
      },
    };
  }

  private mapCompanies(relations: any[]) {
    return relations.map((relation) => ({
      id: relation.company.id,
      name: relation.company.name,
      slug: relation.company.slug,
      role: relation.role.name,
      isDefault: relation.isDefault,
    }));
  }
}
