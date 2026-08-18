'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function businessContext(env = process.env) {
  return {
    brandName: env.BUSINESS_BRAND_NAME || 'Vaysen Packaging (Vaysen包装)',
    description: env.BUSINESS_DESCRIPTION
      || 'an international B2B packaging manufacturer and exporter serving brands, wholesalers, distributors and e-commerce businesses',
    productFocus: env.BUSINESS_PRODUCT_FOCUS
      || 'poly mailers, kraft paper bags, garbage bags, zip-lock bags and other customizable packaging products',
  };
}

function resolveClaudeExecutable(env = process.env, platform = process.platform) {
  if (env.CLAUDE_CLI_PATH) return env.CLAUDE_CLI_PATH;
  if (platform === 'win32') {
    const nativeExe = env.APPDATA && path.join(
      env.APPDATA,
      'npm',
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe',
    );
    if (nativeExe && fs.existsSync(nativeExe)) return nativeExe;
    return 'claude.exe';
  }
  return 'claude';
}

function buildClaudeEnvironment(env = process.env, purpose = 'general') {
  const model = env.ANTHROPIC_MODEL || '';
  return {
    ...env,
    ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '',
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: env.ANTHROPIC_DEFAULT_OPUS_MODEL || model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: env.ANTHROPIC_DEFAULT_SONNET_MODEL || model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || model,
    CLAUDE_AI_PURPOSE: purpose,
  };
}

function runClaude(prompt, options = {}, spawn = spawnSync) {
  const claudeEnv = buildClaudeEnvironment(options.env || process.env, options.purpose);
  const executable = resolveClaudeExecutable(claudeEnv, options.platform || process.platform);
  const args = [
    '-p',
    '--output-format', 'json',
    '--max-turns', String(options.maxTurns || 10),
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'WebSearch,WebFetch,Read',
  ];
  const result = spawn(executable, args, {
    input: prompt,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer || 12 * 1024 * 1024,
    timeout: options.timeout || 300000,
    env: claudeEnv,
    cwd: options.cwd || process.cwd(),
    shell: false,
    windowsHide: true,
  });

  if (result.error || result.status !== 0) {
    return {
      success: false,
      error: result.error?.message || `Claude CLI exited with status ${result.status}`,
      stderr: String(result.stderr || '').slice(0, 2000),
      status: result.status,
    };
  }
  return { success: true, stdout: String(result.stdout || '') };
}

function unwrapClaudeEnvelope(text) {
  try {
    const parsed = JSON.parse(String(text || '').trim());
    return typeof parsed?.result === 'string' ? parsed.result : String(text || '');
  } catch {
    return String(text || '');
  }
}

function parseJsonValue(text, opening, closing) {
  const clean = unwrapClaudeEnvelope(text)
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
  try {
    return JSON.parse(clean);
  } catch {
    const start = clean.indexOf(opening);
    const end = clean.lastIndexOf(closing);
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(clean.slice(start, end + 1)); } catch { return null; }
  }
}

module.exports = {
  buildClaudeEnvironment,
  businessContext,
  parseJsonValue,
  resolveClaudeExecutable,
  runClaude,
  unwrapClaudeEnvelope,
};
