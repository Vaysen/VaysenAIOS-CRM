#!/usr/bin/env node
/**
 * 更新链 dry-run 校验（fail-closed）
 *
 * 校验 electron-builder 的更新链配置与单一版本源一致：
 *   - 版本号来自本包 package.json.version（单一版本源，见 src/shared/version.ts）
 *   - 局域网人工更新模式以 publish key 完全不存在为唯一契约
 *   - artifactName 必须包含 ${version}
 *   - extraResources.from 必须指向契约目录 ../frontend/electron-export
 *
 * 可选参数：
 *   --installed <ver>   模拟「已安装版本」，与本包版本做 isNewer 比较
 *   --strict             任何警告也视为失败（默认：仅硬性违规失败）
 *
 * 退出码：0 = 通过；1 = 存在违规（fail-closed）
 */

import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronDir = path.resolve(__dirname, '..'); // 指向 electron/ 根目录（scripts/ 的父级）

const errors = [];
const warnings = [];

function fail(msg) {
  errors.push(msg);
}
function warn(msg) {
  warnings.push(msg);
}

// ── 1. 读取单一版本源 ───────────────────────────────
const pkgPath = path.join(electronDir, 'package.json');
if (!fs.existsSync(pkgPath)) fail(`未找到 package.json: ${pkgPath}`);
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const APP_VERSION = pkg.version;
if (!APP_VERSION || !/^\d+\.\d+\.\d+/.test(APP_VERSION)) {
  fail(`package.json.version 非法: ${APP_VERSION}`);
}
console.log(`[verify-update-chain] 单一版本源 APP_VERSION = ${APP_VERSION}`);

// ── 2. 解析 electron-builder.yml（轻量行解析，避免引入 yaml 依赖）──
const ymlPath = path.join(electronDir, 'electron-builder.yml');
if (!fs.existsSync(ymlPath)) fail(`未找到 electron-builder.yml: ${ymlPath}`);
const yml = fs.readFileSync(ymlPath, 'utf8');

function findValue(key) {
  const re = new RegExp(`^\\s*(?:- )?${key}\\s*:\\s*(.+?)\\s*$`, 'm');
  const m = yml.match(re);
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : null;
}

