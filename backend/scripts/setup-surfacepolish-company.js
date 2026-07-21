const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const SURFACE_SETTINGS = {
  projectType: 'industry_workspace',
  defaultProductFocus: 'surface finishing machines, vibratory finishing machines, ceramic polishing media, dry finishing media, deburring and polishing solutions',
  productFocus: 'industrial surface finishing equipment, media and compounds',
  mainProducts: [
    'vibratory finishing machine',
    'vibratory deburring machine',
    'tumbler polishing machine',
    'ceramic polishing media',
    'dry finishing media',
    'surface finishing equipment',
    'deburring and polishing line',
  ],
  defaultProspectKeywords: [
    'vibratory finishing machine',
    'vibratory deburring machine',
    'ceramic polishing media',
    'dry finishing media supplier',
    'surface finishing equipment',
    'industrial deburring solution',
    'tumbler polishing machine',
    'mass finishing equipment',
  ],
  targetMarkets: [
    'United Kingdom',
    'Poland',
    'Spain',
    'Portugal',
    'New Zealand',
    'United States',
    'Germany',
    'Italy',
  ],
  targetCustomerProfiles: [
    'manufacturing plants that need deburring and polishing',
    'automotive parts manufacturers',
    'aerospace component suppliers',
    'medical device parts manufacturers',
    'hardware and casting factories',
    'jewelry and metal parts workshops',
    'industrial distributors for finishing equipment and media',
  ],
  excludeProfiles: [
    'DIY hobby users',
    'students',
    'repair tutorial sites',
    'used machine marketplaces',
    'job posts',
    'low-intent informational pages',
  ],
  defaultEmailCta: 'ask whether they are reviewing deburring, polishing, surface finishing equipment, media, compounds, samples, or a custom process recommendation',
  evidenceRules: [
    'Company, email, phone and contacts must come from public pages or trusted directories.',
    'Do not accept placeholder phones or AI-only invented contacts.',
    'Prioritize industrial B2B buyers, factories, distributors and production teams.',
  ],
  sourceFolder: 'D:\\surfacepolish',
};

const PRODUCT_CATEGORIES = [
  {
    name: 'Vibratory Finishing Machines',
    description: 'Machines for mass finishing, deburring, polishing and surface treatment.',
  },
  {
    name: 'Finishing Media',
    description: 'Ceramic media, dry finishing media, compound and consumables.',
  },
  {
    name: 'Custom Surface Finishing Solutions',
    description: 'Process recommendation based on part material, size, finish target and production quantity.',
  },
];

const TAGS = [
  ['industrial-buyer', 'Industrial Buyer', '#2563eb', 'profile'],
  ['factory-production', 'Factory Production', '#0f766e', 'profile'],
  ['distributor', 'Distributor', '#7c3aed', 'profile'],
  ['automotive-parts', 'Automotive Parts', '#ea580c', 'industry'],
  ['medical-hardware', 'Medical / Hardware', '#dc2626', 'industry'],
  ['needs-process-advice', 'Needs Process Advice', '#16a34a', 'intent'],
  ['manual-review', 'Manual Review', '#6b7280', 'workflow'],
];

const TEMPLATE_VARIABLES = [
  ['{{ai_body_html}}', 'AI customer-specific email body HTML', true],
  ['{{contact_name}}', 'Contact Name', false],
  ['{{company_name}}', 'Company Name', true],
  ['{{sender_name}}', 'Sender Name', true],
  ['{{sender_company}}', 'Sender Company', true],
  ['{{sender_website}}', 'Company Website', true],
  ['{{website}}', 'Company Website', false],
  ['{{unsubscribe_link}}', 'Unsubscribe Link', false],
];

const EMAIL_TEMPLATES = [
  {
    name: 'SurfacePolish - First Outreach - Industrial Buyer',
    category: 'First Outreach',
    productCategory: 'Surface Finishing Equipment',
    subject: 'Surface finishing solution for {{company_name}}',
    body: `<!doctype html>
<html><body style="margin:0;padding:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;color:#111827;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f8fafc;padding:24px 0;">
<tr><td align="center"><table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:600px;max-width:100%;background:#ffffff;border:1px solid #e5e7eb;">
<tr><td style="padding:18px 24px;background:#1f2937;color:#ffffff;"><div style="font-size:13px;">{{sender_company}} | Surface Finishing Solutions</div><div style="font-size:20px;font-weight:700;margin-top:4px;">{{company_name}}</div></td></tr>
<tr><td style="padding:24px;font-size:14px;line-height:22px;color:#1f2937;">{{ai_body_html}}</td></tr>
<tr><td style="padding:0 24px 22px 24px;"><a href="{{sender_website}}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:4px;padding:10px 14px;font-size:13px;font-weight:700;">Visit Our Website</a></td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #e5e7eb;background:#f9fafb;font-size:13px;line-height:20px;color:#374151;">Best regards,<br>{{sender_name}}<br>{{sender_company}}<br><a href="{{sender_website}}" style="color:#2563eb;">{{sender_website}}</a></td></tr>
</table></td></tr></table>
{{unsubscribe_link}}
</body></html>`,
  },
  {
    name: 'SurfacePolish - Follow Up - Process Recommendation',
    category: 'Follow Up',
    productCategory: 'Custom Surface Finishing Solutions',
    subject: 'Follow-up: deburring and polishing process for {{company_name}}',
    body: `<!doctype html>
<html><body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,Helvetica,sans-serif;color:#111827;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f9fafb;padding:24px 0;">
<tr><td align="center"><table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:600px;max-width:100%;background:#ffffff;border:1px solid #e5e7eb;">
<tr><td style="padding:20px 24px;"><div style="font-size:18px;font-weight:700;color:#111827;">Custom surface finishing support</div><div style="font-size:13px;color:#6b7280;margin-top:4px;">Machines + media + compound + process recommendation</div></td></tr>
<tr><td style="padding:0 24px 22px 24px;font-size:14px;line-height:22px;color:#1f2937;">{{ai_body_html}}</td></tr>
<tr><td style="padding:0 24px 22px 24px;"><a href="{{sender_website}}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;border-radius:4px;padding:10px 14px;font-size:13px;font-weight:700;">Send Part Details</a></td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #e5e7eb;background:#f9fafb;font-size:13px;line-height:20px;color:#374151;">{{sender_name}} | {{sender_company}}<br><a href="{{sender_website}}" style="color:#0f766e;">{{sender_website}}</a></td></tr>
</table></td></tr></table>
{{unsubscribe_link}}
</body></html>`,
  },
];

