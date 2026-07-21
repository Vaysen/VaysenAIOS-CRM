#!/usr/bin/env node
// scripts/resolve-release-revision.mjs
//
// TASK-107 构建时「发布修订号」解析器。
//
// 设计原则（按 Codex 评审结论 v1.3，并经 v1.3 一致性返工强化）：
//   发布提交哈希（releaseCommit）绝不静态写进 release-manifest.json，
//   避免「提交后再回填自身哈希」的自引用循环。改为在构建/打镜像时，
//   从 release-manifest.json 读取 releaseTag（如 task-107-v1.3），
//   动态执行 `git rev-parse <releaseTag>^{}` 得到权威发布提交，
//   写入 OCI label 与 artifact-manifest.json（产物 manifest）。
//
// 用法：
//   node scripts/resolve-release-revision.mjs [--tag task-107-v1.3] [--out <path>] [--check]
//
// 选项：
//   --tag <name>   覆盖 manifest 中的 releaseTag（默认读 manifest.source.releaseTag）
//   --out <path>   产物 manifest 写出路径（默认写入系统临时目录，绝不落在仓库内）
//   --check        仅解析并校验（tag 可解析 + contentCommit 为祖先），不写任何文件
//
// 安全约束（v1.3 一致性返工要求）：
//   - 默认输出目录为 os.tmpdir()，绝不在仓库根生成未跟踪文件。
//   - --check 模式完全只读、零写。
//   - 任何未知参数或缺失取值立即非零退出，不静默忽略。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg, code = 1) {
  console.error(`[resolve-release] ${msg}`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { tag: null, out: null, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      fail(`unknown argument: ${a}（仅支持 --tag / --out / --check）`);
    }
    if (a === '--check') {
      args.check = true;
      continue;
    }
    if (a === '--tag' || a === '--out') {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) {
        fail(`${a} 需要一个取值，但未提供`);
      }
      if (a === '--tag') args.tag = val;
      else args.out = path.resolve(val);
      i++;
      continue;
    }
    fail(`unknown argument: ${a}（仅支持 --tag / --out / --check）`);
  }
  if (args.check && args.out) {
    fail('--check 与 --out 互斥（--check 不写文件）');
  }
  return args;
}

function git(gitArgs) {
  return execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8' }).trim();
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const manifestPath = path.join(root, 'release-manifest.json');
  if (!fs.existsSync(manifestPath)) fail(`missing ${manifestPath}`);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const tag = args.tag || manifest?.source?.releaseTag;
  if (!tag) fail('no releaseTag found in manifest and none passed via --tag');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(tag)) {
    fail(`invalid release tag name: ${tag}（仅允许不含路径的安全 tag 名）`);
  }

  // 只接受 refs/tags 下的 annotated tag。分支、HEAD、commit 和 lightweight
  // tag 都不是不可变发布锚点，必须 fail closed。
  let releaseCommit;
  try {
    const tagRef = `refs/tags/${tag}`;
    const objectType = git(['cat-file', '-t', tagRef]);
    if (objectType !== 'tag') {
      fail(`release tag must be annotated: ${tag}`);
    }
    releaseCommit = git(['rev-parse', '--verify', `${tagRef}^{commit}`]);
  } catch (e) {
    fail(`failed to resolve tag ${tag}: ${e.message}`);
  }
  const releaseCommitShort = releaseCommit.slice(0, 8);

  // 可追溯性自检：contentCommit 必须是 releaseCommit 的祖先。
  const contentCommit = manifest?.source?.contentCommit;
  if (contentCommit) {
    try {
      git(['merge-base', '--is-ancestor', contentCommit, releaseCommit]);
    } catch {
      fail(
        `traceability broken: contentCommit ${contentCommit} is NOT an ancestor of releaseCommit ${releaseCommit}`,
        2
      );
    }
  }

  console.log(`releaseTag=${tag}`);
  console.log(`releaseCommit=${releaseCommit}`);
  console.log(`releaseCommitShort=${releaseCommitShort}`);
  console.log(`OCI label: --label "org.opencontainers.image.revision=${releaseCommit}"`);
  console.log(`image tag suffix: :${releaseCommitShort}`);

  if (args.check) {
    console.log('[check] OK: tag resolved and traceability verified; no file written');
    return;
  }

  const out = args.out || path.join(os.tmpdir(), 'vaysen-crm-release', 'artifact-manifest.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const artifact = {
    releaseTag: tag,
    releaseCommit,
    releaseCommitShort,
    contentCommit: contentCommit ?? null,
    parentBaselineCommit: manifest?.source?.parentBaselineCommit ?? null,
    resolvedAt: new Date().toISOString(),
    generatedBy: 'scripts/resolve-release-revision.mjs',
  };
  fs.writeFileSync(out, JSON.stringify(artifact, null, 2) + '\n');
  console.log(`wrote ${out}`);
}

main();
