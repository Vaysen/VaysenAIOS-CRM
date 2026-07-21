'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const { test } = require('node:test');

const healthcheck = path.join(__dirname, 'runtime-healthcheck.cjs');

async function withServer(assetContentType, callback, options = {}) {
  const server = http.createServer((request, response) => {
    if (request.url === '/login') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<link href="/_next/static/app.css" rel="stylesheet"><script src="/_next/static/app.js"></script>');
      return;
    }
    if (request.url === '/_next/static/app.css') {
      response.writeHead(200, { 'content-type': assetContentType || 'text/css; charset=utf-8' });
      response.end('body{}');
      return;
    }
    if (request.url === '/_next/static/app.js') {
      response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      response.end('globalThis.__healthy=true;');
      return;
    }
    if (request.url === '/logo.png') {
      if (options.redirectLogo) {
        response.writeHead(307, { location: '/login' }).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(options.emptyLogo ? '' : 'brand-logo');
      return;
    }
    if (request.url === '/favicon.ico') {
      if (options.missingFavicon) {
        response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }).end('missing');
        return;
      }
      response.writeHead(200, { 'content-type': 'image/x-icon' });
      response.end('brand-icon');
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function runHealthcheck(origin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [healthcheck, origin], { windowsHide: true });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
}

test('accepts a login shell whose CSS and JavaScript assets have executable MIME types', async () => {
  const result = await withServer(undefined, runHealthcheck);
  assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null });
});

test('rejects an HTML fallback returned for a referenced stylesheet', async () => {
  const result = await withServer('text/html; charset=utf-8', runHealthcheck);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /returned 200 text\/html/);
});

test('rejects a brand logo redirected to the authenticated login page', async () => {
  const result = await withServer(undefined, runHealthcheck, { redirectLogo: true });
  assert.equal(result.code, 1);
});

test('rejects a missing favicon from the production image', async () => {
  const result = await withServer(undefined, runHealthcheck, { missingFavicon: true });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /favicon\.ico returned 404 text\/html/);
});

test('rejects an empty brand image response', async () => {
  const result = await withServer(undefined, runHealthcheck, { emptyLogo: true });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /logo\.png returned 200 image\/png/);
});
