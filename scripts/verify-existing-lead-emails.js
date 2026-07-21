#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const { Resolver } = require('dns');

const rootDir = path.resolve(__dirname, '..');
const backendDir = path.join(rootDir, 'backend');

loadEnv(path.join(backendDir, '.env'));
process.chdir(backendDir);

function requirePrismaClient() {
  const candidates = [
    path.join(backendDir, 'node_modules', '@prisma/client'),
    path.join(rootDir, 'node_modules', '@prisma/client'),
    '@prisma/client',
  ];
  let lastError;
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

const { PrismaClient } = requirePrismaClient();

const VALID_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const VERIFY_FREE_DOMAINS = new Set([
  'gmail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com',
  'icloud.com', 'aol.com', 'proton.me', 'protonmail.com',
  'qq.com', '163.com', '126.com', 'sina.com', 'sohu.com', 'foxmail.com',
]);

const VERIFY_BLOCKED_MAILBOXES = new Set([
  'support', 'service', 'customer', 'customerservice', 'help', 'returns',
  'privacy', 'legal', 'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'press', 'media', 'pr', 'career', 'careers', 'jobs', 'hr',
]);

const VERIFY_BUSINESS_MAILBOXES = new Set([
  'sourcing', 'procurement', 'purchasing', 'buyer', 'buyers', 'buying',
  'vendor', 'vendors', 'supplier', 'suppliers', 'wholesale', 'b2b',
  'business', 'partnerships', 'partner', 'sales', 'info', 'contact',
  'hello', 'office', 'admin', 'orders', 'export', 'import', 'marketing',
  'merchandise', 'gifts', 'eyewear', 'brand',
]);
const VERIFY_PLACEHOLDER_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'test.com']);
const VERIFY_PLACEHOLDER_LOCALS = new Set(['example', 'sample', 'demo', 'test', 'user', 'firstname', 'lastname', 'first.last', 'john', 'jane', 'john.doe', 'jane.doe']);

const TRUSTED_SUCCESS_STATUSES = new Set([
  'smtp_verified',
  'official_page_verified',
  'verified_public_source',
]);

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : undefined;
const sampleArg = process.argv.find((arg) => arg.startsWith('--sample='));
const sampleSize = sampleArg ? Number(sampleArg.split('=')[1]) : 25;

const mxCache = new Map();
const dnsTimeoutMsArg = process.argv.find((arg) => arg.startsWith('--dns-timeout-ms='));
const dnsTimeoutMs = dnsTimeoutMsArg ? Number(dnsTimeoutMsArg.split('=')[1]) : 5000;

function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function extractDomain(value) {
  const input = String(value || '').trim().toLowerCase();
  if (!input) return '';
  try {
    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
    return new URL(withProtocol).hostname.replace(/^www\./, '');
  } catch {
    return input.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split(':')[0];
  }
}

async function hasMxRecord(domain) {
  const normalized = String(domain || '').toLowerCase();
  if (!normalized) return false;
  if (mxCache.has(normalized)) return mxCache.get(normalized);

  const check = async (resolver) => Promise.race([
    resolver.resolveMx(normalized).then((records) => records.length > 0),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`MX lookup timeout after ${dnsTimeoutMs}ms`)), dnsTimeoutMs)),
  ]);

  try {
    const result = await check(dns);
    mxCache.set(normalized, result);
    return result;
  } catch (error) {
    const retryableCodes = new Set(['ECONNREFUSED', 'ETIMEOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ENODATA']);
    if (!retryableCodes.has(error.code)) {
      mxCache.set(normalized, false);
      return false;
    }
  }

  for (const server of ['223.5.5.5', '114.114.114.114', '8.8.8.8']) {
    try {
      const resolver = new Resolver();
      resolver.setServers([server]);
      const result = await check(resolver);
      mxCache.set(normalized, result);
      return result;
    } catch {}
  }

  mxCache.set(normalized, false);
  return false;
}

async function evaluateLead(lead) {
  const email = String(lead.contactEmail || '').trim().toLowerCase();
  if (!VALID_EMAIL_REGEX.test(email)) {
    return {
      status: 'rejected',
      reason: 'Invalid email format',
      bucket: 'badFormat',
    };
  }

  const [localPart, domain] = email.split('@');
  const mailbox = localPart.split(/[.+_-]/)[0];
  const normalizedDomain = domain.toLowerCase();

  if (VERIFY_PLACEHOLDER_DOMAINS.has(normalizedDomain) || VERIFY_PLACEHOLDER_LOCALS.has(localPart) || /^(john|jane)([._-]?doe)?\d*$/.test(localPart) || /^test\d*$/.test(localPart)) {
    return {
      status: 'rejected',
      reason: 'Placeholder email is not a real customer mailbox',
      bucket: 'placeholderEmail',
    };
  }

  if (VERIFY_FREE_DOMAINS.has(normalizedDomain)) {
    return {
      status: 'rejected',
      reason: 'Free mailbox not allowed for cold outreach',
      bucket: 'freeEmail',
    };
  }

  if (VERIFY_BLOCKED_MAILBOXES.has(mailbox)) {
    return {
      status: 'rejected',
      reason: `Blocked mailbox "${mailbox}" is not suitable for cold outreach`,
      bucket: 'blockedMailbox',
    };
  }

  const hasMx = await hasMxRecord(normalizedDomain);
  if (!hasMx) {
    return {
      status: 'rejected',
      reason: 'Email domain has no MX record',
      bucket: 'noMx',
    };
  }

  const websiteDomain = extractDomain(lead.websiteDomain || lead.website || '');
  const domainMatches = Boolean(websiteDomain && (normalizedDomain === websiteDomain || normalizedDomain.endsWith(`.${websiteDomain}`)));
  const isBusinessMailbox = VERIFY_BUSINESS_MAILBOXES.has(mailbox);

  if (domainMatches) {
    return {
      status: 'official_page_verified',
      reason: 'Auto verified: email domain matches lead website and MX exists',
      bucket: 'domainMatch',
    };
  }

  if (isBusinessMailbox) {
    return {
      status: 'official_page_verified',
      reason: `Auto verified: business mailbox "${mailbox}" with valid MX`,
      bucket: 'businessMailbox',
    };
  }

  return {
    status: 'mx_domain_verified',
    reason: 'Auto verified: MX exists, mailbox role needs manual review',
    bucket: 'mxOnly',
  };
}

