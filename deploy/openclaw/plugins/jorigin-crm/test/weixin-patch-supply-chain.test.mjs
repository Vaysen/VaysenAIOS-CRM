import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildPatchedArtifact,
  createDeterministicTar,
  deterministicGzipStore,
  readSafeNpmPack,
} from '../weixin-patch-supply-chain.mjs';
import {
  isDirectWeixinInbound,
  recordWeixinAcceptanceRejection,
} from '../weixin-patch-files/dist/src/security/acceptance-evidence.js';
import { verifyWeixinAcceptanceEvidence } from '../verify-weixin-acceptance-evidence.mjs';

const PATCH_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'weixin-v2.4.6.patch.json');
const PLUGIN_ROOT = path.dirname(PATCH_PATH);
const PREPARE_PATH = path.resolve(PLUGIN_ROOT, '..', '..', '..', '..', 'scripts', 'prepare-openclaw-runtime.sh');
const VALIDATE_PATH = path.resolve(PLUGIN_ROOT, '..', '..', '..', '..', 'scripts', 'validate-openclaw-production.mjs');

const PRIVATE_CRM_PINS = [
  'sha512-hpI8KOB+A/Xc66V5kAA8Z74MsTcatFlUEnrg9QiV9r//UWPWtVu1IOz5KKG5YQXpQ2rGW+kXpYsIiZjWel8DjQ==',
  'df125cf3c7a2f323fcc4328d9401bbbbdd04b41a',
  '1fadb55fa0be8cf451116e656cf8a5063348a2f37732e435a1d0b9ccc08c1e12',
  '12c25963cfe68631b1e363886bf7001f56c06dc4844b656a1f4a33a5333f8893',
];

function replacementText(patch, filePath) {
  const filePatch = patch.files[filePath];
  assert.ok(filePatch, `patch manifest must manage ${filePath}`);
  return filePatch.replacements.map(({ replace }) => replace).join('\n');
}

test('patch manifest, runtime preparation and managed audit pin the same artifact bytes', () => {
  const patchBytes = fs.readFileSync(PATCH_PATH);
  const patch = JSON.parse(patchBytes.toString('utf8'));
  const audit = fs.readFileSync(path.join(PLUGIN_ROOT, 'audit-managed-install.mjs'), 'utf8');
  const patchSha256 = createHash('sha256').update(patchBytes).digest('hex');
  assert.equal(patchSha256, '59f180806b5687aa53f4804ec6c496f2ab406817dfaa4d6974f192c362a610e2');
  if (fs.existsSync(PREPARE_PATH)) {
    const prepare = fs.readFileSync(PREPARE_PATH, 'utf8');
    for (const value of [patch.patched.integrity, patch.patched.sha256]) {
      assert.ok(prepare.includes(value), `prepare script must pin ${value}`);
    }
  }
  assert.ok(audit.includes(patchSha256), 'managed audit must pin the reviewed patch manifest bytes');
  for (const value of [patch.patched.integrity, patch.patched.sha1, patch.patched.sha256]) {
    assert.ok(audit.includes(value), `managed audit must pin ${value}`);
  }
});

test('private CRM preparation, managed audit and production validator pin identical artifact bytes', () => {
  if (!fs.existsSync(PREPARE_PATH) || !fs.existsSync(VALIDATE_PATH)) {
    return;
  }
  const prepare = fs.readFileSync(PREPARE_PATH, 'utf8');
  const audit = fs.readFileSync(path.join(PLUGIN_ROOT, 'audit-managed-install.mjs'), 'utf8');
  const validate = fs.readFileSync(VALIDATE_PATH, 'utf8');
  for (const value of PRIVATE_CRM_PINS) {
    assert.equal(prepare.split(value).length - 1, 1, `prepare must pin ${value} exactly once`);
    assert.equal(audit.split(value).length - 1, 1, `audit must pin ${value} exactly once`);
    assert.equal(validate.split(value).length - 1, 1, `validator must pin ${value} exactly once`);
  }
});

