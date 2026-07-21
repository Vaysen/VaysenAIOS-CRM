import { PrismaClient } from '@prisma/client';

const MARKET_TIERS = {
  tier1: ['USA', 'Canada', 'UK', 'Germany', 'France', 'Italy', 'Spain', 'Australia'],
  tier2: ['Japan', 'South Korea', 'Brazil', 'Mexico', 'UAE', 'India'],
  tier3: ['Poland', 'South Africa', 'Nigeria', 'Kenya', 'Colombia', 'Chile'],
};

const CUSTOMER_PROFILES = [
  'layer1_ecommerce_sellers',
  'layer2_consumer_brands',
  'layer3_logistics_fulfillment',
  'layer4_packaging_distributors_private_label',
  'layer5_retail_food_industrial_buyers',
];

const MARKET_KEYS = Object.keys(MARKET_TIERS);

const prisma = new PrismaClient();
const users = await prisma.user.findMany({ where: { deletedAt: null }, select: { id: true, email: true, firstName: true, lastName: true } });
const companyId = '4a2d4fee-3a6c-41d9-b91d-9d78ca3ebc43';

let total = 0;
for (const user of users) {
  for (let round = 0; round < 3; round++) {
    const tierKey = MARKET_KEYS[Math.floor(Math.random() * MARKET_KEYS.length)];
    const countries = MARKET_TIERS[tierKey];
    const country = countries[Math.floor(Math.random() * countries.length)];
    const profile = CUSTOMER_PROFILES[Math.floor(Math.random() * CUSTOMER_PROFILES.length)];

    const task = await prisma.searchTask.create({
      data: {
        companyId,
        createdBy: user.id,
        keywords: [],
        targetCountry: country,
        customerType: `${tierKey} / ${profile}`,
        excludeWords: [],
        searchLanguage: 'en',
        maxResults: 100,
        status: 'pending',
      },
    });
    total++;
    console.log(`Task ${task.id.slice(0,8)}: ${user.firstName || user.email} → ${country} - ${profile} (round ${round+1}/3)`);
  }
}

console.log(`\nTotal tasks created: ${total}`);
await prisma.$disconnect();
