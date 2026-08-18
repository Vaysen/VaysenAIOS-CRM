import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertEvidenceLogSafe, sanitizeEvidenceLog } from './sanitize-evidence-log.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logPath = path.join(
  repositoryRoot,
  'docs',
  'audit',
  'evidence',
  'PF-C-frontend-build-contract-windows-2026-07-29.log',
);
const npmCli = process.env.npm_execpath;

if (!npmCli) {
  throw new Error('Run this evidence command through npm so the reviewed npm CLI is explicit');
}
if (process.versions.node !== '20.18.0') {
  throw new Error(`Build-contract evidence requires Node 20.18.0, got ${process.versions.node}`);
}
const npmUserAgent = process.env.npm_config_user_agent || '';
if (!/^npm\/10\.8\.2(?:\s|$)/.test(npmUserAgent)) {
  throw new Error(`Build-contract evidence requires npm 10.8.2, got ${npmUserAgent || 'unknown'}`);
}

mkdirSync(path.dirname(logPath), { recursive: true });
const commandArgs = [
  npmCli,
  '--workspace',
  'frontend',
  'run',
  'verify:build-contract',
];
const child = spawn(process.execPath, commandArgs, {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
    CI: '1',
    NEXT_TELEMETRY_DISABLED: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const chunks = [];
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (chunk) => {
    chunks.push(Buffer.from(chunk));
    stream === child.stdout ? process.stdout.write(chunk) : process.stderr.write(chunk);
  });
}

child.on('error', (error) => {
  chunks.push(Buffer.from(`\n[runner-error] ${error.message}\n`));
});

child.on('close', (code, signal) => {
  const exitCode = Number.isInteger(code) ? code : 1;
  const header = [
    '# PF-C frontend build contract evidence',
    `runtime.node=${process.versions.node}`,
    `runtime.npm=${npmUserAgent}`,
    'command=npm --workspace frontend run verify:build-contract',
    'env.CI=1',
    'env.NEXT_TELEMETRY_DISABLED=1',
    '',
  ].join('\n');
  const footer = `\n[result] exitCode=${exitCode} signal=${signal || 'none'}\n`;
  const evidence = `${header}${sanitizeEvidenceLog(Buffer.concat(chunks).toString('utf8'), {
    repositoryRoot,
  })}${footer}`;
  assertEvidenceLogSafe(evidence, { repositoryRoot });
  writeFileSync(logPath, evidence, 'utf8');
  console.log(`[build-contract-evidence] log=${path.relative(repositoryRoot, logPath)} exit=${exitCode}`);
  process.exitCode = exitCode;
});
