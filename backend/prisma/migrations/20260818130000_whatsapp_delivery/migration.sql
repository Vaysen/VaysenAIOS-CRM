-- R111 批次C：WhatsApp 批量营销执行器
-- 1) WhatsAppSession 增加账号级风控字段（每小时/每日上限、发送间隔、最近发送时间），默认保守。
-- 2) MarketingDeliveryRun 增加进度回写字段 processedCount / totalCount
--    （scheduledFor / claimedAt / executedAt / lastError 已存在，覆盖排程/启动/完成/失败原因）。

-- AlterTable
ALTER TABLE "WhatsAppSession" ADD COLUMN "sendLimitPerHour" INTEGER NOT NULL DEFAULT 60;

-- AlterTable
ALTER TABLE "WhatsAppSession" ADD COLUMN "sendLimitDaily" INTEGER NOT NULL DEFAULT 300;

-- AlterTable
ALTER TABLE "WhatsAppSession" ADD COLUMN "sendIntervalSeconds" INTEGER NOT NULL DEFAULT 8;

-- AlterTable
ALTER TABLE "WhatsAppSession" ADD COLUMN "lastSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "MarketingDeliveryRun" ADD COLUMN "processedCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "MarketingDeliveryRun" ADD COLUMN "totalCount" INTEGER NOT NULL DEFAULT 0;
