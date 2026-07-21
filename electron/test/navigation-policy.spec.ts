const mockOpenExternal = jest.fn();

jest.mock('electron', () => ({ shell: { openExternal: mockOpenExternal } }));

import { isAllowedEmbeddedNavigation, isSafeExternalUrl, registerNavigationGuards } from '../src/main/navigation-policy';

describe('privileged navigation policy', () => {
  const mainOrigins = new Set(['http://127.0.0.1:47831']);

  it('allows only the fixed local app origin for the privileged main renderer', () => {
    expect(isAllowedEmbeddedNavigation('http://127.0.0.1:47831/leads', '', mainOrigins)).toBe(true);
    expect(isAllowedEmbeddedNavigation('https://evil.example/', '', mainOrigins)).toBe(false);
    expect(isAllowedEmbeddedNavigation('file:///etc/passwd', '', mainOrigins)).toBe(false);
  });

  it('limits WhatsApp partitions to the two approved HTTPS hosts', () => {
    expect(isAllowedEmbeddedNavigation('https://web.whatsapp.com/', 'persist:whatsapp', mainOrigins)).toBe(true);
    expect(isAllowedEmbeddedNavigation('https://static.whatsapp.net/a.js', 'persist:whatsapp-2', mainOrigins)).toBe(true);
    expect(isAllowedEmbeddedNavigation('https://web.whatsapp.com.evil.example/', 'persist:whatsapp', mainOrigins)).toBe(false);
    expect(isAllowedEmbeddedNavigation('http://web.whatsapp.com/', 'persist:whatsapp', mainOrigins)).toBe(false);
  });

  it('opens safe external navigation outside Electron and blocks unsafe schemes', () => {
    const handlers = new Map<string, (...args: any[]) => void>();
    const contents = {
      session: { getPartition: () => '' },
      on: jest.fn((name: string, handler: (...args: any[]) => void) => handlers.set(name, handler)),
      setWindowOpenHandler: jest.fn(),
    } as any;
    registerNavigationGuards(contents, mainOrigins, '');
    const event = { preventDefault: jest.fn() };
    handlers.get('will-navigate')!(event, 'https://external.example/');
    expect(event.preventDefault).toHaveBeenCalled();
    expect(mockOpenExternal).toHaveBeenCalledWith('https://external.example/');
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    const unsafeEvent = { preventDefault: jest.fn() };
    handlers.get('will-redirect')!(unsafeEvent, 'javascript:alert(1)');
    expect(unsafeEvent.preventDefault).toHaveBeenCalled();
    expect(mockOpenExternal).toHaveBeenCalledTimes(1);
  });
});
