import assert from 'node:assert/strict';
import test from 'node:test';
import { assertEvidenceLogSafe, sanitizeEvidenceLog } from './sanitize-evidence-log.mjs';

const repositoryRoot = 'F:\\Private Work\\外贸系统\\vaysen-ai-crm';
const projectParent = 'F:\\Private Work\\外贸系统';
const homeDirectory = 'C:\\Users\\Synthetic Reviewer';

test('redacts Windows, MSYS, file URL, encoded, case and trailing-slash path variants', () => {
  const input = [
    'F:\\Private Work\\外贸系统\\vaysen-ai-crm\\frontend',
    'f:/private work/外贸系统/vaysen-ai-crm/frontend/',
    'file:///F:/Private%20Work/%E5%A4%96%E8%B4%B8%E7%B3%BB%E7%BB%9F/vaysen-ai-crm/frontend',
    'F%3A%2FPrivate%20Work%2F%E5%A4%96%E8%B4%B8%E7%B3%BB%E7%BB%9F%2Fvaysen-ai-crm',
    'F:/Private Work/外贸系统',
    'C:/Users/Synthetic Reviewer/cache',
    'Synthetic Reviewer',
    repositoryRoot.replaceAll('\\', '\\\\').replace('vaysen-ai-crm', 'vaysen-crm%2Dpilot'),
    `file:\\/\\/\\/${encodeURIComponent(repositoryRoot.replaceAll('\\', '/'))}`,
    repositoryRoot.replaceAll('\\', '\\u005c'),
    encodeURIComponent(encodeURIComponent(`${homeDirectory}\\cache`)),
  ].join('\n');

  const sanitized = sanitizeEvidenceLog(input, {
    repositoryRoot,
    projectParent,
    homeDirectory,
  });
  assert.match(sanitized, /<PROJECT_ROOT>[\\/]frontend/);
  assert.match(sanitized, /<PROJECT_PARENT>/);
  assert.match(sanitized, /<USER_HOME>/);
  assert.match(sanitized, /<USER_NAME>/);
  assert.doesNotThrow(() =>
    assertEvidenceLogSafe(sanitized, { repositoryRoot, projectParent, homeDirectory }),
  );
});

test('directly fails closed for encoded, JSON-escaped and mixed path attacks', () => {
  const forwardRoot = repositoryRoot.replaceAll('\\', '/');
  for (const unsafe of [
    repositoryRoot.replaceAll('\\', '\\\\').replace('vaysen-ai-crm', 'vaysen-crm%2Dpilot'),
    `file:\\/\\/\\/${encodeURIComponent(forwardRoot)}`,
    repositoryRoot.replaceAll('\\', '\\u005c'),
    encodeURIComponent(encodeURIComponent(`${homeDirectory}\\cache`)),
    encodeURIComponent(encodeURIComponent('Synthetic Reviewer')),
  ]) {
    assert.throws(
      () => assertEvidenceLogSafe(unsafe, { repositoryRoot, projectParent, homeDirectory }),
      /Evidence log/,
    );
  }
});

test('redacts and directly rejects real MSYS and encoded current-workspace paths', () => {
  const currentRepositoryRoot = process.cwd();
  const msysRoot = currentRepositoryRoot
    .replace(/^[A-Za-z]:/, (drive) => `/${drive[0].toLowerCase()}`)
    .replaceAll('\\', '/');
  const attacks = [
    `${msysRoot}/frontend`,
    `${encodeURIComponent(msysRoot)}/frontend`,
    `file:///${msysRoot.slice(1)}/frontend`,
  ];

  for (const unsafe of attacks) {
    assert.throws(
      () => assertEvidenceLogSafe(unsafe, { repositoryRoot: currentRepositoryRoot }),
      /Evidence log/,
    );
  }

  const sanitized = sanitizeEvidenceLog(attacks.join('\n'), {
    repositoryRoot: currentRepositoryRoot,
  });
  assert.equal((sanitized.match(/<PROJECT_ROOT>\/frontend/g) || []).length, attacks.length);
  assert.doesNotThrow(() =>
    assertEvidenceLogSafe(sanitized, { repositoryRoot: currentRepositoryRoot }),
  );
  assert.equal(sanitizeEvidenceLog('/foo/project', { repositoryRoot: currentRepositoryRoot }), '/foo/project');
});

test('directly fails closed for quoted, encoded, header and URL credential attacks', () => {
  for (const unsafe of [
    'Authorization: Basic dXNlcjpwYXNzd29yZA==',
    'authorization="Basic dXNlcjpwYXNzd29yZA=="',
    '"api_key": "abcdefghijklmnop"',
    "'password' = 'abcdefghijklmnop'",
    'refresh_token=abcdefghijklmnop',
    'AWS_SECRET_ACCESS_KEY=abcdefghijklmnop',
    'private_key="-----BEGIN PRIVATE KEY----abc"',
    'NPM_TOKEN=npm_abcdefghijklmnop',
    'Cookie: session=abcdefghijklmnop; Path=/',
    'https://reviewer:supersecret@example.test/build',
    '%41uthorization%3A%20Basic%20dXNlcjpwYXNzd29yZA%253D%253D',
    '%22api_key%22%3A%20%22abcdefghijklmnop%22',
  ]) {
    assert.throws(
      () => assertEvidenceLogSafe(unsafe, { repositoryRoot, projectParent, homeDirectory }),
      /Evidence log/,
    );
  }
});

test('fails closed for residual paths, user names and credential-shaped values', () => {
  for (const unsafe of [
    'F:/Private Work/外贸系统/vaysen-ai-crm/frontend',
    'C:\\Users\\Synthetic Reviewer\\cache',
    'Synthetic Reviewer',
    'authorization=Bearer abcdefghijklmnop',
    'api_key=abcdefghijklmnop',
    'password=abcdefghijklmnop',
  ]) {
    assert.throws(
      () => assertEvidenceLogSafe(unsafe, { repositoryRoot, projectParent, homeDirectory }),
      /Evidence log/,
    );
  }
});
