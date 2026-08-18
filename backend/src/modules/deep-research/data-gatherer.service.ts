import { Injectable, Logger } from '@nestjs/common';
import { isIP } from 'node:net';
import { completeAiJson } from '@/common/ai/ai-client.util';
import { searchTrustedSearxng } from '@/common/http/trusted-searxng-client';
import { safeErrorCategory, safeLogEvent } from '@/common/security/safe-logging';

export const RESEARCH_EVIDENCE_FAILURE_CODE = 'RESEARCH_EVIDENCE_COLLECTION_FAILED';
export const RESEARCH_EVIDENCE_FAILURE_MESSAGE = 'Deep research evidence collection failed';

const SEARCH_FAILURE_CODES = new Set([
  'RESEARCH_SEARCH_TIMEOUT',
  'RESEARCH_SEARCH_INVALID_RESPONSE',
  'RESEARCH_SEARCH_RESPONSE_TOO_LARGE',
  'RESEARCH_SEARCH_FAILED',
]);

type StableResearchError = Error & { code?: string };

export function createResearchEvidenceError(
  code: string = RESEARCH_EVIDENCE_FAILURE_CODE,
  message: string = RESEARCH_EVIDENCE_FAILURE_MESSAGE,
): StableResearchError {
  const error = new Error(message) as StableResearchError;
  error.code = code;
  return error;
}

function stableResearchErrorCode(error: unknown) {
  const code = typeof error === 'object' && error !== null
    ? String((error as { code?: unknown }).code || '')
    : '';
  return SEARCH_FAILURE_CODES.has(code) ? code : RESEARCH_EVIDENCE_FAILURE_CODE;
}

export interface GatheredData {
  raw: string;
  html?: string;
  json?: any;
  error?: string;
  errorCode?: string;
}

interface SearchEvidence {
  title: string;
  url: string;
  snippet: string;
}

const FINDING_CATEGORIES = [
  'company_profile',
  'registration',
  'operations',
  'market',
  'risk',
  'compliance',
  'contact',
  'product',
  'reputation',
] as const;

type FindingCategory = (typeof FINDING_CATEGORIES)[number];

interface EvidenceBackedFinding {
  category: FindingCategory;
  claim: string;
  supportingExcerpt: string;
  sourceUrls: string[];
}

interface EvidenceBackedResearch {
  summary: string | null;
  summarySources: string[];
  findings: EvidenceBackedFinding[];
}

const SEARCH_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_EVIDENCE_RESULTS = 8;
const MAX_TITLE_LENGTH = 300;
const MAX_SNIPPET_LENGTH = 1_200;
const MAX_SUMMARY_LENGTH = 1_500;
const MAX_FINDING_LENGTH = 800;
const MAX_SUPPORTING_EXCERPT_LENGTH = 400;
const MAX_FINDINGS = 24;
const MAX_CITATIONS_PER_ITEM = 8;

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function compactText(value: unknown, maxLength: number) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function isPrivateIpv4(hostname: string) {
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateHostname(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.lan') ||
    host.endsWith('.internal')
  ) {
    return true;
  }

  const ipVersion = isIP(host);
  if (ipVersion === 4) return isPrivateIpv4(host);
  if (ipVersion === 6) {
    const normalized = host.toLowerCase();
    if (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^fe[89ab]/.test(normalized)
    ) {
      return true;
    }
    const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (mappedIpv4) return isPrivateIpv4(mappedIpv4);
  }
  return false;
}

function normalizePublicEvidenceUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value ?? '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password || isPrivateHostname(url.hostname)) return null;
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
      url.port = '';
    }
    return url.toString();
  } catch {
    return null;
  }
}

function websiteDomain(value: string): string | null {
  const candidate = value.trim();
  if (!candidate) return null;
  const normalized = normalizePublicEvidenceUrl(
    /^[a-z][a-z\d+.-]*:\/\//i.test(candidate) ? candidate : `https://${candidate}`,
  );
  if (!normalized) throw new Error('客户官网不是可公开访问的 HTTP(S) 地址');
  return new URL(normalized).hostname.toLowerCase();
}

