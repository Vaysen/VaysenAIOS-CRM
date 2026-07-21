import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const SCRIPT = resolve(ROOT, 'scripts', 'build-electron.mjs');
const NEXT_CONFIG_URL = pathToFileURL(resolve(ROOT, 'next.config.mjs')).href;

function check(url?: string, allowlist?: string, extraArgs: string[] = []) {
  const env = { ...process.env };
  delete env.NEXT_PUBLIC_API_URL;
  delete env.APPROVED_ZEROTIER_API_ORIGINS;
  if (url !== undefined) env.NEXT_PUBLIC_API_URL = url;
  if (allowlist !== undefined) env.APPROVED_ZEROTIER_API_ORIGINS = allowlist;
  return spawnSync(process.execPath, [SCRIPT, '--check', ...extraArgs], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
}

function loadExportConfig(url?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, NEXT_OUTPUT: 'export' };
  delete env.NEXT_PUBLIC_API_URL;
  delete env.APPROVED_ZEROTIER_API_ORIGINS;
  if (url !== undefined) env.NEXT_PUBLIC_API_URL = url;
  return spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `import(${JSON.stringify(NEXT_CONFIG_URL)})`],
    {
      cwd: ROOT,
      env,
      encoding: 'utf8',
    },
  );
}

describe('TASK-110 Electron API fail-closed policy', () => {
  it('defaults a missing API URL to the safe same-origin LAN proxy', () => {
    const result = check();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Electron 同源局域网代理');
  });

  it('accepts a public HTTPS API URL', () => {
    const result = check('https://api.example.com/v1');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('公网 HTTPS');
  });

  it('accepts only the exact same-origin /api path for the LAN proxy', () => {
    const result = check('/api');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Electron 同源局域网代理');
    expect(check('/api/v1').status).toBe(1);
    expect(check('//127.0.0.1/api').status).toBe(1);
  });

  it('rejects public HTTP and localhost', () => {
    expect(check('http://api.example.com/v1').status).toBe(1);
    expect(check('https://localhost:4000/api').status).toBe(1);
    expect(check('https://localhost.:4000/api').status).toBe(1);
    expect(check('https://127.0.0.1:4000/api').status).toBe(1);
    expect(check('https://[::ffff:127.0.0.1]:4000/api').status).toBe(1);
  });

  it('requires an exact approved origin for private/ZeroTier URLs', () => {
    const url = 'http://10.147.17.20:4000/api';
    expect(check(url).status).toBe(1);
    expect(check(url, 'http://10.147.17.21:4000').status).toBe(1);
    expect(check(url, 'http://10.147.17.20:4001').status).toBe(1);
    expect(check(url, 'http://10.147.17.20:4000').status).toBe(0);
  });

  it('rejects unknown command arguments', () => {
    const result = check('https://api.example.com', undefined, ['--unexpected']);
    expect(result.status).toBe(2);
  });

  it('keeps direct NEXT_OUTPUT=export config loading fail-closed', () => {
    const missing = loadExportConfig();
    expect(missing.status, missing.stderr).toBe(0);
    expect(loadExportConfig('https://api.example.com/v1').status).toBe(0);
    expect(loadExportConfig('/api').status).toBe(0);
  });
});
