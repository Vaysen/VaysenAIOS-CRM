#!/usr/bin/env node
/**
 * Vaysen Deep Research CLI
 *
 * Standalone research tool — uses real web search + Zhipu GLM API.
 * Designed to be called from the Vaysen backend via child_process.
 *
 * Usage:
 *   node deep-research-cli.js --company "Desigual" --website "desigual.com" --country "Spain"
 *   node deep-research-cli.js --company "Desigual" --website "desigual.com" --country "Spain" --type contacts
 *   node deep-research-cli.js --company "Desigual" --website "desigual.com" --country "Spain" --type market
 *
 * Output: JSON to stdout (the backend parses this)
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ============================================================
// CONFIG
// ============================================================
const ZHIPU_API_KEY = process.env.ZHIPU_API_KEY;
const ZHIPU_BASE_URL = process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
const ZHIPU_MODEL = process.env.ZHIPU_MODEL || 'glm-4-flash-250414';
const OUTPUT_DIR = process.env.RESEARCH_OUTPUT_DIR || path.join(__dirname, '..', 'research-output');

// ============================================================
// ARG PARSING
// ============================================================
function parseArgs() {
  if (!process.env.ZHIPU_API_KEY) {
    console.error('ERROR: ZHIPU_API_KEY environment variable is required');
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const opts = { type: 'full' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--company' && args[i + 1]) opts.company = args[++i];
    else if (args[i] === '--website' && args[i + 1]) opts.website = args[++i];
    else if (args[i] === '--country' && args[i + 1]) opts.country = args[++i];
    else if (args[i] === '--type' && args[i + 1]) opts.type = args[++i];
  }
  if (!opts.company) { console.error('ERROR: --company is required'); process.exit(1); }
  if (!opts.website) opts.website = `https://${opts.company.toLowerCase().replace(/\s+/g, '')}.com`;
  if (!opts.country) opts.country = 'Unknown';
  return opts;
}

// ============================================================
// HTTP HELPERS (curl argv only; never interpolate URL/header/body into a shell)
// ============================================================
function runCurl(args, timeoutSeconds) {
  const result = spawnSync(process.platform === 'win32' ? 'curl.exe' : 'curl', args, {
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
    timeout: (timeoutSeconds + 5) * 1000,
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw new Error(`curl failed: ${result.error.message}`);
  if (result.status !== 0) {
    if (result.stdout) return { status: result.status || 500, body: result.stdout };
    throw new Error(`curl failed with exit ${result.status}: ${(result.stderr || '').trim()}`);
  }
  return { status: 200, body: result.stdout || '' };
}

function curlGet(url, opts = {}) {
  const timeout = opts.timeout || 15;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/html, */*',
    ...(opts.headers || {}),
  };
  const headerArgs = Object.entries(headers).flatMap(([key, value]) => ['-H', `${key}: ${String(value)}`]);
  return runCurl(['-sS', '-L', '--max-time', String(timeout), ...headerArgs, '--', String(url)], timeout);
}

