-- CreateTable
CREATE TABLE "AudienceSegment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "criteriaJson" JSONB NOT NULL,
    "memberCount" INTEGER NOT NULL DEFAULT 0,
    "autoRefreshEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoRefreshIntervalHours" INTEGER NOT NULL DEFAULT 24,
    "lastRefreshedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudienceSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudienceSegmentMember" (
    "id" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'eligible',
    "addedReason" TEXT NOT NULL DEFAULT 'matched_criteria',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AudienceSegmentMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AudienceSegment_companyId_idx" ON "AudienceSegment"("companyId");

-- CreateIndex
CREATE INDEX "AudienceSegmentMember_leadId_idx" ON "AudienceSegmentMember"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "AudienceSegmentMember_segmentId_leadId_key" ON "AudienceSegmentMember"("segmentId", "leadId");

-- AddForeignKey
ALTER TABLE "AudienceSegment" ADD CONSTRAINT "AudienceSegment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudienceSegmentMember" ADD CONSTRAINT "AudienceSegmentMember_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "AudienceSegment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudienceSegmentMember" ADD CONSTRAINT "AudienceSegmentMember_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
