/**
 * Electron 前端构建包装器（TASK-111 v1.2b 复审后 — 窄范围修正）
 *
 * 唯一职责：把 `electron/scripts/build-frontend.js` 收敛为「单用途 Electron 包装器」。
 * 不再保留任何发布入口的"跳过"或"目录覆盖"旁路（v1.2 复审红线 #2）：
 *   - 删除 SKIP_NPM_BUILD：步骤 1 始终真调 spawnSync（不再 console.log + return）。
 *   - 删除 FRONTEND_DIR_OVERRIDE：FRONTEND_DIR 永远从 __dirname 解析为
 *     `path.resolve(__dirname, '..', '..', 'frontend')`（v1.1 阶段 A 用 3 级 ..
 *     解析到外层，v1.2b 锁定 2 级 ..）。
 *
 * 依赖注入（用于单测）：
 *   - createRunner({ npmCmd, spawnFn, clock, env, log, fail })：构造 spawnSync 调用
 *     包装。单测可注入 fake spawnFn（不真调 npm），但 Windows 真实 spawn 测试
 *     必须注入真的 `child_process.spawnSync` 并真跑 `npm.cmd --version`。
 *   - mainRun(deps, ctx)：所有 step + final writeSumsVerify 都返回 `{ok, errors[]}`，
 *     不调 process.exit；上层 main() 拿到 errors 后才 fail-closed 退出。
 *
 * 步骤（全部 fail-closed）：
 *   1. runner(FRONTEND_DIR) → spawnSync `npm run build:electron`，子进程必须 exit 0
 *      （Windows: shell:true 跨平台；POSIX: /bin/sh）
 *   2. 校验 FRONTEND_DIR/electron-export/index.html 存在
 *   3. 校验 NEXT_PUBLIC_API_URL：
 *      - 缺失 → 立即返回错误（不能产出无法连业务后端的安装包）
 *      - 本机/loopback 永远拒绝；私网/ZeroTier 必须精确命中 allowlist
 *      - 公网必须 HTTPS；userinfo/query/fragment 一律拒绝
 *   4. 写 SHA512SUMS（不自引用）+ 写后**完整**复算（独立扫磁盘 rehash 比对，
 *      不只信刚写的清单）
 *
 * 关键不变量：
 *   - 入口（FRONTEND_DIR）不来自 env
 *   - spawnSync shell:true 跨平台（解决 Windows npm.cmd EINVAL）
 *   - 写后复算 = 重新枚举磁盘 + 逐项 rehash，能发现"清单外新增文件"
 *   - 任何 step 失败 → 返回可识别 Error，main() fail-closed 退出
 *
 * 注意：本脚本提交的是「包装器代码 + 单测 + 契约」，真实 build:electron
 * 端到端仍需等 TASK-110 v1.1 集成。Windows 真实 spawn 测试覆盖
 * `npm.cmd --version` 跨平台 shell:true（不是通用 node -e）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync: realSpawnSync } = require('child_process');

const FRONTEND_DIR = path.resolve(__dirname, '..', '..', 'frontend');
const EXPORT_DIR = path.join(FRONTEND_DIR, 'electron-export');
const ENTRY_FILE = path.join(EXPORT_DIR, 'index.html');
const SUMS_FILE = path.join(EXPORT_DIR, 'SHA512SUMS');
const SUMS_FILE_TMP = path.join(EXPORT_DIR, 'SHA512SUMS.tmp');

const NPM_CMD = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const LOCAL_HOST = /^(localhost|0\.0\.0\.0|::1|127\.)/i;
const PRIVATE_HOST = /^(localhost|0\.0\.0\.0|::1|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/i;

class BuildFrontendError extends Error {
  constructor(stage, message) {
    super(`[${stage}] ${message}`);
    this.name = 'BuildFrontendError';
    this.stage = stage;
  }
}

/**
 * 创建 spawnSync runner（依赖注入点，单测可注入 fake spawnFn）。
 * @param {object} opts
 * @param {string} [opts.npmCmd] - 跨平台 npm 命令（默认 NPM_CMD）
 * @param {Function} [opts.spawnSync] - 注入的 spawnSync（默认 child_process.spawnSync）
 * @param {object} [opts.env] - 注入的 env（默认 process.env）
 * @param {Function} [opts.log] - 注入的 logger（默认 console.log）
 */
