// Data migration: Convert old 13-status system to new 7-stage + reviewStatus
// Run inside backend container: npx ts-node /app/migrate-lead-status.ts

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const STATUS_MAP: Record<string, { status: string; reviewStatus: string }> = {
  new:            { status: 'new',        reviewStatus: 'pending' },
  to_review:      { status: 'new',        reviewStatus: 'pending' },
  approved:       { status: 'new',        reviewStatus: 'approved' },
  contacted:      { status: 'contacted',  reviewStatus: 'approved' },
  opened:         { status: 'contacted',  reviewStatus: 'approved' },
  clicked:        { status: 'contacted',  reviewStatus: 'approved' },
  replied:        { status: 'replied',    reviewStatus: 'approved' },
  quoted:         { status: 'quoted',     reviewStatus: 'approved' },
  negotiating:    { status: 'interested', reviewStatus: 'approved' },
  won:            { status: 'won',        reviewStatus: 'approved' },
  lost:           { status: 'lost',       reviewStatus: 'approved' },
  unqualified:    { status: 'lost',       reviewStatus: 'approved' },
  do_not_contact: { status: 'lost',       reviewStatus: 'approved' },
};

async function main() {
  console.log('Starting lead status migration...\n');

  const leads = await prisma.lead.findMany({
    where: { deletedAt: null },
    select: { id: true, companyName: true, status: true },
  });

  console.log(`Found ${leads.length} leads to migrate.\n`);

  let migrated = 0;
  let skipped = 0;

  for (const lead of leads) {
    const mapping = STATUS_MAP[lead.status];
    if (!mapping) {
      console.log(`  [SKIP] ${lead.companyName}: unknown status "${lead.status}"`);
      skipped++;
      continue;
    }

    if (lead.status === mapping.status) {
      // Status already matches, just ensure reviewStatus is set
      await prisma.lead.update({
        where: { id: lead.id },
        data: { reviewStatus: mapping.reviewStatus },
      });
      console.log(`  [SET REVIEW] ${lead.companyName}: status=${lead.status}, reviewStatus=${mapping.reviewStatus}`);
    } else {
      await prisma.lead.update({
        where: { id: lead.id },
        data: { status: mapping.status, reviewStatus: mapping.reviewStatus },
      });
      console.log(`  [MIGRATE] ${lead.companyName}: ${lead.status} → ${mapping.status} (review: ${mapping.reviewStatus})`);
    }
    migrated++;
  }

  console.log(`\nDone. Migrated: ${migrated}, Skipped: ${skipped}`);
}

main()
  .catch((e) => {
    console.error('Migration failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