function chooseTarget(lead, evaluated) {
  const currentStatus = lead.emailVerificationStatus || 'unverified';
  if (TRUSTED_SUCCESS_STATUSES.has(currentStatus) && evaluated.status !== 'rejected') {
    return {
      status: currentStatus,
      reason: lead.emailVerificationReason,
      bucket: 'preservedTrusted',
    };
  }
  return evaluated;
}

function increment(obj, key) {
  obj[key] = (obj[key] || 0) + 1;
}

async function main() {
  const prisma = new PrismaClient();
  const stats = {
    mode: apply ? 'apply' : 'dry-run',
    totalCandidates: 0,
    checked: 0,
    updatesPlanned: 0,
    updated: 0,
    unchanged: 0,
    wouldReject: 0,
    wouldVerify: 0,
    preservedTrusted: 0,
    badFormat: 0,
    freeEmail: 0,
    blockedMailbox: 0,
    noMx: 0,
    domainMatch: 0,
    businessMailbox: 0,
    mxOnly: 0,
    errors: 0,
    currentStatus: {},
    targetStatus: {},
  };
  const changes = [];

  try {
    const leads = await prisma.lead.findMany({
      where: {
        deletedAt: null,
        contactEmail: { not: null },
      },
      select: {
        id: true,
        companyName: true,
        contactEmail: true,
        website: true,
        websiteDomain: true,
        emailVerificationStatus: true,
        emailVerificationReason: true,
      },
      orderBy: [{ createdAt: 'asc' }],
      ...(Number.isFinite(limit) && limit > 0 ? { take: limit } : {}),
    });

    stats.totalCandidates = leads.length;
    console.log(`${apply ? 'APPLY' : 'DRY-RUN'} verifying ${leads.length} leads with contactEmail`);
    if (!apply) console.log('No database writes will be made. Re-run with --apply to update Lead.emailVerificationStatus.');

    for (let index = 0; index < leads.length; index += 1) {
      const lead = leads[index];
      stats.checked += 1;
      increment(stats.currentStatus, lead.emailVerificationStatus || 'unverified');

      try {
        const evaluated = await evaluateLead(lead);
        const target = chooseTarget(lead, evaluated);
        increment(stats, target.bucket);
        increment(stats.targetStatus, target.status);

        const currentStatus = lead.emailVerificationStatus || 'unverified';
        const currentReason = lead.emailVerificationReason || null;
        const targetReason = target.reason || null;
        const changed = currentStatus !== target.status || currentReason !== targetReason;

        if (target.status === 'rejected') stats.wouldReject += 1;
        if (target.status !== 'rejected') stats.wouldVerify += 1;
        if (target.bucket === 'preservedTrusted') stats.preservedTrusted += 1;

        if (changed) {
          stats.updatesPlanned += 1;
          const change = {
            id: lead.id,
            companyName: lead.companyName,
            contactEmail: lead.contactEmail,
            from: currentStatus,
            to: target.status,
            reason: target.reason,
          };
          if (changes.length < sampleSize) changes.push(change);

          if (apply) {
            await prisma.lead.update({
              where: { id: lead.id },
              data: {
                emailVerificationStatus: target.status,
                emailVerificationReason: target.reason,
              },
            });
            stats.updated += 1;
          }
        } else {
          stats.unchanged += 1;
        }
      } catch (error) {
        stats.errors += 1;
        console.error(`Failed to verify lead ${lead.id}: ${error.message}`);
      }

      if ((index + 1) % 100 === 0 || index + 1 === leads.length) {
        console.log(`Progress ${index + 1}/${leads.length}: planned=${stats.updatesPlanned}, reject=${stats.wouldReject}, verify=${stats.wouldVerify}, errors=${stats.errors}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log('\n=== Summary ===');
  console.log(JSON.stringify(stats, null, 2));
  console.log('\n=== Planned change sample ===');
  console.log(JSON.stringify(changes, null, 2));
}

main().catch((error) => {
  console.error('FAILED:', error);
  process.exitCode = 1;
});
