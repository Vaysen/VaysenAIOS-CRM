-- R111 批次A：邮箱账户分级（accountRole + tags）
-- 现有账号默认 CORE（核心商务），营销账号由后续人工/UI 标注为 MARKETING。

-- CreateEnum
CREATE TYPE "AccountRole" AS ENUM ('CORE', 'MARKETING', 'SUPPORT');

-- AlterTable
ALTER TABLE "EmailAccount" ADD COLUMN "accountRole" "AccountRole" NOT NULL DEFAULT 'CORE';

-- AlterTable
ALTER TABLE "EmailAccount" ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