function quoteSearchTerm(value: string) {
  const clean = compactText(value, 120).replace(/["\\]/g, ' ').trim();
  return clean ? `"${clean}"` : '';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string) {
  const actual = Object.keys(record).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${label} 字段必须严格为: ${required.join(', ')}`);
  }
}

function validateBoundedText(value: unknown, label: string, maxLength: number) {
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`);
  const normalized = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) throw new Error(`${label} 不得为空`);
  if (normalized.length > maxLength) throw new Error(`${label} 超过 ${maxLength} 字符上限`);
  return normalized;
}

function normalizeEvidenceText(value: unknown) {
  return compactText(value, MAX_SNIPPET_LENGTH).toLocaleLowerCase('en-US');
}

const EVIDENCE_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'in',
  'is', 'it', 'of', 'on', 'or', 'that', 'the', 'their', 'this', 'to', 'was',
  'were', 'will', 'with',
]);

function evidenceTokens(value: unknown) {
  const text = normalizeEvidenceText(value);
  const tokens = new Set<string>();
  for (const word of text.match(/[a-z0-9]+/g) || []) {
    if (word.length < 3 || EVIDENCE_STOP_WORDS.has(word)) continue;
    tokens.add(word.length > 6 ? word.slice(0, 6) : word);
  }
  for (const run of text.match(/[\p{Script=Han}]+/gu) || []) {
    if (run.length === 1) tokens.add(run);
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.add(run.slice(index, index + 2));
    }
  }
  return tokens;
}

function hasConservativeEvidenceOverlap(candidate: unknown, evidenceSnippet: unknown) {
  const candidateTokens = evidenceTokens(candidate);
  const evidenceTokenSet = evidenceTokens(evidenceSnippet);
  if (candidateTokens.size === 0 || evidenceTokenSet.size === 0) return false;
  const matched = [...candidateTokens].filter((token) => evidenceTokenSet.has(token)).length;
  const minimumMatches = candidateTokens.size === 1 ? 1 : 2;
  return matched >= minimumMatches && matched / candidateTokens.size >= 0.4;
}

