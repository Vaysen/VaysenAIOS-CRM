import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { OpenClawModule } from '../openclaw/openclaw.module';
import { DailyDiagnosisController } from './daily-diagnosis.controller';
import { DailyDiagnosisService } from './daily-diagnosis.service';

/**
 * 每日 AI 运营诊断（dailyDiagnosis 快照）。
 * 复用 agent.getBrief、analytics（overview/sources/whatsapp-stats）作为聚合输入，
 * 经 OpenClaw 网关生成结构化 JSON 诊断并落库。
 */
@Module({
  imports: [AgentModule, AnalyticsModule, OpenClawModule],
  controllers: [DailyDiagnosisController],
  providers: [DailyDiagnosisService],
  exports: [DailyDiagnosisService],
})
export class DailyDiagnosisModule {}
