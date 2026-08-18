-- CRM-04: tenant-scoped evidence-first CustomerFact runtime.
-- Proposals are the only pending state. Facts become confirmed only through
-- an explicit human command; evidence rows are immutable observations.

CREATE TYPE "FactEvidenceKind" AS ENUM ('SOURCE_EXCERPT', 'MANUAL_ATTESTATION');
CREATE TYPE "FactEvidenceRelation" AS ENUM ('SUPPORTS', 'CONTRADICTS');
CREATE TYPE "CustomerFactProposalStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'REJECTED', 'EXPIRED');
CREATE TYPE "CustomerFactStatus" AS ENUM ('CONFIRMED', 'CONFLICT', 'EXPIRED', 'SUPERSEDED', 'INVALIDATED');
CREATE TYPE "FactCommandReceiptKind" AS ENUM ('PROPOSAL_CREATED', 'PROPOSAL_ACCEPTED', 'PROPOSAL_REJECTED');

CREATE TABLE "FactSource" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "canonicalUri" TEXT,
  "title" TEXT,
  "publisher" TEXT,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "retrievedAt" TIMESTAMP(3) NOT NULL,
  "contentHash" TEXT,
  "trustLevel" TEXT,
  "attestedById" TEXT,
  "attestedAt" TIMESTAMP(3),
  "attestationReasonHash" TEXT,
  "inputDigest" TEXT,
  "metadata" JSONB,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FactSource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FactEvidence" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "evidenceKind" "FactEvidenceKind" NOT NULL,
  "excerpt" TEXT NOT NULL,
  "excerptHash" TEXT NOT NULL,
  "locator" TEXT NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL,
  "publishedAt" TIMESTAMP(3),
  "evidenceConfidence" INTEGER NOT NULL DEFAULT 50,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FactEvidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FactEvidence_confidence_check" CHECK ("evidenceConfidence" BETWEEN 0 AND 100)
);

CREATE TABLE "CustomerFactProposal" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "leadId" TEXT NOT NULL,
  "factKey" TEXT NOT NULL,
  "valueType" TEXT NOT NULL,
  "valueJson" JSONB NOT NULL,
  "status" "CustomerFactProposalStatus" NOT NULL DEFAULT 'PROPOSED',
  "origin" TEXT NOT NULL,
  "confidenceScore" INTEGER NOT NULL DEFAULT 50,
  "generatedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "reviewReasonHash" TEXT,
  "baseFactId" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerFactProposal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomerFactProposal_confidence_check" CHECK ("confidenceScore" BETWEEN 0 AND 100),
  CONSTRAINT "CustomerFactProposal_version_check" CHECK ("version" > 0)
);

CREATE TABLE "CustomerFact" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "leadId" TEXT NOT NULL,
  "factKey" TEXT NOT NULL,
  "valueType" TEXT NOT NULL,
  "valueJson" JSONB NOT NULL,
  "status" "CustomerFactStatus" NOT NULL,
  "origin" TEXT NOT NULL,
  "confidenceScore" INTEGER NOT NULL DEFAULT 50,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "validFrom" TIMESTAMP(3),
  "validUntil" TIMESTAMP(3),
  "staleAt" TIMESTAMP(3),
  "conflictGroupKey" TEXT,
  "confirmedById" TEXT,
  "confirmedAt" TIMESTAMP(3),
  "supersedesFactId" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerFact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomerFact_confidence_check" CHECK ("confidenceScore" BETWEEN 0 AND 100),
  CONSTRAINT "CustomerFact_version_check" CHECK ("version" > 0)
);

CREATE TABLE "ProposalEvidenceLink" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "proposalId" TEXT NOT NULL,
  "evidenceId" TEXT NOT NULL,
  "relation" "FactEvidenceRelation" NOT NULL,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProposalEvidenceLink_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CustomerFactEvidenceLink" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "factId" TEXT NOT NULL,
  "proposalId" TEXT,
  "evidenceId" TEXT NOT NULL,
  "relation" "FactEvidenceRelation" NOT NULL,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerFactEvidenceLink_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FactCommandReceipt" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "proposalId" TEXT,
  "requestId" TEXT NOT NULL,
  "operationDigest" TEXT NOT NULL,
  "kind" "FactCommandReceiptKind" NOT NULL,
  "receipt" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FactCommandReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FactEvidence_companyId_excerptHash_key" ON "FactEvidence"("companyId", "excerptHash");
