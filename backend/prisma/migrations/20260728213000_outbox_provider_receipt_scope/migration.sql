-- Scope provider receipts to the concrete sender account/session. Providers
-- are only required to keep message identifiers unique within that scope.
ALTER TABLE "ExternalActionOutbox"
ADD COLUMN "providerScope" TEXT NOT NULL DEFAULT 'legacy';

-- Existing rows stay in the globally unique legacy scope. New application
-- writes use email:<accountId> or whatsapp:<sessionId>. The default keeps a
-- rolling deployment fail-closed if an old process briefly inserts a row.

DROP INDEX "ExternalActionOutbox_channel_provider_providerReceiptId_key";

CREATE UNIQUE INDEX "ExternalActionOutbox_channel_providerScope_provider_providerReceiptId_key"
ON "ExternalActionOutbox"("channel", "providerScope", "provider", "providerReceiptId");

-- Rollback:
-- 1. Before recreating the old global unique index, audit duplicate
--    (channel, provider, providerReceiptId) values across providerScope.
-- 2. DROP INDEX "ExternalActionOutbox_channel_providerScope_provider_providerReceiptId_key";
-- 3. CREATE UNIQUE INDEX "ExternalActionOutbox_channel_provider_providerReceiptId_key"
--    ON "ExternalActionOutbox"("channel", "provider", "providerReceiptId");
-- 4. ALTER TABLE "ExternalActionOutbox" DROP COLUMN "providerScope";
