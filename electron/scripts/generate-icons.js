#!/usr/bin/env node
/**
 * Brand icon guard.
 *
 * The former script generated an unrelated blue placeholder and could silently
 * overwrite the approved Vaysen AI CRM artwork. Brand assets are now reviewed
 * release inputs: build/icon-source.png + build/icon.ico. This command only
 * validates them and never writes or regenerates artwork.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const buildDir = path.resolve(__dirname, '..', 'build');
const sourcePath = path.join(buildDir, 'icon-source.png');
const icoPath = path.join(buildDir, 'icon.ico');
const APPROVED_SOURCE_SHA256 = '2d3e30d9ff5643a77dc1adf3c55391d51c07bf5da386b214fb780d1d2a1406e9';
const APPROVED_ICO_SHA256 = '60615070c195406b58bcea3b62be77fea0bfe6665833f7296537da9ea83a6a48';
const APPROVED_ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function fail(message) {
  console.error(`[brand-icon] ${message}`);
  process.exit(1);
}

for (const file of [sourcePath, icoPath]) {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) fail(`missing approved brand asset: ${file}`);
}

const png = fs.readFileSync(sourcePath);
if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
  fail('icon-source.png is not a valid PNG input');
}
const ico = fs.readFileSync(icoPath);
if (ico.length < 22 || ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1 || ico.readUInt16LE(4) < 1) {
  fail('icon.ico is not a valid ICO container');
}

const sourceSha = crypto.createHash('sha256').update(png).digest('hex');
const icoSha = crypto.createHash('sha256').update(ico).digest('hex');
if (sourceSha !== APPROVED_SOURCE_SHA256 || icoSha !== APPROVED_ICO_SHA256) {
  fail('brand asset digest changed; an explicit branding review and guard update are required');
}
const count = ico.readUInt16LE(4);
const sizes = [];
for (let index = 0; index < count; index += 1) {
  const offset = 6 + index * 16;
  if (offset + 16 > ico.length) fail('icon.ico directory is truncated');
  const width = ico[offset] || 256;
  const height = ico[offset + 1] || 256;
  if (width !== height) fail(`icon.ico contains a non-square frame: ${width}x${height}`);
  sizes.push(width);
}
if (JSON.stringify(sizes) !== JSON.stringify(APPROVED_ICO_SIZES)) {
  fail(`icon.ico must contain approved frames ${APPROVED_ICO_SIZES.join(',')}; actual ${sizes.join(',')}`);
}

console.log(`[brand-icon] source sha256=${sourceSha}`);
console.log(`[brand-icon] ico sha256=${icoSha}`);
console.log(`[brand-icon] frames=${sizes.join(',')}`);
console.log('[brand-icon] approved assets verified; no files written');