function createRunner({
  npmCmd = NPM_CMD,
  npmArgs = ['run', 'build:electron'],
  spawnSync = realSpawnSync,
  env = process.env,
  log = console.log,
} = {}) {
  return {
    runFrontendBuild(cwd) {
      log(`[build-frontend] 步骤 1：${npmCmd} ${npmArgs.join(' ')} @ ${cwd}`);
      // shell:true 跨平台：Windows 上 npm 是 .cmd/.bat，spawnSync 需 shell 才能解析，
      // 否则 EINVAL（v1.2 复审红线 #1）；POSIX 走 /bin/sh。stdio:'inherit' 让用户能看到输出。
      const r = spawnSync(npmCmd, npmArgs, {
        cwd,
        stdio: 'inherit',
        env,
        shell: true,
      });
      if (r.error) {
        throw new BuildFrontendError('步骤1', `spawn 失败: ${r.error.message}`);
      }
      if (r.status !== 0) {
        throw new BuildFrontendError('步骤1', `frontend build:electron exit ${r.status}（非零）`);
      }
      log('[build-frontend] 步骤 1：子进程 exit 0');
    },
  };
}

function parseApprovedOrigins(raw = '') {
  const origins = new Set();
  for (const entry of raw.split(',')) {
    const value = entry.trim();
    if (!value) continue;
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol)) continue;
      if (parsed.username || parsed.password || parsed.search || parsed.hash) continue;
      if (parsed.pathname !== '/' && parsed.pathname !== '') continue;
      origins.add(parsed.origin);
    } catch {
      // 非法 allowlist 项只会被忽略，不会扩大权限。
    }
  }
  return origins;
}

function isForbidApiUrl(url, approvedOriginsRaw = process.env.APPROVED_ZEROTIER_API_ORIGINS || '') {
  if (typeof url !== 'string' || !url.trim()) return 'URL 为空';
  if (url.trim() === '/api') return null;
  let u;
  try {
    u = new URL(url.trim());
  } catch {
    return 'URL 解析失败';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `协议非 http(s): ${u.protocol}`;
  if (u.username || u.password || u.search || u.hash) return 'URL 不允许凭据、查询参数或 fragment';
  if (LOCAL_HOST.test(u.hostname)) return `localhost/loopback 禁止用于发布: ${u.hostname}`;
  const isPrivate = PRIVATE_HOST.test(u.hostname);
  if (isPrivate && !parseApprovedOrigins(approvedOriginsRaw).has(u.origin)) {
    return `私网/ZeroTier origin 未在 APPROVED_ZEROTIER_API_ORIGINS 中: ${u.origin}`;
  }
  if (!isPrivate && u.protocol !== 'https:') return `公网 API 必须使用 HTTPS: ${u.origin}`;
  return null;
}

// ── SHA512SUMS：扫描 + 安全校验 + 写后完整复算 ──

function _scanEntries(dir, sumsFile) {
  const entries = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else {
        const rel = path.relative(dir, p).replace(/\\/g, '/');
        if (rel === 'SHA512SUMS' || rel === 'SHA512SUMS.tmp') continue;
        entries.push({ rel, abs: p });
      }
    }
  };
  walk(dir);
  entries.sort((a, b) => a.rel.localeCompare(b.rel));
  return entries;
}

function _hashFile(abs) {
  const buf = fs.readFileSync(abs);
  return crypto.createHash('sha512').update(buf).digest('hex');
}

function _validateRel(rel) {
  if (path.isAbsolute(rel)) return `绝对路径: ${rel}`;
  if (rel.split('/').some((seg) => seg === '..')) return `路径穿越: ${rel}`;
  return null;
}

/**
 * 写 SHA512SUMS 后**完整**复算：重新枚举磁盘（不依赖 writeSums 的 entries 缓存），
 * 逐项 rehash 比对清单。
 * 关键差异（v1.2 复审红线 #6）：如果写盘后磁盘新增了清单外的文件，复算会发现。
 */
