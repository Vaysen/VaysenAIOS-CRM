/**
 * audience-segments.module.ts
 *
 * R111 批次A 客群系统模块：客群 CRUD + 条件筛选 + 成员计算 + 定时自动重算。
 * 无外部适配器、无 BullMQ worker（自动刷新用模块内 setInterval，参照
 * imap-inbound / owner-notification.dispatcher 的定时器模式）。
 */
import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AudienceSegmentsController } from './audience-segments.controller';
import { AudienceSegmentsService } from './audience-segments.service';

@Module({
  controllers: [AudienceSegmentsController],
  providers: [AudienceSegmentsService, PrismaService],
  exports: [AudienceSegmentsService],
})
export class AudienceSegmentsModule {}
