import {
  DEFAULT_EMAIL_COMPANY_NAME,
  DEFAULT_EMAIL_COMPANY_WEBSITE,
  ensureCompanyWebsite,
  findLegacyEmailBrandReference,
  replaceLegacyEmailBrandReferences,
  resolveEmailCompanyName,
  resolveEmailCompanyWebsite,
  validateEmailContent,
} from './email-content.guard';

describe('external email brand policy', () => {
  const safeBody = [
    '<p>We manufacture custom packaging and can prepare a sample quotation for your team.</p>',
    '<p><a href="https://example.com">Example Trading Company</a></p>',
    '<p>To unsubscribe, reply with Unsubscribe.</p>',
  ].join('');

  it('uses Example Trading Company when company branding is absent or retired', () => {
    expect(resolveEmailCompanyName()).toBe(DEFAULT_EMAIL_COMPANY_NAME);
    expect(resolveEmailCompanyName('Jingseyewear')).toBe(DEFAULT_EMAIL_COMPANY_NAME);
    expect(resolveEmailCompanyWebsite()).toBe(DEFAULT_EMAIL_COMPANY_WEBSITE);
    expect(resolveEmailCompanyWebsite('https://surface-polish.com')).toBe(DEFAULT_EMAIL_COMPANY_WEBSITE);
    expect(resolveEmailCompanyWebsite('http://127.0.0.1')).toBe(DEFAULT_EMAIL_COMPANY_WEBSITE);
  });

  it('prioritizes a safe configured company name and public website', () => {
    expect(resolveEmailCompanyName('Acme Packaging')).toBe('Acme Packaging');
    expect(resolveEmailCompanyWebsite('https://pack.example.org/about')).toBe('https://pack.example.org/about');
  });

  it('adds the Vaysen AI CRM website when a body has no configured website', () => {
    const html = ensureCompanyWebsite('<p>Custom packaging quotation and sample support.</p>');
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toMatch(/jingseyewear|surfacepolish|fastenernails/i);
  });

  it.each([
    'Jingseyewear',
    'Surface Polish',
    'fastenernails.com',
    'https://wholesale-eyewear.example.com',
  ])('detects retired sender branding or domains: %s', (legacy) => {
    expect(findLegacyEmailBrandReference(legacy)).toBeTruthy();
  });

  it('rewrites stale draft branding to Vaysen AI CRM before final validation', () => {
    const repaired = replaceLegacyEmailBrandReferences(
      '<a href="https://www.jingseyewear.com/catalog">Jingseyewear catalog</a>',
    );
    expect(repaired).toContain('https://example.com');
    expect(repaired).toContain(DEFAULT_EMAIL_COMPANY_NAME);
    expect(findLegacyEmailBrandReference(repaired)).toBeNull();
  });

  it.each([
    ['Jingseyewear offer', safeBody],
    ['Custom packaging offer', `${safeBody}<p>Visit https://surfacepolish.com</p>`],
    ['Custom packaging offer', `${safeBody}<p>Fastener Nails supply</p>`],
  ])('fails closed when the final email contains retired branding', (subject, body) => {
    const result = validateEmailContent(subject, body);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('retired brand or domain');
  });

  it('accepts a complete Vaysen AI CRM deliverable', () => {
    expect(validateEmailContent('Custom packaging options', safeBody)).toEqual({ valid: true });
  });
});
