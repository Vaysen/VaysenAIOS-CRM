import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const rows = await prisma.$queryRawUnsafe(`
  SELECT table_name, column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE (table_name = 'Lead' AND column_name IN ('language', 'reviewStatus'))
     OR (table_name = 'CommunicationMessage' AND column_name = 'deliveryStatus')
  ORDER BY table_name, column_name
`);
const indexRows = await prisma.$queryRawUnsafe(`
  SELECT indexname, indexdef FROM pg_indexes
  WHERE schemaname = current_schema() AND indexname = 'Lead_companyId_reviewStatus_idx'
`);
const byKey = new Map(rows.map((row) => [`${row.table_name}.${row.column_name}`, row]));
assert.deepEqual(byKey.get('Lead.language'), { table_name: 'Lead', column_name: 'language', data_type: 'text', is_nullable: 'YES', column_default: null });
assert.equal(byKey.get('Lead.reviewStatus')?.data_type, 'text');
assert.equal(byKey.get('Lead.reviewStatus')?.is_nullable, 'NO');
assert.match(String(byKey.get('Lead.reviewStatus')?.column_default), /pending/);
assert.deepEqual(byKey.get('CommunicationMessage.deliveryStatus'), { table_name: 'CommunicationMessage', column_name: 'deliveryStatus', data_type: 'text', is_nullable: 'YES', column_default: null });
assert.equal(indexRows.length, 1);
assert.match(indexRows[0].indexdef, /companyId.*reviewStatus/);
console.log(JSON.stringify({ columns: rows, index: indexRows }, null, 2));
await prisma.$disconnect();
