import {
  appendPublicUnsubscribe,
  findPrivateNetworkUrl,
  injectPublicTrackingPixel,
  isPrivateOrLocalHostname,
  prepareEmailForExternalDelivery,
  replaceLinksWithPublicTracking,
} from './email-public-links';

const ORIGINAL_ENV = {
  PUBLIC_TRACKING_BASE_URL: process.env.PUBLIC_TRACKING_BASE_URL,
  PUBLIC_UNSUBSCRIBE_URL: process.env.PUBLIC_UNSUBSCRIBE_URL,
};

describe('LAN-only external email URL policy', () => {
  beforeEach(() => {
    delete process.env.PUBLIC_TRACKING_BASE_URL;
    delete process.env.PUBLIC_UNSUBSCRIBE_URL;
  });

  afterAll(() => {
    if (ORIGINAL_ENV.PUBLIC_TRACKING_BASE_URL !== undefined) {
      process.env.PUBLIC_TRACKING_BASE_URL = ORIGINAL_ENV.PUBLIC_TRACKING_BASE_URL;
    }
    if (ORIGINAL_ENV.PUBLIC_UNSUBSCRIBE_URL !== undefined) {
      process.env.PUBLIC_UNSUBSCRIBE_URL = ORIGINAL_ENV.PUBLIC_UNSUBSCRIBE_URL;
    }
  });

  it('keeps original CTA and omits tracking when no public callback exists', () => {
    const source = '<p><a href="https://www.vaysen.com/products">View products</a></p>';
    const tracked = replaceLinksWithPublicTracking(injectPublicTrackingPixel(source, 'track-1'), 'track-1');
    expect(tracked).toContain('href="https://www.vaysen.com/products"');
    expect(tracked).not.toContain('email-track');
  });

  it.each([
    'backend',
    'printer.local',
    'vaysen-crm.lan',
    'service.internal',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:192.168.50.20',
  ])('treats non-public host forms as private: %s', (hostname) => {
    expect(isPrivateOrLocalHostname(hostname)).toBe(true);
  });

  it.each([
    'vaysen.com',
    'mail.vaysen.com',
    '2606:4700:4700::1111',
  ])('allows a public DNS name or global IPv6 host: %s', (hostname) => {
    expect(isPrivateOrLocalHostname(hostname)).toBe(false);
  });

  it('detects an IPv4-mapped IPv6 private URL after URL canonicalization', () => {
    expect(findPrivateNetworkUrl('<a href="http://[::ffff:192.168.50.20]/quote">Quote</a>')).toBeTruthy();
  });

  it('adds a reachable reply-based unsubscribe instruction without an internal URL', () => {
    const html = appendPublicUnsubscribe('<p>Hello</p>', 'token-1');
    expect(html).toContain('reply to this email');
    expect(html).toContain('Unsubscribe');
    expect(findPrivateNetworkUrl(html)).toBeNull();
  });

  it('uses explicitly configured public HTTPS endpoints', () => {
    process.env.PUBLIC_TRACKING_BASE_URL = 'https://mail.vaysen.com';
    process.env.PUBLIC_UNSUBSCRIBE_URL = 'https://www.vaysen.com/unsubscribe/{token}';
    const source = '<a href="https://www.vaysen.com/products">View</a>';
    const html = appendPublicUnsubscribe(
      replaceLinksWithPublicTracking(injectPublicTrackingPixel(source, 'track-1'), 'track-1'),
      'token-1',
    );
    expect(html).toContain('https://mail.vaysen.com/api/email-track/open/track-1');
    expect(html).toContain('https://mail.vaysen.com/api/email-track/click/track-1');
    expect(html).toContain('https://www.vaysen.com/unsubscribe/token-1');
  });

  it('does not hide a private CTA inside a public tracking URL', () => {
    process.env.PUBLIC_TRACKING_BASE_URL = 'https://mail.vaysen.com';
    const source = '<a href="http://127.0.0.1/private-offer">View</a>';
    const tracked = replaceLinksWithPublicTracking(source, 'track-private');
    expect(tracked).toContain('href="http://127.0.0.1/private-offer"');
    expect(tracked).not.toContain('email-track/click');
    expect(findPrivateNetworkUrl(tracked)).toContain('127.0.0.1');
  });

  it('detects and restores a percent-encoded private target even when tracking is enabled', () => {
    process.env.PUBLIC_TRACKING_BASE_URL = 'https://mail.vaysen.com';
    const privateTarget = encodeURIComponent('http://192.168.50.20/customer-offer');
    const wrapped = `<a href="https://mail.vaysen.com/api/email-track/click/t1?url=${privateTarget}">View</a>`;

    expect(findPrivateNetworkUrl(wrapped)).toContain('192.168.50.20');
    const deliverable = prepareEmailForExternalDelivery(wrapped);
    expect(deliverable).toContain('href="http://192.168.50.20/customer-offer"');
    expect(deliverable).not.toContain('email-track/click');
    expect(findPrivateNetworkUrl(deliverable)).toContain('192.168.50.20');
  });

  it('repairs historical private tracking URLs and restores the original CTA', () => {
    const original = encodeURIComponent('https://www.vaysen.com/products');
    const stale = `<a href="http://127.0.0.1/api/email-track/click/t1?url=${original}">View</a><img src="http://127.0.0.1/api/email-track/open/t1" />`;
    const clean = prepareEmailForExternalDelivery(stale);
    expect(clean).toContain('https://www.vaysen.com/products');
    expect(clean).not.toContain('127.0.0.1');
    expect(clean).not.toContain('email-track');
    expect(clean).toContain('reply to this email');
  });

  it('rejects private or non-HTTPS callback configuration by falling back safely', () => {
    process.env.PUBLIC_TRACKING_BASE_URL = 'http://127.0.0.1';
    process.env.PUBLIC_UNSUBSCRIBE_URL = 'https://192.168.50.20/unsubscribe/{token}';
    const html = appendPublicUnsubscribe(injectPublicTrackingPixel('<p>Hello</p>', 't1'), 'u1');
    expect(html).not.toContain('email-track');
    expect(findPrivateNetworkUrl(html)).toBeNull();
    expect(html).toContain('reply to this email');
  });
});
