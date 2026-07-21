import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { AddCompanyUserDto } from './dto/add-company-user.dto';

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
    const company = await this.prisma.company.findUnique({
      where: { id },
      include: {
        _count: { select: { users: true, leads: true } },
      },
    });

    if (!company) throw new NotFoundException('Company not found');
    await this.ensureCompanyAccess(currentUser, id);

    return company;
  }

  async create(dto: CreateCompanyDto, currentUser: any) {
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
    const company = await this.prisma.company.findUnique({ where: { id } });
    if (!company) throw new NotFoundException('Company not found');

    await this.ensureCompanyAdminAccess(currentUser, id);

    const updated = await this.prisma.company.update({
      where: { id },
      data: dto,
    });

    await this.prisma.auditLog.create({
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
  }

  async remove(id: string, currentUser: any) {
    const isSuperAdmin = currentUser.companies.some(
      (c: any) => c.role === 'super_admin',
    );
    if (!isSuperAdmin) throw new ForbiddenException('Only super admin can delete companies');

    const company = await this.prisma.company.findUnique({ where: { id } });
    if (!company) throw new NotFoundException('Company not found');

    await this.prisma.company.update({
      where: { id },
      data: { isActive: false },
    });

    await this.prisma.auditLog.create({
      data: {
        companyId: id,
        userId: currentUser.id,
        action: 'company:delete',
        entityType: 'Company',
        entityId: id,
      },
    });

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

    const relation = await this.prisma.userCompanyRelation.findUnique({
      where: { userId_companyId: { userId, companyId: id } },
    });
    if (!relation) throw new NotFoundException('User not in this company');

    await this.prisma.userCompanyRelation.delete({
      where: { id: relation.id },
    });

    await this.prisma.auditLog.create({
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
  }

  private async ensureCompanyAccess(currentUser: any, companyId: string) {
    const isSuperAdmin = currentUser.companies.some(
      (c: any) => c.role === 'super_admin',
    );
    if (isSuperAdmin) return;

    const hasAccess = currentUser.companies.some((c: any) => c.id === companyId);
    if (!hasAccess) {
      throw new ForbiddenException('No access to this company');
    }
  }

  private async ensureCompanyAdminAccess(currentUser: any, companyId: string) {
    const isSuperAdmin = currentUser.companies.some(
      (c: any) => c.role === 'super_admin',
    );
    if (isSuperAdmin) return;

    const company = currentUser.companies.find(
      (c: any) =>
        c.id === companyId &&
        (c.role === 'company_admin' || c.role === 'sales_manager'),
    );
    if (!company) {
      throw new ForbiddenException('Only company admin can manage company settings');
    }
  }
}
