#!/usr/bin/env node
/**
 * TASK-107 统一只读发布门禁 (verify-baseline) v1.4
 *
 * 目标：任何 Agent 从全新 worktree 用锁文件安装（npm run install:all）后，执行同一条
 * 命令即可复现 backend / frontend / electron 的 typecheck 与 tests，并校验 Node 运行时契约。
 * v1.3 额外让 npm 以非 workspace 模式校验 frontend 自带 package-lock，确保 Docker
 * 独立构建上下文中的 `npm ci` 不会被根 workspace 锁文件假绿掩盖。
 * v1.4 将 backend Jest 固定为 `--runInBand`。低核数发布主机并行运行 68 个套件时会
 * 让正常约 1 秒的二维码测试因 CPU 争抢超过 Jest 5 秒默认超时；串行执行保持相同
 * 654 项断言与覆盖面，同时使统一发布门禁在目标 Linux 上稳定可复现。
 *
 * v1.2 修正（针对 TASK-111 v1.1 阶段 A 红线 6 复审反馈）：
 *  - Electron 段已切到 `npm test`（带 jest.config 分级覆盖率门禁：global 60%、
 *    ipc-handlers.ts 低阈值），**不再**调 `test:functional --coverage=false` 绕行。
 *  - Electron 段运行覆盖率会写 `electron/coverage/`，与本门禁「不生成仓库产物」的承诺
 *    有冲突。v1.2 在 npm test 之前把 JEST_COVERAGE_DIR 临时改为系统临时目录
 *    （`os.tmpdir()/.verify-baseline/electron-coverage-<pid>`），跑完丢弃；重定向或清理
 *    失败必须使对应门禁失败，不允许回退写入仓库 `coverage/`。
 *  - test:functional 仍存在为开发期快跑入口，**不进入**本统一发布门禁。
 *
 * v1.1 修正（针对 TASK-107 审核反馈）：
 *  - 只调用锁文件安装出的本地工具，通过 `npm run <script>` 执行；绝不调用 `npx`，
 *    避免无依赖环境隐式联网下载并长时间挂起。
 *  - 依赖缺失时 `npm run` 立即失败（非 0 退出），不再静默降级。
 *  - 只读：不改源码、不写数据库、不生成产物到仓库；五域生产依赖 audit 会访问 npm registry，
 *    网络、进程或 audit 报告异常均 fail closed。
 *    （覆盖率报告在临时目录，写后即删）
 *
 * 用法：
 *   node scripts/verify-baseline.mjs            # 全量门禁
 *   node scripts/verify-baseline.mjs --skip electron   # 跳过某个子项目
 *   node scripts/verify-baseline.mjs electron           # 只跑 electron 段
 *
 * 退出码：0 全部通过；非 0 表示有门禁失败。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const isWin = process.platform === 'win32';
// 直接用 npm 可执行文件；npm run 只解析本地 node_modules/.bin，不会触发 npx 联网。
const npm = isWin ? 'npm.cmd' : 'npm';

const skip = new Set();
let allowNodeMismatch = false;
let onlyProject = null;
const projects = new Set(['backend', 'frontend', 'electron']);
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--skip') {
    const project = argv[++i];
    if (!projects.has(project)) {
      console.error(`--skip 只接受 backend/frontend/electron，实际: ${project || '(missing)'}`);
      process.exit(2);
    }
    skip.add(project);
  } else if (arg === '--allow-node-mismatch') {
    allowNodeMismatch = true;
  } else if (projects.has(arg)) {
    if (onlyProject && onlyProject !== arg) {
      console.error(`只能指定一个单项目，已指定 ${onlyProject}，又收到 ${arg}`);
      process.exit(2);
    }
    onlyProject = arg;
  } else {
    console.error(`未知参数: ${arg}`);
    process.exit(2);
  }
}
if (onlyProject) {
  for (const project of projects) {
    if (project !== onlyProject) skip.add(project);
  }
}

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`\n[${tag}] ${name}${detail ? '  — ' + detail : ''}`);
}

function npmRun(step, cwd, script, extraArgs = []) {
  const argv = ['run', script, ...extraArgs];
  console.log(`\n>>> ${step}\n    npm run ${script}${extraArgs.length ? ' ' + extraArgs.join(' ') : ''}  (cwd=${cwd})`);
  const r = spawnSync(npm, argv, { cwd, stdio: 'inherit', shell: isWin });
  const ok = r.status === 0;
  record(step, ok, ok ? '' : `exit ${r.status}`);
  return ok;
}

// 依赖检测：
//  backend/frontend 为 npm workspaces，依赖 hoist 到 ROOT/node_modules；
//  electron 独立安装，依赖在 electron/node_modules。
//  注意：npm 在執行 `npm run` 时会惰性创建 node_modules/.bin，因此不能用 .bin
//  是否存在来判断依赖装没装（全新 ci 后、尚未 npm run 过时 .bin 不存在是正常的）。
//  改用实际工具包目录是否存在作为「锁文件已安装」的可靠信号。
function depsInstalled(sub) {
  const base = sub === 'electron' ? join(ROOT, 'electron') : ROOT;
  const markers = sub === 'electron'
    ? ['jest', 'typescript']
    : ['jest', 'vitest', 'typescript', 'prisma'];
  return markers.every(m => existsSync(join(base, 'node_modules', m)));
}
function failNoDeps(step, sub) {
  const where = sub === 'electron' ? 'electron/node_modules' : '根 node_modules（workspaces hoist）';
  record(step, false,
    `依赖未安装：未检测到 ${where}。请先执行 npm run install:all（锁文件安装）。`);
}

console.log('==================================================');
console.log(' TASK-107 verify-baseline  v1.4 (read-only; live npm registry access required)');
console.log(' Five production npm audits fail closed on registry/network/report errors.');
console.log('==================================================');

// 1) Node 运行时契约（精确钉版 20.18.0，门禁比较完整版本号）
const EXPECTED_NODE = '20.18.0';
const actualNode = process.versions.node;
if (actualNode === EXPECTED_NODE) {
  record('node-version-contract', true, `node ${actualNode} (exact ${EXPECTED_NODE})`);
} else if (allowNodeMismatch) {
  record('node-version-contract', true,
    `node ${actualNode}（允许偏离精确契约 ${EXPECTED_NODE}，仅用于非交付环境探测）`);
} else {
  record('node-version-contract', false,
    `当前 node ${actualNode}，契约要求精确 ${EXPECTED_NODE}。请安装 Node ${EXPECTED_NODE} 后重试，或以 --allow-node-mismatch 仅做探测。`);
}

// 1b) 锁文件生产依赖引擎契约。仅检查 Node 20.18.0 是否满足每个生产依赖的
// engines.node；不联网、不改锁文件。用于阻断“运行时版本正确、依赖却要求 Node 22”的假绿。
if (depsInstalled('backend')) {
  const engineAudit = spawnSync(
    process.execPath,
    [join(ROOT, 'scripts', 'verify-node-engine-contract.mjs')],
    { cwd: ROOT, stdio: 'inherit' },
  );
  record(
    'production-dependency-node-engine-contract',
    engineAudit.status === 0,
    engineAudit.status === 0 ? `target node ${EXPECTED_NODE}` : `exit ${engineAudit.status}`,
  );
} else {
  record(
    'production-dependency-node-engine-contract',
    false,
    '依赖未安装，无法加载 semver 并核验锁文件',
  );
}

// 2) backend
npmRun('production dependency audits (five independent locks)', ROOT, 'verify:production-audits');

if (!skip.has('backend')) {
  const cwd = join(ROOT, 'backend');
  if (!depsInstalled('backend')) {
    failNoDeps('backend: prisma generate', 'backend');
    failNoDeps('backend: typecheck', 'backend');
    failNoDeps('backend: test (jest)', 'backend');
  } else {
    npmRun('backend: prisma generate', cwd, 'prisma:generate');
    npmRun('backend: typecheck (tsc --noEmit)', cwd, 'typecheck');
    npmRun('backend: test (jest)', cwd, 'test', ['--', '--runInBand']);
    npmRun('backend: production runtime module load', cwd, 'verify:runtime-load');
  }
}

// 3) frontend
if (!skip.has('frontend')) {
  const cwd = join(ROOT, 'frontend');
  const isolatedLock = spawnSync(
    npm,
    ['ci', '--dry-run', '--ignore-scripts', '--no-audit', '--no-fund', '--workspaces=false'],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
      shell: isWin,
    },
  );
  if (isolatedLock.status !== 0) {
    process.stderr.write(isolatedLock.stderr || isolatedLock.stdout || 'frontend isolated npm ci failed\n');
  }
  record(
    'frontend: isolated package-lock (npm ci --dry-run)',
    isolatedLock.status === 0,
    isolatedLock.status === 0 ? 'frontend Docker context lock is self-contained' : `exit ${isolatedLock.status}`,
  );
  if (!depsInstalled('frontend')) {
    failNoDeps('frontend: typecheck', 'frontend');
    failNoDeps('frontend: test (vitest run)', 'frontend');
  } else {
    npmRun('frontend: typecheck (tsc --noEmit)', cwd, 'typecheck');
    npmRun('frontend: test (vitest run)', cwd, 'test:run');
  }
}

// 4) electron
if (!skip.has('electron')) {
  const cwd = join(ROOT, 'electron');
  if (!depsInstalled('electron')) {
    failNoDeps('electron: typecheck', 'electron');
    failNoDeps('electron: test (jest with coverage gate)', 'electron');
  } else {
    npmRun('electron: typecheck (tsc --noEmit)', cwd, 'typecheck');
    // TASK-111 v1.1 红线 8 + 红线 6 复审修复：
    //   - 切到 `npm test`（带 jest.config.js 分级覆盖率门禁：global 60%、ipc-handlers.ts 低阈值）。
    //   - test:functional 仍保留为「无覆盖率功能测试」选项（开发期快跑/调试用），不进入发布门禁。
    //   - 红线 6：覆盖率报告原本会写 `electron/coverage/`，与本门禁「不写仓库产物」承诺冲突。
    //     解决：临时把 JEST_COVERAGE_DIR 重定向到 os.tmpdir()，跑完用 rmSync 删除。
    //     重定向或清理失败必须计为门禁失败，不允许静默写回仓库 coverage/。
    const tmpCov = join(tmpdir(), `verify-baseline-electron-coverage-${process.pid}-${Date.now()}`);
    // shell:true 跨平台：Windows 上 npm 是 .cmd/.bat，spawnSync 需 shell 才能解析；
    // POSIX 走 /bin/sh。stdio:'inherit' 让用户能看到测试输出。
    // 注意：tmpCov 用 os.tmpdir() 拿 Windows 原生路径（如 <system temp dir>/），
    // 避免 Git Bash 把 /tmp 解释成 F:\tmp 而报 ENOENT。
    const r = spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['test'],
      {
        cwd,
        stdio: 'inherit',
        env: { ...process.env, NODE_OPTIONS: '', JEST_COVERAGE_DIR: tmpCov },
        shell: true,
      }
    );
    if (r.error) {
      console.error(`[electron test] spawn 错误: ${r.error.message}`);
      results.push({ name: 'electron: test (jest with coverage gate)', ok: false, detail: `spawn 错误: ${r.error.message}` });
    } else if (r.status !== 0) {
      // 保留临时目录便于失败排查
      console.error(`[electron test] 失败：保留 ${tmpCov} 供排查`);
      results.push({ name: 'electron: test (jest with coverage gate)', ok: false, detail: `exit ${r.status}（保留 ${tmpCov}）` });
    } else {
      // 成功后清理临时覆盖率目录；清理失败也违反只读门禁。
      try {
        rmSync(tmpCov, { recursive: true, force: true });
        console.log(`[electron test] exit 0（覆盖率报告已清理）`);
        results.push({ name: 'electron: test (jest with coverage gate)', ok: true, detail: '覆盖报告已清理' });
      } catch (cleanupError) {
        console.error(`[electron test] 覆盖率临时目录清理失败: ${cleanupError.message}`);
        results.push({ name: 'electron: test (jest with coverage gate)', ok: false, detail: '覆盖率临时目录清理失败' });
      }
    }
  }
}

// 汇总
console.log('\n==================================================');
console.log(' 门禁汇总');
console.log('==================================================');
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
}
console.log(`\n通过 ${results.length - failed}/${results.length}，失败 ${failed}`);
process.exit(failed === 0 ? 0 : 1);
