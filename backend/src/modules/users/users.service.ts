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
import {
  hasFullAccess,
  requireActiveCompany,
} from '../../common/utils/data-isolation';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findAll(currentUser: any, query: { page?: number; limit?: number }) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const activeCompany = requireActiveCompany(currentUser);

    const where: any = {
      deletedAt: null,
      companies: {
        some: { companyId: activeCompany.id, isActive: true },
      },
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
            where: { companyId: activeCompany.id, isActive: true },
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
    const activeCompany = requireActiveCompany(currentUser);
    const globalAdmin = this.isGlobalSuperAdmin(currentUser);
    const user = await this.prisma.user.findUnique({
      where: globalAdmin
        ? { id, deletedAt: null }
        : {
            id,
            deletedAt: null,
            companies: {
              some: {
                companyId: activeCompany.id,
                isActive: true,
                company: { isActive: true },
              },
            },
          },
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
          where: { companyId: activeCompany.id, isActive: true },
          select: {
            isDefault: true,
            company: { select: { id: true, name: true, slug: true } },
            role: { select: { id: true, name: true, displayName: true } },
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  async create(dto: CreateUserDto, currentUser: any) {
    requireActiveCompany(currentUser);
    await this.checkCompanyAdminAccess(currentUser, dto.companyId);

    // The existing unique email column is used as the login username.
    const normalizedEmail = dto.email.toLowerCase().trim();

    const existing = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existing) {
      throw new ConflictException('Username already registered');
    }

    const role = await this.prisma.role.findUnique({
      where: { id: dto.roleId },
    });
    if (!role) throw new NotFoundException('Role not found');
    this.assertRoleAssignmentAllowed(currentUser, role.name);

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
    if (id !== currentUser.id) {
      throw new ForbiddenException('Users may only update their own profile');
    }
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
    const activeCompany = requireActiveCompany(currentUser);
    if (id === currentUser.id) {
      throw new BadRequestException('Cannot change your own account status');
    }
    await this.checkCompanyAdminAccess(currentUser, activeCompany.id);
    const globalAdmin = this.isGlobalSuperAdmin(currentUser);
    const userQuery = {
      where: globalAdmin
        ? { id }
        : {
            id,
            deletedAt: null,
            companies: {
              some: { companyId: activeCompany.id, isActive: true },
            },
          },
      include: {
        companies: {
          select: {
            company: { select: { id: true } },
          },
        },
      },
    };
    const user = await this.prisma.user.findUnique(userQuery);
    if (!user || user.deletedAt) throw new NotFoundException('User not found');

    await this.checkCompanyAccess(currentUser, user);

    if (this.isGlobalSuperAdmin(currentUser)) {
      await this.runSerializable(async (tx) => {
        await this.assertActiveGlobalSuperAdmin(
          currentUser.id,
          activeCompany.id,
          tx,
        );
        if (!isActive) {
          await this.assertGlobalAccountMutationKeepsCompanyAdmins(id, tx);
        }
        await tx.user.update({
          where: { id },
          data: { isActive },
        });
        await tx.auditLog.create({
          data: {
            userId: currentUser.id,
            action: isActive ? 'user:enable' : 'user:disable',
            entityType: 'User',
            entityId: id,
            newValue: { isActive },
            companyId: activeCompany.id,
          },
        });
      });
    } else {
      await this.runSerializable(async (tx) => {
        const relation = await tx.userCompanyRelation.findUnique({
          where: {
            userId_companyId: {
              userId: id,
              companyId: activeCompany.id,
            },
          },
          include: { role: true },
        });
        if (!relation) {
          throw new NotFoundException('User not found in active company');
        }
        if (relation.role.name === 'super_admin') {
          throw new ForbiddenException(
            'Only a super administrator can manage this account',
          );
        }
        if (!isActive) {
          await this.assertNotLastCompanyAdmin(id, activeCompany.id, tx);
        }
        await tx.userCompanyRelation.update({
          where: { id: relation.id },
          data: { isActive },
        });
        await tx.auditLog.create({
          data: {
            userId: currentUser.id,
            action: isActive ? 'user:enable' : 'user:disable',
            entityType: 'User',
            entityId: id,
            newValue: { isActive },
            companyId: activeCompany.id,
          },
        });
      });
    }

    if (!this.isGlobalSuperAdmin(currentUser)) {
      return {
        message: isActive
          ? 'User enabled in active company'
          : 'User disabled in active company',
        userId: id,
        companyId: activeCompany.id,
        isActive,
      };
    }
    return this.findOne(id, currentUser);
  }

  async updateRole(id: string, roleId: string, companyId: string, currentUser: any) {
    requireActiveCompany(currentUser);
    await this.checkCompanyAdminAccess(currentUser, companyId);
    const globalAdmin = this.isGlobalSuperAdmin(currentUser);
    const user = globalAdmin
      ? await this.prisma.user.findUnique({ where: { id } })
      : await this.prisma.user.findUnique({
          where: {
            id,
            deletedAt: null,
            companies: { some: { companyId, isActive: true } },
          },
        });
    if (!user || user.deletedAt) throw new NotFoundException('User not found');

    await this.runSerializable(async (tx) => {
      if (globalAdmin) {
        await this.assertActiveGlobalSuperAdmin(
          currentUser.id,
          requireActiveCompany(currentUser).id,
          tx,
        );
      }
      const relation = await tx.userCompanyRelation.findUnique({
        where: { userId_companyId: { userId: id, companyId } },
        include: { role: true },
      });
      if (!relation) {
        throw new NotFoundException('User not found in this company');
      }
      const role = await tx.role.findUnique({ where: { id: roleId } });
      if (!role) throw new NotFoundException('Role not found');
      this.assertRoleAssignmentAllowed(currentUser, role.name);
      if (
        relation.role.name === 'company_admin'
        && role.name !== 'company_admin'
      ) {
        await this.assertNotLastCompanyAdmin(id, companyId, tx);
      }
      if (
        relation.role.name === 'super_admin'
        && role.name !== 'super_admin'
      ) {
        await this.assertNotLastGlobalSuperAdmin(id, companyId, tx);
      }
      if (
        relation.role.name === 'super_admin'
        && !this.isGlobalSuperAdmin(currentUser)
      ) {
        throw new ForbiddenException(
          'Only a super administrator can change this role',
        );
      }

      await tx.userCompanyRelation.update({
        where: { id: relation.id },
        data: { roleId },
      });
      await tx.auditLog.create({
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
    });

    return this.findOne(id, currentUser);
  }

  async adminUpdate(id: string, dto: AdminUpdateUserDto, currentUser: any) {
    const activeCompany = requireActiveCompany(currentUser);
    const isFullAccess = hasFullAccess(currentUser, activeCompany.id);
    if (!isFullAccess) {
      throw new ForbiddenException('Only company admin can manage users');
    }
    const globalAdmin = this.isGlobalSuperAdmin(currentUser);
    const userQuery = {
      where: globalAdmin
        ? { id }
        : {
            id,
            deletedAt: null,
            companies: {
              some: { companyId: activeCompany.id, isActive: true },
            },
          },
      include: {
        companies: {
          select: { id: true, company: { select: { id: true } }, role: { select: { id: true, name: true } } },
        },
      },
    };
    const user = await this.prisma.user.findUnique(userQuery);
    if (!user || user.deletedAt) throw new NotFoundException('User not found');

    // Check company access
    await this.checkCompanyAccess(currentUser, user);

    const targetRelation = user.companies.find(
      (relation: any) => relation.company.id === activeCompany.id,
    );
    if (!targetRelation) throw new NotFoundException('User not found in active company');
    if (
      targetRelation.role.name === 'super_admin'
      && !this.isGlobalSuperAdmin(currentUser)
    ) {
      throw new ForbiddenException('Only a super administrator can manage this account');
    }
    if (!this.isGlobalSuperAdmin(currentUser)) {
      const globalFieldsRequested = !!(
        dto.email
        || dto.password
        || dto.firstName
        || dto.lastName
        || dto.phone !== undefined
        || dto.isActive !== undefined
      );
      if (globalFieldsRequested) {
        throw new ForbiddenException(
          'Company administrators may only change the active-company role; global account fields are super-admin only',
        );
      }
    }

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

    await this.runSerializable(async (tx) => {
      if (globalAdmin) {
        await this.assertActiveGlobalSuperAdmin(
          currentUser.id,
          activeCompany.id,
          tx,
        );
      }
      if (dto.isActive === false) {
        await this.assertGlobalAccountMutationKeepsCompanyAdmins(id, tx);
      }
      if (Object.keys(updateData).length > 0) {
        await tx.user.update({ where: { id }, data: updateData });
      }
      if (dto.password || dto.isActive === false) {
        await tx.refreshToken.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }

      // Update role if requested
      if (dto.roleId) {
        const companyId = activeCompany.id;
        const requestedRole = await tx.role.findUnique({
          where: { id: dto.roleId },
        });
        if (!requestedRole) throw new NotFoundException('Role not found');
        this.assertRoleAssignmentAllowed(currentUser, requestedRole.name);
        if (companyId) {
          const relation = await tx.userCompanyRelation.findUnique({
            where: { userId_companyId: { userId: id, companyId } },
            include: { role: true },
          });
          if (relation) {
            if (
              relation.role.name === 'company_admin'
              && requestedRole.name !== 'company_admin'
            ) {
              await this.assertNotLastCompanyAdmin(id, companyId, tx);
            }
            if (
              relation.role.name === 'super_admin'
              && requestedRole.name !== 'super_admin'
            ) {
              await this.assertNotLastGlobalSuperAdmin(id, companyId, tx);
            }
            await tx.userCompanyRelation.update({
              where: { id: relation.id },
              data: { roleId: dto.roleId },
            });
          }
        }
      }

      await tx.auditLog.create({
        data: {
          companyId: activeCompany.id,
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
    const activeCompany = requireActiveCompany(currentUser);
    if (id === currentUser.id) {
      throw new BadRequestException('Cannot remove your own account');
    }
    await this.checkCompanyAdminAccess(currentUser, activeCompany.id);
    const isGlobalSuperAdmin = this.isGlobalSuperAdmin(currentUser);
    const userQuery = {
      where: isGlobalSuperAdmin
        ? { id }
        : {
            id,
            deletedAt: null,
            companies: {
              some: { companyId: activeCompany.id, isActive: true },
            },
          },
      include: {
        companies: {
          select: {
            company: { select: { id: true } },
          },
        },
      },
    };
    const user = await this.prisma.user.findUnique(userQuery);
    if (!user || user.deletedAt) throw new NotFoundException('User not found');

    await this.checkCompanyAccess(currentUser, user);

    if (isGlobalSuperAdmin) {
      await this.runSerializable(async (tx) => {
        await this.assertActiveGlobalSuperAdmin(
          currentUser.id,
          activeCompany.id,
          tx,
        );
        await this.assertGlobalAccountMutationKeepsCompanyAdmins(id, tx);
        await tx.user.update({
          where: { id },
          data: { deletedAt: new Date(), isActive: false },
        });
        await tx.refreshToken.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await tx.auditLog.create({
          data: {
            userId: currentUser.id,
            companyId: activeCompany.id,
            action: 'user:delete',
            entityType: 'User',
            entityId: id,
          },
        });
      });
    } else {
      await this.runSerializable(async (tx) => {
        const relation = await tx.userCompanyRelation.findUnique({
          where: {
            userId_companyId: {
              userId: id,
              companyId: activeCompany.id,
            },
          },
          include: { role: true },
        });
        if (!relation) {
          throw new NotFoundException('User not found in active company');
        }
        if (relation.role.name === 'super_admin') {
          throw new ForbiddenException(
            'Only a super administrator can manage this account',
          );
        }
        await this.assertNotLastCompanyAdmin(id, activeCompany.id, tx);
        await tx.userCompanyRelation.update({
          where: { id: relation.id },
          data: { isActive: false },
        });
        await tx.auditLog.create({
          data: {
            userId: currentUser.id,
            companyId: activeCompany.id,
            action: 'user:delete',
            entityType: 'User',
            entityId: id,
          },
        });
      });
    }

    return {
      message: isGlobalSuperAdmin
        ? 'User deleted successfully'
        : 'User removed from active company',
    };
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt) throw new NotFoundException('User not found');

    const isMatch = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!isMatch) {
      throw new BadRequestException('Current password is incorrect');
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, 12);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash },
      });
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    return { message: 'Password changed successfully' };
  }

  async getMyPreferences(currentUser: any) {
    const companyId = requireActiveCompany(currentUser).id;

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
    const companyId = requireActiveCompany(currentUser).id;

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
    const activeCompany = requireActiveCompany(currentUser);
    const targetCompanyIds =
      targetUser.companies?.map((c: any) => c.company?.id || c.companyId) || [];

    if (!targetCompanyIds.includes(activeCompany.id)) {
      throw new ForbiddenException('Cannot access user from another company');
    }
  }

  private async checkCompanyAdminAccess(currentUser: any, companyId: string) {
    if (hasFullAccess(currentUser, companyId)) return;
    throw new ForbiddenException(
      'Only super_admin or this company administrator can manage users',
    );
  }

  private isGlobalSuperAdmin(currentUser: any) {
    return currentUser.activeCompany?.role === 'super_admin'
      && currentUser.activeCompany?.id === currentUser.activeCompanyId
      && currentUser.companies?.some(
        (company: any) => company.role === 'super_admin',
      ) === true;
  }

  private assertRoleAssignmentAllowed(currentUser: any, roleName: string) {
    if (this.isGlobalSuperAdmin(currentUser)) return;
    const tenantRoles = [
      'company_admin',
      'sales_manager',
      'sales_user',
      'viewer',
    ];
    if (!tenantRoles.includes(roleName)) {
      throw new ForbiddenException(
        'Only a super administrator can grant or revoke global roles',
      );
    }
  }

  private async assertNotLastCompanyAdmin(
    userId: string,
    companyId: string,
    db: any = this.prisma,
  ) {
    const relation = await db.userCompanyRelation.findUnique({
      where: { userId_companyId: { userId, companyId } },
      include: { role: true },
    });
    if (relation?.role.name !== 'company_admin' || !relation.isActive) return;
    const adminCount = await db.userCompanyRelation.count({
      where: {
        companyId,
        isActive: true,
        role: { name: 'company_admin' },
        user: { isActive: true, deletedAt: null },
      },
    });
    if (adminCount <= 1) {
      throw new BadRequestException(
        'Cannot remove or demote the last active company administrator',
      );
    }
  }

  private async assertGlobalAccountMutationKeepsCompanyAdmins(
    userId: string,
    db: any,
  ) {
    const affectedMemberships = await db.userCompanyRelation.findMany({
      where: {
        userId,
        isActive: true,
        role: { name: 'company_admin' },
      },
      select: { companyId: true },
    });
    const companyIds: string[] = [
      ...new Set<string>(
        (affectedMemberships as Array<{ companyId: string }>).map(
          (membership: { companyId: string }) => membership.companyId,
        ),
      ),
    ];
    for (const companyId of companyIds) {
      await this.assertNotLastCompanyAdmin(userId, companyId, db);
    }
    await this.assertGlobalAccountMutationKeepsSuperAdmins(userId, db);
  }

  private async assertActiveGlobalSuperAdmin(
    userId: string,
    activeCompanyId: string,
    db: any,
  ) {
    const actorMembership = await db.userCompanyRelation.findFirst({
      where: {
        userId,
        companyId: activeCompanyId,
        isActive: true,
        role: { name: 'super_admin' },
        user: { isActive: true, deletedAt: null },
        company: { isActive: true },
      },
      select: { id: true },
    });
    if (!actorMembership) {
      throw new ForbiddenException(
        'Active global super administrator access is required',
      );
    }
  }

  private async assertGlobalAccountMutationKeepsSuperAdmins(
    userId: string,
    db: any,
  ) {
    const superMembership = await db.userCompanyRelation.findFirst({
      where: {
        userId,
        isActive: true,
        role: { name: 'super_admin' },
        company: { isActive: true },
      },
      select: { id: true },
    });
    if (!superMembership) return;
    const otherSuperAdmin = await db.userCompanyRelation.findFirst({
      where: {
        userId: { not: userId },
        isActive: true,
        role: { name: 'super_admin' },
        user: { isActive: true, deletedAt: null },
        company: { isActive: true },
      },
      select: { userId: true },
    });
    if (!otherSuperAdmin) {
      throw new BadRequestException(
        'Cannot disable or delete the last active global super administrator',
      );
    }
  }

  private async assertNotLastGlobalSuperAdmin(
    userId: string,
    companyId: string,
    db: any,
  ) {
    const relation = await db.userCompanyRelation.findUnique({
      where: { userId_companyId: { userId, companyId } },
      include: { role: true },
    });
    if (relation?.role.name !== 'super_admin' || !relation.isActive) return;
    const remainingSuperMembership = await db.userCompanyRelation.findFirst({
      where: {
        id: { not: relation.id },
        isActive: true,
        role: { name: 'super_admin' },
        user: { isActive: true, deletedAt: null },
        company: { isActive: true },
      },
      select: { id: true },
    });
    if (!remainingSuperMembership) {
      throw new BadRequestException(
        'Cannot demote the last active global super administrator',
      );
    }
  }

  private async runSerializable<T>(callback: (tx: any) => Promise<T>) {
    try {
      return await this.prisma.$transaction(callback, {
        isolationLevel: 'Serializable',
      });
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2034') {
        throw new ConflictException(
          'Concurrent administrator change detected; reload and retry',
        );
      }
      throw error;
    }
  }

  private preferenceKey(userId: string) {
    return `user.aiPreference.${userId}`;
  }
}
