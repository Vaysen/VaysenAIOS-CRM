#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const COPY_START = /^COPY .+ FROM stdin;$/;
const COPY_END = '\\.';

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function canonicalizePgDumpData(input) {
  if (typeof input !== 'string') throw new TypeError('pg_dump input must be a string');
  if (input.includes('\r')) throw new Error('pg_dump input must use LF line endings');

  const lines = input.endsWith('\n') ? input.slice(0, -1).split('\n') : input.split('\n');
  const output = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === COPY_END) throw new Error('unexpected COPY terminator outside a COPY block');
    output.push(line);
    if (!COPY_START.test(line)) continue;

    const rows = [];
    let terminated = false;
    while (index + 1 < lines.length) {
      index += 1;
      const row = lines[index];
      if (row === COPY_END) {
        terminated = true;
        break;
      }
      rows.push(row);
    }
    if (!terminated) throw new Error('unterminated COPY block in pg_dump data');
    rows.sort(bytewiseCompare);
    output.push(...rows, COPY_END);
  }

  return `${output.join('\n')}\n`;
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  process.stdout.write(canonicalizePgDumpData(Buffer.concat(chunks).toString('utf8')));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    process.stderr.write(`[PG DUMP CANONICALIZER ERROR] ${error.message}\n`);
    process.exitCode = 1;
  });
}
