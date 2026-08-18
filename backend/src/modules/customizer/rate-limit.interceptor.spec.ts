import { extractRateLimitClientIp } from './rate-limit.interceptor';

describe('customizer rate-limit client identity', () => {
  it('ignores a forged X-Forwarded-For prefix when Nginx supplies X-Real-IP', () => {
    const base = { headers: { 'x-real-ip': '172.31.5.9' }, socket: { remoteAddress: '172.20.0.2' } };
    expect(extractRateLimitClientIp({ ...base, headers: { ...base.headers, 'x-forwarded-for': '1.1.1.1, 172.31.5.9' } }))
      .toBe('172.31.5.9');
    expect(extractRateLimitClientIp({ ...base, headers: { ...base.headers, 'x-forwarded-for': '8.8.8.8, 172.31.5.9' } }))
      .toBe('172.31.5.9');
  });

  it('uses only the right-most valid forwarded address as a safe fallback', () => {
    expect(extractRateLimitClientIp({
      headers: { 'x-forwarded-for': 'forged-value, 10.10.2.3' },
      socket: { remoteAddress: '172.20.0.2' },
    })).toBe('10.10.2.3');
  });

  it('falls back to the socket for invalid proxy headers', () => {
    expect(extractRateLimitClientIp({
      headers: { 'x-real-ip': 'attacker', 'x-forwarded-for': 'not-an-ip' },
      socket: { remoteAddress: '172.20.0.2' },
    })).toBe('172.20.0.2');
  });
});
