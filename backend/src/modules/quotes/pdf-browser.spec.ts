import { resolvePdfBrowserExecutable } from './pdf-browser';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('resolvePdfBrowserExecutable', () => {
  it('uses a valid explicit Puppeteer executable path first', () => {
    const resolved = resolvePdfBrowserExecutable({
      env: { PUPPETEER_EXECUTABLE_PATH: '/custom/chromium' },
      platform: 'linux',
      pathExists: (candidate) => candidate === '/custom/chromium',
    });

    expect(resolved).toBe('/custom/chromium');
  });

  it('fails closed when the explicit executable path is invalid', () => {
    expect(() =>
      resolvePdfBrowserExecutable({
        env: { PUPPETEER_EXECUTABLE_PATH: '/missing/chromium' },
        platform: 'linux',
        pathExists: (candidate) => candidate === '/usr/bin/chromium',
      }),
    ).toThrow(
      'Configured PDF browser executable does not exist: /missing/chromium',
    );
  });

  it('detects the Chromium path installed by the Linux backend image', () => {
    const resolved = resolvePdfBrowserExecutable({
      env: {},
      platform: 'linux',
      pathExists: (candidate) => candidate === '/usr/bin/chromium',
    });

    expect(resolved).toBe('/usr/bin/chromium');
  });

  it('detects Edge on Windows when Chrome is not installed', () => {
    const edgePath =
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
    const resolved = resolvePdfBrowserExecutable({
      env: {},
      platform: 'win32',
      pathExists: (candidate) => candidate === edgePath,
    });

    expect(resolved).toBe(edgePath);
  });

  it('reports the checked paths when no browser can be found', () => {
    expect(() =>
      resolvePdfBrowserExecutable({
        env: {},
        platform: 'linux',
        pathExists: () => false,
      }),
    ).toThrow(
      /Set PUPPETEER_EXECUTABLE_PATH\. Checked: \/usr\/bin\/chromium/,
    );
  });
});

describe('backend PDF browser image contract', () => {
  const dockerfile = readFileSync(
    resolve(__dirname, '../../../Dockerfile'),
    'utf8',
  );

  it('installs Chromium and pins Puppeteer to its executable', () => {
    expect(dockerfile).toMatch(/apt-get install[\s\S]*\bchromium\s*\\/);
    expect(dockerfile).toContain(
      'ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium',
    );
  });

  it('installs a CJK font for Chinese quote content', () => {
    expect(dockerfile).toMatch(/apt-get install[\s\S]*\bfonts-noto-cjk\s*\\/);
  });

  it('pins the non-root runtime UID/GID used by host bind mounts', () => {
    expect(dockerfile).toContain('ARG APP_UID=999');
    expect(dockerfile).toContain('ARG APP_GID=999');
    expect(dockerfile).toContain('useradd --uid "${APP_UID}" --gid "${APP_GID}"');
    expect(dockerfile).toContain('chown -R "${APP_UID}:${APP_GID}" /app');
  });

  it('gives Chromium a writable HOME and launches it during image build', () => {
    expect(dockerfile).toContain('ENV HOME=/tmp');
    expect(dockerfile).toContain("HOME=/tmp chromium --headless --no-sandbox --disable-gpu --dump-dom about:blank");
    expect(dockerfile).toContain('su appuser -s /bin/sh');
  });
});
