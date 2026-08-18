-- Existing refresh-token plaintext cannot be migrated safely. Revoke it by
-- replacing the old column with one-way token metadata; all users must log in
-- once after this migration.
ALTER TABLE "RefreshToken"
  ADD COLUMN "tokenHash" TEXT,
  ADD COLUMN "familyId" TEXT,
  ADD COLUMN "consumedAt" TIMESTAMP(3),
  ADD COLUMN "revokedAt" TIMESTAMP(3),
  ADD COLUMN "replacedById" TEXT;

UPDATE "RefreshToken"
SET
  "tokenHash" = 'legacy-revoked:' || "id",
  "familyId" = 'legacy-revoked:' || "id",
  "revokedAt" = CURRENT_TIMESTAMP;

ALTER TABLE "RefreshToken"
  ALTER COLUMN "tokenHash" SET NOT NULL,
  ALTER COLUMN "familyId" SET NOT NULL,
  DROP COLUMN "token",
  DROP COLUMN "isRevoked";

CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");
CREATE INDEX "RefreshToken_familyId_revokedAt_idx" ON "RefreshToken"("familyId", "revokedAt");
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");

CREATE TABLE "DeploymentInitialization" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "initializedByUserId" TEXT NOT NULL,
  "initializedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeploymentInitialization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PublicRequestNonce" (
  "id" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "nonce" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PublicRequestNonce_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PublicRequestNonce_sourceKey_nonce_key"
  ON "PublicRequestNonce"("sourceKey", "nonce");
CREATE INDEX "PublicRequestNonce_expiresAt_idx"
  ON "PublicRequestNonce"("expiresAt");
