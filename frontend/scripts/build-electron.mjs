// TASK-110：Electron 静态导出构建入口（跨平台，仅依赖 Node，无需 cross-env）
// 设置 NEXT_OUTPUT=export 后执行 next build，产出 Next 静态导出目录 out/
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { validateElectronApiUrl } from './electron-api-policy.mjs';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const checkOnly = args.length === 1 && args[0] === '--check';
if (args.length > 0 && !checkOnly) {
  console.error(`[build-electron] 未知参数：${args.join(' ')}`);
  process.exit(2);
}

const requestedApiUrl = process.env.NEXT_PUBLIC_API_URL || '/api';
const apiValidation = validateElectronApiUrl(requestedApiUrl);
if (!apiValidation.ok) {
  console.error(`[build-electron] API 配置拒绝构建：${apiValidation.reason}`);
  process.exit(1);
}

process.env.NEXT_PUBLIC_API_URL = apiValidation.normalizedUrl;
process.env.NEXT_OUTPUT = 'export';

if (checkOnly) {
console.log(
    `[build-electron] API 配置通过：${apiValidation.normalizedUrl} (${apiValidation.localProxy ? 'Electron 同源局域网代理' : apiValidation.privateOrigin ? '已批准私网/ZeroTier' : '公网 HTTPS'})`,
  );
  process.exit(0);
}

// 解析 next 可执行文件（兼容本地或 hoisted node_modules）
let nextBin;
try {
  nextBin = require.resolve('next/dist/bin/next', { paths: [root] });
} catch (error) {
  console.error(`[build-electron] 无法解析本地 Next 构建器，请先执行 npm ci：${error.message}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, [nextBin, 'build'], {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error(`[build-electron] 启动 Next 构建失败：${result.error.message}`);
}

process.exit(result.status ?? 1);
