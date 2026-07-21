// Packaging prospect configuration for Example Trading Company.
// Product wording may be overridden globally through BUSINESS_PRODUCT_FOCUS;
// the categories define buyer signals instead of locking the worker to one SKU.

export interface ProspectSubCategory {
  name: string;
  nameEn: string;
  keywords: string[];
  targetCountry: string;
  customerType: string;
  excludeWords: string[];
}

export interface ProspectLayer {
  id: number;
  name: string;
  categories: ProspectSubCategory[];
}

const DEFAULT_EXCLUDES = ['amazon', 'ebay', 'etsy', 'alibaba', 'made-in-china', '1688'];

const LAYER_1: ProspectLayer = {
  id: 1,
  name: 'Layer 1 - E-commerce and direct-to-consumer brands',
  categories: [
    {
      name: '电商与DTC品牌', nameEn: 'E-commerce & DTC Brands', targetCountry: 'USA',
      keywords: ['direct to consumer brand custom shipping mailers', 'ecommerce brand branded packaging supplier', 'online retailer sustainable mailer bags procurement'],
      customerType: 'Growing e-commerce or DTC brand shipping repeat orders and needing branded, protective, right-sized packaging.',
      excludeWords: DEFAULT_EXCLUDES,
    },
    {
      name: '服装鞋帽品牌', nameEn: 'Fashion Apparel & Footwear', targetCountry: 'USA',
      keywords: ['fashion brand custom poly mailer packaging', 'apparel company shipping bag procurement', 'footwear brand ecommerce packaging buyer'],
      customerType: 'Apparel, footwear, or accessories brand using custom poly mailers, returnable mailers, garment bags, or kraft shopping bags.',
      excludeWords: DEFAULT_EXCLUDES,
    },
    {
      name: '美妆个护品牌', nameEn: 'Beauty & Personal Care', targetCountry: 'USA',
      keywords: ['beauty brand custom ecommerce packaging', 'skincare company sustainable mailers packaging buyer', 'cosmetics brand branded shipping bags procurement'],
      customerType: 'Beauty or personal-care brand requiring branded mailers, zipper bags, sample bags, and secondary packaging.',
      excludeWords: DEFAULT_EXCLUDES,
    },
    {
      name: '订阅盒与礼品品牌', nameEn: 'Subscription & Gift Brands', targetCountry: 'USA',
      keywords: ['subscription box company custom mailer packaging', 'gift brand branded packaging procurement', 'monthly box sustainable shipping bags supplier'],
      customerType: 'Subscription, gifting, or curated-product brand with recurring fulfillment and seasonal custom packaging demand.',
      excludeWords: DEFAULT_EXCLUDES,
    },
  ],
};

const LAYER_2: ProspectLayer = {
  id: 2,
  name: 'Layer 2 - Food, retail and hospitality buyers',
  categories: [
    {
      name: '咖啡烘焙与食品零售', nameEn: 'Coffee Bakery & Food Retail', targetCountry: 'USA',
      keywords: ['coffee roaster kraft paper bag wholesale procurement', 'bakery custom paper bags buyer', 'food retailer branded takeaway bag supplier'],
      customerType: 'Coffee roaster, bakery, specialty-food brand, or retail chain buying compliant kraft bags and carry-out packaging in volume.',
      excludeWords: DEFAULT_EXCLUDES,
    },
    {
      name: '餐饮外卖连锁', nameEn: 'Restaurant & Takeaway Chains', targetCountry: 'USA',
      keywords: ['restaurant chain custom kraft bags procurement', 'takeaway food packaging purchasing manager', 'cafe chain paper carry bag supplier'],
      customerType: 'Restaurant, takeaway, cafe, or hospitality group with multi-location paper bag and waste-bag requirements.',
      excludeWords: DEFAULT_EXCLUDES,
    },
    {
      name: '精品零售与买手店', nameEn: 'Boutique & Specialty Retail', targetCountry: 'USA',
      keywords: ['boutique retailer custom kraft shopping bags', 'specialty retail branded paper bag procurement', 'gift shop packaging buyer wholesale'],
      customerType: 'Boutique, gift shop, concept store, or specialty retailer needing branded shopping and merchandise bags.',
      excludeWords: DEFAULT_EXCLUDES,
    },
    {
      name: '酒店与活动运营商', nameEn: 'Hospitality & Events', targetCountry: 'USA',
      keywords: ['hotel group custom packaging procurement', 'event organizer branded gift bags buyer', 'resort retail paper bags supplier'],
      customerType: 'Hotel, resort, event, or corporate-gifting operator sourcing custom bags and event packaging.',
      excludeWords: DEFAULT_EXCLUDES,
    },
  ],
};

