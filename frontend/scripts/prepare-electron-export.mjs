// TASK-110：将 Next 静态导出目录 out/ 复制为稳定的 TASK-111 契约路径 electron-export/
// 这样无论 Next 内部导出目录如何命名，TASK-111 的 electron-builder.yml 始终消费固定路径。
import { cpSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateElectronApiUrl } from './electron-api-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'out');
const dest = resolve(root, 'electron-export');

const apiValidation = validateElectronApiUrl(process.env.NEXT_PUBLIC_API_URL || '/api');
if (!apiValidation.ok) {
  console.error(`[prepare-electron-export] API 配置拒绝导出：${apiValidation.reason}`);
  process.exit(1);
}

if (!existsSync(src)) {
  console.error(
    '[prepare-electron-export] 未找到 out/，请先运行 next build（NEXT_OUTPUT=export）。',
  );
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
writeFileSync(
  resolve(dest, 'electron-build-contract.json'),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      target: 'electron',
      apiBaseUrl: apiValidation.normalizedUrl,
      apiOrigin: apiValidation.origin,
      privateOrigin: apiValidation.privateOrigin,
      localProxy: apiValidation.localProxy,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

const files = readdirSync(dest);
console.log(
  `[prepare-electron-export] 已导出 Electron 静态资源到 ${dest}（${files.length} 个顶层条目）。`,
);
console.log('[prepare-electron-export] TASK-111 契约路径：frontend/electron-export/');
