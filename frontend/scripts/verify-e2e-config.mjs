import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const config = await readFile('playwright.config.ts', 'utf8');
const requiredScripts = ['e2e', 'e2e:ui'];
const failures = requiredScripts
  .filter((name) => !pkg.scripts?.[name])
  .map((name) => `missing script ${name}`);
if (!config.includes("const e2eBaseUrl = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3100'")) {
  failures.push('Playwright must use the dedicated E2E base URL');
}
if (!config.includes("command: 'npm run dev -- -p 3100'")) {
  failures.push('Playwright webServer must bind the dedicated E2E port');
}
if (!config.includes('baseURL: e2eBaseUrl') || !config.includes('url: e2eBaseUrl')) {
  failures.push('Playwright use.baseURL and webServer.url must share e2eBaseUrl');
}
if (!config.includes('process.env.PLAYWRIGHT_CHANNEL')) {
  failures.push('Playwright must support a preinstalled browser channel');
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('E2E config verified');