function curlPost(url, body, opts = {}) {
  const timeout = opts.timeout || 30;
  const headers = {
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  const headerArgs = Object.entries(headers).flatMap(([key, value]) => ['-H', `${key}: ${String(value)}`]);
  const tmpFile = path.join(os.tmpdir(), `vaysen-crm-curl-body-${process.pid}-${Date.now()}.json`);
  try {
    fs.writeFileSync(tmpFile, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    return runCurl([
      '-sS', '-L', '--max-time', String(timeout), ...headerArgs,
      '--data-binary', `@${tmpFile}`, '--', String(url),
    ], timeout);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
}

// ============================================================
// DATA GATHERING
// ============================================================

async function gatherWikipedia(companyName) {
  const variants = [
    companyName,
    companyName + ' (company)',
    companyName + ' Brands',
    companyName.replace(/é/g, 'e'),
  ];
  for (const variant of variants.slice(0, 3)) {
    try {
      const encoded = encodeURIComponent(variant);
      const { body } = curlGet(`https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`);
      const data = JSON.parse(body);
      if (data.type === 'disambiguation') continue;
      if (data.title && data.extract) {
        return {
          title: data.title,
          extract: data.extract?.slice(0, 3000) || '',
          description: data.description || '',
          pageUrl: data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encoded}`,
        };
      }
    } catch { continue; }
  }
  return null;
}

async function gatherDuckDuckGo(query) {
  try {
    const { body } = await curlGet(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
    const results = [];
    const snippetRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = snippetRegex.exec(body))) {
      const title = stripHtml(m[2]);
      const snippet = stripHtml(m[3]);
      const url = m[1].replace(/\/\/duckduckgo\.com\/l\/\?uddg=/, '');
      if (title && url) results.push({ title, url: decodeURIComponent(url), snippet });
      if (results.length >= 10) break;
    }
    return results;
  } catch { return []; }
}

async function gatherSocialMedia(companyName) {
  const social = {};
  const searches = [
    { key: 'linkedin', q: `site:linkedin.com/company "${companyName}"` },
    { key: 'instagram', q: `site:instagram.com "${companyName}" official` },
    { key: 'facebook', q: `site:facebook.com "${companyName}" official` },
    { key: 'twitter', q: `"${companyName}" site:x.com OR site:twitter.com` },
    { key: 'tiktok', q: `site:tiktok.com "${companyName}"` },
  ];

  for (const s of searches.slice(0, 3)) {
    try {
      const results = await gatherDuckDuckGo(s.q);
      if (results.length > 0) {
        social[s.key] = results.slice(0, 2).map(r => ({ title: r.title, url: r.url, snippet: r.snippet }));
      }
    } catch {}
  }
  return social;
}

async function gatherWebsiteInfo(website) {
  try {
    if (!website || website === 'undefined') return { text: '', emails: [], phones: [], socialLinks: {} };
    const url = website.startsWith('http') ? website : `https://${website}`;
    const { body } = await curlGet(url);
    const text = stripHtml(body).slice(0, 15000);

    // Extract emails
    const emails = (body.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])
      .filter(e => !e.includes('example') && !e.includes('sentry') && !e.includes('wixpress'))
      .map(e => e.toLowerCase());
    const uniqueEmails = [...new Set(emails)].slice(0, 10);

    // Extract phones
    const phones = (text.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{2,4}[-.\s]?\d{2,4}[-.\s]?\d{0,4}/g) || [])
      .filter(p => p.replace(/[\s\-().]/g, '').length >= 7).slice(0, 5);

    // Extract social links from HTML
    const socialLinks = {};
    const linkRegex = /href=["']([^"']*(?:instagram|linkedin|facebook|twitter|tiktok|youtube)[^"']*)["']/gi;
    let m;
    while ((m = linkRegex.exec(body))) {
      const href = m[1].toLowerCase();
      if (href.includes('instagram')) socialLinks.instagram = href;
      else if (href.includes('linkedin')) socialLinks.linkedin = href;
      else if (href.includes('facebook')) socialLinks.facebook = href;
      else if (href.includes('twitter') || href.includes('x.com')) socialLinks.twitter = href;
      else if (href.includes('tiktok')) socialLinks.tiktok = href;
      else if (href.includes('youtube')) socialLinks.youtube = href;
    }

    return { text: text.slice(0, 10000), emails: uniqueEmails, phones, socialLinks };
  } catch (err) {
    return { text: `Failed: ${err.message}`, emails: [], phones: [], socialLinks: {} };
  }
}

async function gatherSimilarweb(domain) {
  if (!domain) return null;
  try {
    const { body } = await curlGet(`https://www.similarweb.com/website/${domain}/`, {
      headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    });

    const text = stripHtml(body);

    // Parse key metrics
    const data = {};
    const visitMatch = text.match(/(\d[\d,.]*[MBK]?)\s*(?:visits|Total Visits|Visits)/i);
    if (visitMatch) data.monthlyVisits = visitMatch[1];

    const bounceMatch = text.match(/([\d.]+%)\s*(?:bounce|Bounce)/i);
    if (bounceMatch) data.bounceRate = bounceMatch[1];

    const pagesMatch = text.match(/([\d.]+)\s*(?:pages|Pages)\s*(?:per|Per)/i);
    if (pagesMatch) data.pagesPerVisit = pagesMatch[1];

    const durationMatch = text.match(/(\d+m\s*\d+s|\d+:\d+)\s*(?:visit|Avg|Average)/i);
    if (durationMatch) data.avgDuration = durationMatch[1];

    // Country distribution
    const countryMatches = text.match(/([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)\s*(\d+\.?\d*)%/g);
    if (countryMatches) data.topCountries = countryMatches.slice(0, 5).map(c => c.replace(/\s*\d+\.?\d*%$/, ''));

    // Traffic sources
    const sources = [];
    if (text.includes('Organic')) sources.push('Organic Search');
    if (text.includes('Direct')) sources.push('Direct');
    if (text.includes('Social')) sources.push('Social Media');
    if (text.includes('Referral')) sources.push('Referrals');
    if (text.includes('Paid')) sources.push('Paid Search');
    if (sources.length > 0) data.trafficSources = sources;

    return Object.keys(data).length > 0 ? data : null;
  } catch { return null; }
}

async function gatherBusinessInfo(companyName, country) {
  const results = [];
  try {
    // Search for business registration
    const queries = [
      `"${companyName}" "revenue" OR "employees" OR "founded"`,
      `"${companyName}" ${country} company registration`,
    ];
    for (const q of queries.slice(0, 2)) {
      const r = await gatherDuckDuckGo(q);
      results.push(...r.slice(0, 3));
    }
  } catch {}
  return results;
}

// ============================================================
// ZHIPU GLM API CALL
// ============================================================

function buildSystemPrompt(type) {
  const prompts = {
    full: `你是一位资深的国际B2B包装行业客户背调分析师。Vaysen包装（Vaysen Packaging）主营快递袋、牛皮纸袋、垃圾袋、自封袋及其他可定制软包装。请根据提供的真实网络数据，用中文撰写一份专业的客户背景调查报告，并从重复采购、定制需求、材质、尺寸、印刷、MOQ与交付条件评估合作匹配度。

必须输出严格的JSON格式：
{
  "executiveSummary": "一段话总结客户情况（100-200字）",
  "companyBasicInfo": {"legalName":"","country":"","founded":"","companyType":"","registrationStatus":"","employeeCount":"","annualRevenue":"","headquarters":""},
  "businessAddressAnalysis": {"registeredAddress":"","operatingAddress":"","addressType":"","isRealOffice":false,"notes":""},
  "marketAnalysis": {"targetMarkets":[],"targetCustomerProfile":"","brandPositioning":"","priceRange":"","mainProductLines":[],"stylePreference":""},
  "socialMediaAudit": {"platforms":[{"platform":"","handle":"","followers":"","engagement":"","notes":""}],"overallAssessment":""},
  "websiteAnalysis": {"platform":"","isShopify":false,"hasOnlineStore":false,"trafficEstimate":"","notes":""},
  "salesEstimate": {"monthlyTraffic":"","conversionRate":"","estimatedMonthlySales":"","estimatedAnnualSales":""},
  "keyContacts": {"confirmed":[{"name":"","title":"","email":"","phone":"","linkedin":"","source":"","backgroundAnalysis":""}],"unconfirmed":[{"name":"","title":"","email":"","howToVerify":""}]},
  "riskAssessment": {"companyLegitimacy":{"score":3,"maxScore":5,"notes":""},"brandMaturity":{"score":3,"maxScore":5,"notes":""},"procurementPotential":{"score":3,"maxScore":5,"notes":""},"overallScore":0,"overallGrade":"","recommendation":""},
  "cooperationStrategy": {"shortTerm":"","midTerm":"","longTerm":"","recommendedProducts":[],"emailAngles":[],"nextActions":[]},
  "dataSources":[]
}

⚠️ 核心规则：
- 你收到的数据是真实的网络采集数据，不是幻觉
- Wikipedia提供了公司基本信息 → 务必使用！不要写"未确认"
- 网站采集到了邮箱和社媒链接 → 务必在报告中列出
- DuckDuckGo搜索结果中如果有相关信息 → 引用它
- 只有真的在所有数据源中都找不到的信息才能写"未确认"
- 所有字段输出中文，但公司名/品牌名/URL保留原文`,

    contacts: `你是外贸B2B联系人挖掘专家。请根据提供的真实网络数据，深度挖掘可联系的关键人。

输出JSON格式：
{
  "keyContacts": {"confirmed":[{"name":"","title":"","email":"","phone":"","linkedin":"","whatsapp":"","source":""}],"unconfirmed":[{"name":"","title":"","email":"","linkedin":"","howToVerify":""}]},
  "socialProfiles": [{"name":"","platform":"","handle":"","url":""}],
  "emailPatterns": "分析该公司邮箱格式规律"
}
从网络采集数据中提取所有可用的联系方式。不要编造。`,

    market: `你是国际B2B包装行业市场分析师。从快递袋、牛皮纸袋、垃圾袋、自封袋及可定制软包装的采购场景分析客户商业模式和匹配策略。

输出JSON：
{
  "businessModel": {"type":"","platform":"","targetMarket":"","marketingChannels":""},
  "marketPosition": {"positioning":"","competitors":[],"differentiation":""},
  "productMatch": {"score":0,"recommendedProducts":[],"recommendedMaterials":"","recommendedPrice":"","cooperationModel":""},
  "cooperationStrategy": {"shortTerm":"","midTerm":"","longTerm":"","riskWarning":""},
  "pitchAngles": [{"subject":"","angle":"","keyPoints":[]}]
}
产品匹配度0-100分。根据真实数据给出具体建议。`
  };
  return prompts[type] || prompts.full;
}

async function callZhipu(systemPrompt, userPrompt) {
  const url = `${ZHIPU_BASE_URL}/chat/completions`;
  const body = JSON.stringify({
    model: ZHIPU_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.3,
    max_tokens: 8000,
  });

  const response = curlPost(url, body, {
    headers: { 'Authorization': `Bearer ${ZHIPU_API_KEY}` },
    timeout: 60,
  });

  const data = JSON.parse(response.body);
  if (data.error) throw new Error(`Zhipu GLM API error: ${data.error.message}`);
  const content = data.choices?.[0]?.message?.content || '{}';
  return parseJSON(content);
}

function parseJSON(content) {
  const clean = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  try { return JSON.parse(clean); } catch {
    const match = clean.match(/\{[\s\S]*\}/);
    try { return match ? JSON.parse(match[0]) : {}; } catch { return {}; }
  }
}

// ============================================================
// HTML GENERATION
// ============================================================

function generateHtml(json, leadInfo, type) {
  const now = new Date().toLocaleDateString('zh-CN');
  const css = `<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif;font-size:14px;line-height:1.8;color:#1a1a2e;background:#f8f9fa}
.report-container{max-width:900px;margin:0 auto;padding:40px 30px;background:#fff;box-shadow:0 2px 20px rgba(0,0,0,0.08)}
h1{font-size:26px;color:#1e3a5f;border-bottom:3px solid #2563eb;padding-bottom:12px;margin-bottom:8px}
h2{font-size:19px;color:#1e40af;margin:25px 0 12px;padding-left:10px;border-left:4px solid #2563eb}
h3{font-size:15px;color:#374151;margin:12px 0 8px}
.data-table{width:100%;border-collapse:collapse;margin:10px 0}
.data-table td{padding:8px 12px;border:1px solid #e5e7eb}
.data-table td:first-child{background:#f0f4ff;font-weight:600;width:28%;color:#1e3a5f}
.contact-card{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px 16px;margin:8px 0}
.source{font-size:11px;color:#9ca3af;display:block;margin-top:4px}
.note{font-size:12px;color:#6b7280;margin-top:8px;font-style:italic}
.risk-item{margin:6px 0;font-size:15px}
.overall-score{font-size:18px;margin:15px 0 8px;padding:10px;background:#f8fafc;border-radius:6px}
.match-score{font-size:48px;font-weight:700;text-align:center;margin:15px 0}
.footer{margin-top:40px;padding-top:20px;border-top:2px solid #e5e7eb;font-size:11px;color:#9ca3af;text-align:center}
.subtitle{font-size:13px;color:#6b7280;margin-bottom:20px}
@media print{body{background:#fff}.report-container{box-shadow:none;max-width:100%}}
</style>`;

  // Build data source badges
  const sources = [];
  if (json._gathered?.wikipedia) sources.push('Wikipedia ✅');
  else sources.push('Wikipedia ❌');
  if (json._gathered?.similarweb) sources.push('Similarweb ✅');
  else sources.push('Similarweb ❌');
  if (json._gathered?.website?.emails?.length > 0) sources.push('官网采集 ✅');
  else sources.push('官网采集 ❌');
  if (json._gathered?.socialMedia) sources.push('社媒搜索 ✅');
  sources.push('DuckDuckGo搜索', '智谱 GLM 分析');

  // Build sections based on type
  let bodyHtml = '';
  if (type === 'full' || type === undefined) {
    bodyHtml = buildFullReportHtml(json, leadInfo);
  } else if (type === 'contacts') {
    bodyHtml = buildContactsHtml(json, leadInfo);
  } else if (type === 'market') {
    bodyHtml = buildMarketHtml(json, leadInfo);
  }

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${esc(leadInfo.companyName)} — 客户背调报告</title>${css}</head><body>
<div class="report-container">
<h1>客户背景调查报告</h1>
<div class="subtitle">调查对象：${esc(leadInfo.companyName)} | 报告日期：${now} | 调查范围：公司实体 / 经营地址 / 主要市场 / 独立站 / 流量分析 / 联络人</div>
<div class="subtitle">数据来源：${sources.join(' | ')}</div>
${bodyHtml}
<div class="footer"><p>本报告基于公开可查的网络信息编制，仅供参考。</p><p>Generated by Vaysen 外贸系统 — AI Deep Research Engine</p></div>
</div></body></html>`;
}

function buildFullReportHtml(r, lead) {
  const sections = [
    ['一、执行摘要', r.executiveSummary ? `<p>${esc(r.executiveSummary)}</p>` : ''],
    ['二、公司基本信息', buildTable([
      ['公司名称', r.companyBasicInfo?.legalName || lead.companyName],
      ['注册国家', r.companyBasicInfo?.country || '未确认'],
      ['成立时间', r.companyBasicInfo?.founded || '未确认'],
      ['总部', r.companyBasicInfo?.headquarters || '未确认'],
      ['公司类型', r.companyBasicInfo?.companyType || '未确认'],
      ['员工规模', r.companyBasicInfo?.employeeCount || '未确认'],
      ['年营收', r.companyBasicInfo?.annualRevenue || '未确认'],
    ])],
    ['三、经营地址分析', buildTable([
      ['注册地址', r.businessAddressAnalysis?.registeredAddress || '未确认'],
      ['经营地址', r.businessAddressAnalysis?.operatingAddress || '未确认'],
      ['地址类型', r.businessAddressAnalysis?.addressType || '未确认'],
    ]) + (r.businessAddressAnalysis?.notes ? `<p class="note">${esc(r.businessAddressAnalysis.notes)}</p>` : '')],
    ['四、市场分析', `<p>目标市场：${esc(arr(r.marketAnalysis?.targetMarkets))}</p><p>客户画像：${esc(r.marketAnalysis?.targetCustomerProfile || '')}</p><p>品牌定位：${esc(r.marketAnalysis?.brandPositioning || '')}</p><p>价格区间：${esc(r.marketAnalysis?.priceRange || '')}</p><p>主营产品：${esc(arr(r.marketAnalysis?.mainProductLines))}</p>`],
    ['五、社交媒体与在线渠道', buildSocialTable(r.socialMediaAudit?.platforms)],
    ['六、网站与流量分析', buildTable([
      ['网站平台', r.websiteAnalysis?.platform || '未确认'],
      ['是否有商城', r.websiteAnalysis?.hasOnlineStore ? '有' : '未确认'],
      ['流量估算', r.websiteAnalysis?.trafficEstimate || r.salesEstimate?.monthlyTraffic || '未确认'],
    ]) + (r.websiteAnalysis?.notes ? `<p class="note">${esc(r.websiteAnalysis.notes)}</p>` : '')],
    ['七、销量估算', buildTable([
      ['月访问量', r.salesEstimate?.monthlyTraffic || '未确认'],
      ['转化率参考', r.salesEstimate?.conversionRate || '未确认'],
      ['预估月销量', r.salesEstimate?.estimatedMonthlySales || '未确认'],
    ])],
    ['八、关键联系人', buildContactsSection(r.keyContacts)],
    ['九、风险评估', buildRiskSection(r.riskAssessment)],
    ['十、合作建议', `<p><strong>短期：</strong>${esc(r.cooperationStrategy?.shortTerm || '')}</p><p><strong>中期：</strong>${esc(r.cooperationStrategy?.midTerm || '')}</p><p><strong>长期：</strong>${esc(r.cooperationStrategy?.longTerm || '')}</p><p><strong>推荐产品：</strong>${esc(arr(r.cooperationStrategy?.recommendedProducts))}</p><p><strong>邮件角度：</strong>${esc(arr(r.cooperationStrategy?.emailAngles))}</p><p><strong>下一步：</strong>${esc(arr(r.cooperationStrategy?.nextActions))}</p>`],
  ];

  return sections.map(([title, content]) => content ? `<h2>${title}</h2>${content}` : '').join('');
}

function buildContactsHtml(r, lead) {
  return `
<h2>一、挖掘总结</h2>
<p>共发现 <strong>${r.keyContacts?.confirmed?.length || 0}</strong> 个已确认联系人。</p>
${buildContactsSection(r.keyContacts)}
<h2>二、社交媒体发现</h2>
${(r.socialProfiles || []).map(p => `<p>• ${esc(p.name)} — ${esc(p.platform)}: <a href="${esc(p.url)}">${esc(p.handle || p.url)}</a></p>`).join('')}
<h2>三、邮箱格式分析</h2>
<p>${esc(r.emailPatterns || '未检测到明确格式')}</p>`;
}

function buildMarketHtml(r, lead) {
  return `
<h2>一、商业模式分析</h2>
${buildTable([['商业模式', r.businessModel?.type || ''],['网站平台', r.businessModel?.platform || ''],['目标市场', r.businessModel?.targetMarket || ''],['营销渠道', r.businessModel?.marketingChannels || '']])}
<h2>二、市场定位</h2>
<p>${esc(r.marketPosition?.positioning || '')}</p><p>竞品：${esc(arr(r.marketPosition?.competitors))}</p>
<h2>三、产品匹配度</h2>
<div class="match-score" style="color:${(r.productMatch?.score || 0) >= 70 ? '#22c55e' : (r.productMatch?.score || 0) >= 40 ? '#f59e0b' : '#ef4444'}">${r.productMatch?.score || 0}/100</div>
<p>推荐产品：${esc(arr(r.productMatch?.recommendedProducts))}</p>
<p>合作模式：${esc(r.productMatch?.cooperationModel || '')}</p>
<h2>四、开发信角度</h2>
${(r.pitchAngles || []).map(a => `<p>• <strong>${esc(a.subject)}</strong> — ${esc(a.angle)}</p>`).join('')}`;
}

// ============================================================
// HTML BUILDERS
// ============================================================

function buildTable(rows) {
  let html = '<table class="data-table">';
  for (const [k, v] of rows) {
    html += `<tr><td>${esc(k)}</td><td>${esc(String(v || '未确认'))}</td></tr>`;
  }
  return html + '</table>';
}

function buildSocialTable(platforms) {
  if (!platforms?.length) return '<p>未找到社交媒体数据</p>';
  let html = '<table class="data-table"><tr><th>平台</th><th>账号</th><th>粉丝</th><th>备注</th></tr>';
  for (const p of platforms) {
    html += `<tr><td>${esc(p.platform)}</td><td>${esc(p.handle)}</td><td>${p.followers || '-'}</td><td>${esc(p.notes || '')}</td></tr>`;
  }
  return html + '</table>';
}

function buildContactsSection(kc) {
  if (!kc) return '<p>未找到联系人数据</p>';
  let html = '';
  const confirmed = kc.confirmed || [];
  if (confirmed.length > 0) {
    html += '<h3>已确认联系人</h3>';
    for (const c of confirmed) {
      html += `<div class="contact-card">
<div>👤 <strong>${esc(c.name)}</strong>${c.title ? ` — ${esc(c.title)}` : ''}</div>
${c.email ? `<div>📧 <a href="mailto:${esc(c.email)}">${esc(c.email)}</a></div>` : ''}
${c.phone ? `<div>📱 ${esc(c.phone)}</div>` : ''}
${c.linkedin ? `<div>🔗 <a href="${esc(c.linkedin)}">LinkedIn</a></div>` : ''}
${c.whatsapp ? `<div>💬 WhatsApp: ${esc(c.whatsapp)}</div>` : ''}
<span class="source">来源：${esc(c.source || '网络搜索')}</span></div>`;
    }
  }
  const unconfirmed = kc.unconfirmed || [];
  if (unconfirmed.length > 0) {
    html += '<h3>待确认联系人</h3>';
    for (const c of unconfirmed) {
      html += `<p>• ${esc(c.name)} — ${esc(c.title || '未知职位')} — 验证：${esc(c.howToVerify || '通过LinkedIn确认')}</p>`;
    }
  }
  return html || '<p>未找到联系人数据</p>';
}

function buildRiskSection(ra) {
  if (!ra) return '';
  const dims = [
    ['公司正规性', ra.companyLegitimacy],
    ['品牌成熟度', ra.brandMaturity],
    ['采购潜力', ra.procurementPotential],
  ];
  let html = '';
  for (const [label, dim] of dims) {
    if (!dim) continue;
    const score = typeof dim === 'object' ? dim.score : dim;
    const color = score >= 4 ? '#22c55e' : score >= 2 ? '#f59e0b' : '#ef4444';
    html += `<div class="risk-item"><span>${label}：</span><span style="color:${color};font-size:20px">${'★'.repeat(Math.min(5, score))}${'☆'.repeat(Math.max(0, 5 - score))}</span><span>(${score}/5)</span></div>`;
    if (typeof dim === 'object' && dim.notes) html += `<p class="note">${esc(dim.notes)}</p>`;
  }
  html += `<div class="overall-score">综合评分：<strong>${ra.overallScore || '-'}</strong> — ${esc(ra.overallGrade || '')}</div>`;
  html += `<p class="note">${esc(ra.recommendation || '')}</p>`;
  return html;
}

// ============================================================
// HELPERS
// ============================================================

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function arr(a) {
  if (!a) return '';
  return Array.isArray(a) ? a.join('、') : String(a);
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const opts = parseArgs();
  console.error(`[deep-research-cli] Starting research for: ${opts.company}`);

  // Phase 1: Gather data in parallel
  console.error('[1/4] Gathering data...');
  const domain = (opts.website || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');

  const [wikipedia, socialMedia, websiteInfo, similarweb, businessInfo] = await Promise.allSettled([
    gatherWikipedia(opts.company),
    gatherSocialMedia(opts.company),
    gatherWebsiteInfo(opts.website),
    gatherSimilarweb(domain),
    gatherBusinessInfo(opts.company, opts.country),
  ]);

  const gathered = {
    wikipedia: wikipedia.status === 'fulfilled' ? wikipedia.value : null,
    socialMedia: socialMedia.status === 'fulfilled' ? socialMedia.value : {},
    website: websiteInfo.status === 'fulfilled' ? websiteInfo.value : { text: '', emails: [], phones: [], socialLinks: {} },
    similarweb: similarweb.status === 'fulfilled' ? similarweb.value : null,
    businessInfo: businessInfo.status === 'fulfilled' ? businessInfo.value : [],
  };

  console.error(`  Wikipedia: ${gathered.wikipedia ? 'OK' : 'FAIL'}`);
  console.error(`  Social Media: ${Object.keys(gathered.socialMedia).length} platforms`);
  console.error(`  Website: ${gathered.website.emails.length} emails, ${Object.keys(gathered.website.socialLinks).length} social links`);
  console.error(`  Similarweb: ${gathered.similarweb ? 'OK' : 'FAIL'}`);

  // Phase 2: AI Analysis via Zhipu GLM
  console.error('[2/4] AI analysis via Zhipu GLM...');
  const userPrompt = `
## 客户基本信息
公司名：${opts.company}
网站：${opts.website}
国家：${opts.country}

## Wikipedia数据（权威来源）
${JSON.stringify(gathered.wikipedia, null, 2)}

## Similarweb流量数据
${JSON.stringify(gathered.similarweb, null, 2)}

## 官网采集数据
网站文本摘要：${gathered.website.text?.slice(0, 8000) || '无'}
提取的邮箱：${JSON.stringify(gathered.website.emails)}
提取的电话：${JSON.stringify(gathered.website.phones)}
官网社媒链接：${JSON.stringify(gathered.website.socialLinks)}

## 社媒搜索结果
${JSON.stringify(gathered.socialMedia, null, 2)}

## 商业信息搜索
${JSON.stringify(gathered.businessInfo?.slice(0, 5), null, 2)}

⚠️ 重要：Wikipedia数据是权威来源，如果提供了公司基本信息（成立年份、CEO、营收等），务必在报告中引用。不要因为无法验证就写"未确认"——Wikipedia数据本身就是可靠的验证来源。

请生成完整报告。`;

  let aiResult;
  try {
    aiResult = await callZhipu(buildSystemPrompt(opts.type), userPrompt);
    console.error('  AI analysis complete');
  } catch (err) {
    console.error(`  Zhipu GLM error: ${err.message}`);
    process.exit(1);
  }

  // Attach gathered data to result
  aiResult._gathered = {
    wikipedia: !!gathered.wikipedia,
    similarweb: !!gathered.similarweb,
    website: gathered.website,
    socialMedia: !!Object.keys(gathered.socialMedia).length,
  };

  // Phase 3: Generate HTML
  console.error('[3/4] Generating HTML report...');
  const html = generateHtml(aiResult, opts, opts.type);

  // Phase 4: Save to file + output JSON
  console.error('[4/4] Saving...');
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const safeName = opts.company.replace(/[^a-zA-Z0-9一-鿿]/g, '-');
  const htmlFile = path.join(OUTPUT_DIR, `${safeName}-${Date.now()}.html`);
  fs.writeFileSync(htmlFile, html, 'utf8');
  console.error(`  HTML saved: ${htmlFile}`);

  // Output JSON to stdout
  const output = {
    success: true,
    html,
    json: aiResult,
    title: `${opts.company} — 客户背调报告`,
    htmlFile,
    sources: {
      wikipedia: !!gathered.wikipedia,
      similarweb: !!gathered.similarweb,
      websiteEmails: gathered.website.emails.length,
      websiteSocialLinks: Object.keys(gathered.website.socialLinks).length,
      socialMediaPlatforms: Object.keys(gathered.socialMedia).length,
    },
  };

  process.stdout.write(JSON.stringify(output));
  console.error('[deep-research-cli] Complete.');
}

main().catch(err => {
  console.error(`FATAL: ${err.message}`);
  process.stdout.write(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
