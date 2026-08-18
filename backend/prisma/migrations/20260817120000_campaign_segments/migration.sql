-- AlterTable
ALTER TABLE "MarketingCampaign" ADD COLUMN "channel" TEXT;

-- CreateTable
CREATE TABLE "MarketingCampaignSegment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingCampaignSegment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketingCampaignSegment_segmentId_idx" ON "MarketingCampaignSegment"("segmentId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingCampaignSegment_campaignId_segmentId_key" ON "MarketingCampaignSegment"("campaignId", "segmentId");

-- AddForeignKey
ALTER TABLE "MarketingCampaignSegment" ADD CONSTRAINT "MarketingCampaignSegment_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
