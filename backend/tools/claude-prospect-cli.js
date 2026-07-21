#!/usr/bin/env node
'use strict';

const { businessContext, parseJsonValue, runClaude } = require('./claude-cli-runtime');

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { count: 10, batch: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--country' && argv[i + 1]) opts.country = argv[++i];
    else if (argv[i] === '--profile' && argv[i + 1]) opts.profile = argv[++i];
    else if (argv[i] === '--keywords' && argv[i + 1]) opts.keywords = argv[++i];
    else if (argv[i] === '--count' && argv[i + 1]) opts.count = Math.max(1, Math.min(20, Number(argv[++i]) || 10));
    else if (argv[i] === '--batch' && argv[i + 1]) opts.batch = Number(argv[++i]) || 1;
    else if (argv[i] === '--exclude' && argv[i + 1]) opts.exclude = argv[++i];
  }
  if (!opts.country) throw new Error('--country is required');
  return opts;
}

function isServiceEmail(email) {
  const [local = '', domain = ''] = String(email || '').toLowerCase().split('@');
  const freeDomains = new Set([
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
    'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com',
    'qq.com', '163.com', '126.com', 'foxmail.com',
  ]);
  return freeDomains.has(domain)
    || /^(customer\.?service|customerservice|consumer\.?service|consumerservice|support|help|service|returns?|privacy|legal|abuse|security|noreply|no-reply|do-not-reply|donotreply|webmaster|postmaster|info|contact|hello)$/i.test(local);
}

function normalize(items, country) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && typeof item === 'object' && !/[\u3400-\u9fff]/.test(JSON.stringify(item)))
    .map((item) => {
      const email = String(item.contactEmail || '').split(/[,\s;]/)
        .find((value) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) && !isServiceEmail(value)) || '';
      return {
        title: item.title || item.companyName || '',
        url: item.url || item.website || '',
        snippet: item.snippet || item.whyTarget || item.summary || '',
        companyName: item.companyName || item.title || '',
        country: item.country || country,
        contactEmail: email,
        contactPerson: item.contactPerson || item.contactName || '',
        contactTitle: item.contactTitle || '',
        contactPhone: item.contactPhone || '',
        whatsapp: item.whatsapp || '',
        industryCategory: item.industryCategory || item.customerType || '',
        confidenceScore: Number(item.confidenceScore || 0),
        mainProducts: item.mainProducts || '',
        whyTarget: item.whyTarget || '',
        linkedin: item.linkedin || '', facebook: item.facebook || '', instagram: item.instagram || '',
        twitter: item.twitter || item.x || '', pinterest: item.pinterest || '', reddit: item.reddit || '',
        youtube: item.youtube || '', tiktok: item.tiktok || '', otherSocial: item.otherSocial || '',
        source: item.source || item.emailSource || '',
        emailSource: item.emailSource || item.source || '',
        emailConfidence: item.emailConfidence || 'Unverified public-source candidate',
      };
    })
    .filter((item) => item.companyName && item.url && item.contactEmail);
}

function buildProspectPrompt(opts, env = process.env) {
  const business = businessContext(env);
  return `You are a strict international B2B customer discovery agent for ${business.brandName}, ${business.description}.

Find ${opts.count} real prospective buyers in ${opts.country} for: ${opts.keywords || business.productFocus}.
Dynamic customer profile: ${opts.profile || 'packaging importers, distributors, brand owners, retailers and e-commerce fulfillment businesses'}.
Exclude: ${opts.exclude || 'China, Hong Kong, Taiwan, marketplaces, directories and free-mailbox contacts'}.
Batch: ${opts.batch}. Find different companies from earlier batches.

Use WebSearch and WebFetch. Verify each company against its official website. Every result must have a public business-domain email and a source URL. Never invent facts or contacts. Reject free mailboxes and service-only addresses. Return English facts only.

Return ONLY a strict JSON array of at most ${opts.count} objects with these keys:
companyName, website, country, contactEmail, contactPerson, contactTitle, contactPhone, industryCategory, confidenceScore, mainProducts, whyTarget, linkedin, facebook, instagram, twitter, pinterest, reddit, youtube, tiktok, otherSocial, emailSource, emailConfidence.`;
}

function main(argv = process.argv.slice(2), env = process.env) {
  try {
    const opts = parseArgs(argv);
    const result = runClaude(buildProspectPrompt(opts, env), {
      env,
      purpose: 'prospect',
      maxTurns: 10,
      timeout: Number(env.CLAUDE_PROSPECT_TIMEOUT_MS || 300000),
    });
    if (!result.success) {
      console.error(`[claude-prospect] ${result.error}`);
      process.stdout.write('[]');
      return 1;
    }
    const prospects = normalize(parseJsonValue(result.stdout, '[', ']'), opts.country);
    process.stderr.write(`[claude-prospect] Accepted ${prospects.length} evidence-backed prospects\n`);
    process.stdout.write(JSON.stringify(prospects));
    return 0;
  } catch (error) {
    console.error(`[claude-prospect] ${error.message}`);
    process.stdout.write('[]');
    return 1;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { buildProspectPrompt, main, normalize, parseArgs };
