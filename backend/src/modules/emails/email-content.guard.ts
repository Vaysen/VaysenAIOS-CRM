import {
  findPrivateNetworkUrl,
  isPrivateOrLocalHostname,
  isPublicTrackingEnabled,
} from './email-public-links';

const UNREPLACED_VARIABLE_REGEX = /\{\{[a-zA-Z0-9_]+\}\}/g;
const LEGACY_BRAND_REGEX = /\b(?:jingseyewear|surface[\s-]*polish|fastener[\s-]*nails)\b/i;
const LEGACY_DOMAIN_REGEX = /\b(?:https?:\/\/)?(?:www\.)?(?:[a-z0-9-]+\.)*[a-z0-9-]*(?:jingseyewear|surface-?polish|fastener-?nails|eyewear)[a-z0-9-]*(?:\.[a-z0-9-]+)+\b/i;

export const DEFAULT_EMAIL_COMPANY_NAME = 'Vaysen Packaging';
export const DEFAULT_EMAIL_COMPANY_WEBSITE = 'https://vaysen.com';

export interface EmailContentValidationResult {
  valid: boolean;
  reason?: string;
}

export function findLegacyEmailBrandReference(...values: Array<string | null | undefined>): string | null {
  const text = values.filter(Boolean).join('\n');
  return text.match(LEGACY_DOMAIN_REGEX)?.[0] || text.match(LEGACY_BRAND_REGEX)?.[0] || null;
}

/** Rewrites stale generated/template branding before a draft reaches final validation. */
export function replaceLegacyEmailBrandReferences(value: string): string {
  return (value || '')
    .replace(/\b(?:https?:\/\/)?(?:www\.)?(?:[a-z0-9-]+\.)*[a-z0-9-]*(?:jingseyewear|surface-?polish|fastener-?nails|eyewear)[a-z0-9-]*(?:\.[a-z0-9-]+)+\b/gi, (match) => (
      /^https?:\/\//i.test(match) ? DEFAULT_EMAIL_COMPANY_WEBSITE : 'vaysen.com'
    ))
    .replace(/\b(?:jingseyewear|surface[\s-]*polish|fastener[\s-]*nails)\b/gi, DEFAULT_EMAIL_COMPANY_NAME);
}

export function resolveEmailCompanyName(name?: string | null): string {
  const value = (name || '').trim();
  return value && !findLegacyEmailBrandReference(value) ? value : DEFAULT_EMAIL_COMPANY_NAME;
}

export function resolveEmailCompanyWebsite(website?: string | null): string {
  const value = (website || '').trim();
  if (!value || findLegacyEmailBrandReference(value)) return DEFAULT_EMAIL_COMPANY_WEBSITE;

  try {
    const parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || isPrivateOrLocalHostname(parsed.hostname)) {
      return DEFAULT_EMAIL_COMPANY_WEBSITE;
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return DEFAULT_EMAIL_COMPANY_WEBSITE;
  }
}

export function normalizeRequiredWebsite(website?: string | null) {
  const value = resolveEmailCompanyWebsite(website);
  return value
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

export function validateEmailContent(
  subject: string | null | undefined,
  bodyHtml: string | null | undefined,
  requiredWebsite?: string | null,
): EmailContentValidationResult {
  const subjectText = (subject || '').trim();
  const body = (bodyHtml || '').trim();
  const plain = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const requiredHost = normalizeRequiredWebsite(requiredWebsite);

  if (!subjectText) return { valid: false, reason: 'Missing subject' };
  if (!body) return { valid: false, reason: 'Missing HTML body' };
  const legacyReference = findLegacyEmailBrandReference(subjectText, body);
  if (legacyReference) {
    return { valid: false, reason: `Email contains a retired brand or domain: ${legacyReference}` };
  }
  if (plain.length < 20) return { valid: false, reason: `Email body is too short (${plain.length} chars plain text, minimum 20)` };
  const unreplaced = Array.from(new Set(`${subjectText}\n${body}`.match(UNREPLACED_VARIABLE_REGEX) || []));
  if (unreplaced.length > 0) {
    return { valid: false, reason: `Email still contains unreplaced template variables: ${unreplaced.join(', ')}` };
  }
  if (/```|^json\s*[:{[]|\"subject\"\s*:|\"bodyHtml\"\s*:/i.test(body)) {
    return { valid: false, reason: 'Email body appears to contain raw AI JSON or code fences' };
  }
  if (!new RegExp(requiredHost.replace(/\./g, '\\.'), 'i').test(body)) {
    return { valid: false, reason: `Email body must include ${requiredHost}` };
  }
  if (!/unsubscribe/i.test(body)) {
    return { valid: false, reason: 'Email body must include unsubscribe information' };
  }
  const privateUrl = findPrivateNetworkUrl(body);
  if (privateUrl) {
    return { valid: false, reason: `Email body must not expose a LAN/private URL: ${privateUrl}` };
  }
  if (isPublicTrackingEnabled() && !/email-track\/open/i.test(body)) {
    return { valid: false, reason: 'Email body must include open tracking pixel' };
  }

  return { valid: true };
}

export function ensureCompanyWebsite(bodyHtml: string, website?: string | null, label?: string | null) {
  const resolvedWebsite = resolveEmailCompanyWebsite(website);
  const host = normalizeRequiredWebsite(resolvedWebsite);
  if (new RegExp(host.replace(/\./g, '\\.'), 'i').test(bodyHtml)) return bodyHtml;
  const href = resolvedWebsite;
  const display = label || `www.${host}`;
  const cta = `<p style="margin:16px 0 0 0;line-height:1.55;color:#374151;font-size:14px;">You can also review our capabilities at <a href="${href}" style="color:#2563eb;">${display}</a>.</p>`;
  return bodyHtml.includes('</body>') ? bodyHtml.replace('</body>', `${cta}</body>`) : `${bodyHtml}${cta}`;
}

export function ensureVaysenWebsite(bodyHtml: string) {
  return ensureCompanyWebsite(bodyHtml, DEFAULT_EMAIL_COMPANY_WEBSITE, 'vaysen.com');
}
