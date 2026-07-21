#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignoredDirs = new Set([
  '.git',
  'node_modules',
  'dist',
  '.next',
  '.next-web',
  'out',
  'electron-export',
  'coverage',
  'release',
  'output',
  'uploads',
  'data',
  '.runtime',
  '.whatsapp-sessions',
]);
const allowedEnvNames = new Set(['.env.example', '.env.preview.example']);
const forbiddenNames = [/\.pem$/i, /\.pfx$/i, /\.p12$/i, /\.key$/i, /\.dump$/i, /\.sqlite(?:3)?$/i, /\.db$/i, /^id_rsa/i];
const textExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.sh', '.ps1', '.bat', '.txt', '.html', '.css', '.prisma', '.sql', '.env', '.example', '.conf', '.logrotate', '.py', '.workspace']);
const forbiddenText = [
  ['legacy company name', /J-Origin|嘉源美|jiayuanmei|jorigin/i],
  ['legacy product name', /TradeLead/i],
  ['private server address', /172\.25\.|192\.168\.2\.219|192\.168\.1\.20/],
  ['private customer fixture', /Elvis-W|8615624584719/],
  ['local personal path', /[A-Z]:\\Users\\[^\\\s]+|F:\\嘉源美包装资料/i],
  ['common provider key', /(?:sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})/],
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
];

const failures = [];
const files = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    const rel = path.relative(root, absolute).replaceAll('\\', '/');
    const publicPluginRuntime = rel === 'deploy/openclaw/plugins/vaysen-crm/dist';
    if (entry.isDirectory() && ignoredDirs.has(entry.name) && !publicPluginRuntime) continue;
    if (entry.isDirectory()) walk(absolute);
    else files.push(absolute);
  }
}

walk(root);

for (const file of files) {
  const rel = path.relative(root, file).replaceAll('\\', '/');
  const base = path.basename(file);
  if (base.startsWith('.env') && !allowedEnvNames.has(base)) failures.push(`${rel}: runtime env file is forbidden`);
  if (forbiddenNames.some((rule) => rule.test(base))) failures.push(`${rel}: forbidden credential or database file type`);
  const ext = path.extname(file).toLowerCase();
  if (!textExtensions.has(ext) && !base.startsWith('.env') && !['Dockerfile', 'Makefile', 'NOTICE'].includes(base)) continue;
  const text = fs.readFileSync(file, 'utf8');
  const policyOnlyFile = rel === 'scripts/verify-public-release.mjs' || rel === 'docs/OPEN-SOURCE-SANITIZATION.md';
  for (const [label, rule] of forbiddenText) {
    if (policyOnlyFile) continue;
    if (rule.test(text)) failures.push(`${rel}: ${label}`);
  }
}

const catalogPath = path.join(root, 'backend', 'src', 'modules', 'products', 'data', 'usd-price-catalog.json');
try {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  if (catalog.source !== 'synthetic-open-source-demo-data') failures.push('product catalog is not marked synthetic');
  for (const item of catalog.items ?? []) {
    if (Number(item.costCny) !== 0 || Number(item.saleUsd) !== 0) failures.push(`product catalog contains non-zero private price: ${item.catalogItemId}`);
  }
} catch (error) {
  failures.push(`cannot validate product catalog: ${error.message}`);
}

const expectedHashes = new Map([
  ['frontend/public/logo.png', '5ac8f4b49c6d6066d1de2132da19e2880938fad23e4a385c4fd5024d8358924c'],
  ['electron/build/icon-source.png', '4409ff9c1e580b0321362749fa070ba702146947aef5feef3cca854a58e63fa3'],
  ['frontend/public/favicon.ico', '35ce49d420c8efe55754cbac62089082d54630d4e8f9844d60cc2a86027855ad'],
  ['electron/build/icon.ico', '35ce49d420c8efe55754cbac62089082d54630d4e8f9844d60cc2a86027855ad'],
]);

for (const [rel, expected] of expectedHashes) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    failures.push(`${rel}: required Vaysen brand asset is missing`);
    continue;
  }
  const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (actual !== expected) failures.push(`${rel}: unapproved brand asset hash ${actual}`);
}

if (failures.length > 0) {
  console.error(`Public release gate failed (${failures.length}):`);
  for (const failure of [...new Set(failures)].sort()) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Public release gate passed: ${files.length} files inspected, synthetic prices confirmed, Vaysen assets verified.`);
