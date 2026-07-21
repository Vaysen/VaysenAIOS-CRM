import { shell } from 'electron';
import type { WebContents } from 'electron';

const WHATSAPP_PARTITION = /^persist:whatsapp(?:-|$)/;
const WHATSAPP_HOSTS = new Set(['web.whatsapp.com', 'static.whatsapp.net']);
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function isAllowedEmbeddedNavigation(
  targetUrl: string,
  partition: string,
  mainOrigins: ReadonlySet<string>,
): boolean {
  if (targetUrl === 'about:blank') return true;
  const parsed = parseUrl(targetUrl);
  if (!parsed) return false;
  if (WHATSAPP_PARTITION.test(partition)) {
    return parsed.protocol === 'https:' && WHATSAPP_HOSTS.has(parsed.hostname.toLowerCase());
  }
  return mainOrigins.has(parsed.origin);
}

export function isSafeExternalUrl(targetUrl: string): boolean {
  const parsed = parseUrl(targetUrl);
  return Boolean(parsed && EXTERNAL_PROTOCOLS.has(parsed.protocol));
}

export function registerNavigationGuards(
  contents: WebContents,
  mainOrigins: ReadonlySet<string>,
  partition = '',
): void {
  const guard = (event: Electron.Event, targetUrl: string) => {
    if (isAllowedEmbeddedNavigation(targetUrl, partition, mainOrigins)) return;
    event.preventDefault();
    if (isSafeExternalUrl(targetUrl)) void shell.openExternal(targetUrl);
  };

  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);
  contents.setWindowOpenHandler(({ url }) => {
    if (!isAllowedEmbeddedNavigation(url, partition, mainOrigins) && isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
}
