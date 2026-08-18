'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const distRoot = path.resolve(__dirname, '..', 'dist');
const runtimePaths = {
  main: path.join(distRoot, 'src', 'main.js'),
  worker: path.join(distRoot, 'src', 'worker.js'),
  whatsappAdapter: path.join(distRoot, 'src', 'modules', 'whatsapp', 'whatsapp-adapter.js'),
  baileysLoader: path.join(distRoot, 'src', 'modules', 'whatsapp', 'baileys-loader.js'),
};

function verifyBuildLayout() {
  for (const [name, runtimePath] of Object.entries(runtimePaths)) {
    assert.ok(fs.existsSync(runtimePath), `Missing standard backend runtime output (${name}): ${runtimePath}`);
  }

  const nestedBackendSource = path.join(distRoot, 'backend', 'src');
  assert.equal(
    fs.existsSync(nestedBackendSource),
    false,
    `Invalid nested backend build output must not replace dist/src: ${nestedBackendSource}`,
  );
}

async function main() {
  verifyBuildLayout();

  const adapter = require(runtimePaths.whatsappAdapter);
  const loader = require(runtimePaths.baileysLoader);

  assert.equal(typeof adapter.WhatsAppAdapter, 'function');
  assert.equal(typeof loader.loadBaileys, 'function');

  const baileys = await loader.loadBaileys();
  assert.equal(typeof baileys.makeWASocket, 'function');
  assert.equal(typeof baileys.useMultiFileAuthState, 'function');
  assert.equal(typeof baileys.downloadMediaMessage, 'function');
  assert.ok(baileys.DisconnectReason);

  console.log('[RUNTIME LOAD OK] Standard dist/src layout and lazy Baileys ESM load verified');
}

main().catch((error) => {
  console.error('[RUNTIME LOAD ERROR]', error);
  process.exitCode = 1;
});
