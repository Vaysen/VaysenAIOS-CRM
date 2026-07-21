import * as fs from 'fs';
import * as path from 'path';

export type AiDiagnosticSnapshot = {
  status: 'ok' | 'degraded';
  runtime: {
    node: string;
    platform: NodeJS.Platform;
    uptimeSeconds: number;
    rssMegabytes: number;
  };
  configuration: {
    aiProviderConfigured: boolean;
    researchCliPresent: boolean;
    prospectCliPresent: boolean;
  };
  timestamp: string;
};

export function aiDiagnosticsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ENABLE_AI_DIAGNOSTICS === 'true';
}

export function buildAiDiagnosticSnapshot(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): AiDiagnosticSnapshot {
  const aiProviderConfigured = Boolean(
    env.ANTHROPIC_AUTH_TOKEN
    || env.ANTHROPIC_API_KEY
    || env.ZHIPU_API_KEY
    || env.OPENAI_API_KEY,
  );
  const researchCliPresent = fs.existsSync(path.join(cwd, 'tools', 'claude-research-cli.js'));
  const prospectCliPresent = fs.existsSync(path.join(cwd, 'tools', 'claude-prospect-cli.js'));
  const rssMegabytes = Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10;

  return {
    status: aiProviderConfigured && researchCliPresent && prospectCliPresent ? 'ok' : 'degraded',
    runtime: {
      node: process.versions.node,
      platform: process.platform,
      uptimeSeconds: Math.floor(process.uptime()),
      rssMegabytes,
    },
    configuration: {
      aiProviderConfigured,
      researchCliPresent,
      prospectCliPresent,
    },
    timestamp: new Date().toISOString(),
  };
}
