import { existsSync } from 'fs';

const LINUX_BROWSER_PATHS = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
] as const;

const WINDOWS_BROWSER_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
] as const;

const MACOS_BROWSER_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
] as const;

export interface BrowserExecutableResolverOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  pathExists?: (path: string) => boolean;
}

function defaultPathsForPlatform(platform: NodeJS.Platform): readonly string[] {
  if (platform === 'win32') return WINDOWS_BROWSER_PATHS;
  if (platform === 'darwin') return MACOS_BROWSER_PATHS;
  return LINUX_BROWSER_PATHS;
}

/**
 * Resolve the browser used by puppeteer-core. An explicit environment value is
 * a deployment contract, so an invalid value fails closed instead of silently
 * selecting a different browser from the host.
 */
export function resolvePdfBrowserExecutable(
  options: BrowserExecutableResolverOptions = {},
): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathExists = options.pathExists ?? existsSync;
  const configuredPath = (
    env.PUPPETEER_EXECUTABLE_PATH || env.CHROME_EXECUTABLE_PATH || ''
  ).trim();

  if (configuredPath) {
    if (pathExists(configuredPath)) return configuredPath;
    throw new Error(
      `Configured PDF browser executable does not exist: ${configuredPath}`,
    );
  }

  const candidates = defaultPathsForPlatform(platform);
  const detectedPath = candidates.find((candidate) => pathExists(candidate));
  if (detectedPath) return detectedPath;

  throw new Error(
    `No supported browser found for PDF generation. Set PUPPETEER_EXECUTABLE_PATH. Checked: ${candidates.join(', ')}`,
  );
}
