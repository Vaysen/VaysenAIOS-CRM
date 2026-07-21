BEGIN;

-- A WhatsApp conversation is identified by the tenant, the receiving
-- WhatsAppSession and the provider thread/JID.  A nullable key keeps the
-- constraint out of unrelated email/website conversations.
ALTER TABLE "Conversation"
ADD COLUMN "threadKey" TEXT;

-- Historical deployments may already contain duplicate conversations from
-- concurrent findFirst -> create calls.  Give only one deterministic (oldest)
-- row in each historical set the canonical key.  The other rows remain
-- readable/auditable with NULL; no customer messages are destructively moved
-- or deleted by this reliability migration.
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "companyId", "channel", "whatsappSessionId", "externalThreadId"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS row_number
  FROM "Conversation"
  WHERE "channel" = 'whatsapp'
    AND "whatsappSessionId" IS NOT NULL
    AND "externalThreadId" IS NOT NULL
)
UPDATE "Conversation" AS conversation
SET "threadKey" = CONCAT(
  'whatsapp:',
  conversation."whatsappSessionId",
  ':',
  conversation."externalThreadId"
)
FROM ranked
WHERE ranked."id" = conversation."id"
  AND ranked.row_number = 1;

CREATE UNIQUE INDEX "conversation_company_channel_thread_key"
ON "Conversation"("companyId", "channel", "threadKey");

COMMIT;
