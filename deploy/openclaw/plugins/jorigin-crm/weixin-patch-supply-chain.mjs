#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

function fail(message) {
  throw new Error(message);
}

function assertRegularFile(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-link file: ${file}`);
}

function digest(buffer, algorithm, encoding = 'hex') {
  return createHash(algorithm).update(buffer).digest(encoding);
}

function tarString(buffer, start, length) {
  const field = buffer.subarray(start, start + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString('utf8');
}

function tarNumber(buffer, start, length, label) {
  const field = buffer.subarray(start, start + length);
  if ((field[0] & 0x80) !== 0) fail(`unsupported base-256 tar ${label}`);
  const raw = field.toString('ascii').replace(/\0.*$/s, '').trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) fail(`invalid tar ${label}`);
  const parsed = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail(`invalid tar ${label}`);
  return parsed;
}

function parsePax(data) {
  const values = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) fail('invalid pax record length');
    const lengthText = data.subarray(offset, space).toString('ascii');
    if (!/^[1-9][0-9]*$/.test(lengthText)) fail('invalid pax record length');
    const length = Number.parseInt(lengthText, 10);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > data.length || data[end - 1] !== 0x0a) {
      fail('truncated pax record');
    }
    const record = data.subarray(space + 1, end - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals <= 0) fail('invalid pax record');
    values[record.slice(0, equals)] = record.slice(equals + 1);
    offset = end;
  }
  return values;
}

function normalizeEntry(value, isDirectory) {
  if (!value || value.includes('\\') || value.includes('\0') || /[\u0000-\u001f]/.test(value)) {
    fail(`unsafe npm-pack entry path: ${JSON.stringify(value)}`);
  }
  const withoutSlash = value.endsWith('/') ? value.slice(0, -1) : value;
  if (withoutSlash === 'package' && isDirectory) return null;
  if (!withoutSlash.startsWith('package/')) fail(`npm-pack entry is outside package root: ${value}`);
  const relative = withoutSlash.slice('package/'.length);
  const normalized = path.posix.normalize(relative);
  if (!relative || normalized !== relative || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(relative)) {
    fail(`unsafe npm-pack entry path: ${value}`);
  }
  if (relative === 'node_modules' || relative.startsWith('node_modules/')) {
    fail(`npm-pack artifact contains forbidden node_modules content: ${relative}`);
  }
  return relative;
}

export function readSafeNpmPack(artifactPath) {
  assertRegularFile(artifactPath, 'upstream npm-pack artifact');
  let tar;
  try {
    tar = gunzipSync(fs.readFileSync(artifactPath));
  } catch (error) {
    fail(`invalid npm-pack gzip stream: ${error instanceof Error ? error.message : String(error)}`);
  }
  const files = new Map();
  let offset = 0;
  let globalPax = {};
  let nextPax = {};
  let longPath = null;
  let sawEnd = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      sawEnd = true;
      break;
    }
    const size = tarNumber(header, 124, 12, 'entry size');
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) fail('truncated npm-pack tar entry');
    const data = tar.subarray(dataStart, dataEnd);
    const type = String.fromCharCode(header[156] || 0);
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const headerPath = prefix ? `${prefix}/${name}` : name;
    if (type === 'x' || type === 'g') {
      const values = parsePax(data);
      if (values.linkpath) fail('npm-pack pax record contains a link target');
      if (type === 'g') globalPax = { ...globalPax, ...values };
      else nextPax = values;
    } else if (type === 'L') {
      longPath = data.toString('utf8').replace(/\0.*$/s, '').replace(/\n$/, '');
    } else {
      const effectivePath = nextPax.path ?? longPath ?? globalPax.path ?? headerPath;
      nextPax = {};
      longPath = null;
      const isDirectory = type === '5';
      if (type !== '\0' && type !== '0' && !isDirectory) {
        fail(`npm-pack artifact contains unsupported entry type ${JSON.stringify(type)}: ${effectivePath}`);
      }
      const relative = normalizeEntry(effectivePath, isDirectory);
      if (!isDirectory && relative) {
        if (files.has(relative)) fail(`duplicate npm-pack file: ${relative}`);
        files.set(relative, Buffer.from(data));
      }
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (!sawEnd || files.size === 0) fail('npm-pack tar is missing its terminator or files');
  return files;
}

function putString(header, offset, length, value, label) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) fail(`${label} is too long for deterministic ustar`);
  bytes.copy(header, offset);
}

function putOctal(header, offset, length, value, label) {
  const raw = value.toString(8);
  if (raw.length > length - 1) fail(`${label} is too large for deterministic ustar`);
  putString(header, offset, length, `${raw.padStart(length - 1, '0')}\0`, label);
}

function tarHeader(relative, size) {
  const pathname = `package/${relative}`;
  const header = Buffer.alloc(512, 0);
  putString(header, 0, 100, pathname, 'npm-pack path');
  putOctal(header, 100, 8, 0o644, 'mode');
  putOctal(header, 108, 8, 0, 'uid');
  putOctal(header, 116, 8, 0, 'gid');
  putOctal(header, 124, 12, size, 'size');
  putOctal(header, 136, 12, 0, 'mtime');
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  putString(header, 257, 6, 'ustar\0', 'ustar magic');
  putString(header, 263, 2, '00', 'ustar version');
  putString(header, 265, 32, 'root', 'uname');
  putString(header, 297, 32, 'root', 'gname');
  const checksum = header.reduce((total, byte) => total + byte, 0);
  const encoded = `${checksum.toString(8).padStart(6, '0')}\0 `;
  putString(header, 148, 8, encoded, 'checksum');
  return header;
}

export function createDeterministicTar(files) {
  const chunks = [];
  for (const relative of [...files.keys()].sort()) {
    const data = files.get(relative);
    chunks.push(tarHeader(relative, data.length), data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// A stored-block gzip stream avoids zlib-version/platform variance. The bytes
// are reproducible on Linux and Windows and still conform to RFC 1952/1951.
export function deterministicGzipStore(buffer) {
  const chunks = [Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff])];
  let offset = 0;
  while (offset < buffer.length) {
    const length = Math.min(65_535, buffer.length - offset);
    const final = offset + length === buffer.length;
    const header = Buffer.alloc(5);
    header[0] = final ? 0x01 : 0x00;
    header.writeUInt16LE(length, 1);
    header.writeUInt16LE((~length) & 0xffff, 3);
    chunks.push(header, buffer.subarray(offset, offset + length));
    offset += length;
  }
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(buffer), 0);
  trailer.writeUInt32LE(buffer.length >>> 0, 4);
  chunks.push(trailer);
  return Buffer.concat(chunks);
}

function occurrences(source, needle) {
  if (!needle) fail('patch replacement search must not be empty');
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

export function applyReviewedPatch(files, patch) {
  if (patch?.schemaVersion !== 1 || !patch.files || typeof patch.files !== 'object') {
    fail('unsupported Weixin patch manifest');
  }
  const output = new Map(files);
  for (const [relative, rule] of Object.entries(patch.files)) {
    const input = output.get(relative);
    if (!input) fail(`reviewed patch input is missing: ${relative}`);
    const beforeSha256 = digest(input, 'sha256');
    if (beforeSha256 !== rule.beforeSha256) fail(`reviewed patch input digest mismatch: ${relative}`);
    let text = input.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(input)) fail(`reviewed patch input is not canonical UTF-8: ${relative}`);
    for (const replacement of rule.replacements ?? []) {
      const expectedOccurrences = replacement.expectedOccurrences ?? 1;
      const count = occurrences(text, replacement.search);
      if (count !== expectedOccurrences) {
        fail(`reviewed patch anchor count mismatch: ${relative} expected=${expectedOccurrences} actual=${count}`);
      }
      text = text.split(replacement.search).join(replacement.replace);
    }
    const patched = Buffer.from(text, 'utf8');
    const afterSha256 = digest(patched, 'sha256');
    if (afterSha256 !== rule.afterSha256) fail(`reviewed patch output digest mismatch: ${relative}`);
    output.set(relative, patched);
  }
  for (const [relative, addition] of Object.entries(patch.addFiles ?? {})) {
    if (output.has(relative)) fail(`reviewed patch addition already exists upstream: ${relative}`);
    if (path.posix.normalize(relative) !== relative || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
      fail(`reviewed patch addition has an unsafe path: ${relative}`);
    }
    const content = Buffer.from(addition.content, 'utf8');
    if (digest(content, 'sha256') !== addition.sha256) {
      fail(`reviewed patch addition digest mismatch: ${relative}`);
    }
    output.set(relative, content);
  }
  return output;
}

export function normalizedTreeSha256(files) {
  const records = [...files.keys()].sort().map((relative) => {
    const content = files.get(relative);
    return `${relative}\0${content.length}\0${digest(content, 'sha256')}`;
  });
  return digest(Buffer.from(`${records.join('\n')}\n`, 'utf8'), 'sha256');
}

export function buildPatchedArtifact({ upstreamPath, patchPath }) {
  assertRegularFile(upstreamPath, 'upstream npm-pack artifact');
  assertRegularFile(patchPath, 'reviewed patch manifest');
  const upstream = fs.readFileSync(upstreamPath);
  const patchBytes = fs.readFileSync(patchPath);
  const patch = JSON.parse(patchBytes.toString('utf8'));
  const patchRoot = path.dirname(path.resolve(patchPath));
  const patchPayloads = {};
  const resolvedAddFiles = {};
  for (const [relative, addition] of Object.entries(patch.addFiles ?? {})) {
    if (typeof addition.sourceFile !== 'string' || path.posix.normalize(addition.sourceFile) !== addition.sourceFile
      || addition.sourceFile.startsWith('../') || path.posix.isAbsolute(addition.sourceFile)) {
      fail(`reviewed patch payload path is unsafe: ${relative}`);
    }
    const payloadPath = path.resolve(patchRoot, ...addition.sourceFile.split('/'));
    const payloadRelative = path.relative(patchRoot, payloadPath);
    if (payloadRelative.startsWith(`..${path.sep}`) || payloadRelative === '..' || path.isAbsolute(payloadRelative)) {
      fail(`reviewed patch payload escapes its root: ${relative}`);
    }
    assertRegularFile(payloadPath, 'reviewed patch payload');
    const content = fs.readFileSync(payloadPath);
    const payloadSha256 = digest(content, 'sha256');
    if (payloadSha256 !== addition.sha256) fail(`reviewed patch payload digest mismatch: ${relative}`);
    if (!Buffer.from(content.toString('utf8'), 'utf8').equals(content)) fail(`reviewed patch payload is not UTF-8: ${relative}`);
    resolvedAddFiles[relative] = { ...addition, content: content.toString('utf8') };
    patchPayloads[relative] = { path: payloadPath, sha256: payloadSha256 };
  }
  const resolvedPatch = { ...patch, addFiles: resolvedAddFiles };
  const upstreamFacts = {
    sha1: digest(upstream, 'sha1'),
    sha256: digest(upstream, 'sha256'),
    integrity: `sha512-${digest(upstream, 'sha512', 'base64')}`,
  };
  for (const [key, actual] of Object.entries(upstreamFacts)) {
    if (patch.upstream?.[key] !== actual) fail(`upstream artifact ${key} mismatch`);
  }
  const files = readSafeNpmPack(upstreamPath);
  const packageJson = JSON.parse(files.get('package.json')?.toString('utf8') ?? 'null');
  if (packageJson?.name !== patch.packageName || packageJson?.version !== patch.version) {
    fail('upstream package identity mismatch');
  }
  const patchedFiles = applyReviewedPatch(files, resolvedPatch);
  const artifact = deterministicGzipStore(createDeterministicTar(patchedFiles));
  return {
    artifact,
    patchSha256: digest(patchBytes, 'sha256'),
    patchPayloads,
    upstream: upstreamFacts,
    patched: {
      sha1: digest(artifact, 'sha1'),
      sha256: digest(artifact, 'sha256'),
      integrity: `sha512-${digest(artifact, 'sha512', 'base64')}`,
      treeSha256: normalizedTreeSha256(patchedFiles),
      size: artifact.length,
    },
    files: patchedFiles,
  };
}

function main() {
  const [upstreamPath, patchPath, outputPath] = process.argv.slice(2);
  if (!upstreamPath || !patchPath || !outputPath) {
    fail('usage: weixin-patch-supply-chain.mjs <verified-upstream.tgz> <reviewed-patch.json> <patched-output.tgz>');
  }
  const outputParent = path.dirname(path.resolve(outputPath));
  const parentStat = fs.lstatSync(outputParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) fail('patched artifact parent must be a real directory');
  if (fs.existsSync(outputPath)) fail('patched artifact output already exists');
  const result = buildPatchedArtifact({ upstreamPath, patchPath });
  const patch = JSON.parse(fs.readFileSync(patchPath, 'utf8'));
  for (const [key, actual] of Object.entries(result.patched)) {
    if (key === 'size') continue;
    if (patch.patched?.[key] !== actual) fail(`patched artifact ${key} mismatch`);
  }
  fs.writeFileSync(outputPath, result.artifact, { mode: 0o600, flag: 'wx' });
  const persisted = fs.readFileSync(outputPath);
  if (!persisted.equals(result.artifact)) fail('patched artifact write verification failed');
  process.stdout.write(`${JSON.stringify({ patchSha256: result.patchSha256, patched: result.patched })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
