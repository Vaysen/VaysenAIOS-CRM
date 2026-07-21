#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { businessContext, parseJsonValue, runClaude } = require('./claude-cli-runtime');

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { type: 'full', website: '', country: 'Unknown' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--company' && argv[i + 1]) opts.company = argv[++i];
    else if (argv[i] === '--website' && argv[i + 1]) opts.website = argv[++i];
    else if (argv[i] === '--country' && argv[i + 1]) opts.country = argv[++i];
    else if (argv[i] === '--type' && argv[i + 1]) opts.type = argv[++i];
  }
  if (!opts.company) throw new Error('--company is required');
  return opts;
}

function buildResearchPrompt(opts, env = process.env) {
  const business = businessContext(env);
  return `Use WebSearch and WebFetch to research this prospective B2B packaging buyer for ${business.brandName}.

Seller context: ${business.description}.
Product focus: ${business.productFocus}.
Prospect: ${opts.company}
Website: ${opts.website || 'find the official website'}
Country: ${opts.country}
Report type: ${opts.type}

Return ONLY strict JSON. Every factual field must have public evidence. Do not invent emails, contacts, phones, revenue, employee counts or social links. Use empty values for unverified facts.
Required keys: companyName, officialWebsite, country, headquarters, founded, founder, ceo, employees, revenue, businessModel, productLines, targetFit, contacts, socialMedia, marketSignals, tradeSignals, risks, recommendedFollowUp, unverified_flags, sources.
Each factual object should include value and source_url. Explain targetFit specifically against the dynamic packaging product focus above.`;
}

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function valueOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value.value || value.summary || value.url || '' : value || '';
}

function renderHtml(data, opts, warning = '') {
  const list = (items) => (Array.isArray(items) ? items : []).map((item) => `<li>${escapeHtml(valueOf(item))}</li>`).join('');
  const contacts = (Array.isArray(data.contacts) ? data.contacts : []).map((contact) =>
    `<li>${escapeHtml(contact.name)} ${escapeHtml(contact.title)} ${escapeHtml(contact.email)} ${escapeHtml(contact.source_url)}</li>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(opts.company)} - AI 客户背调</title></head><body>
<h1>${escapeHtml(valueOf(data.companyName) || opts.company)} - AI 客户背调</h1>
${warning ? `<p>部分失败：${escapeHtml(warning)}</p>` : ''}
<p>官网：${escapeHtml(valueOf(data.officialWebsite) || opts.website)}</p><p>国家：${escapeHtml(valueOf(data.country) || opts.country)}</p>
<p>业务模式：${escapeHtml(valueOf(data.businessModel))}</p><p>包装采购匹配：${escapeHtml(valueOf(data.targetFit))}</p>
<h2>产品线</h2><ul>${list(data.productLines)}</ul><h2>联系人</h2><ul>${contacts}</ul>
<h2>市场与贸易信号</h2><ul>${list(data.marketSignals)}${list(data.tradeSignals)}</ul>
<h2>风险</h2><ul>${list(data.risks)}</ul><h2>建议</h2><ul>${list(data.recommendedFollowUp)}</ul>
<h2>来源</h2><ul>${list(data.sources)}</ul></body></html>`;
}

function main(argv = process.argv.slice(2), env = process.env) {
  try {
    const opts = parseArgs(argv);
    const result = runClaude(buildResearchPrompt(opts, env), {
      env,
      purpose: 'research',
      maxTurns: 12,
      timeout: Number(env.CLAUDE_RESEARCH_TIMEOUT_MS || 600000),
    });
    const data = result.success ? parseJsonValue(result.stdout, '{', '}') : null;
    const json = data && typeof data === 'object' ? data : {
      companyName: opts.company,
      officialWebsite: opts.website,
      country: opts.country,
      risks: ['AI research did not return verified structured data.'],
      recommendedFollowUp: ['Retry after checking Claude CLI credentials and network access.'],
      sources: [],
    };
    const error = data ? '' : result.error || 'Claude output was not valid JSON';
    const html = renderHtml(json, opts, error);
    const outputDir = env.RESEARCH_OUTPUT_DIR || path.join(os.tmpdir(), 'vaysen-crm-research-output');
    fs.mkdirSync(outputDir, { recursive: true });
    const safeName = opts.company.replace(/[^\w.-]+/g, '-').slice(0, 80) || 'research';
    const htmlFile = path.join(outputDir, `${safeName}-${Date.now()}.html`);
    fs.writeFileSync(htmlFile, html, 'utf8');
    process.stdout.write(JSON.stringify({
      success: Boolean(data), error: error || undefined, title: `${opts.company} - AI 客户背调`, html, htmlFile, json,
      sources: {
        contactEmail: Array.isArray(json.contacts) && json.contacts.some((contact) => contact.email),
        socialMedia: Array.isArray(json.socialMedia) ? json.socialMedia.length : 0,
        sourceCount: Array.isArray(json.sources) ? json.sources.length : 0,
      },
    }));
    // A structured partial report is a valid transport response; callers inspect
    // the success/error fields and can still present the diagnostic safely.
    return 0;
  } catch (error) {
    console.error(`[claude-research] ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { buildResearchPrompt, main, parseArgs, renderHtml };
