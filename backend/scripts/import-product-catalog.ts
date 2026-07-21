/**
 * 产品目录导入脚本
 * 将公司产品报价单数据导入数据库
 * 运行: npx ts-node scripts/import-product-catalog.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// 产品分类映射
const categories = [
  { name: '牛皮纸自立袋', code: 'kraft_stand_up', sort: 1 },
  { name: '八边封自立袋', code: 'eight_side_seal', sort: 2 },
  { name: '磨砂自立骨袋', code: 'frosted_zip', sort: 3 },
  { name: '磨砂平底骨袋', code: 'frosted_flat', sort: 4 },
  { name: '气泡信封袋', code: 'bubble_envelope', sort: 5 },
  { name: '快递袋', code: 'express_bag', sort: 6 },
  { name: '咖啡袋', code: 'coffee_bag', sort: 7 },
  { name: '拉链袋', code: 'zip_lock', sort: 8 },
  { name: '保鲜袋', code: 'freshness_bag', sort: 9 },
  { name: '背胶袋', code: 'adhesive_bag', sort: 10 },
  { name: '风琴袋', code: 'gusseted_bag', sort: 11 },
  { name: '异形自立袋', code: 'special_shaped', sort: 12 },
];

// 产品数据 (从 PDF 提取)
const products = [
  // MX-001 开窗牛皮纸自立袋
  {
    productCode: 'MX-001', name: '开窗牛皮纸自立袋', material: '哑光牛皮纸+CPP', thickness: '双面28丝',
    category: '牛皮纸自立袋', productType: 'stand_up',
    specs: [
      { size: '9*14+3.5x14C', unitPrice: 0.085, moq: 6000, packPerBundle: 100, bundleWeightKg: 0.38, cartonSize: '55*46*25' },
      { size: '10*15+3.5x14C', unitPrice: 0.1, moq: 6000, packPerBundle: 100, bundleWeightKg: 0.42, cartonSize: '55*46*25' },
      { size: '12*20+4x14C', unitPrice: 0.15, moq: 4800, packPerBundle: 100, bundleWeightKg: 0.66, cartonSize: '52*44*32' },
      { size: '14*20+4x14C', unitPrice: 0.18, moq: 3800, packPerBundle: 100, bundleWeightKg: 0.82, cartonSize: '56*47*29' },
      { size: '14*22+4x14C', unitPrice: 0.2, moq: 3000, packPerBundle: 100, bundleWeightKg: 0.88, cartonSize: '52*44*23' },
      { size: '16*22+4x14C', unitPrice: 0.23, moq: 2500, packPerBundle: 100, bundleWeightKg: 0.94, cartonSize: '56*46*23' },
      { size: '16*26+4x14C', unitPrice: 0.24, moq: 2400, packPerBundle: 100, bundleWeightKg: 0.94, cartonSize: '52*45*32' },
      { size: '17*24+4x14C', unitPrice: 0.255, moq: 2300, packPerBundle: 100, bundleWeightKg: 1.12, cartonSize: '52*46*31' },
      { size: '18*26+4x14C', unitPrice: 0.275, moq: 1900, packPerBundle: 100, bundleWeightKg: 1.22, cartonSize: '57*46*24' },
      { size: '18*28+4x14C', unitPrice: 0.29, moq: 1700, packPerBundle: 100, bundleWeightKg: 1.4, cartonSize: '57*45*24' },
      { size: '20*30+5x14C', unitPrice: 0.34, moq: 1600, packPerBundle: 100, bundleWeightKg: 1.64, cartonSize: '55*45*24' },
      { size: '23*33+5x14C', unitPrice: 0.42, moq: 1400, packPerBundle: 100, bundleWeightKg: 2.0, cartonSize: '56*46*25' },
      { size: '25*35+6x14C', unitPrice: 0.56, moq: 1000, packPerBundle: 100, bundleWeightKg: 2.3, cartonSize: '56*46*25' },
    ],
  },
  // MX-001 五谷杂粮自立骨袋
  {
    productCode: 'MX-001B', name: '五谷杂粮自立骨袋', material: '牛皮纸', thickness: '双面28丝',
    category: '牛皮纸自立袋', productType: 'stand_up',
    specs: [
      { size: '15*22+4', unitPrice: 0.35, moq: 2500, packPerBundle: 100, bundleWeightKg: 1.09, cartonSize: '35*45*38', color: '红色/绿色' },
      { size: '18*26+4.5', unitPrice: 0.46, moq: 2400, packPerBundle: 100, bundleWeightKg: 1.52, cartonSize: '38*55*35', color: '红色/绿色' },
      { size: '20*30+5', unitPrice: 0.52, moq: 1600, packPerBundle: 100, bundleWeightKg: 1.78, cartonSize: '41*43*38', color: '红色' },
      { size: '16*26+8', unitPrice: 0.72, moq: 1300, packPerBundle: 100, bundleWeightKg: 2.45, cartonSize: '37*49*33', color: '印刷款八边封' },
      { size: '18*28+8', unitPrice: 0.77, moq: 1400, packPerBundle: 100, bundleWeightKg: 2.58, cartonSize: '38*55*34', color: '印刷款八边封' },
      { size: '20*30+8', unitPrice: 0.8, moq: 1000, packPerBundle: 100, bundleWeightKg: 3.5, cartonSize: '41*42*38', color: '印刷款八边封' },
    ],
  },
  // MX-002 不开窗镀铝牛皮纸自立袋
  {
    productCode: 'MX-002', name: '不开窗镀铝牛皮纸自立袋', material: '牛皮纸+PET+铝+CPP', thickness: '双面28丝',
    category: '牛皮纸自立袋', productType: 'stand_up',
    specs: [
      { size: '9*14+3x14C', unitPrice: 0.08, moq: 6000, packPerBundle: 100, bundleWeightKg: 0.42, cartonSize: '52*46*31' },
      { size: '11*18.5+3x14C', unitPrice: 0.12, moq: 5000, packPerBundle: 100, bundleWeightKg: 0.58, cartonSize: '52*46*31' },
      { size: '12*18.5+3x14C', unitPrice: 0.14, moq: 4800, packPerBundle: 100, bundleWeightKg: 0.64, cartonSize: '52*46*31' },
      { size: '13*18.5+4x14C', unitPrice: 0.16, moq: 3900, packPerBundle: 100, bundleWeightKg: 0.72, cartonSize: '52*46*31' },
      { size: '13*21+4x14C', unitPrice: 0.17, moq: 3700, packPerBundle: 100, bundleWeightKg: 0.82, cartonSize: '52*46*31' },
      { size: '15*21+4x14C', unitPrice: 0.19, moq: 3500, packPerBundle: 100, bundleWeightKg: 0.96, cartonSize: '52*46*31' },
      { size: '15*23+4x14C', unitPrice: 0.2, moq: 3200, packPerBundle: 100, bundleWeightKg: 1.04, cartonSize: '52*46*31' },
      { size: '17*24+4x14C', unitPrice: 0.205, moq: 2300, packPerBundle: 100, bundleWeightKg: 1.18, cartonSize: '52*46*31' },
      { size: '18*30+5x14C', unitPrice: 0.3, moq: 2000, packPerBundle: 100, bundleWeightKg: 1.25, cartonSize: '52*46*31' },
      { size: '20*25+5x14C', unitPrice: 0.3, moq: 2200, packPerBundle: 100, bundleWeightKg: 1.52, cartonSize: '52*46*31' },
      { size: '20*30+5x14C', unitPrice: 0.35, moq: 1600, packPerBundle: 100, bundleWeightKg: 1.76, cartonSize: '52*46*31' },
      { size: '23*33+5x14C', unitPrice: 0.43, moq: 1400, packPerBundle: 100, bundleWeightKg: 2.1, cartonSize: '52*46*31' },
    ],
  },
  // MX-003 八边封牛皮纸无窗自立袋
  {
    productCode: 'MX-003', name: '八边封牛皮纸无窗自立袋', material: '哑光牛皮纸+PE', thickness: '双面28丝',
    category: '八边封自立袋', productType: 'eight_side',
    specs: [
      { size: '10*20+6x14C', unitPrice: 0.31, moq: 2700, packPerBundle: 50, bundleWeightKg: 0.46, cartonSize: '51*46*31' },
      { size: '12*22+6x14C', unitPrice: 0.37, moq: 2600, packPerBundle: 50, bundleWeightKg: 0.52, cartonSize: '51*46*31' },
      { size: '14*24+8x14C', unitPrice: 0.45, moq: 1700, packPerBundle: 50, bundleWeightKg: 0.76, cartonSize: '51*46*31' },
      { size: '16*26+8x14C', unitPrice: 0.52, moq: 1400, packPerBundle: 50, bundleWeightKg: 0.84, cartonSize: '51*46*31' },
      { size: '18*28+8x14C', unitPrice: 0.6, moq: 1300, packPerBundle: 50, bundleWeightKg: 0.96, cartonSize: '51*46*31' },
      { size: '20*30+8x14C', unitPrice: 0.65, moq: 1000, packPerBundle: 50, bundleWeightKg: 1.08, cartonSize: '51*46*31' },
    ],
  },
  // MX-004 镀铝八边封牛皮纸自立袋
  {
    productCode: 'MX-004', name: '镀铝八边封牛皮纸自立袋', material: '哑光牛皮纸+PET+铝+PE', thickness: '双面32丝',
    category: '八边封自立袋', productType: 'eight_side',
    specs: [
      { size: '10*20+6x16C', unitPrice: 0.36, moq: 2600, packPerBundle: 50, bundleWeightKg: 0.46, cartonSize: '51*46*31' },
      { size: '12*22+6x16C', unitPrice: 0.43, moq: 2200, packPerBundle: 50, bundleWeightKg: 0.6, cartonSize: '51*46*31' },
      { size: '14*24+6x16C', unitPrice: 0.53, moq: 1500, packPerBundle: 50, bundleWeightKg: 0.78, cartonSize: '51*46*31' },
      { size: '16*26+8x16C', unitPrice: 0.6, moq: 1400, packPerBundle: 50, bundleWeightKg: 0.92, cartonSize: '51*46*31' },
      { size: '18*28+8x16C', unitPrice: 0.69, moq: 1300, packPerBundle: 50, bundleWeightKg: 1.04, cartonSize: '51*46*31' },
      { size: '20*30+8x16C', unitPrice: 0.78, moq: 900, packPerBundle: 50, bundleWeightKg: 1.24, cartonSize: '51*46*31' },
    ],
  },
  // MX-005 八边封开窗牛皮纸自立袋
  {
    productCode: 'MX-005', name: '八边封开窗牛皮纸自立袋', material: '哑光牛皮纸+PE', thickness: '双面28丝',
    category: '八边封自立袋', productType: 'eight_side',
    specs: [
      { size: '10*20+6x14C', unitPrice: 0.31, moq: 2700, packPerBundle: 50, bundleWeightKg: 0.42, cartonSize: '51*46*31' },
      { size: '12*22+6x14C', unitPrice: 0.38, moq: 2600, packPerBundle: 50, bundleWeightKg: 0.52, cartonSize: '51*46*31' },
      { size: '14*24+8x14C', unitPrice: 0.44, moq: 1700, packPerBundle: 50, bundleWeightKg: 0.74, cartonSize: '51*46*31' },
      { size: '16*26+8x14C', unitPrice: 0.54, moq: 1400, packPerBundle: 50, bundleWeightKg: 0.82, cartonSize: '51*46*31' },
      { size: '18*28+8x14C', unitPrice: 0.61, moq: 1300, packPerBundle: 50, bundleWeightKg: 0.98, cartonSize: '51*46*31' },
      { size: '20*30+8x14C', unitPrice: 0.67, moq: 1000, packPerBundle: 50, bundleWeightKg: 1.04, cartonSize: '51*46*31' },
    ],
  },
  // MX-006 开窗牛皮纸手提自立袋
  {
    productCode: 'MX-006', name: '开窗牛皮纸手提自立袋', material: '哑光牛皮纸+CPP', thickness: '双面30丝',
    category: '牛皮纸自立袋', productType: 'stand_up',
    specs: [
      { size: '15.5*23.5+4x15C', unitPrice: 0.26, moq: 2400, packPerBundle: 100, bundleWeightKg: 1.04, cartonSize: '52*46*31', color: '棕/橙/绿' },
    ],
  },
  // MX-007 白色牛皮纸自立袋
  {
    productCode: 'MX-007', name: '白色牛皮纸自立袋', material: '白牛皮纸', thickness: '双面32丝',
    category: '牛皮纸自立袋', productType: 'stand_up',
    specs: [
      { size: '10*15+3*16', unitPrice: 0.155, moq: 4800, packPerBundle: 100, bundleWeightKg: 0.51, cartonSize: '33*49*38' },
      { size: '12*20+4*16', unitPrice: 0.205, moq: 3500, packPerBundle: 100, bundleWeightKg: 0.822, cartonSize: '33*49*38' },
      { size: '14*20+4*16', unitPrice: 0.23, moq: 3500, packPerBundle: 100, bundleWeightKg: 0.95, cartonSize: '33*57*38' },
      { size: '16*24+4*16', unitPrice: 0.315, moq: 2500, packPerBundle: 100, bundleWeightKg: 1.22, cartonSize: '37*49*38' },
      { size: '18*26+4*16', unitPrice: 0.39, moq: 2400, packPerBundle: 100, bundleWeightKg: 1.1, cartonSize: '38*55*34' },
      { size: '20*30+5*16', unitPrice: 0.455, moq: 1600, packPerBundle: 100, bundleWeightKg: 2.0, cartonSize: '41*43*38' },
      { size: '22*29+4*16', unitPrice: 0.52, moq: 1700, packPerBundle: 100, bundleWeightKg: 2.06, cartonSize: '42*45*40' },
    ],
  },
  // 休闲食品印刷
  {
    productCode: 'MX-007B', name: '休闲食品印刷袋', material: '牛皮纸', thickness: '双面32丝',
    category: '牛皮纸自立袋', productType: 'stand_up',
    specs: [
      { size: '15*23+4*16', unitPrice: 0.27, moq: 3000, packPerBundle: 50, bundleWeightKg: 1.18, cartonSize: '38*55*34' },
      { size: '18*27+4*16', unitPrice: 0.35, moq: 2400, packPerBundle: 50, bundleWeightKg: 1.56, cartonSize: '38*55*34' },
      { size: '20*30+4*16', unitPrice: 0.44, moq: 1800, packPerBundle: 50, bundleWeightKg: 1.96, cartonSize: '38*55*34' },
    ],
  },
  // MX-008 磨砂自立骨袋
  {
    productCode: 'MX-008', name: '磨砂自立骨袋', material: '磨砂/EVA', thickness: '双面20丝',
    category: '磨砂自立骨袋', productType: 'zip_lock',
    specs: [
      { size: '9*13+3', unitPrice: 0.085, moq: 10000, packPerBundle: 100, bundleWeightKg: 0.3, cartonSize: '44*40*38' },
      { size: '9*15+3', unitPrice: 0.09, moq: 9600, packPerBundle: 100, bundleWeightKg: 0.32, cartonSize: '44*38*32' },
      { size: '10*15+3', unitPrice: 0.09, moq: 7000, packPerBundle: 100, bundleWeightKg: 0.38, cartonSize: '50*33*40' },
      { size: '11*17+3', unitPrice: 0.12, moq: 7200, packPerBundle: 100, bundleWeightKg: 0.44, cartonSize: '57*35*38' },
      { size: '12*19+3', unitPrice: 0.155, moq: 5000, packPerBundle: 100, bundleWeightKg: 0.54, cartonSize: '50*34*38' },
      { size: '13*20+4', unitPrice: 0.16, moq: 5000, packPerBundle: 100, bundleWeightKg: 0.62, cartonSize: '57*34*37' },
      { size: '14*20+4', unitPrice: 0.17, moq: 5000, packPerBundle: 100, bundleWeightKg: 0.58, cartonSize: '57*35*36' },
      { size: '15*22+4', unitPrice: 0.19, moq: 3800, packPerBundle: 100, bundleWeightKg: 0.76, cartonSize: '50*36*37' },
      { size: '16*23+4', unitPrice: 0.21, moq: 3800, packPerBundle: 100, bundleWeightKg: 0.86, cartonSize: '50*36*39' },
      { size: '17*24+4', unitPrice: 0.23, moq: 3500, packPerBundle: 100, bundleWeightKg: 0.98, cartonSize: '53*39*39' },
      { size: '18*26+4', unitPrice: 0.265, moq: 3300, packPerBundle: 100, bundleWeightKg: 1.06, cartonSize: '51*39*39' },
      { size: '20*30+5', unitPrice: 0.325, moq: 2400, packPerBundle: 100, bundleWeightKg: 1.4, cartonSize: '43*43*36' },
      { size: '22*32+5', unitPrice: 0.35, moq: 2600, packPerBundle: 100, bundleWeightKg: 1.6, cartonSize: '44*43*40' },
      { size: '24*30+5', unitPrice: 0.39, moq: 1400, packPerBundle: 100, bundleWeightKg: 1.64, cartonSize: '47*26*40' },
      { size: '24*35+5', unitPrice: 0.48, moq: 1500, packPerBundle: 100, bundleWeightKg: 2.0, cartonSize: '47*26*40' },
      { size: '24*37+5', unitPrice: 0.495, moq: 1400, packPerBundle: 100, bundleWeightKg: 2.09, cartonSize: '47*26*40' },
      { size: '26*38+5', unitPrice: 0.51, moq: 1400, packPerBundle: 100, bundleWeightKg: 2.3, cartonSize: '47*26*40' },
    ],
  },
  // MX-008 磨砂平底骨袋
  {
    productCode: 'MX-008B', name: '磨砂平底骨袋', material: '磨砂/EVA', thickness: '双面20丝',
    category: '磨砂平底骨袋', productType: 'zip_lock',
    specs: [
      { size: '9*13', unitPrice: 0.065, moq: 12000, packPerBundle: 100, bundleWeightKg: 0.24, cartonSize: '51*32*36' },
      { size: '10*15', unitPrice: 0.08, moq: 8000, packPerBundle: 100, bundleWeightKg: 0.32, cartonSize: '51*32*36' },
      { size: '11*17', unitPrice: 0.095, moq: 8000, packPerBundle: 100, bundleWeightKg: 0.38, cartonSize: '51*32*36' },
      { size: '12*20', unitPrice: 0.12, moq: 5500, packPerBundle: 100, bundleWeightKg: 0.48, cartonSize: '51*32*36' },
      { size: '14*20', unitPrice: 0.14, moq: 5600, packPerBundle: 100, bundleWeightKg: 0.57, cartonSize: '51*32*36' },
      { size: '15*22', unitPrice: 0.16, moq: 4200, packPerBundle: 100, bundleWeightKg: 0.68, cartonSize: '47*36*38' },
      { size: '16*24', unitPrice: 0.19, moq: 4000, packPerBundle: 100, bundleWeightKg: 0.78, cartonSize: '51*38*37' },
    ],
  },
];

async function main() {
  console.log('Starting product catalog import...');

  // 获取第一个活跃公司
  const company = await prisma.company.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
  if (!company) {
    console.error('No active company found!');
    process.exit(1);
  }
  console.log(`Using company: ${company.name} (${company.id})`);

  // 创建分类
  const categoryMap = new Map();
  for (const cat of categories) {
    const existing = await prisma.productCategory.findFirst({
      where: { companyId: company.id, name: cat.name },
    });
    if (existing) {
      categoryMap.set(cat.name, existing);
    } else {
      const created = await prisma.productCategory.create({
        data: { companyId: company.id, name: cat.name, code: cat.code, sortOrder: cat.sort },
      });
      categoryMap.set(cat.name, created);
    }
  }
  console.log(`Created/verified ${categoryMap.size} categories`);

  // 创建产品和规格
  let productCount = 0;
  let specCount = 0;

  for (const p of products) {
    const category = categoryMap.get(p.category);
    if (!category) {
      console.warn(`Category not found: ${p.category}`);
      continue;
    }

    // 检查产品是否已存在
    const existing = await prisma.product.findFirst({
      where: { companyId: company.id, sku: p.productCode },
    });

    let product;
    if (existing) {
      product = existing;
      console.log(`Product already exists: ${p.productCode}`);
    } else {
      product = await prisma.product.create({
        data: {
          companyId: company.id,
          categoryId: category.id,
          sku: p.productCode,
          name: p.name,
          productCode: p.productCode,
          material: p.material,
          thickness: p.thickness,
          productType: p.productType,
          basePrice: 0,
          currency: 'CNY',
          isActive: true,
        },
      });
      productCount++;
    }

    // 创建规格
    for (const spec of p.specs) {
      const specExists = await prisma.productSpec.findFirst({
        where: { productId: product.id, size: spec.size },
      });
      if (specExists) continue;

      const cartonParts = (spec.cartonSize || '').split('*');
      const sizeParts = spec.size.split(/[\*\+x]/);

      await prisma.productSpec.create({
        data: {
          productId: product.id,
          specCode: spec.size,
          size: spec.size,
          widthCm: parseFloat(sizeParts[0]) || null,
          lengthCm: parseFloat(sizeParts[1]) || null,
          gussetCm: parseFloat(sizeParts[2]) || null,
          unitPrice: spec.unitPrice,
          moq: spec.moq,
          packPerBundle: spec.packPerBundle,
          bundleWeightKg: spec.bundleWeightKg,
          cartonSize: spec.cartonSize,
          cartonLengthCm: parseFloat(cartonParts[0]) || null,
          cartonWidthCm: parseFloat(cartonParts[1]) || null,
          cartonHeightCm: parseFloat(cartonParts[2]) || null,
          isActive: true,
        },
      });
      specCount++;
    }
  }

  console.log(`\nImport complete!`);
  console.log(`  Products created: ${productCount}`);
  console.log(`  Specs created: ${specCount}`);
  console.log(`  Total products in DB: ${await prisma.product.count({ where: { companyId: company.id } })}`);
  console.log(`  Total specs in DB: ${await prisma.productSpec.count()}`);
}

main()
  .catch((e) => {
    console.error('Import failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
