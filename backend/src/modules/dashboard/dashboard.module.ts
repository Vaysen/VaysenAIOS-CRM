import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { PrismaService } from '../../common/prisma/prisma.service';

@Module({ controllers: [DashboardController], providers: [DashboardService, PrismaService], exports: [DashboardService] })
export class DashboardModule {}
