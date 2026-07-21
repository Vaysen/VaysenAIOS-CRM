'use strict';

const assert = require('node:assert/strict');

async function main() {
  const adapter = require('../dist/src/modules/whatsapp/whatsapp-adapter.js');
  const loader = require('../dist/src/modules/whatsapp/baileys-loader.js');

  assert.equal(typeof adapter.WhatsAppAdapter, 'function');
  assert.equal(typeof loader.loadBaileys, 'function');

  const baileys = await loader.loadBaileys();
  assert.equal(typeof baileys.makeWASocket, 'function');
  assert.equal(typeof baileys.useMultiFileAuthState, 'function');
  assert.equal(typeof baileys.downloadMediaMessage, 'function');
  assert.ok(baileys.DisconnectReason);

  console.log('[RUNTIME LOAD OK] CommonJS backend can lazily load Baileys ESM');
}

main().catch((error) => {
  console.error('[RUNTIME LOAD ERROR]', error);
  process.exitCode = 1;
});
