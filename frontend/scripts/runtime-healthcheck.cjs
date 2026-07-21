'use strict';

const origin = new URL(process.argv[2] || 'http://127.0.0.1:3000');

async function fetchBounded(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    return await fetch(url, { signal: controller.signal, redirect: 'error' });
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const page = await fetchBounded(new URL('/login', origin));
  if (!page.ok) throw new Error(`login page returned ${page.status}`);

  const html = await page.text();
  const assetPaths = [...html.matchAll(/(?:src|href)=["']([^"']*\/_next\/static\/[^"']+\.(?:css|js)(?:\?[^"']*)?)["']/g)]
    .map((match) => match[1]);

  for (const extension of ['.css', '.js']) {
    const assetPath = assetPaths.find((value) => value.split('?', 1)[0].endsWith(extension));
    if (!assetPath) throw new Error(`login page did not reference a ${extension} asset`);

    const asset = await fetchBounded(new URL(assetPath, origin));
    const contentType = (asset.headers.get('content-type') || '').toLowerCase();
    const expectedType = extension === '.css' ? 'text/css' : 'javascript';
    if (!asset.ok || contentType.includes('text/html') || !contentType.includes(expectedType)) {
      throw new Error(`${assetPath} returned ${asset.status} ${contentType || 'without content-type'}`);
    }
  }

  // Public brand assets must bypass the authentication middleware. A 307 to
  // /login looks superficially reachable but renders as a broken image.
  for (const assetPath of ['/logo.png', '/favicon.ico']) {
    const asset = await fetchBounded(new URL(assetPath, origin));
    const contentType = (asset.headers.get('content-type') || '').toLowerCase();
    const body = await asset.arrayBuffer();
    if (asset.status !== 200 || !contentType.startsWith('image/') || body.byteLength === 0) {
      throw new Error(`${assetPath} returned ${asset.status} ${contentType || 'without content-type'}`);
    }
  }
}

main().catch((error) => {
  console.error(`[frontend health] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