test('patch manifest declares fail-closed owner identity propagation for Weixin direct messages', () => {
  const patch = JSON.parse(fs.readFileSync(PATCH_PATH, 'utf8'));
  for (const prefix of ['src', 'dist/src']) {
    const inboundPatch = replacementText(patch, `${prefix}/messaging/inbound.${prefix === 'src' ? 'ts' : 'js'}`);
    const processPatch = replacementText(patch, `${prefix}/messaging/process-message.${prefix === 'src' ? 'ts' : 'js'}`);

    assert.match(inboundPatch, /SenderId:\s*(?:full\.)?from_user_id\b/);
    assert.match(processPatch, /readFrameworkAllowFromList\(deps\.accountId\)/);
    assert.match(processPatch, /(?:includes|has)\(senderId\)/);
    assert.match(processPatch, /ctx\.OwnerAllowFrom\s*=\s*\[senderId\]/);
    assert.match(processPatch, /recordWeixinAcceptanceRejection\(full, ["']GROUP_REJECTED["']\)/);
    assert.match(processPatch, /recordWeixinAcceptanceRejection\(full, ["']NON_OWNER_REJECTED["']\)/);
  }
});

function message(text, groupId) {
  return {
    from_user_id: 'fixture-peer-never-persisted',
    ...(groupId === undefined ? {} : { group_id: groupId }),
    item_list: [{ text_item: { text } }],
  };
}

function acceptanceFixture(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaysen-weixin-evidence-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  fs.chmodSync(stateDir, 0o700);
  const previous = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previous;
  });
  return stateDir;
}

function runPolicyFixture(input, owner, calls) {
  if (!isDirectWeixinInbound(input)) {
    recordWeixinAcceptanceRejection(input, 'GROUP_REJECTED');
    return;
  }
  calls.auth += 1;
  if (!owner) {
    recordWeixinAcceptanceRejection(input, 'NON_OWNER_REJECTED');
    return;
  }
  calls.route += 1;
  calls.dispatch += 1;
  calls.tool += 1;
}

test('deterministic ustar and stored-block gzip are byte-identical and safely readable', () => {
  const files = new Map([
    ['package.json', Buffer.from('{"name":"fixture","version":"1.0.0"}\n')],
    ['dist/index.js', Buffer.from('export default {}\n')],
  ]);
  const first = deterministicGzipStore(createDeterministicTar(files));
  const second = deterministicGzipStore(createDeterministicTar(new Map([...files].reverse())));
  assert.deepEqual(first, second);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaysen-deterministic-pack-'));
  try {
    const artifact = path.join(root, 'fixture.tgz');
    fs.writeFileSync(artifact, first);
    const parsed = readSafeNpmPack(artifact);
    assert.deepEqual([...parsed.keys()].sort(), [...files.keys()].sort());
    assert.deepEqual(parsed.get('dist/index.js'), files.get('dist/index.js'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the reviewed official tgz patch has fixed bytes and guards before slash/auth/route/dispatch', (t) => {
  const upstreamPath = process.env.WEIXIN_UPSTREAM_TGZ;
  if (!upstreamPath || !fs.existsSync(upstreamPath)) {
    t.skip('set WEIXIN_UPSTREAM_TGZ to the verified official 2.4.6 tgz for the artifact fixture');
    return;
  }
  const result = buildPatchedArtifact({ upstreamPath, patchPath: PATCH_PATH });
  assert.equal(result.patched.sha256, '15cde2b9926263ab5cfba21f2b935c710bc01dd983611e3dee673a052fa203d6');
  assert.equal(result.patched.integrity, 'sha512-WarnJ65LzlqhSluRnY4c/SvnnKnZTNhIEMXZEih+iQRDe4iZsVznsp3EySB+ADBdsa6XSH4MfhyijFLgiTPyhQ==');
  assert.equal(result.patched.sha1, 'c13881a517533b1b223543b77f7186ff556882fd');
  assert.equal(result.patched.treeSha256, '7f2d15c5e1d665ee7b3e7b1fc9885b915854e960d7f82ac97a512939eb2664b1');
  assert.equal(JSON.parse(result.files.get('package.json').toString('utf8')).dependencies.zod, '4.3.6');
  const inboundSource = result.files.get('src/messaging/inbound.ts').toString('utf8');
  const processSource = result.files.get('src/messaging/process-message.ts').toString('utf8');
  const inboundCode = result.files.get('dist/src/messaging/inbound.js').toString('utf8');
  const processCode = result.files.get('dist/src/messaging/process-message.js').toString('utf8');
  const monitorCode = result.files.get('dist/src/monitor/monitor.js').toString('utf8');
  const channelCode = result.files.get('dist/src/channel.js').toString('utf8');
  assert.match(channelCode, /gatewayMethods: \["web\.login\.start", "web\.login\.wait"\]/);
  assert.match(channelCode, /normalizeAccountId\(params\.accountId \|\| result\.accountId\)/);
  assert.match(channelCode, /createHash\("sha256"\)\.update\(ownerPeerId, "utf8"\)\.digest\("hex"\)/);
  assert.match(channelCode, /result\.alreadyConnected && params\.accountId/);
  assert.match(channelCode, /loadWeixinAccount\(params\.accountId\)\?\.userId\?\.trim\(\)/);
  assert.doesNotMatch(channelCode, /accountId:\s*result\.accountId/);
  assert.match(inboundSource, /SenderId:\s*(?:full\.)?from_user_id\b/);
  assert.match(inboundCode, /SenderId:\s*(?:full\.)?from_user_id\b/);
  assert.match(processSource, /ctx\.OwnerAllowFrom\s*=\s*\[senderId\]/);
  const processGuard = processCode.indexOf('if (!isDirectWeixinInbound(full))');
  for (const downstream of ['handleSlashCommand(', 'resolveSenderCommandAuthorizationWithRuntime(', 'resolveAgentRoute(', 'dispatchReplyFromConfig(']) {
    assert.ok(processGuard >= 0 && processGuard < processCode.indexOf(downstream), `guard must precede ${downstream}`);
  }
  assert.ok(
    processCode.indexOf('recordWeixinAcceptanceRejection(full, "NON_OWNER_REJECTED")')
      < processCode.indexOf('handleSlashCommand('),
    'direct non-owner rejection must precede slash command execution',
  );
  const directDmGuard = processCode.indexOf('if (directDmOutcome === "disabled" || directDmOutcome === "unauthorized")');
  const ownerAllowlistRead = processCode.indexOf('readFrameworkAllowFromList(deps.accountId)');
  const ownerMembershipCheck = processCode.search(/(?:includes|has)\(senderId\)/);
  const ownerContext = processCode.search(/ctx\.OwnerAllowFrom\s*=\s*\[senderId\]/);
  const commandAuthorization = processCode.indexOf('ctx.CommandAuthorized = commandAuthorized');
  const dispatch = processCode.indexOf('dispatchReplyFromConfig(');
  assert.ok(directDmGuard >= 0 && directDmGuard < ownerContext, 'unpaired direct-message guard must precede owner context');
  assert.match(
    processCode.slice(directDmGuard, ownerContext),
    /recordWeixinAcceptanceRejection\(full, "NON_OWNER_REJECTED"\)[\s\S]*?return;/,
    'disabled or unpaired direct messages must return before owner context is granted',
  );
  assert.ok(ownerAllowlistRead >= 0 && ownerAllowlistRead < ownerMembershipCheck, 'owner allowlist must be read before membership is checked');
  assert.ok(ownerMembershipCheck < ownerContext, 'explicit owner membership must be proven before OwnerAllowFrom is set');
  assert.ok(ownerContext < commandAuthorization, 'trusted owner context must be established before command authorization is exposed');
  assert.ok(commandAuthorization < dispatch, 'dispatch must occur only after the authorized owner context is complete');
  const monitorGuard = monitorCode.indexOf('if (!isDirectWeixinInbound(full))');
  assert.ok(monitorGuard >= 0 && monitorGuard < monitorCode.indexOf('configManager.getForUser('));
  assert.ok(monitorCode.indexOf('recordWeixinAcceptanceRejection(full, "GROUP_REJECTED")') >= monitorGuard);
});

test('group ordinary/slash and direct non-owner fixtures write only sanitized exact evidence', (t) => {
  const stateDir = acceptanceFixture(t);
  const groupMarker = 'JYACC_GROUP_0123456789abcdef';
  const slashMarker = 'JYACC_GROUP_fedcba9876543210';
  const nonOwnerMarker = 'JYACC_NONOWNER_0011223344556677';

  const ordinaryCalls = { auth: 0, route: 0, dispatch: 0, tool: 0 };
  runPolicyFixture(message(`please test ${groupMarker}`, 'group-1'), false, ordinaryCalls);
  assert.deepEqual(ordinaryCalls, { auth: 0, route: 0, dispatch: 0, tool: 0 });
  verifyWeixinAcceptanceEvidence({ marker: groupMarker, outcome: 'GROUP_REJECTED', stateDir });

  const slashCalls = { auth: 0, route: 0, dispatch: 0, tool: 0 };
  runPolicyFixture(message(`/${slashMarker}`, 'group-2'), true, slashCalls);
  assert.deepEqual(slashCalls, { auth: 0, route: 0, dispatch: 0, tool: 0 });
  verifyWeixinAcceptanceEvidence({ marker: slashMarker, outcome: 'GROUP_REJECTED', stateDir });

  const nonOwnerCalls = { auth: 0, route: 0, dispatch: 0, tool: 0 };
  runPolicyFixture(message(`/${nonOwnerMarker}`), false, nonOwnerCalls);
  assert.deepEqual(nonOwnerCalls, { auth: 1, route: 0, dispatch: 0, tool: 0 });
  const verified = verifyWeixinAcceptanceEvidence({ marker: nonOwnerMarker, outcome: 'NON_OWNER_REJECTED', stateDir });
  const evidencePath = path.join(stateDir, 'acceptance-evidence', 'openclaw-weixin', `${verified.markerDigest}.json`);
  const raw = fs.readFileSync(evidencePath, 'utf8');
  assert.ok(!raw.includes(nonOwnerMarker));
  assert.ok(!raw.includes('fixture-peer-never-persisted'));
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['markerDigest', 'observedAt', 'outcome', 'schemaVersion']);
});

test('direct owner passes and never writes rejection evidence', (t) => {
  const stateDir = acceptanceFixture(t);
  const calls = { auth: 0, route: 0, dispatch: 0, tool: 0 };
  runPolicyFixture(message('JYACC_NONOWNER_8899aabbccddeeff'), true, calls);
  assert.deepEqual(calls, { auth: 1, route: 1, dispatch: 1, tool: 1 });
  assert.equal(fs.existsSync(path.join(stateDir, 'acceptance-evidence')), false);
});

test('malformed markers are ignored and a symlinked evidence path fails closed', (t) => {
  const stateDir = acceptanceFixture(t);
  assert.equal(recordWeixinAcceptanceRejection(message('JYACC_GROUP_ABCDEF0123456789', 'g'), 'GROUP_REJECTED'), null);
  const target = path.join(stateDir, 'target');
  fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(stateDir, 'acceptance-evidence'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(
    () => recordWeixinAcceptanceRejection(message('JYACC_GROUP_1234567890abcdef', 'g'), 'GROUP_REJECTED'),
    /evidence directory is unsafe/,
  );
});
