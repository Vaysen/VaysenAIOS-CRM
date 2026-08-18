import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../../../../database/alibaba-products/00-master-price-list.md');
const output = resolve(here, '../src/modules/products/data/usd-price-catalog.json');
const markdown = await readFile(source, 'utf8');

const rows = markdown.split(/\r?\n/).flatMap((line) => {
  if (!/^\|\s*\d+\s*\|/.test(line)) return [];
  const cells = line.split('|').slice(1, -1).map((value) => value.trim());
  if (cells.length !== 8) throw new Error(`Unexpected price row: ${line}`);
  const [sequence, categoryCn, categoryEn, size, thickness, packageText, rmbText, usdText] = cells;
  const costCny = Number(rmbText.replace(/[¥,]/g, ''));
  const saleUsd = Number(usdText.replace(/[$,]/g, ''));
  if (!Number.isFinite(costCny) || !Number.isFinite(saleUsd) || costCny <= 0 || saleUsd <= 0) {
    throw new Error(`Invalid price row: ${line}`);
  }
  const catalogItemId = `JYM-${String(sequence).padStart(4, '0')}`;
  return [{ catalogItemId, categoryCn, categoryEn, size, thickness, packageText, unit: 'pc', costCny, saleUsd }];
});

if (rows.length !== 168) throw new Error(`Expected 168 price rows, received ${rows.length}`);

const catalog = {
  schemaVersion: 1,
  priceVersion: 'jym-usd-2026-05-31-v1',
  effectiveAt: '2026-05-31',
  source: 'database/alibaba-products/00-master-price-list.md',
  pricingPolicy: {
    sourceCurrency: 'CNY',
    quoteCurrency: 'USD',
    protectionFxRateCnyPerUsd: 6.5,
    markup: 1.5,
    roundingDecimals: 3,
    requiresHumanApproval: true,
  },
  sourceSha256: createHash('sha256').update(markdown).digest('hex'),
  items: rows,
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
console.log(`Generated ${rows.length} USD price items -> ${output}`);
