import { Injectable, UnauthorizedException } from '@nestjs/common';
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
          where: { isActive: true },
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

    const requestedCompanyId =
      (req?.headers?.['x-company-id'] as string | undefined) ||
      (req?.headers?.['X-Company-Id'] as string | undefined);
    const selectedIndex = requestedCompanyId
      ? companies.findIndex((company) => company.id === requestedCompanyId)
      : -1;
    const orderedCompanies =
      selectedIndex > 0
        ? [companies[selectedIndex], ...companies.filter((_, index) => index !== selectedIndex)]
        : companies;

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      companies: orderedCompanies,
    };
  }
}