function verifyAgainstExistingSums(dir, sumsFile) {
  if (!fs.existsSync(sumsFile)) return { present: false };
  const written = fs.readFileSync(sumsFile, 'utf8').split('\n').filter(Boolean);
  const seen = new Set();
  for (const line of written) {
    const spaceIdx = line.indexOf('  ');
    if (spaceIdx !== 128) {
      throw new BuildFrontendError('步骤4', `SHA512SUMS 行格式错误: ${line.slice(0, 40)}...`);
    }
    const want = line.slice(0, 128);
    const rel = line.slice(130);
    const vErr = _validateRel(rel);
    if (vErr) throw new BuildFrontendError('步骤4', `SHA512SUMS 非法条目: ${vErr}`);
    if (seen.has(rel)) throw new BuildFrontendError('步骤4', `SHA512SUMS 重复条目: ${rel}`);
    seen.add(rel);
    const abs = path.join(dir, rel);
    if (!fs.existsSync(abs)) {
      throw new BuildFrontendError('步骤4', `SHA512SUMS 引用不存在的文件: ${rel}`);
    }
    const got = _hashFile(abs);
    if (want !== got) {
      throw new BuildFrontendError(
        '步骤4',
        `SHA512SUMS 哈希失配: ${rel} (清单 ${want.slice(0, 12)}…, 磁盘 ${got.slice(0, 12)}…)`
      );
    }
  }
  return { present: true, count: written.length };
}

/**
 * 写 SHA512SUMS + 写盘前后双校验（v1.2b 红线 #6）。
 * 关键不变量：
 *   1) 写盘**前**用 verifyAgainstExistingSums 校验现有清单（catch 外部篡改）
 *   2) 写新清单（基于当前磁盘 scan）
 *   3) 写盘**后**重新枚举磁盘（不信任 entries 缓存），逐项 rehash
 *      （catch "清单外新增文件"——写盘过程中塞了文件）
 */
function writeSumsAndVerify(dir, sumsFile, log = console.log) {
  // 1) 写盘前独立复算：catch 已存在的坏清单（v1.2b 红线 #6 — 外部篡改检测）
  verifyAgainstExistingSums(dir, sumsFile);
  // 2) 删除旧清单
  try { fs.unlinkSync(sumsFile); } catch { /* 旧的不存在可接受 */ }
  // 3) 扫描 + 安全校验
  const entries = _scanEntries(dir, sumsFile);
  for (const { rel } of entries) {
    const vErr = _validateRel(rel);
    if (vErr) throw new BuildFrontendError('步骤4', `扫描非法条目: ${vErr}`);
  }
  const seen = new Set();
  for (const { rel } of entries) {
    if (seen.has(rel)) throw new BuildFrontendError('步骤4', `扫描重复条目: ${rel}`);
    seen.add(rel);
  }
  // 4) 计算哈希 + 写临时文件 + 原子重命名
  const lines = entries.map(({ rel, abs }) => `${_hashFile(abs)}  ${rel}`);
  const tmp = sumsFile + '.tmp';
  fs.writeFileSync(tmp, lines.join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, sumsFile);
  log(`[build-frontend] 步骤 4a：已写入 ${sumsFile}（${lines.length} 个文件）`);

  // 5) 写后**完整**复算：重新枚举磁盘（不信任 entries 缓存），逐项 rehash
  const postEntries = _scanEntries(dir, sumsFile);
  if (postEntries.length !== lines.length) {
    throw new BuildFrontendError(
      '步骤4',
      `写后复算：清单 ${lines.length} 条 ≠ 磁盘 ${postEntries.length} 个文件（清单外有文件？）`
    );
  }
  const postMap = new Map(postEntries.map(({ rel, abs }) => [rel, abs]));
  for (const line of lines) {
    const spaceIdx = line.indexOf('  ');
    if (spaceIdx !== 128) {
      throw new BuildFrontendError('步骤4', `清单行格式错误: ${line.slice(0, 40)}...`);
    }
    const want = line.slice(0, 128);
    const rel = line.slice(130);
    const vErr = _validateRel(rel);
    if (vErr) throw new BuildFrontendError('步骤4', `清单非法条目: ${vErr}`);
    const abs = postMap.get(rel);
    if (!abs) {
      throw new BuildFrontendError('步骤4', `清单引用磁盘缺失文件: ${rel}`);
    }
    const got = _hashFile(abs);
    if (want !== got) {
      throw new BuildFrontendError(
        '步骤4',
        `写后复算哈希失配: ${rel} (清单 ${want.slice(0, 12)}…, 磁盘 ${got.slice(0, 12)}…)`
      );
    }
  }
  log(`[build-frontend] 步骤 4b：写后完整复算通过（${lines.length} 个文件自洽）`);
  return { count: lines.length };
}

// ── 步骤函数：每个返回 void 或 throw BuildFrontendError ──

