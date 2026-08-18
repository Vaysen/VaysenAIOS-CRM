-- R111 批次D：每日 AI 运营诊断快照（dailyDiagnosis）
-- diagnosisDate 存 Asia/Shanghai 时区的工作日日期（YYYY-MM-DD，@db.Date 只存日期部分）。
-- status: COMPLETED / FAILED / GENERATING；metricsSnapshot 存生成时的输入指标，用于快照回显。

-- CreateTable
CREATE TABLE "DailyDiagnosis" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "diagnosisDate" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "healthScore" INTEGER,
    "summary" TEXT,
    "highlights" JSONB,
    "risks" JSONB,
    "recommendations" JSONB,
    "metricsSnapshot" JSONB,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyDiagnosis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DailyDiagnosis_companyId_diagnosisDate_idx" ON "DailyDiagnosis"("companyId", "diagnosisDate");

-- CreateIndex
CREATE UNIQUE INDEX "DailyDiagnosis_companyId_diagnosisDate_key" ON "DailyDiagnosis"("companyId", "diagnosisDate");
