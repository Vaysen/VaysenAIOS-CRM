import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(private prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || (() => { throw new Error('JWT_SECRET environment variable is required'); })(),
      passReqToCallback: true,
    });
  }

  async validate(req: any, payload: { sub: string; email: string }) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: {
        companies: {
          where: { isActive: true, company: { isActive: true } },
          include: { company: true, role: true },
        },
      },
    });

    if (!user || !user.isActive || user.deletedAt) {
      throw new UnauthorizedException('User not found or inactive');
    }

    const companies = user.companies.map((r) => ({
      id: r.company.id,
      name: r.company.name,
      role: r.role.name,
      roleId: r.role.id,
      isDefault: r.isDefault,
    }));

    const requestedCompanyId = String(
      req?.headers?.['x-company-id'] || '',
    ).trim() || null;
    const isSuperAdmin = companies.some(
      (company) => company.role === 'super_admin',
    );
    const superAdminRoleId = companies.find(
      (company) => company.role === 'super_admin',
    )?.roleId;

    const defaultCompanies = companies.filter((company) => company.isDefault);
    let activeCompany = requestedCompanyId
      ? companies.find((company) => company.id === requestedCompanyId) || null
      : defaultCompanies.length === 1
        ? defaultCompanies[0]
        : null;

    if (requestedCompanyId && activeCompany && isSuperAdmin) {
      activeCompany = {
        ...activeCompany,
        role: 'super_admin',
        roleId: superAdminRoleId!,
      };
    }

    if (requestedCompanyId && !activeCompany) {
      if (!isSuperAdmin) {
        throw new ForbiddenException('No access to requested company');
      }
      const targetCompany = await this.prisma.company.findFirst({
        where: { id: requestedCompanyId, isActive: true },
        select: { id: true, name: true },
      });
      if (!targetCompany) {
        throw new ForbiddenException('Requested company is unavailable');
      }
      activeCompany = {
        ...targetCompany,
        role: 'super_admin',
        roleId: superAdminRoleId!,
        isDefault: false,
      };
    }

    if (!activeCompany && companies.length === 1) {
      activeCompany = companies[0];
    }

    if (!activeCompany) {
      throw new ForbiddenException(
        'Active company is ambiguous; select one with X-Company-Id',
      );
    }

    if (
      activeCompany
      && !isSuperAdmin
      && !companies.some((company) => company.id === activeCompany!.id)
    ) {
      throw new ForbiddenException('No access to active company');
    }

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      companies,
      activeCompanyId: activeCompany?.id || null,
      activeCompany,
    };
  }
}