function findUnderBlock(blockKey, key) {
  const lines = yml.split('\n');
  let inBlock = false;
  for (const line of lines) {
    if (new RegExp(`^${blockKey}\\s*:`).test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (/^[A-Za-z]/.test(line) && !/^\s/.test(line)) break; // 下一个顶层 key
      const m = line.match(new RegExp(`^\\s*(?:- )?${key}\\s*:\\s*(.+?)\\s*$`));
      if (m) return m[1].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return null;
}

// 发布模式：本软件仅在局域网使用，publish 块必须完全不存在。仅检查
// publish.url 会漏过 github/s3 等 provider。
if (!/^\s*publish\s*:/m.test(yml)) {
  console.log('[verify-update-chain] update mode = manual-lan（无 publish 配置，人工覆盖安装）');
} else {
  fail('局域网人工更新包不得包含任何 publish 配置');
}

// artifactName
const artifactName = findValue('artifactName');
if (!artifactName) {
  fail('electron-builder.yml: 未找到 artifactName');
} else if (!artifactName.includes('${version}')) {
  fail(`artifactName 必须包含 \${version}: ${artifactName}`);
} else {
  console.log(`[verify-update-chain] artifactName = ${artifactName} (OK)`);
}

// extraResources.from
const extraFrom = findUnderBlock('extraResources', 'from');
if (!extraFrom) {
  fail('electron-builder.yml: 未找到 extraResources.from');
} else if (extraFrom !== '../frontend/electron-export') {
  fail(`extraResources.from 必须指向契约目录 ../frontend/electron-export: ${extraFrom}`);
} else {
  console.log(`[verify-update-chain] extraResources.from = ${extraFrom} (OK)`);
}
if (!/-\s+from:\s*build\/icon\.ico\s*[\r\n]+\s*to:\s*brand\/icon\.ico/m.test(yml)) {
  fail('extraResources 必须把 build/icon.ico 打包为 brand/icon.ico，供系统托盘使用');
}

for (const iconKey of ['icon', 'installerIcon', 'uninstallerIcon', 'installerHeaderIcon']) {
  const iconValue = findValue(iconKey);
  if (iconValue !== 'build/icon.ico') {
    fail(`${iconKey} 必须指向品牌图标 build/icon.ico，实际为 ${iconValue || '(missing)'}`);
  }
}

const brandIconPath = path.join(electronDir, 'build', 'icon.ico');
if (!fs.existsSync(brandIconPath)) {
  fail(`品牌图标不存在: ${brandIconPath}`);
} else {
  const icon = fs.readFileSync(brandIconPath);
  if (icon.length < 22 || icon.readUInt16LE(0) !== 0 || icon.readUInt16LE(2) !== 1 || icon.readUInt16LE(4) < 1) {
    fail('build/icon.ico 不是可解析的 ICO 容器');
  }
}

const frontendExport = path.resolve(electronDir, '..', 'frontend', 'electron-export');
const contractPath = path.join(frontendExport, 'electron-build-contract.json');
const sumsPath = path.join(frontendExport, 'SHA512SUMS');
for (const required of [path.join(frontendExport, 'index.html'), contractPath, sumsPath]) {
  if (!fs.existsSync(required)) fail(`Electron 前端发布输入缺失: ${required}`);
}
if (fs.existsSync(contractPath)) {
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  if (contract.apiBaseUrl !== '/api' || contract.localProxy !== true || contract.target !== 'electron') {
    fail('Electron 前端契约必须是 target=electron、apiBaseUrl=/api、localProxy=true');
  }
}
if (fs.existsSync(sumsPath)) {
  for (const line of fs.readFileSync(sumsPath, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^([a-f0-9]{128})\s+(?:\*)?(.+)$/);
    if (!match) {
      fail(`SHA512SUMS 行格式非法: ${line}`);
      continue;
    }
    const filePath = path.resolve(frontendExport, match[2].replace(/\//g, path.sep));
    if (!filePath.startsWith(frontendExport + path.sep) || !fs.existsSync(filePath)) {
      fail(`SHA512SUMS 引用缺失或越界文件: ${match[2]}`);
      continue;
    }
    const actual = crypto.createHash('sha512').update(fs.readFileSync(filePath)).digest('hex');
    if (actual !== match[1]) fail(`SHA512 不匹配: ${match[2]}`);
  }
}

if (!pkg.scripts?.dist?.includes('release:prepare') || !pkg.scripts?.pack?.includes('release:prepare')) {
  fail('dist/pack 必须委托唯一的 release:prepare 发布入口，禁止打包旧前端缓存');
}
if (pkg.devDependencies?.rcedit !== '4.0.1') {
  fail(`Windows 品牌资源编辑器必须精确锁定 rcedit 4.0.1（Node 20 兼容），实际为 ${pkg.devDependencies?.rcedit || '(missing)'}`);
}
if (findValue('afterPack') !== 'scripts/after-pack-rcedit.js') {
  fail('electron-builder.yml 必须在 afterPack 调用锁文件安装的品牌资源钩子');
}
if (findUnderBlock('win', 'signAndEditExecutable') !== 'false') {
  fail('win.signAndEditExecutable 必须为 false，避免依赖需要 Windows symlink 权限的隐式 winCodeSign 下载器');
}
if (findUnderBlock('win', 'executableName') !== 'vaysen-crm-desktop') {
  fail('win.executableName 必须为稳定 ASCII 名 vaysen-crm-desktop');
}
const afterPackPath = path.join(electronDir, 'scripts', 'after-pack-rcedit.js');
if (!fs.existsSync(afterPackPath)) {
  fail(`品牌资源 afterPack 钩子不存在: ${afterPackPath}`);
} else {
  const source = fs.readFileSync(afterPackPath, 'utf8');
  for (const required of ['Vaysen AI CRM', 'Example Trading Company', 'build', 'icon.ico']) {
    if (!source.includes(required)) fail(`afterPack 品牌资源钩子缺少契约: ${required}`);
  }
}

// ── 3. 可选：模拟已安装版本比较 ─────────────────────
const installedIdx = process.argv.indexOf('--installed');
if (installedIdx !== -1) {
  const installed = process.argv[installedIdx + 1] || '';
  const a = APP_VERSION.split('.').map(Number);
  const b = installed.split('.').map(Number);
  let newer = false;
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(a[i]) ? a[i] : 0;
    const y = Number.isFinite(b[i]) ? b[i] : 0;
    if (x > y) {
      newer = true;
      break;
    }
    if (x < y) break;
  }
  console.log(
    `[verify-update-chain] 已安装=${installed} 当前=${APP_VERSION} → ${newer ? '有可用更新' : '已是最新'}`
  );
}

// ── 4. 汇总 ──────────────────────────────────────────
const strict = process.argv.includes('--strict');
if (warnings.length) {
  for (const w of warnings) console.warn(`[WARN] ${w}`);
}
if (errors.length) {
  console.error('\n[verify-update-chain] ❌ 校验未通过：');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('\n[verify-update-chain] ✅ 更新链配置校验通过');
process.exit(0);
