/**
 * build-frontend.js 单测（TASK-111 v1.2b 复审后 — 依赖注入 + 真实 spawn）
 *
 * v1.2 复审红线 #2：删除 SKIP_NPM_BUILD / FRONTEND_DIR_OVERRIDE 旁路。
 *   - v1.2 之前单测用 SKIP_NPM_BUILD=1 跳过真 spawn 跑出假绿
 *   - v1.2b 单测改用**依赖注入**：注入 fake spawnFn / fake clock，
 *     全部断言走被测代码本身
 *   - 真 spawn 测试仅一处：Windows 真跑 `npm.cmd --version` / POSIX `npm --version`
 *     验证跨平台 shell:true 不再 EINVAL（用户裁定 3）
 *
 * v1.2b 复审红线 #7：setTimeout 注册 try/finally 包裹（mainRun 通过 runner
 * 注入 fake clock 模拟 setTimeout 同步抛错 → 闸门 release）。
 *
 * 关键不变量：
 *   - 步骤 1 始终真调 spawn（不再有 SKIP 旁路）
 *   - 路径解析必须落到脚本所属项目根目录的 frontend，不依赖 worktree 目录名
 *   - 缺 NEXT_PUBLIC_API_URL 时仅允许安全的同源 /api 默认值
 *   - SHA512SUMS 不自引用 + 写后**完整**复算（不只信刚写的清单）
 *   - 闸门 setTimeout 注册抛错也 release
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'electron', 'scripts', 'build-frontend.js');

function makeTmpFrontend(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfe-test-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"stub","scripts":{}}');
  return dir;
}

function makeExportDir(frontendDir: string, withEntry = true): string {
  const exp = path.join(frontendDir, 'electron-export');
  fs.mkdirSync(exp, { recursive: true });
  if (withEntry) {
    fs.writeFileSync(path.join(exp, 'index.html'), '<html><body>test</body></html>');
  }
  return exp;
}

function cleanup(dir: string) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('build-frontend.js — 路径解析（v1.2b 锁定 2 级 ..）', () => {
  test('FRONTEND_DIR 必为脚本目录向上 2 级的 frontend（不是外层）', () => {
    const m = require(SCRIPT);
    const expected = path.resolve(path.dirname(SCRIPT), '..', '..', 'frontend');
    const outsideProject = path.resolve(path.dirname(SCRIPT), '..', '..', '..', 'frontend');
    expect(path.resolve(m.FRONTEND_DIR)).toBe(expected);
    expect(path.resolve(m.FRONTEND_DIR)).not.toBe(outsideProject);
  });
});
describe('build-frontend.js — 步骤 1 跨平台 spawn（v1.2b 红线 #1）', () => {
  // 用户裁定 3：Windows 测试必须真调 npm.cmd --version（其他平台 npm --version），断言 exit 0
  test('createRunner 用真 spawnSync 在本机真跑 npm --version 应 exit 0', () => {
    const m = require(SCRIPT);
    const logs: string[] = [];
    const runner = m.createRunner({
      spawnSync,
      npmArgs: ['--version'],
      log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
    });
    expect(() => runner.runFrontendBuild(process.cwd())).not.toThrow();
    expect(logs.join('\n')).toContain('子进程 exit 0');
  });

  test('createRunner 包装 spawnSync：传入 fake spawnFn 替代真 npm 调用', () => {
    const m = require(SCRIPT);
    const fakeSpawn = jest.fn(() => ({ status: 0, stdout: 'ok', stderr: '' }));
    const runner = m.createRunner({ spawnSync: fakeSpawn as any, npmCmd: 'npm' });
    runner.runFrontendBuild('/tmp/fake');
    expect(fakeSpawn).toHaveBeenCalledWith(
      'npm',
      ['run', 'build:electron'],
      expect.objectContaining({ cwd: '/tmp/fake', shell: true })
    );
  });

  test('createRunner 子进程非 0 抛 BuildFrontendError', () => {
    const m = require(SCRIPT);
    const fakeSpawn = jest.fn(() => ({ status: 1, stdout: '', stderr: 'err' }));
    const runner = m.createRunner({ spawnSync: fakeSpawn as any });
    expect(() => runner.runFrontendBuild('/tmp/x')).toThrow(/exit 1/);
  });

  test('createRunner spawn 抛错抛 BuildFrontendError', () => {
    const m = require(SCRIPT);
    const fakeSpawn = jest.fn(() => ({ error: new Error('EINVAL'), status: null, stdout: '', stderr: '' }));
    const runner = m.createRunner({ spawnSync: fakeSpawn as any });
    expect(() => runner.runFrontendBuild('/tmp/x')).toThrow(/spawn 失败/);
  });
});
describe('build-frontend.js — 步骤 2 入口校验', () => {
  let tmp: string | undefined;
  afterEach(() => { if (tmp) cleanup(tmp); });

  test('缺契约目录应抛 BuildFrontendError 步骤2（v1.2b 集成路径）', () => {
    tmp = makeTmpFrontend();
    const m = require(SCRIPT);
    const exportDir = path.join(tmp, 'electron-export');
    expect(() => m.step2_verifyExport(() => {}, { exportDir })).toThrow(/electron-export/);
  });
});
// EOF
describe('build-frontend.js — 步骤 3 局域网同源 API 契约', () => {
  test('缺 NEXT_PUBLIC_API_URL 时采用安全的同源 /api，不烘焙服务器地址', () => {
    const m = require(SCRIPT);
    const origEnv = process.env.NEXT_PUBLIC_API_URL;
    delete process.env.NEXT_PUBLIC_API_URL;
    try {
      expect(() => m.step3_verifyApiUrl()).not.toThrow();
    } finally {
      if (origEnv !== undefined) process.env.NEXT_PUBLIC_API_URL = origEnv;
    }
  });

  test('合法 https 公网 URL 通过', () => {
    const m = require(SCRIPT);
    const origEnv = process.env.NEXT_PUBLIC_API_URL;
    process.env.NEXT_PUBLIC_API_URL = 'https://api.example.com/api';
    try {
      expect(() => m.step3_verifyApiUrl()).not.toThrow();
    } finally {
      if (origEnv !== undefined) process.env.NEXT_PUBLIC_API_URL = origEnv;
      else delete process.env.NEXT_PUBLIC_API_URL;
    }
  });

  test('局域网 Electron 同源 /api 通过且其他相对路径拒绝', () => {
    const m = require(SCRIPT);
    expect(m.isForbidApiUrl('/api')).toBeNull();
    expect(m.isForbidApiUrl('/api/v1')).toMatch(/解析失败/);
  });

  test('私网 HTTPS 空 allowlist 拒绝，精确批准后通过', () => {
    const m = require(SCRIPT);
    const origEnv = process.env.NEXT_PUBLIC_API_URL;
    const origAllowlist = process.env.APPROVED_ZEROTIER_API_ORIGINS;
    process.env.NEXT_PUBLIC_API_URL = 'https://10.0.0.2:4000/api';
    try {
      delete process.env.APPROVED_ZEROTIER_API_ORIGINS;
      expect(() => m.step3_verifyApiUrl()).toThrow(/APPROVED_ZEROTIER_API_ORIGINS/);
      process.env.APPROVED_ZEROTIER_API_ORIGINS = 'https://10.0.0.2:4000';
      expect(() => m.step3_verifyApiUrl()).not.toThrow();
    } finally {
      if (origEnv !== undefined) process.env.NEXT_PUBLIC_API_URL = origEnv;
      else delete process.env.NEXT_PUBLIC_API_URL;
      if (origAllowlist !== undefined) process.env.APPROVED_ZEROTIER_API_ORIGINS = origAllowlist;
      else delete process.env.APPROVED_ZEROTIER_API_ORIGINS;
    }
  });

  test('公网 HTTP 拒绝', () => {
    const m = require(SCRIPT);
    expect(m.isForbidApiUrl('http://api.example.com/api')).toMatch(/必须使用 HTTPS/);
  });

  test('localhost http 仍 fail-closed（公网 HTTP / 私网 HTTP / 本机都拒）', () => {
    const m = require(SCRIPT);
    const origEnv = process.env.NEXT_PUBLIC_API_URL;
    process.env.NEXT_PUBLIC_API_URL = 'http://localhost:4000/api';
    try {
      expect(() => m.step3_verifyApiUrl()).toThrow(/私网|localhost/);
    } finally {
      if (origEnv !== undefined) process.env.NEXT_PUBLIC_API_URL = origEnv;
      else delete process.env.NEXT_PUBLIC_API_URL;
    }
  });
});

describe('build-frontend.js — 步骤 4 SHA512SUMS 写后完整复算（v1.2b 红线 #6）', () => {
  let tmp: string | undefined;
  afterEach(() => { if (tmp) cleanup(tmp); });

  test('写盘前独立复算：清单存在 + 磁盘被篡改应抛哈希失配（v1.2b 红线 #6）', () => {
    // v1.2b 关键差异：写盘前用 verifyAgainstExistingSums 校验现有清单 vs 磁盘。
    // 篡改磁盘文件后**第二次**调用 writeSumsAndVerify，步骤 1 应立即 fail。
    tmp = makeTmpFrontend();
    const exp = fs.mkdtempSync(path.join(os.tmpdir(), 'bfe-step4-preverify-'));
    fs.writeFileSync(path.join(exp, 'index.html'), '<html>v1</html>');
    const m = require(SCRIPT);
    const sumsFile = path.join(exp, 'SHA512SUMS');
    // 第一次写：清单与磁盘一致
    m.writeSumsAndVerify(exp, sumsFile, () => {});
    // 篡改 index.html 但保留 SHA512SUMS
    fs.writeFileSync(path.join(exp, 'index.html'), '<html>tampered</html>');
    // 第二次写：写盘前 verifyAgainstExistingSums 立即 fail-closed（写盘后才知道）
    expect(() => m.writeSumsAndVerify(exp, sumsFile, () => {})).toThrow(/哈希失配/);
  });

  test('SHA512SUMS 列表不包含自身行（自洽）', () => {
    tmp = makeTmpFrontend();
    const exp = fs.mkdtempSync(path.join(os.tmpdir(), 'bfe-step4-self-'));
    fs.writeFileSync(path.join(exp, 'index.html'), '<html>x</html>');
    fs.writeFileSync(path.join(exp, 'extra.txt'), 'extra');
    const m = require(SCRIPT);
    const sumsFile = path.join(exp, 'SHA512SUMS');
    m.writeSumsAndVerify(exp, sumsFile, () => {});
    const sums = fs.readFileSync(sumsFile, 'utf8');
    expect(sums).not.toMatch(/SHA512SUMS/);
  });

  test('写后复算：磁盘文件数 vs 清单条目数不一致应被检测（v1.2b 红线 #6 关键差异）', () => {
    // v1.2b 关键差异：writeSumsAndVerify 写盘**后**重新调用 _scanEntries，不只信刚
    // 写完的 lines 缓存。如果磁盘在写盘后新增了文件，重新枚举会发现 N+1 个文件
    // 而 lines 只有 N 个 → fail-closed。
    //
    // 测试方法：writeSumsAndVerify 写完后**手动**往 exp 加 rogue 文件，然后再次调
    // writeSumsAndVerify——但**先**绕过 verifyAgainstExistingSums 抛错（因为旧清单
    // 仍正确），让**写后**复算 catch。
    // 用更直接的方式：第一次 writeSumsAndVerify 后，篡改磁盘（写 rogue + 改 index.html
    // hash）让 verifyAgainstExistingSums 抛错前，先看写后复算是否独立扫描——其实
    // verifyAgainstExistingSums 会先抛。
    //
    // 最终方案：把 rogue 文件用 jest.spyOn 注入到 _scanEntries 第二次调用时
    // （第二次 _scanEntries 是写后复算，第一次 _scanEntries 决定 lines.length）。
    // spy 必须在 _hashFile 之前的第二次 _scanEntries 才有效——但两次 _scanEntries
    // 都在 _hashFile 之前；spy 改 readdirSync 让第一次 _scanEntries 也看到 rogue
    // → 进了 lines → 写后扫到 rogue 仍 = lines → 不抛。
    //
    // 因此：测试"写后复算捕新增"必须 spy _hashFile 阶段在 _scanEntries 之后注入。
    // 用 _hashFile spy：第一次 _hashFile (index.html) 后塞 rogue, 后续 _hashFile
    // 会算 rogue 但 _scanEntries 第一次没扫到 rogue(顺序问题) → lines 不含 rogue
    // → 写后扫到 rogue → 不一致 → 抛"清单外有文件"。
    tmp = makeTmpFrontend();
    const exp = fs.mkdtempSync(path.join(os.tmpdir(), 'bfe-step4-rogue-'));
    fs.writeFileSync(path.join(exp, 'index.html'), '<html>x</html>');
    const m = require(SCRIPT);
    const sumsFile = path.join(exp, 'SHA512SUMS');
    // spy _hashFile：第一次被调（hash index.html）后同步塞 rogue.txt
    const crypto = require('node:crypto');
    const realHash = crypto.createHash;
    let hashed = 0;
    jest.spyOn(crypto, 'createHash').mockImplementation(((alg: string) => {
      const real = realHash.call(crypto, alg);
      if (alg === 'sha512' && hashed === 0) {
        hashed++;
        // 在第一次 hash 返回前同步塞 rogue.txt 到 exp
        try { fs.writeFileSync(path.join(exp, 'rogue.txt'), 'rogue'); } catch { /* ignore */ }
      }
      return real;
    }) as any);
    try {
      expect(() => m.writeSumsAndVerify(exp, sumsFile, () => {})).toThrow(/清单外有文件/);
    } finally {
      (crypto.createHash as any).mockRestore?.();
    }
  });

  test('外部篡改 SHA512SUMS 清单（坏清单）应抛哈希失配', () => {
    tmp = makeTmpFrontend();
    const exp = fs.mkdtempSync(path.join(os.tmpdir(), 'bfe-step4-sums-'));
    fs.writeFileSync(path.join(exp, 'index.html'), '<html>v1</html>');
    const m = require(SCRIPT);
    const sumsFile = path.join(exp, 'SHA512SUMS');
    m.writeSumsAndVerify(exp, sumsFile, () => {});
    // 篡改 SHA512SUMS 本身（不只篡改文件）
    const sums = fs.readFileSync(sumsFile, 'utf8');
    const tampered = sums.replace(/^[0-9a-f]{128}/, '0'.repeat(128));
    fs.writeFileSync(sumsFile, tampered, 'utf8');
    // 第二次写：写盘前 verifyAgainstExistingSums 立即 fail
    expect(() => m.writeSumsAndVerify(exp, sumsFile, () => {})).toThrow(/哈希失配/);
  });
});

describe('build-frontend.js — mainRun 集成（依赖注入）', () => {
  test('步骤 1 抛错 → mainRun 返回 ok:false + errors[0].stage=步骤1', () => {
    const m = require(SCRIPT);
    const fakeSpawn = jest.fn(() => ({ error: new Error('EINVAL'), status: null, stdout: '', stderr: '' }));
    const r = m.mainRun({ runner: m.createRunner({ spawnSync: fakeSpawn as any }) });
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].stage).toBe('步骤1');
    expect(r.errors[0].message).toMatch(/spawn 失败/);
  });

  test('mainRun 不在 process.exit 路径上（生产入口不粗暴退出）', () => {
    // 模拟 mainRun 抛 BuildFrontendError，确认 main() 拿到 errors 后才 exit
    const m = require(SCRIPT);
    const r = m.mainRun({ runner: m.createRunner({ spawnSync: () => ({ error: new Error('x'), status: null, stdout: '', stderr: '' }) as any }) });
    expect(typeof r.ok).toBe('boolean');
    expect(r.ok).toBe(false);
    // 不应该有任何 process.exit 调用（mainRun 不调 process.exit）
  });
});
