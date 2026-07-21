import { readFileSync } from 'fs';
import { join } from 'path';

export const ASSISTANT_ACTION_PROTOCOL = '2026-07-14.1';

function safeRevision(value: string | undefined) {
  const normalized = value?.trim();
  return normalized && /^[a-f0-9]{7,64}$/i.test(normalized) ? normalized : 'unknown';
}

function safeReleaseTag(value: string | undefined) {
  const normalized = value?.trim();
  return normalized && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(normalized)
    ? normalized
    : 'unknown';
}

function readBuildRevision(env: NodeJS.ProcessEnv) {
  if (env.BUILD_REVISION) return safeRevision(env.BUILD_REVISION);
  try {
    return safeRevision(readFileSync(join(process.cwd(), 'BUILD_REVISION'), 'utf8'));
  } catch {
    return 'unknown';
  }
}

export function buildHealthPayload(env: NodeJS.ProcessEnv = process.env) {
  const runtimeCommit = safeRevision(env.RELEASE_COMMIT);
  const buildCommit = readBuildRevision(env);
  return {
    status: 'ok',
    release: {
      commit: runtimeCommit,
      commitShort: safeRevision(env.RELEASE_COMMIT_SHORT),
      tag: safeReleaseTag(env.RELEASE_TAG),
      buildCommit,
      matchesBuild: runtimeCommit !== 'unknown' && runtimeCommit === buildCommit,
    },
    contracts: {
      assistantAction: ASSISTANT_ACTION_PROTOCOL,
    },
  } as const;
}
