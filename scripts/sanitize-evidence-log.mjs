import { homedir } from 'node:os';
import path from 'node:path';
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodePercentRuns(value) {
  return value.replace(/(?:%[0-9a-f]{2})+/gi, (encoded) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  });
}

function normalizeEvidenceText(value) {
  let normalized = String(value).replace(/\u001b\[[0-9;]*m/g, '');
  for (let layer = 0; layer < 6; layer += 1) {
    const decoded = decodePercentRuns(normalized)
      .replace(/\\u(?:005c|002f)/gi, '/')
      .replace(/\\u003a/gi, ':')
      .replace(/\\\//g, '/')
      .replace(/\\\\/g, '\\');
    if (decoded === normalized) break;
    normalized = decoded;
  }
  normalized = normalized.replace(/\\/g, '/');
  normalized = normalized.replace(/file:\/\/\/([a-z])(?=\/)/gi, (_, drive) => `file:///${drive.toUpperCase()}:`);
  return normalized.replace(
    /(^|[\s"'`=(:,;])\/([a-z])(?=\/)/gi,
    (_, prefix, drive) => `${prefix}${drive.toUpperCase()}:`,
  );
}

function normalizedPath(value) {
  const input = String(value);
  const resolved = /^[A-Za-z]:[\\/]/.test(input)
    ? path.win32.resolve(input)
    : path.resolve(input);
  return normalizeEvidenceText(resolved).replace(/\/+$/, '');
}

function pathApiFor(value) {
  return /^[A-Za-z]:[\\/]/.test(String(value)) ? path.win32 : path;
}

function credentialFinding(text) {
  const assignment =
    /["']?(?:api[_-]?key|client[_-]?secret|password|access[_-]?token|refresh[_-]?token|aws[_-]?secret[_-]?access[_-]?key|private[_-]?key|npm[_-]?token)["']?\s*[:=]\s*(?!["']?<REDACTED>["']?)[`"']?[^\s`"',;}{]{8,}/i;
  if (assignment.test(text)) return 'credential assignment';
  if (/(?:authorization\s*[:=]\s*)["']?(?:bearer|basic)\s+(?!<REDACTED>)[A-Za-z0-9._~+/=-]{6,}/i.test(text)) {
    return 'authorization credential';
  }
  if (/(?:^|[\r\n])cookie\s*:\s*[^\r\n]*(?:session|sid|auth)[^=;\r\n]*=(?!<REDACTED>)[^;\s\r\n]{6,}/i.test(text)) {
    return 'session cookie';
  }
  if (/https?:\/\/(?!<REDACTED>)[^/\s:@]+:[^/\s@]+@/i.test(text)) return 'URL userinfo';
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(text)) return 'private key';
  return null;
}

export function sanitizeEvidenceLog(
  value,
  {
    repositoryRoot,
    homeDirectory = homedir(),
    projectParent,
  },
) {
  const resolvedProjectParent = projectParent ?? pathApiFor(repositoryRoot).dirname(repositoryRoot);
  const userName = pathApiFor(homeDirectory).basename(homeDirectory);
  const replacements = [
    [normalizedPath(repositoryRoot), '<PROJECT_ROOT>'],
    [normalizedPath(resolvedProjectParent), '<PROJECT_PARENT>'],
    [normalizedPath(homeDirectory), '<USER_HOME>'],
  ].sort((left, right) => right[0].length - left[0].length);

  let sanitized = normalizeEvidenceText(value);
  for (const [target, replacement] of replacements) {
    sanitized = sanitized.replace(new RegExp(escapeRegExp(target), 'gi'), replacement);
  }
  if (userName.length >= 3) {
    const normalizedUserName = normalizeEvidenceText(userName);
    sanitized = sanitized.replace(new RegExp(escapeRegExp(normalizedUserName), 'gi'), '<USER_NAME>');
  }
  return sanitized.replace(/[ \t]+$/gm, '');
}

export function assertEvidenceLogSafe(
  value,
  {
    repositoryRoot,
    homeDirectory = homedir(),
    projectParent,
  },
) {
  const text = normalizeEvidenceText(value);
  const resolvedProjectParent = projectParent ?? pathApiFor(repositoryRoot).dirname(repositoryRoot);
  const forbiddenPaths = [
    normalizedPath(repositoryRoot),
    normalizedPath(resolvedProjectParent),
    normalizedPath(homeDirectory),
  ];
  for (const forbidden of forbiddenPaths) {
    if (new RegExp(escapeRegExp(forbidden), 'i').test(text)) {
      throw new Error('Evidence log still contains an absolute workspace or user path');
    }
  }
  const userName = normalizeEvidenceText(pathApiFor(homeDirectory).basename(homeDirectory));
  if (userName.length >= 3 && new RegExp(escapeRegExp(userName), 'i').test(text)) {
    throw new Error('Evidence log still contains the local user name');
  }
  const finding = credentialFinding(text);
  if (finding) throw new Error(`Evidence log contains a credential-shaped value (${finding})`);
}