CREATE INDEX "FactSource_companyId_kind_createdAt_idx" ON "FactSource"("companyId", "kind", "createdAt");
CREATE INDEX "FactEvidence_companyId_sourceId_capturedAt_idx" ON "FactEvidence"("companyId", "sourceId", "capturedAt");
CREATE INDEX "CustomerFactProposal_companyId_leadId_factKey_status_idx" ON "CustomerFactProposal"("companyId", "leadId", "factKey", "status");
CREATE INDEX "CustomerFactProposal_companyId_status_createdAt_idx" ON "CustomerFactProposal"("companyId", "status", "createdAt");
CREATE INDEX "CustomerFact_companyId_leadId_factKey_status_idx" ON "CustomerFact"("companyId", "leadId", "factKey", "status");
CREATE INDEX "CustomerFact_companyId_status_validUntil_idx" ON "CustomerFact"("companyId", "status", "validUntil");
CREATE UNIQUE INDEX "ProposalEvidenceLink_companyId_proposalId_evidenceId_relation_key" ON "ProposalEvidenceLink"("companyId", "proposalId", "evidenceId", "relation");
CREATE INDEX "ProposalEvidenceLink_companyId_evidenceId_idx" ON "ProposalEvidenceLink"("companyId", "evidenceId");
CREATE UNIQUE INDEX "CustomerFactEvidenceLink_companyId_factId_evidenceId_relation_key" ON "CustomerFactEvidenceLink"("companyId", "factId", "evidenceId", "relation");
CREATE INDEX "CustomerFactEvidenceLink_companyId_evidenceId_idx" ON "CustomerFactEvidenceLink"("companyId", "evidenceId");
CREATE UNIQUE INDEX "FactCommandReceipt_companyId_requestId_key" ON "FactCommandReceipt"("companyId", "requestId");
CREATE UNIQUE INDEX "FactCommandReceipt_companyId_operationDigest_key" ON "FactCommandReceipt"("companyId", "operationDigest");
CREATE INDEX "FactCommandReceipt_companyId_createdAt_idx" ON "FactCommandReceipt"("companyId", "createdAt");

ALTER TABLE "FactSource" ADD CONSTRAINT "FactSource_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FactSource" ADD CONSTRAINT "FactSource_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FactEvidence" ADD CONSTRAINT "FactEvidence_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FactEvidence" ADD CONSTRAINT "FactEvidence_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "FactSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FactEvidence" ADD CONSTRAINT "FactEvidence_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerFactProposal" ADD CONSTRAINT "CustomerFactProposal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerFactProposal" ADD CONSTRAINT "CustomerFactProposal_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerFactProposal" ADD CONSTRAINT "CustomerFactProposal_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerFactProposal" ADD CONSTRAINT "CustomerFactProposal_baseFactId_fkey" FOREIGN KEY ("baseFactId") REFERENCES "CustomerFact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerFact" ADD CONSTRAINT "CustomerFact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerFact" ADD CONSTRAINT "CustomerFact_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerFact" ADD CONSTRAINT "CustomerFact_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerFact" ADD CONSTRAINT "CustomerFact_supersedesFactId_fkey" FOREIGN KEY ("supersedesFactId") REFERENCES "CustomerFact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProposalEvidenceLink" ADD CONSTRAINT "ProposalEvidenceLink_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProposalEvidenceLink" ADD CONSTRAINT "ProposalEvidenceLink_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "CustomerFactProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProposalEvidenceLink" ADD CONSTRAINT "ProposalEvidenceLink_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "FactEvidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProposalEvidenceLink" ADD CONSTRAINT "ProposalEvidenceLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerFactEvidenceLink" ADD CONSTRAINT "CustomerFactEvidenceLink_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerFactEvidenceLink" ADD CONSTRAINT "CustomerFactEvidenceLink_factId_fkey" FOREIGN KEY ("factId") REFERENCES "CustomerFact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerFactEvidenceLink" ADD CONSTRAINT "CustomerFactEvidenceLink_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "CustomerFactProposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerFactEvidenceLink" ADD CONSTRAINT "CustomerFactEvidenceLink_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "FactEvidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerFactEvidenceLink" ADD CONSTRAINT "CustomerFactEvidenceLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FactCommandReceipt" ADD CONSTRAINT "FactCommandReceipt_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FactCommandReceipt" ADD CONSTRAINT "FactCommandReceipt_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "CustomerFactProposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
