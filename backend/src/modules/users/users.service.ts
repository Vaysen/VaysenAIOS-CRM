import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findAll(currentUser: any, query: { page?: number; limit?: number }) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const companyIds = currentUser.companies.map((c: any) => c.id);
    const isSuperAdmin = currentUser.companies.some(
      (c: any) => c.role === 'super_admin',
    );

    const where: any = isSuperAdmin
      ? { deletedAt: null }
      : {
          deletedAt: null,
          companies: { some: { companyId: { in: companyIds } } },
        };

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          avatar: true,
          isActive: true,
          lastLoginAt: true,
          createdAt: true,
          companies: {
            select: {
              company: { select: { id: true, name: true, slug: true } },
              role: { select: { id: true, name: true, displayName: true } },
            },
          },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data: users,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string, currentUser: any) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        avatar: true,
        isActive: true,
        isEmailVerified: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
        companies: {
          select: {
            isDefault: true,
            company: { select: { id: true, name: true, slug: true } },
            role: { select: { id: true, name: true, displayName: true } },
          },
        },
      },
    });

    if (!user || user.deletedAt) {
      throw new NotFoundException('User not found');
    }

    await this.checkCompanyAccess(currentUser, user);
    return user;
  }

  async create(dto: CreateUserDto, currentUser: any) {
    // The existing unique email column is used as the login username.
    const normalizedEmail = dto.email.toLowerCase().trim();

    const existing = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existing) {
      throw new ConflictException('Username already registered');
    }

    await this.checkCompanyAdminAccess(currentUser, dto.companyId);

    const role = await this.prisma.role.findUnique({
      where: { id: dto.roleId },
    });
    if (!role) throw new NotFoundException('Role not found');

    const passwordHash = await bcrypt.hash(dto.password, 12);

    const user = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          email: normalizedEmail,
          passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone,
        },
      });

      await tx.userCompanyRelation.create({
        data: {
          userId: u.id,
          companyId: dto.companyId,
          roleId: dto.roleId,
        },
      });

      await tx.auditLog.create({
        data: {
          companyId: dto.companyId,
          userId: currentUser.id,
          action: 'user:create',
          entityType: 'User',
          entityId: u.id,
          newValue: { email: dto.email, firstName: dto.firstName, lastName: dto.lastName },
        },
      });

      return u;
    });

    return this.findOne(user.id, currentUser);
  }

  async update(id: string, dto: UpdateUserDto, currentUser: any) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        companies: {
          select: {
            company: { select: { id: true } },
          },
        },
      },
    });
    if (!user || user.deletedAt) throw new NotFoundException('User not found');

    await this.checkCompanyAccess(currentUser, user);

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        ...(dto.firstName && { firstName: dto.firstName }),
        ...(dto.lastName && { lastName: dto.lastName }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
      },
    });

    return this.findOne(updated.id, currentUser);
  }

  async updateStatus(id: string, isActive: boolean, currentUser: any) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        companies: {
          select: {
            company: { select: { id: true } },
          },
        },
      },
    });
    if (!user || user.deletedAt) throw new NotFoundException('User not found');

    await this.checkCompanyAccess(currentUser, user);

    await this.prisma.user.update({
      where: { id },
      data: { isActive },
    });

    await this.prisma.auditLog.create({
      data: {
        userId: currentUser.id,
        action: isActive ? 'user:enable' : 'user:disable',
        entityType: 'User',
        entityId: id,
        newValue: { isActive },
      },
    });

    return this.findOne(id, currentUser);
  }

  async updateRole(id: string, roleId: string, companyId: string, currentUser: any) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user || user.deletedAt) throw new NotFoundException('User not found');

    await this.checkCompanyAdminAccess(currentUser, companyId);

    const relation = await this.prisma.userCompanyRelation.findUnique({
      where: { userId_companyId: { userId: id, companyId } },
    });

    if (!relation) {
      throw new NotFoundException('User not found in this company');
    }

    await this.prisma.userCompanyRelation.update({
      where: { id: relation.id },
      data: { roleId },
    });

    await this.prisma.auditLog.create({
      data: {
        companyId,
        userId: currentUser.id,
        action: 'user:update_role',
        entityType: 'User',
        entityId: id,
        oldValue: { roleId: relation.roleId },
        newValue: { roleId },
      },
    });

    return this.findOne(id, currentUser);
  }

  async adminUpdate(id: string, dto: AdminUpdateUserDto, currentUser: any) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        companies: {
          select: { id: true, company: { select: { id: true } }, role: { select: { id: true, name: true } } },
        },
      },
    });
    if (!user || user.deletedAt) throw new NotFoundException('User not found');

    // Only company_admin or super_admin can do this
    const isFullAccess = currentUser.companies?.some(
      (c: any) => ['super_admin', 'company_admin'].includes(c.role),
    );
    if (!isFullAccess) {
      throw new ForbiddenException('Only company admin can manage users');
    }

    // Check company access
    await this.checkCompanyAccess(currentUser, user);

    // Cannot modify yourself (prevent accidental lockout)
    if (user.id === currentUser.id && (dto.isActive === false || dto.roleId || dto.password)) {
      throw new BadRequestException('Cannot deactivate or change role of your own account');
    }

    const updateData: any = {};
    if (dto.firstName) updateData.firstName = dto.firstName;
    if (dto.lastName) updateData.lastName = dto.lastName;
    if (dto.phone !== undefined) updateData.phone = dto.phone;

    if (dto.email) {
      const normalizedEmail = dto.email.toLowerCase().trim();
      // Check username not taken by another user.
      const existing = await this.prisma.user.findUnique({ where: { email: normalizedEmail } });
      if (existing && existing.id !== id) {
        throw new ConflictException('Username already in use by another user');
      }
      updateData.email = normalizedEmail;
    }

    if (dto.password) {
      updateData.passwordHash = await bcrypt.hash(dto.password, 12);
    }

    if (dto.isActive !== undefined) {
      updateData.isActive = dto.isActive;
    }

    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(updateData).length > 0) {
        await tx.user.update({ where: { id }, data: updateData });
      }

      // Update role if requested
      if (dto.roleId) {
        const companyId = currentUser.companies[0]?.id;
        if (companyId) {
          const relation = await tx.userCompanyRelation.findUnique({
            where: { userId_companyId: { userId: id, companyId } },
          });
          if (relation) {
            await tx.userCompanyRelation.update({
              where: { id: relation.id },
              data: { roleId: dto.roleId },
            });
          }
        }
      }

      await tx.auditLog.create({
        data: {
          companyId: currentUser.companies[0]?.id,
          userId: currentUser.id,
          action: 'user:admin_update',
          entityType: 'User',
          entityId: id,
          newValue: {
            email: dto.email || user.email,
            firstName: dto.firstName || user.firstName,
            lastName: dto.lastName || user.lastName,
            roleId: dto.roleId || undefined,
            isActive: dto.isActive,
          },
        },
      });
    });

    return this.findOne(id, currentUser);
  }

  async remove(id: string, currentUser: any) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        companies: {
          select: {
            company: { select: { id: true } },
          },
        },
      },
    });
    if (!user || user.deletedAt) throw new NotFoundException('User not found');

    await this.checkCompanyAccess(currentUser, user);

    await this.prisma.user.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });

    await this.prisma.auditLog.create({
      data: {
        userId: currentUser.id,
        action: 'user:delete',
        entityType: 'User',
        entityId: id,
      },
    });

    return { message: 'User deleted successfully' };
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt) throw new NotFoundException('User not found');

    const isMatch = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!isMatch) {
      throw new BadRequestException('Current password is incorrect');
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, 12);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });

    return { message: 'Password changed successfully' };
  }

  async getMyPreferences(currentUser: any) {
    const companyId = currentUser.companies?.[0]?.id;
    if (!companyId) return { aiPreference: '' };

    const setting = await this.prisma.systemSetting.findUnique({
      where: {
        companyId_key: {
          companyId,
          key: this.preferenceKey(currentUser.id),
        },
      },
    });

    return { aiPreference: setting?.value || '' };
  }

  async updateMyPreferences(currentUser: any, aiPreference: string) {
    const companyId = currentUser.companies?.[0]?.id;
    if (!companyId) throw new BadRequestException('No company context');

    const value = (aiPreference || '').slice(0, 8000);
    await this.prisma.systemSetting.upsert({
      where: {
        companyId_key: {
          companyId,
          key: this.preferenceKey(currentUser.id),
        },
      },
      create: {
        companyId,
        key: this.preferenceKey(currentUser.id),
        value,
        group: 'user_ai_preference',
        description: 'Current user personal AI preference for prospecting and outreach writing',
        updatedBy: currentUser.id,
      },
      update: {
        value,
        updatedBy: currentUser.id,
      },
    });

    return { aiPreference: value };
  }

  async getAvailableRoles() {
    const roles = await this.prisma.role.findMany({
      select: { id: true, name: true, displayName: true, description: true, isSystem: true },
    });
    return {
      data: roles.map((r) => ({
        ...r,
        label: r.displayName, // Frontend uses 'label' field
      })),
    };
  }

  private async checkCompanyAccess(currentUser: any, targetUser: any) {
    const isSuperAdmin = currentUser.companies.some(
      (c: any) => c.role === 'super_admin',
    );
    if (isSuperAdmin) return;

    const currentCompanyIds = currentUser.companies.map((c: any) => c.id);
    const targetCompanyIds =
      targetUser.companies?.map((c: any) => c.company?.id || c.companyId) || [];

    const hasOverlap = currentCompanyIds.some((id: string) =>
      targetCompanyIds.includes(id),
    );
    if (!hasOverlap) {
      throw new ForbiddenException('Cannot access user from another company');
    }
  }

  private async checkCompanyAdminAccess(currentUser: any, companyId: string) {
    const isFullAccess = currentUser.companies.some(
      (c: any) => ['super_admin', 'company_admin'].includes(c.role),
    );
    if (isFullAccess) return;

    // Check if user belongs to this company at all
    const company = currentUser.companies.find((c: any) => c.id === companyId);
    if (!company) {
      throw new ForbiddenException('Not a member of this company');
    }

    throw new ForbiddenException('Only super_admin or company_admin can manage users');
  }

  private preferenceKey(userId: string) {
    return `user.aiPreference.${userId}`;
  }
}
