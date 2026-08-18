import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { AddCompanyUserDto } from './dto/add-company-user.dto';
import {
  hasFullAccess,
  requireActiveCompany,
} from '../../common/utils/data-isolation';

@Injectable()
export class CompaniesService {
  constructor(private prisma: PrismaService) {}

  async findAll(currentUser: any) {
    const isSuperAdmin = currentUser.companies.some(
      (c: any) => c.role === 'super_admin',
    );

    if (isSuperAdmin) {
      const companies = await this.prisma.company.findMany({
        include: {
          _count: { select: { users: true, leads: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
      return { data: companies };
    }

    const companyIds = currentUser.companies.map((c: any) => c.id);
    const companies = await this.prisma.company.findMany({
      where: { id: { in: companyIds } },
      include: {
        _count: { select: { users: true, leads: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return { data: companies };
  }

  async findOne(id: string, currentUser: any) {
    await this.ensureCompanyAccess(currentUser, id);
    const company = await this.prisma.company.findUnique({
      where: { id },
      include: {
        _count: { select: { users: true, leads: true } },
      },
    });

    if (!company) throw new NotFoundException('Company not found');

    return company;
  }

  async create(dto: CreateCompanyDto, currentUser: any) {
    if (!this.isGlobalSuperAdmin(currentUser)) {
      throw new ForbiddenException(
        'Only a super administrator can create companies',
      );
    }

    const slug = dto.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      + '-' + Date.now().toString(36);

    const company = await this.prisma.company.create({
      data: { ...dto, slug },
    });

    const role = await this.prisma.role.findUnique({
      where: { name: 'company_admin' },
    });

    if (role) {
      await this.prisma.userCompanyRelation.create({
        data: {
          userId: currentUser.id,
          companyId: company.id,
          roleId: role.id,
        },
      });
    }

    await this.prisma.auditLog.create({
      data: {
        companyId: company.id,
        userId: currentUser.id,
        action: 'company:create',
        entityType: 'Company',
        entityId: company.id,
        newValue: { name: dto.name },
      },
    });

    return company;
  }

  async update(id: string, dto: UpdateCompanyDto, currentUser: any) {
    await this.ensureCompanyAdminAccess(currentUser, id);
    const company = await this.prisma.company.findUnique({ where: { id } });
    if (!company) throw new NotFoundException('Company not found');
    if (dto.isActive === false && !this.isGlobalSuperAdmin(currentUser)) {
      throw new ForbiddenException(
        'Only a super administrator can deactivate a company',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      if (dto.isActive === false) {
        await this.assertCompanyDeactivationKeepsGlobalSuperAdmin(id, tx);
      }
      const updated = await tx.company.update({
        where: { id },
        data: dto,
      });
      await tx.auditLog.create({
        data: {
          companyId: id,
          userId: currentUser.id,
          action: 'company:update',
          entityType: 'Company',
          entityId: id,
          oldValue: { name: company.name },
          newValue: { name: dto.name || company.name },
        },
      });
      return updated;
    }, { isolationLevel: 'Serializable' });
  }

  async remove(id: string, currentUser: any) {
    const activeCompany = requireActiveCompany(currentUser);
    if (activeCompany.id !== id) {
      throw new ForbiddenException(
        'Select the target company before deleting it',
      );
    }
    if (!this.isGlobalSuperAdmin(currentUser)) {
      throw new ForbiddenException('Only super admin can delete companies');
    }

    const company = await this.prisma.company.findUnique({ where: { id } });
    if (!company) throw new NotFoundException('Company not found');

    await this.prisma.$transaction(async (tx) => {
      await this.assertCompanyDeactivationKeepsGlobalSuperAdmin(id, tx);
      await tx.company.update({
        where: { id },
        data: { isActive: false },
      });
      await tx.auditLog.create({
        data: {
          companyId: id,
          userId: currentUser.id,
          action: 'company:delete',
          entityType: 'Company',
          entityId: id,
        },
      });
    }, { isolationLevel: 'Serializable' });

    return { message: 'Company deleted successfully' };
  }

  async getCompanyUsers(id: string, currentUser: any) {
    await this.ensureCompanyAccess(currentUser, id);

    const users = await this.prisma.userCompanyRelation.findMany({
      where: { companyId: id },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            isActive: true,
            lastLoginAt: true,
          },
        },
        role: { select: { id: true, name: true, displayName: true } },
      },
    });

    return { data: users };
  }

  async addUser(id: string, dto: AddCompanyUserDto, currentUser: any) {
    await this.ensureCompanyAdminAccess(currentUser, id);

    const requestedRole = await this.prisma.role.findUnique({
      where: { id: dto.roleId },
    });
    if (!requestedRole) throw new NotFoundException('Role not found');
    const tenantRoles = ['company_admin', 'sales_manager', 'sales_user', 'viewer'];
    if (
      !this.isGlobalSuperAdmin(currentUser)
      && !tenantRoles.includes(requestedRole.name)
    ) {
      throw new ForbiddenException('Only a super administrator can grant global roles');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: dto.userId },
    });
    if (!user || user.deletedAt) throw new NotFoundException('User not found');

    const existing = await this.prisma.userCompanyRelation.findUnique({
      where: { userId_companyId: { userId: dto.userId, companyId: id } },
    });
    if (existing) throw new ConflictException('User already in this company');

    const relation = await this.prisma.userCompanyRelation.create({
      data: {
        userId: dto.userId,
        companyId: id,
        roleId: dto.roleId,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        companyId: id,
        userId: currentUser.id,
        action: 'company:add_user',
        entityType: 'Company',
        entityId: id,
        newValue: { userId: dto.userId, roleId: dto.roleId },
      },
    });

    return relation;
  }

  async removeUser(id: string, userId: string, currentUser: any) {
    await this.ensureCompanyAdminAccess(currentUser, id);
    if (userId === currentUser.id) {
      throw new BadRequestException('Cannot remove your own company membership');
    }

    return this.runSerializable(async (tx) => {
      const relation = await tx.userCompanyRelation.findUnique({
        where: { userId_companyId: { userId, companyId: id } },
        include: { role: true },
      });
      if (!relation) throw new NotFoundException('User not in this company');
      if (
        relation.role.name === 'super_admin'
        && !this.isGlobalSuperAdmin(currentUser)
      ) {
        throw new ForbiddenException('Only a super administrator can remove this membership');
      }
      if (relation.role.name === 'super_admin' && relation.isActive) {
        await this.assertActiveGlobalSuperAdmin(currentUser.id, id, tx);
        await this.assertSuperMembershipRemovalKeepsGlobalSuperAdmin(
          relation.id,
          tx,
        );
      }
      if (relation.role.name === 'company_admin' && relation.isActive) {
        const adminCount = await tx.userCompanyRelation.count({
          where: {
            companyId: id,
            isActive: true,
            role: { name: 'company_admin' },
            user: { isActive: true, deletedAt: null },
          },
        });
        if (adminCount <= 1) {
          throw new BadRequestException('Cannot remove the last active company administrator');
        }
      }

      await tx.userCompanyRelation.delete({ where: { id: relation.id } });
      await tx.auditLog.create({
        data: {
          companyId: id,
          userId: currentUser.id,
          action: 'company:remove_user',
          entityType: 'Company',
          entityId: id,
          oldValue: { userId },
        },
      });
      return { message: 'User removed from company' };
    });
  }

  private async ensureCompanyAccess(currentUser: any, companyId: string) {
    const activeCompany = requireActiveCompany(currentUser);
    if (activeCompany.id !== companyId) {
      throw new ForbiddenException('No access to this company');
    }
  }

  private async ensureCompanyAdminAccess(currentUser: any, companyId: string) {
    if (!hasFullAccess(currentUser, companyId)) {
      throw new ForbiddenException('Only company admin can manage company settings');
    }
  }

  private isGlobalSuperAdmin(currentUser: any) {
    return currentUser.activeCompany?.role === 'super_admin'
      && currentUser.activeCompany?.id === currentUser.activeCompanyId
      && currentUser.companies?.some(
        (company: any) => company.role === 'super_admin',
      ) === true;
  }

  private async assertCompanyDeactivationKeepsGlobalSuperAdmin(
    companyId: string,
    db: any,
  ) {
    const hostedSuperAdmin = await db.userCompanyRelation.findFirst({
      where: {
        companyId,
        isActive: true,
        role: { name: 'super_admin' },
        user: { isActive: true, deletedAt: null },
      },
      select: { id: true },
    });
    if (!hostedSuperAdmin) return;
    const remainingSuperAdmin = await db.userCompanyRelation.findFirst({
      where: {
        companyId: { not: companyId },
        isActive: true,
        role: { name: 'super_admin' },
        user: { isActive: true, deletedAt: null },
        company: { isActive: true },
      },
      select: { id: true },
    });
    if (!remainingSuperAdmin) {
      throw new BadRequestException(
        'Cannot deactivate the company hosting the last global super administrator',
      );
    }
  }

  private async assertActiveGlobalSuperAdmin(
    userId: string,
    companyId: string,
    db: any,
  ) {
    const actorMembership = await db.userCompanyRelation.findFirst({
      where: {
        userId,
        companyId,
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

  private async assertSuperMembershipRemovalKeepsGlobalSuperAdmin(
    relationId: string,
    db: any,
  ) {
    const remainingUsers = await db.userCompanyRelation.findMany({
      where: {
        id: { not: relationId },
        isActive: true,
        role: { name: 'super_admin' },
        user: { isActive: true, deletedAt: null },
        company: { isActive: true },
      },
      distinct: ['userId'],
      select: { userId: true },
      take: 1,
    });
    if (remainingUsers.length === 0) {
      throw new BadRequestException(
        'Cannot remove the last active global super administrator membership',
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
}
