import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync(resolve(__dirname, '..', 'Dockerfile'), 'utf8');

describe('TASK-110 frontend image healthcheck contract', () => {
  it('uses the pinned Node runtime instead of an uninstalled curl binary', () => {
    const healthcheck = dockerfile.match(/HEALTHCHECK[\s\S]*?\n\s*CMD\s+(\[[^\n]+\])/);
    expect(healthcheck, 'Dockerfile HEALTHCHECK exec form 不存在').not.toBeNull();
    const command = JSON.parse(healthcheck![1]) as string[];
    expect(command).toEqual(['node', 'scripts/runtime-healthcheck.cjs']);
    expect(dockerfile).toContain('COPY --from=builder --chown=appuser:appuser /app/scripts/runtime-healthcheck.cjs ./scripts/runtime-healthcheck.cjs');
    expect(healthcheck![0]).not.toMatch(/\bcurl\b/);
  });
});
