#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const OUTCOMES = Object.freeze({
  GROUP_REJECTED: /^JYACC_GROUP_[a-f0-9]{16}$/,
  NON_OWNER_REJECTED: /^JYACC_NONOWNER_[a-f0-9]{16}$/,
});

function assertRealDirectory(directory, mode, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} is unsafe`);
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== mode) throw new Error(`${label} mode is unsafe`);
}

function assertEvidenceTree(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      throw new Error('acceptance evidence tree contains a link or special file');
    }
    if (stat.isDirectory()) assertEvidenceTree(full);
  }
}

export function verifyWeixinAcceptanceEvidence({ marker, outcome, stateDir }) {
  const pattern = OUTCOMES[outcome];
  if (!pattern || typeof marker !== 'string' || !pattern.test(marker)) {
    throw new Error('acceptance marker or expected outcome is invalid');
  }
  if (!stateDir || !path.isAbsolute(stateDir)) throw new Error('OpenClaw state root is invalid');
  assertRealDirectory(stateDir, 0o700, 'OpenClaw state root');
  const evidenceRoot = path.join(stateDir, 'acceptance-evidence');
  const channelRoot = path.join(evidenceRoot, 'openclaw-weixin');
  assertRealDirectory(evidenceRoot, 0o700, 'acceptance evidence root');
  assertRealDirectory(channelRoot, 0o700, 'Weixin acceptance evidence root');
  assertEvidenceTree(channelRoot);
  const markerDigest = createHash('sha256').update(marker, 'utf8').digest('hex');
  const evidencePath = path.join(channelRoot, `${markerDigest}.json`);
  const stat = fs.lstatSync(evidencePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('acceptance evidence file is unsafe');
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) throw new Error('acceptance evidence file mode is unsafe');
  const raw = fs.readFileSync(evidencePath, 'utf8');
  if (raw.includes(marker)) throw new Error('acceptance evidence leaked a raw marker');
  const evidence = JSON.parse(raw);
  const keys = Object.keys(evidence).sort();
  if (keys.join(',') !== 'markerDigest,observedAt,outcome,schemaVersion') {
    throw new Error('acceptance evidence schema is invalid');
  }
  if (evidence.schemaVersion !== 1 || evidence.markerDigest !== markerDigest || evidence.outcome !== outcome) {
    throw new Error('acceptance evidence does not match the requested digest/outcome');
  }
  if (typeof evidence.observedAt !== 'string' || new Date(evidence.observedAt).toISOString() !== evidence.observedAt) {
    throw new Error('acceptance evidence timestamp is invalid');
  }
  return { markerDigest, outcome, observedAt: evidence.observedAt };
}

function main() {
  const [marker, outcome, stateDirArg] = process.argv.slice(2);
  const stateDir = stateDirArg || process.env.OPENCLAW_STATE_DIR;
  const result = verifyWeixinAcceptanceEvidence({ marker, outcome, stateDir });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
