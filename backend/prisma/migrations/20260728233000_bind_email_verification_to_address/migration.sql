-- Security V1: bind verification evidence to the normalized recipient address.
-- Existing verified rows intentionally remain NULL and therefore fail closed
-- until the address is reverified by a trusted verifier.
-- Rollback (only after stopping outbound writers):
--   ALTER TABLE "Lead" DROP COLUMN "emailVerifiedAddressHash";
-- Rolling back removes the address binding and must be paired with code that
-- still fails closed rather than trusting the legacy lead-level status alone.
ALTER TABLE "Lead"
ADD COLUMN "emailVerifiedAddressHash" TEXT;
