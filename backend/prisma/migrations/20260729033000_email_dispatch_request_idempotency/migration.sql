CREATE TABLE "EmailDispatchRequest" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "operatorUserId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payloadDigest" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailDispatchRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailDispatchRequest_companyId_idempotencyKey_key"
ON "EmailDispatchRequest"("companyId", "idempotencyKey");

CREATE INDEX "EmailDispatchRequest_companyId_operatorUserId_status_createdAt_idx"
ON "EmailDispatchRequest"("companyId", "operatorUserId", "status", "createdAt");

ALTER TABLE "EmailDispatchRequest"
ADD CONSTRAINT "EmailDispatchRequest_companyId_fkey"
FOREIGN KEY ("companyId") REFERENCES "Company"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EmailDispatchRequest"
ADD CONSTRAINT "EmailDispatchRequest_operatorUserId_fkey"
FOREIGN KEY ("operatorUserId") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