const LAYER_3: ProspectLayer = {
  id: 3,
  name: 'Layer 3 - Logistics and industrial users',
  categories: [
    {
      name: '第三方物流与履约仓', nameEn: '3PL & Fulfilment', targetCountry: 'USA',
      keywords: ['3pl fulfillment custom shipping mailers procurement', 'fulfilment warehouse poly mailer supplier', 'logistics company packaging purchasing'],
      customerType: '3PL, fulfillment warehouse, or logistics operator consuming shipping mailers and protective bags at repeat scale.',
      excludeWords: DEFAULT_EXCLUDES,
    },
    {
      name: '快递与邮政服务', nameEn: 'Courier & Postal Services', targetCountry: 'USA',
      keywords: ['courier company tamper evident mailer bags procurement', 'postal service shipping bag supplier', 'express delivery custom poly mailers tender'],
      customerType: 'Courier, postal, or last-mile delivery company requiring secure tamper-evident mailers and document pouches.',
      excludeWords: DEFAULT_EXCLUDES,
    },
    {
      name: '清洁物业与垃圾袋采购', nameEn: 'Cleaning Facility & Waste Bags', targetCountry: 'USA',
      keywords: ['facility management garbage bags bulk procurement', 'commercial cleaning company trash liner supplier', 'janitorial distributor waste bag wholesale'],
      customerType: 'Facility-management, commercial-cleaning, hospitality, or janitorial buyer consuming garbage bags and bin liners in volume.',
      excludeWords: DEFAULT_EXCLUDES,
    },
    {
      name: '工业零部件与五金', nameEn: 'Industrial Parts & Hardware', targetCountry: 'USA',
      keywords: ['industrial parts ziplock bags packaging procurement', 'hardware distributor resealable bag supplier', 'factory custom protective bags purchasing'],
      customerType: 'Industrial, hardware, electronics, or parts distributor using resealable bags and protective flexible packaging.',
      excludeWords: DEFAULT_EXCLUDES,
    },
  ],
};

const LAYER_4: ProspectLayer = {
  id: 4,
  name: 'Layer 4 - Distribution and private-label channels',
  categories: [
    {
      name: '包装经销商', nameEn: 'Packaging Distributors', targetCountry: 'USA',
      keywords: ['packaging distributor poly mailers wholesale', 'flexible packaging importer kraft bags buyer', 'packaging supplies distributor private label'],
      customerType: 'Packaging importer, distributor, wholesaler, or converter seeking a reliable OEM factory and broad bag assortment.',
      excludeWords: DEFAULT_EXCLUDES,
    },
    {
      name: '批发与现金自运渠道', nameEn: 'Wholesale & Cash-and-Carry', targetCountry: 'USA',
      keywords: ['wholesale packaging supplies buyer', 'cash and carry garbage bags importer', 'business supplies distributor custom bags'],
      customerType: 'Wholesale, cash-and-carry, or business-supplies channel buying packaging products for resale.',
      excludeWords: DEFAULT_EXCLUDES,
    },
    {
      name: '促销品与企业礼品商', nameEn: 'Promotional Product Distributors', targetCountry: 'USA',
      keywords: ['promotional products distributor custom bags', 'corporate merchandise branded mailers procurement', 'custom gift bag wholesaler supplier'],
      customerType: 'Promotional-products or corporate-gifting distributor needing custom-printed bags for campaigns and events.',
      excludeWords: DEFAULT_EXCLUDES,
    },
    {
      name: '私牌零售商', nameEn: 'Private-label Retailers', targetCountry: 'USA',
      keywords: ['private label garbage bags retailer buyer', 'retail chain private label ziplock bags procurement', 'store brand packaging products sourcing'],
      customerType: 'Retail chain, supermarket, or home-goods seller sourcing private-label garbage bags, zipper bags, and household packaging.',
      excludeWords: DEFAULT_EXCLUDES,
    },
  ],
};