async function main() {
  const company = await prisma.company.upsert({
    where: { slug: 'surfacepolish' },
    update: {
      name: 'SurfacePolish',
      website: 'https://www.surface-polish.com',
      industry: 'Industrial Surface Finishing Equipment',
      description: 'Surface finishing machines, media, compounds and customized deburring/polishing process recommendations for industrial B2B buyers.',
      settings: SURFACE_SETTINGS,
      isActive: true,
    },
    create: {
      name: 'SurfacePolish',
      slug: 'surfacepolish',
      website: 'https://www.surface-polish.com',
      industry: 'Industrial Surface Finishing Equipment',
      country: 'China',
      description: 'Surface finishing machines, media, compounds and customized deburring/polishing process recommendations for industrial B2B buyers.',
      settings: SURFACE_SETTINGS,
      isActive: true,
    },
  });

  const roleByName = new Map((await prisma.role.findMany()).map((role) => [role.name, role.id]));
  const roleForUser = {
    chris: 'company_admin',
    maria: 'sales_user',
    audrey: 'sales_user',
    skylar: 'sales_user',
    max: 'sales_user',
  };

  for (const [email, roleName] of Object.entries(roleForUser)) {
    const user = await prisma.user.findUnique({ where: { email } });
    const roleId = roleByName.get(roleName);
    if (!user || !roleId) continue;
    await prisma.userCompanyRelation.upsert({
      where: { userId_companyId: { userId: user.id, companyId: company.id } },
      update: { roleId, isActive: true },
      create: { userId: user.id, companyId: company.id, roleId, isActive: true, isDefault: false },
    });
  }

  for (const [key, value] of Object.entries({
    'company.profile': JSON.stringify(SURFACE_SETTINGS, null, 2),
    'company.website': 'https://www.surface-polish.com',
    'ai.defaultProductFocus': SURFACE_SETTINGS.defaultProductFocus,
  })) {
    await prisma.systemSetting.upsert({
      where: { companyId_key: { companyId: company.id, key } },
      update: { value, group: 'surfacepolish', description: 'SurfacePolish industry workspace setting' },
      create: { companyId: company.id, key, value, group: 'surfacepolish', description: 'SurfacePolish industry workspace setting' },
    });
  }

  for (const [name, displayName, color, category] of TAGS) {
    await prisma.tag.upsert({
      where: { companyId_name: { companyId: company.id, name } },
      update: { displayName, color, category },
      create: { companyId: company.id, name, displayName, color, category, isSystem: true },
    });
  }

  for (const [index, item] of PRODUCT_CATEGORIES.entries()) {
    await prisma.productCategory.upsert({
      where: { companyId_name: { companyId: company.id, name: item.name } },
      update: { description: item.description, sortOrder: index + 1, isActive: true },
      create: { companyId: company.id, name: item.name, description: item.description, sortOrder: index + 1, isActive: true },
    });
  }

  const adminUser = await prisma.user.findUnique({ where: { email: 'chris' } });
  for (const tpl of EMAIL_TEMPLATES) {
    let template = await prisma.emailTemplate.findFirst({
      where: { companyId: company.id, name: tpl.name },
    });
    if (template) {
      template = await prisma.emailTemplate.update({
        where: { id: template.id },
        data: {
          category: tpl.category,
          productCategory: tpl.productCategory,
          subject: tpl.subject,
          body: tpl.body,
          language: 'en',
          isActive: true,
        },
      });
    } else {
      template = await prisma.emailTemplate.create({
        data: {
          companyId: company.id,
          createdBy: adminUser?.id,
          name: tpl.name,
          category: tpl.category,
          productCategory: tpl.productCategory,
          subject: tpl.subject,
          body: tpl.body,
          language: 'en',
          isActive: true,
        },
      });
    }

    for (const [variable, label, isRequired] of TEMPLATE_VARIABLES) {
      await prisma.emailTemplateVariable.upsert({
        where: { templateId_variable: { templateId: template.id, variable } },
        update: { label, isRequired },
        create: { templateId: template.id, variable, label, isRequired },
      });
    }
  }

  console.log(JSON.stringify({ ok: true, companyId: company.id, slug: company.slug }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
