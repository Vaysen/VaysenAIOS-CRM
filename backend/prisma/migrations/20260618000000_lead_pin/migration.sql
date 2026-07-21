-- CreateTable: LeadPin (user-level lead pinning)
CREATE TABLE "LeadPin" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LeadPin_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "LeadPin_leadId_userId_key" ON "LeadPin"("leadId", "userId");
CREATE INDEX "LeadPin_companyId_userId_idx" ON "LeadPin"("companyId", "userId");
CREATE INDEX "LeadPin_leadId_idx" ON "LeadPin"("leadId");

-- Foreign Keys
ALTER TABLE "LeadPin" ADD CONSTRAINT "LeadPin_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeadPin" ADD CONSTRAINT "LeadPin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
