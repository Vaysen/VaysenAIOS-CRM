import { Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  // R111 批次D：导出 AnalyticsService 供 daily-diagnosis 聚合输入复用
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