function validateSourceUrls(
  value: unknown,
  label: string,
  allowedEvidenceUrls: ReadonlySet<string>,
  requireAtLeastOne: boolean,
) {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是 URL 数组`);
  if (value.length > MAX_CITATIONS_PER_ITEM) {
    throw new Error(`${label} 超过 ${MAX_CITATIONS_PER_ITEM} 条引用上限`);
  }
  if (requireAtLeastOne && value.length === 0) throw new Error(`${label} 至少需要一条证据引用`);
  if (!requireAtLeastOne && value.length !== 0) throw new Error(`${label} 在对应内容为空时必须为空数组`);

  const normalized: string[] = [];
  for (const source of value) {
    if (typeof source !== 'string' || !source.trim()) throw new Error(`${label} 包含空引用`);
    const url = normalizePublicEvidenceUrl(source);
    if (!url || !allowedEvidenceUrls.has(url)) {
      throw new Error(`${label} 包含不在 SearXNG 证据集中的 URL`);
    }
    if (normalized.includes(url)) throw new Error(`${label} 包含重复引用`);
    normalized.push(url);
  }
  return normalized;
}

function validateResearchContract(
  value: unknown,
  evidence: readonly SearchEvidence[],
): EvidenceBackedResearch {
  if (!isPlainRecord(value)) throw new Error('AI 模型返回了非法的背调 JSON');
  assertExactKeys(value, ['summary', 'summarySources', 'findings'], '背调结果');
  const evidenceByUrl = new Map(evidence.map((item) => [item.url, item]));
  const allowedEvidenceUrls = new Set(evidenceByUrl.keys());

  let summary: string | null;
  let summarySources: string[];
  if (value.summary === null) {
    summary = null;
    summarySources = validateSourceUrls(value.summarySources, 'summarySources', allowedEvidenceUrls, false);
  } else {
    summary = validateBoundedText(value.summary, 'summary', MAX_SUMMARY_LENGTH);
    summarySources = validateSourceUrls(value.summarySources, 'summarySources', allowedEvidenceUrls, true);
  }

  if (!Array.isArray(value.findings)) throw new Error('findings 必须是数组');
  if (value.findings.length > MAX_FINDINGS) throw new Error(`findings 超过 ${MAX_FINDINGS} 条上限`);

  const findings: EvidenceBackedFinding[] = [];
  const seenClaims = new Set<string>();
  for (const [index, item] of value.findings.entries()) {
    const label = `findings[${index}]`;
    if (!isPlainRecord(item)) throw new Error(`${label} 必须是对象`);
    assertExactKeys(item, ['category', 'claim', 'sourceUrls', 'supportingExcerpt'], label);
    if (typeof item.category !== 'string' || !FINDING_CATEGORIES.includes(item.category as FindingCategory)) {
      throw new Error(`${label}.category 不在允许分类中`);
    }
    const claim = validateBoundedText(item.claim, `${label}.claim`, MAX_FINDING_LENGTH);
    let supportingExcerpt = validateBoundedText(
      item.supportingExcerpt,
      `${label}.supportingExcerpt`,
      MAX_SUPPORTING_EXCERPT_LENGTH,
    );
    const sourceUrls = validateSourceUrls(
      item.sourceUrls,
      `${label}.sourceUrls`,
      allowedEvidenceUrls,
      true,
    );
    const normalizedExcerpt = normalizeEvidenceText(supportingExcerpt);
    const isExactEvidenceExcerpt = normalizedExcerpt.length >= 8 && sourceUrls.some((url) =>
      normalizeEvidenceText(evidenceByUrl.get(url)?.snippet).includes(normalizedExcerpt),
    );
    if (!isExactEvidenceExcerpt) {
      // Generative models are unreliable byte-for-byte copyists. Never archive a
      // rewritten quote: once the model has selected an allowlisted SearXNG URL,
      // materialize the evidence excerpt deterministically from that exact row.
      // This keeps the public-source boundary strict while removing a needless
      // dependency on the provider reproducing punctuation and whitespace.
      const usableCitedSnippets = sourceUrls
        .map((url) => evidenceByUrl.get(url)?.snippet)
        .filter((snippet) => normalizeEvidenceText(snippet).length >= 8);
      if (usableCitedSnippets.length === 0) {
        throw new Error(`${label}.sourceUrls 没有包含可核验原文摘要的 SearXNG 证据`);
      }
      const canonicalExcerpt = usableCitedSnippets
        .filter((snippet) => hasConservativeEvidenceOverlap(supportingExcerpt, snippet))
        .map((snippet) => compactText(snippet, MAX_SUPPORTING_EXCERPT_LENGTH))
        .find((excerpt) => normalizeEvidenceText(excerpt).length >= 8);
      if (!canonicalExcerpt) {
        throw new Error(`${label}.supportingExcerpt 不是任何所引证 SearXNG 摘要的原文片段或保守语义匹配`);
      }
      supportingExcerpt = canonicalExcerpt;
    }
    const dedupeKey = `${item.category}\u0000${claim.toLowerCase()}`;
    if (seenClaims.has(dedupeKey)) throw new Error(`${label}.claim 与其他结论重复`);
    seenClaims.add(dedupeKey);
    findings.push({
      category: item.category as FindingCategory,
      claim,
      supportingExcerpt,
      sourceUrls,
    });
  }

  if (!summary && findings.length === 0) throw new Error('背调结果没有任何可引用的结论');
  return { summary, summarySources, findings };
}

@Injectable()
export class DataGathererService {
  private readonly logger = new Logger(DataGathererService.name);

  async gatherAll(companyName: string, website: string, country: string): Promise<GatheredData> {
    try {
      const company = compactText(companyName, 160);
      if (!company) throw new Error('缺少客户公司名称，无法开始背调');

      const domain = websiteDomain(website || '');
      const evidence = await this.searchPublicEvidence(company, country, domain);
      if (evidence.length === 0) {
        throw new Error('SearXNG 未返回可核验的公开网页证据，已停止 AI 背调');
      }

      const evidenceJson = JSON.stringify(evidence, null, 2);
      const researchMessages = [
        {
          role: 'system' as const,
          content: [
            '你是国际 B2B 客户背调分析员。只返回严格 JSON。',
            '只能依据用户消息里提供的 evidence 数组，不得使用模型记忆，不得补写或猜测任何事实。',
            '输出必须且只能包含三个顶层字段：summary、summarySources、findings，不得输出未知字段。',
            'summary 为不超过 1500 字符的字符串或 null；非 null 时 summarySources 必须至少引用一个 evidence URL，null 时必须为 []。',
            `findings 最多 ${MAX_FINDINGS} 条，每条必须且只能包含 category、claim、supportingExcerpt、sourceUrls。`,
            `category 只能是：${FINDING_CATEGORIES.join(', ')}。claim 不超过 ${MAX_FINDING_LENGTH} 字符。`,
            '每一条 finding 的 sourceUrls 必须至少引用一个 evidence 中的 URL。不得引用 evidence 之外的 URL，不得空引用。',
            'supportingExcerpt 必须逐字摘自该 finding 所引用 URL 对应的 evidence.snippet，不得改写；服务端会做子串校验。',
            '无法由证据直接支持的结论不要输出。即使 summary 已引用证据，每一条 finding 仍必须独立引用证据。',
            '示例结构：{"summary":"...","summarySources":["https://..."],"findings":[{"category":"registration","claim":"...","supportingExcerpt":"证据摘要原文片段","sourceUrls":["https://..."]}]}',
          ].join('\n'),
        },
        {
          role: 'user' as const,
          content: [
            `客户公司：${company}`,
            `国家/地区：${compactText(country, 100) || '未知'}`,
            `官网域名：${domain || '未提供'}`,
            '以下是唯一允许使用的公开搜索证据（标题、URL、摘要），未抓取或信任目标网页正文：',
            evidenceJson,
          ].join('\n'),
        },
      ];
      let result = await completeAiJson<unknown>({
        purpose: 'research',
        task: 'research',
        temperature: 0.1,
        maxTokens: 3000,
        messages: researchMessages,
      });

      let contract: EvidenceBackedResearch;
      try {
        contract = validateResearchContract(result.data, evidence);
      } catch (validationError: any) {
        const validationMessage = String(validationError?.message || validationError);
        const isRecoverableModelFormattingError =
          /supportingExcerpt 不是任何所引证 SearXNG 摘要的原文片段或保守语义匹配/.test(validationMessage) ||
          /\.category 不在允许分类中/.test(validationMessage);
        if (!isRecoverableModelFormattingError) {
          throw validationError;
        }
        // GLM 偶尔会改写摘要或创造提示词以外的分类。不能把无语义重叠的
        // 引文或模型自创分类直接归档；仅对此格式偏差有界重试一次，第二次
        // 仍须通过完全相同的严格校验。
        result = await completeAiJson<unknown>({
          purpose: 'research',
          task: 'research',
          temperature: 0,
          maxTokens: 3000,
          messages: [
            ...researchMessages,
            {
              role: 'user',
              content: [
                `上一份 JSON 被服务端拒绝：${compactText(validationMessage, 240)}`,
                `请重新生成完整 JSON。category 只能逐字使用：${FINDING_CATEGORIES.join(', ')}。`,
                '每个 supportingExcerpt 必须从对应 sourceUrls 的 evidence.snippet 中逐字复制连续原文；无法逐字引用或无法归入允许分类的 finding 直接删除，不得改写证据或创造新分类。',
              ].join('\n'),
            },
          ],
        });
        contract = validateResearchContract(result.data, evidence);
      }
      const json = {
        ...contract,
        provider: result.provider,
        model: result.model,
        evidenceSources: evidence,
      };
      const html = this.buildReportHtml(company, result.provider, result.model, json, evidence);
      return { raw: result.text, html, json };
    } catch (err: unknown) {
      const errorCode = stableResearchErrorCode(err);
      this.logger.error(safeLogEvent('deep_research.evidence_collection_failed', {
        error: err,
        errorCategory: safeErrorCategory(err),
      }));
      return {
        raw: '',
        error: RESEARCH_EVIDENCE_FAILURE_MESSAGE,
        errorCode,
      };
    }
  }

  private async searchPublicEvidence(company: string, country: string, domain: string | null) {
    const configuredBase = process.env.SEARXNG_URL || process.env.SEARXNG_BASE_URL;
    if (!configuredBase) throw new Error('未配置 SEARXNG_URL 或 SEARXNG_BASE_URL');

    let searchBaseUrl: string;
    try {
      const base = new URL(configuredBase);
      if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
        throw new Error('invalid protocol or credentials');
      }
      base.search = '';
      base.hash = '';
      searchBaseUrl = base.toString();
    } catch {
      throw new Error('SEARXNG_URL 配置无效');
    }

    const companyTerm = quoteSearchTerm(company);
    const countryTerm = quoteSearchTerm(country || '');
    const domainTerm = domain ? quoteSearchTerm(domain) : '';
    const common = [companyTerm, countryTerm, domainTerm].filter(Boolean).join(' ');
    const queries = [
      common,
      [companyTerm, countryTerm, domain ? `site:${domain}` : 'company profile'].filter(Boolean).join(' '),
      [companyTerm, countryTerm, domainTerm, 'business company profile'].filter(Boolean).join(' '),
    ].filter((query, index, all) => query && all.indexOf(query) === index);

    const evidence: SearchEvidence[] = [];
    const seenUrls = new Set<string>();
    for (const query of queries) {
      const rows = await this.searchSearxng(searchBaseUrl, query);
      for (const row of rows) {
        if (seenUrls.has(row.url)) continue;
        seenUrls.add(row.url);
        evidence.push(row);
        if (evidence.length >= MAX_EVIDENCE_RESULTS) return evidence;
      }
    }
    return evidence;
  }

  private async searchSearxng(baseUrl: string, query: string): Promise<SearchEvidence[]> {
    try {
      const results = await searchTrustedSearxng(query, MAX_EVIDENCE_RESULTS, {
        baseUrl,
        timeoutMs: SEARCH_TIMEOUT_MS,
        maxResponseBytes: MAX_RESPONSE_BYTES,
      });

      const rows: SearchEvidence[] = [];
      for (const item of results) {
        const normalizedUrl = normalizePublicEvidenceUrl(item.url);
        if (!normalizedUrl) continue;
        const title = compactText(item.title, MAX_TITLE_LENGTH);
        const snippet = compactText(item.snippet, MAX_SNIPPET_LENGTH);
        if (!title && !snippet) continue;
        rows.push({ title: title || new URL(normalizedUrl).hostname, url: normalizedUrl, snippet });
      }
      return rows;
    } catch (error: unknown) {
      const candidate = error as { name?: unknown; message?: unknown } | null;
      if (candidate?.name === 'TimeoutError' || candidate?.name === 'AbortError') {
        throw createResearchEvidenceError('RESEARCH_SEARCH_TIMEOUT');
      }
      if (candidate?.message === 'SEARXNG_RESPONSE_JSON_INVALID') {
        throw createResearchEvidenceError('RESEARCH_SEARCH_INVALID_RESPONSE');
      }
      if (candidate?.message === 'SEARXNG_RESPONSE_TOO_LARGE') {
        throw createResearchEvidenceError('RESEARCH_SEARCH_RESPONSE_TOO_LARGE');
      }
      throw createResearchEvidenceError('RESEARCH_SEARCH_FAILED');
    }
  }

  private buildReportHtml(
    companyName: string,
    provider: string,
    model: string,
    json: Record<string, any>,
    evidence: SearchEvidence[],
  ) {
    const sourceItems = evidence
      .map(
        (item) => `<li><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>${
          item.snippet ? `<p>${escapeHtml(item.snippet)}</p>` : ''
        }</li>`,
      )
      .join('');
    return [
      '<div class="deep-research-report">',
      `<h1>${escapeHtml(companyName)} - AI 深度背调</h1>`,
      `<p><strong>AI Provider：</strong>${escapeHtml(provider)} (${escapeHtml(model)})</p>`,
      '<p><strong>证据边界：</strong>本报告仅基于下列 SearXNG 搜索结果的标题、URL 与摘要，未抓取目标网页正文。</p>',
      '<h2>结构化结果</h2>',
      `<pre>${escapeHtml(JSON.stringify(json, null, 2))}</pre>`,
      '<h2>公开证据来源</h2>',
      `<ol>${sourceItems}</ol>`,
      '</div>',
    ].join('');
  }
}
