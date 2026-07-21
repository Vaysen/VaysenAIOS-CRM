import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Create default roles
  const roles = await Promise.all([
    prisma.role.upsert({
      where: { name: 'super_admin' },
      update: {},
      create: { name: 'super_admin', displayName: 'Super Admin', isSystem: true },
    }),
    prisma.role.upsert({
      where: { name: 'company_admin' },
      update: {},
      create: { name: 'company_admin', displayName: 'Company Admin', isSystem: true },
    }),
    prisma.role.upsert({
      where: { name: 'sales_manager' },
      update: {},
      create: { name: 'sales_manager', displayName: 'Sales Manager', isSystem: true },
    }),
    prisma.role.upsert({
      where: { name: 'sales_user' },
      update: {},
      create: { name: 'sales_user', displayName: 'Sales User', isSystem: true },
    }),
    prisma.role.upsert({
      where: { name: 'viewer' },
      update: {},
      create: { name: 'viewer', displayName: 'Viewer', isSystem: true },
    }),
  ]);
  console.log(`Created ${roles.length} roles`);

  // Create default permissions
  const permissions = [
    { code: 'lead:create', displayName: 'Create Leads', group: 'leads' },
    { code: 'lead:read', displayName: 'View Leads', group: 'leads' },
    { code: 'lead:update', displayName: 'Edit Leads', group: 'leads' },
    { code: 'lead:delete', displayName: 'Delete Leads', group: 'leads' },
    { code: 'lead:import', displayName: 'Import Leads', group: 'leads' },
    { code: 'lead:export', displayName: 'Export Leads', group: 'leads' },
    { code: 'lead:assign', displayName: 'Assign Leads', group: 'leads' },
    { code: 'email:send', displayName: 'Send Emails', group: 'emails' },
    { code: 'email:manage_accounts', displayName: 'Manage Email Accounts', group: 'emails' },
    { code: 'email:manage_templates', displayName: 'Manage Email Templates', group: 'emails' },
    { code: 'email:manage_campaigns', displayName: 'Manage Campaigns', group: 'emails' },
    { code: 'user:create', displayName: 'Create Users', group: 'users' },
    { code: 'user:read', displayName: 'View Users', group: 'users' },
    { code: 'user:update', displayName: 'Edit Users', group: 'users' },
    { code: 'user:delete', displayName: 'Delete Users', group: 'users' },
    { code: 'analytics:view', displayName: 'View Analytics', group: 'analytics' },
    { code: 'settings:update', displayName: 'Update Settings', group: 'settings' },
    { code: 'compliance:manage_blacklist', displayName: 'Manage Blacklist', group: 'compliance' },
  ];

  for (const perm of permissions) {
    await prisma.permission.upsert({
      where: { code: perm.code },
      update: {},
      create: perm,
    });
  }
  console.log(`Created ${permissions.length} permissions`);

  // Seed default tags
  const profileTags = [
    'E-commerce/DTC', 'Retail Brand', 'Logistics/Fulfillment', 'Food/Hospitality',
    'Packaging Distributor', 'Cleaning/Facility', 'Industrial/Hardware',
    'Gift/Promotional', 'Sustainable Brand', 'Wholesale/B2B',
  ];
  const engagementTags = ['Email Opened', 'Email Clicked', 'Email Replied', 'High Engagement', 'Meeting Booked'];
  const systemTags = ['Hot Lead', 'VIP', 'Follow Up Urgent', 'Sample Requested', 'Import Ready', 'High Confidence'];

  const allTags = [
    ...profileTags.map((n) => ({ name: n, category: 'profile', color: '#3b82f6' })),
    ...engagementTags.map((n) => ({ name: n, category: 'engagement', color: '#22c55e' })),
    ...systemTags.map((n) => ({ name: n, category: 'system', color: '#f59e0b' })),
  ];

  // Create a default company for system tags if none exists
  const companies = await prisma.company.findMany({ take: 1 });
  if (companies.length > 0) {
    const companyId = companies[0].id;
    for (const t of allTags) {
      await prisma.tag.upsert({
        where: { companyId_name: { companyId, name: t.name } },
        update: {},
        create: { companyId, name: t.name, displayName: t.name, color: t.color, category: t.category, isSystem: true },
      });
    }
    console.log(`Seeded ${allTags.length} default tags`);
  }

  console.log('Seeding complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