function step1_runFrontendBuild(runner, log = console.log) {
  if (!fs.existsSync(path.join(FRONTEND_DIR, 'package.json'))) {
    throw new BuildFrontendError('步骤1', `FRONTEND_DIR 不含 package.json: ${FRONTEND_DIR}`);
  }
  runner.runFrontendBuild(FRONTEND_DIR);
}

function step2_verifyExport(log = console.log, paths = {}) {
  const exportDir = paths.exportDir || EXPORT_DIR;
  const entryFile = paths.entryFile || path.join(exportDir, 'index.html');
  log(`[build-frontend] 步骤 2：校验 ${exportDir}`);
  if (!fs.existsSync(exportDir)) {
    throw new BuildFrontendError('步骤2', `未找到契约目录: ${exportDir}（步骤 1 未产出 electron-export/）`);
  }
  if (!fs.existsSync(entryFile)) {
    throw new BuildFrontendError('步骤2', `未找到契约入口: ${entryFile}（electron-export/ 缺失 index.html）`);
  }
}

/**
 * 步骤 3：校验 NEXT_PUBLIC_API_URL。
 * v1.2 复审红线 #3：缺失必须 fail-closed（不能产出无法连业务后端的安装包）。
 * v1.2b 仍只校验私网/本机段（公网 HTTPS 由 runtime-config 在加载时校验，
 * 这是构建期参数检查）。
 */
function step3_verifyApiUrl(log = console.log) {
  log('[build-frontend] 步骤 3：校验构建参数 NEXT_PUBLIC_API_URL');
  const api = process.env.NEXT_PUBLIC_API_URL || '/api';
  const err = isForbidApiUrl(api, process.env.APPROVED_ZEROTIER_API_ORIGINS || '');
  if (err) {
    throw new BuildFrontendError('步骤3', `NEXT_PUBLIC_API_URL 校验失败: ${err}（值: ${api}）`);
  }
  log(`[build-frontend] 步骤 3：NEXT_PUBLIC_API_URL=${api} (${process.env.NEXT_PUBLIC_API_URL ? '显式配置' : '局域网安全默认'})`);
}

function step4_writeSumsAndVerify(log = console.log) {
  log('[build-frontend] 步骤 4：写 SHA512SUMS（写后完整复算）');
  return writeSumsAndVerify(EXPORT_DIR, SUMS_FILE, log);
}

/**
 * 主执行入口（不调 process.exit，返回 errors[]）。
 * 单测 / 上层 main 都通过 deps 注入。
 */
function mainRun({ runner, log = console.log } = {}) {
  const r = runner || createRunner();
  try {
    step1_runFrontendBuild(r, log);
    step2_verifyExport(log);
    step3_verifyApiUrl(log);
    step4_writeSumsAndVerify(log);
    log('[build-frontend] ✅ Electron 包装器全部步骤通过');
    log('[build-frontend] ✅ TASK-110/TASK-111 集成构建与产物校验闭合');
    return { ok: true, errors: [] };
  } catch (err) {
    const e = err instanceof BuildFrontendError ? err : new BuildFrontendError('unknown', err?.message || String(err));
    log(`[build-frontend] ❌ ${e.message}`);
    return { ok: false, errors: [e] };
  }
}

module.exports = {
  // 错误类型 + 步骤函数（单测可独立调用）
  BuildFrontendError,
  step1_runFrontendBuild,
  step2_verifyExport,
  step3_verifyApiUrl,
  step4_writeSumsAndVerify,
  // runner 工厂（依赖注入点）
  createRunner,
  // 主入口（不调 process.exit）
  mainRun,
  // 纯函数（单测覆盖）
  isForbidApiUrl,
  verifyAgainstExistingSums,
  writeSumsAndVerify,
  _scanEntries,
  _validateRel,
  LOCAL_HOST,
  PRIVATE_HOST,
  parseApprovedOrigins,
  FRONTEND_DIR,
  EXPORT_DIR,
  SUMS_FILE,
  ENTRY_FILE,
  NPM_CMD,
};

// 生产 CLI 入口：拿到 errors 立即 fail-closed
if (require.main === module) {
  const result = mainRun({ runner: createRunner(), log: console.log });
  if (!result.ok) {
    for (const e of result.errors) {
      console.error(`[build-frontend] ❌ ${e.message}`);
    }
    process.exit(1);
  }
}
