-- R111 批次B：Foxmail 式邮件中心 — CommunicationMessage 批量操作字段
-- isArchived / isStarred / deletedAt（软删除），收件箱查询默认过滤 isArchived=false / deletedAt=null。
-- companyId 位于 Conversation 表，故等价索引落在消息自身列（direction+isArchived、isStarred）上。

-- AlterTable
ALTER TABLE "CommunicationMessage" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "CommunicationMessage" ADD COLUMN "isStarred" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "CommunicationMessage" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "CommunicationMessage_direction_isArchived_idx" ON "CommunicationMessage"("direction", "isArchived");

-- CreateIndex
CREATE INDEX "CommunicationMessage_isStarred_idx" ON "CommunicationMessage"("isStarred");
