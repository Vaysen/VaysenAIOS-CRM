/**
 * Vaysen Trade OS — Preview Demo Data Seed
 * Safe preview data: no real email, no WhatsApp send, AI test mode.
 * Run: npx ts-node prisma/seed-preview.ts
 */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const DEMO_CUSTOMERS = [
  { name:'GreenPack Solutions', country:'USA', industry:'E-commerce', contact:'Michael Brown', email:'demo-mike@preview.local' },
  { name:'EcoBox London', country:'UK', industry:'Retail', contact:'Sarah Wilson', email:'demo-sarah@preview.local' },
  { name:'Verpackung GmbH', country:'Germany', industry:'Food Pkg', contact:'Klaus Mueller', email:'demo-klaus@preview.local' },
  { name:'PackPro Inc', country:'Canada', industry:'Logistics', contact:'Emily Chen', email:'demo-emily@preview.local' },
  { name:'BioBag Australia', country:'Australia', industry:'Eco', contact:'James Taylor', email:'demo-james@preview.local' },
  { name:'Distribuidora Verde', country:'Mexico', industry:'Wholesale', contact:'Carlos Ruiz', email:'demo-carlos@preview.local' },
  { name:'Sakura Pack Japan', country:'Japan', industry:'Gift', contact:'Yuki Tanaka', email:'demo-yuki@preview.local' },
  { name:'Embalagens Brasil', country:'Brazil', industry:'Industrial', contact:'Ana Silva', email:'demo-ana@preview.local' },
  { name:'PakWorld Dubai', country:'UAE', industry:'Trading', contact:'Ahmed Al-Rashid', email:'demo-ahmed@preview.local' },
  { name:'PolyCraft France', country:'France', industry:'Cosmetics', contact:'Sophie Dubois', email:'demo-sophie@preview.local' },
  { name:'Korea Pack Systems', country:'South Korea', industry:'Electronics', contact:'Park Jin-woo', email:'demo-jinwoo@preview.local' },
  { name:'Italia Imballaggi', country:'Italy', industry:'Fashion', contact:'Marco Rossi', email:'demo-marco@preview.local' },
];

async function main() {
  console.log('=== Vaysen Preview Demo Data Seed ===');
  const company = await prisma.company.findFirst({ where: { isActive: true } });
  if (!company) throw new Error('No active company. Run create-accounts first.');
  const cid = company.id;

  let created = 0;
  for (const c of DEMO_CUSTOMERS) {
    const exists = await prisma.lead.findFirst({ where: { companyId: cid, contactEmail: c.email, deletedAt: null } });
    if (exists) continue;

    const daysAgo = Math.floor(Math.random() * 60) + 1;
    const lead = await prisma.lead.create({
      data: {
        companyId: cid, companyName: c.name, contactName: c.contact,
        contactEmail: c.email, country: c.country, industry: c.industry,
        sourceType: 'website_inquiry', status: ['new','active','active'][Math.floor(Math.random()*3)],
        leadGrade: ['A','A','B','B','C'][Math.floor(Math.random()*5)],
        notes: `Preview demo — ${c.country} ${c.industry}`,
        lastContactedAt: Math.random() > 0.5 ? new Date(Date.now() - (Math.floor(Math.random()*20)+8) * 86400000) : null,
        createdAt: new Date(Date.now() - daysAgo * 86400000),
      },
    });

    // ContactPoint
    await prisma.contactPoint.create({
      data: { companyId: cid, leadId: lead.id, type: 'email', originalValue: c.email, normalizedValue: c.email.toLowerCase(), isPrimary: true },
    });

    // Conversation
    const conv = await prisma.conversation.create({
      data: {
        companyId: cid, leadId: lead.id, channel: 'website_inquiry',
        subject: `${c.name} 预览询盘`, status: 'active',
        lastMessageAt: new Date(), lastMessagePreview: `Demo inquiry from ${c.name}`,
      },
    });

    await prisma.communicationMessage.create({
      data: { conversationId: conv.id, direction: 'inbound', content: `您好，我们来自${c.country}，需要定制包装产品。请提供产品目录和报价。`, contentType: 'text', fromAddress: c.email, receivedAt: new Date() },
    });

    // Activity
    await prisma.leadActivity.create({
      data: { companyId: cid, leadId: lead.id, activityType: 'website_inquiry', title: `${c.name} 预览询盘`, occurredAt: new Date() },
    });

    created++;
  }

  console.log(`Created ${created} preview leads with conversations.`);
  console.log('=== Done. Preview data ready for TASK-024 handover. ===');
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