const LAYER_5: ProspectLayer = {
  id: 5,
  name: 'Layer 5 - Sustainability-led packaging buyers',
  categories: [
    {
      name: '可持续消费品牌', nameEn: 'Sustainable Consumer Brands', targetCountry: 'USA',
      keywords: ['sustainable brand recycled poly mailer procurement', 'eco friendly ecommerce packaging buyer', 'compostable shipping bag sourcing manager'],
      customerType: 'Sustainability-led consumer brand seeking recycled-content, reusable, recyclable, or compostable packaging options.',
      excludeWords: DEFAULT_EXCLUDES,
    },
    {
      name: '环保包装经销商', nameEn: 'Eco Packaging Distributors', targetCountry: 'USA',
      keywords: ['eco packaging distributor recycled mailers wholesale', 'sustainable packaging importer kraft bags', 'compostable bag distributor private label'],
      customerType: 'Eco-packaging distributor or wholesaler evaluating certified materials, factory traceability, and custom formats.',
      excludeWords: DEFAULT_EXCLUDES,
    },
    {
      name: '有机天然产品品牌', nameEn: 'Organic & Natural Product Brands', targetCountry: 'USA',
      keywords: ['organic products brand sustainable packaging procurement', 'natural skincare eco mailers buyer', 'ethical fashion recycled packaging supplier'],
      customerType: 'Organic, natural, ethical-fashion, or wellness brand whose packaging must support its sustainability claims.',
      excludeWords: DEFAULT_EXCLUDES,
    },
    {
      name: '大型企业ESG采购', nameEn: 'Corporate ESG Procurement', targetCountry: 'USA',
      keywords: ['corporate sustainable packaging procurement manager', 'retail chain packaging ESG supplier', 'company recycled shipping mailers tender'],
      customerType: 'Enterprise procurement or ESG team replacing conventional shipping, retail, or waste bags with documented lower-impact alternatives.',
      excludeWords: DEFAULT_EXCLUDES,
    },
  ],
};

export const ALL_LAYERS: ProspectLayer[] = [LAYER_1, LAYER_2, LAYER_3, LAYER_4, LAYER_5];

export const TARGET_MARKET_TIERS: { tier: number; countries: string[] }[] = [
  { tier: 1, countries: ['USA', 'Canada', 'UK', 'Germany', 'France', 'Italy', 'Spain', 'Netherlands', 'Sweden', 'Norway', 'Denmark', 'Finland', 'Australia', 'New Zealand'] },
  { tier: 2, countries: ['Japan', 'South Korea', 'Thailand', 'Vietnam', 'Philippines', 'Indonesia', 'Malaysia', 'India', 'Brazil', 'Mexico', 'Argentina', 'Chile', 'Colombia', 'UAE', 'Saudi Arabia'] },
  { tier: 3, countries: ['Pakistan', 'Bangladesh', 'Qatar', 'Kuwait', 'Kazakhstan', 'Uzbekistan', 'South Africa', 'Nigeria', 'Kenya', 'Poland', 'Czech Republic', 'Romania'] },
];

export const ALL_TARGET_COUNTRIES = TARGET_MARKET_TIERS.flatMap((tier) => tier.countries);

export function randomTargetCountry(): string {
  const weighted = TARGET_MARKET_TIERS.flatMap(({ tier, countries }) =>
    countries.flatMap((country) => Array(tier === 1 ? 3 : tier === 2 ? 2 : 1).fill(country)),
  );
  return weighted[Math.floor(Math.random() * weighted.length)] || 'USA';
}

export function randomCategory(layerId: number): ProspectSubCategory {
  const layer = getLayerById(layerId);
  if (!layer) throw new Error(`Layer ${layerId} not found`);
  return layer.categories[Math.floor(Math.random() * layer.categories.length)];
}

export function randomCategoryExcluding(layerId: number, excludeNames: string[]): ProspectSubCategory {
  const layer = getLayerById(layerId);
  if (!layer) throw new Error(`Layer ${layerId} not found`);
  const available = layer.categories.filter((category) => !excludeNames.includes(category.name));
  const pool = available.length ? available : layer.categories;
  return pool[Math.floor(Math.random() * pool.length)];
}

export function randomCategoryAcrossAllLayers(excludeLayerIds: number[] = []) {
  const available = ALL_LAYERS.filter((layer) => !excludeLayerIds.includes(layer.id));
  const pool = available.length ? available : ALL_LAYERS;
  const layer = pool[Math.floor(Math.random() * pool.length)];
  return { layer, category: layer.categories[Math.floor(Math.random() * layer.categories.length)] };
}

export function formatTaskTitle(date: Date, userName: string, country: string, categoryName: string, maxResults: number): string {
  const timestamp = date.toISOString().substring(0, 16).replace('T', ' ');
  return `${timestamp} - ${userName} - ${country} - ${categoryName} - ${maxResults}条`;
}

export function getLayerCategoryNames(layerId: number): string[] {
  return getLayerById(layerId)?.categories.map((category) => category.name) || [];
}

export function getLayerById(layerId: number): ProspectLayer | undefined {
  return ALL_LAYERS.find((layer) => layer.id === layerId);
}
