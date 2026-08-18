import {
  BROWSER_API_BASE_KEY,
  healthUrlForApiBase,
  normalizeRuntimeApiBaseUrl,
  saveBrowserApiBaseUrl,
  validateRuntimeApiBaseUrl,
} from '../electron/runtime-config';

describe('runtime API base normalization', () => {
  it('appends /api to a server root', () => {
    expect(normalizeRuntimeApiBaseUrl('http://192.168.50.10:4000')).toBe('http://192.168.50.10:4000/api');
  });

  it('preserves an existing /api base without duplicating it', () => {
    expect(normalizeRuntimeApiBaseUrl('http://crm.lan:4000/api')).toBe('http://crm.lan:4000/api');
    expect(normalizeRuntimeApiBaseUrl('http://crm.lan:4000/api/')).toBe('http://crm.lan:4000/api');
    expect(normalizeRuntimeApiBaseUrl('/api/')).toBe('/api');
  });

  it('rejects unrelated URL paths while accepting the documented address forms', () => {
    expect(validateRuntimeApiBaseUrl('http://crm.lan:4000')).toBeNull();
    expect(validateRuntimeApiBaseUrl('http://crm.lan:4000/api')).toBeNull();
    expect(() => normalizeRuntimeApiBaseUrl('http://crm.lan:4000/v1')).toThrow(/\/api/);
  });

  it('makes health probes target the raw backend /health endpoint', () => {
    expect(healthUrlForApiBase('http://crm.lan:4000')).toBe('http://crm.lan:4000/health');
    expect(healthUrlForApiBase('http://crm.lan:4000/api')).toBe('http://crm.lan:4000/health');
    expect(healthUrlForApiBase('/api')).toBe('/health');
  });

  it('stores normalized browser values so api requests use /api/auth paths', () => {
    localStorage.removeItem(BROWSER_API_BASE_KEY);
    expect(saveBrowserApiBaseUrl('http://crm.lan:4000')).toBe('http://crm.lan:4000/api');
    expect(localStorage.getItem(BROWSER_API_BASE_KEY)).toBe('http://crm.lan:4000/api');
  });
});
