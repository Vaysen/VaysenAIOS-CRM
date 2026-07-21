const runtime = require('../../../tools/claude-cli-runtime');
const prospect = require('../../../tools/claude-prospect-cli');
const research = require('../../../tools/claude-research-cli');
import * as fs from 'fs';
import * as path from 'path';

describe('cross-platform Claude CLI runtime', () => {
  it('spawns an executable without a shell and sends the prompt through stdin', () => {
    const spawn = jest.fn(() => ({ status: 0, stdout: '{"result":"[]"}', stderr: '' }));
    const result = runtime.runClaude('private prompt; no temp file', {
      env: { CLAUDE_CLI_PATH: '/opt/claude/bin/claude' },
      platform: 'linux',
    }, spawn);

    expect(result.success).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      '/opt/claude/bin/claude',
      expect.arrayContaining(['-p', '--output-format', 'json']),
      expect.objectContaining({ input: 'private prompt; no temp file', shell: false }),
    );
  });

  it('resolves the native Windows binary instead of cmd.exe/type pipelines', () => {
    expect(runtime.resolveClaudeExecutable({ CLAUDE_CLI_PATH: 'C:\\Tools\\claude.exe' }, 'win32'))
      .toBe('C:\\Tools\\claude.exe');
  });

  it('uses only explicit Anthropic credentials and never maps the Zhipu key into Claude CLI', () => {
    const env = runtime.buildClaudeEnvironment({
      ANTHROPIC_API_KEY: 'anthropic-secret',
      ZHIPU_API_KEY: 'zhipu-secret',
    }, 'prospect');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('anthropic-secret');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
    expect(env.ANTHROPIC_AUTH_TOKEN).not.toBe('zhipu-secret');
  });

  it('builds dynamic Vaysen AI CRM packaging prompts', () => {
    const env = {
      BUSINESS_BRAND_NAME: 'Example Trading Company Test Brand',
      BUSINESS_DESCRIPTION: 'custom sustainable packaging exporter',
      BUSINESS_PRODUCT_FOCUS: 'custom kraft bags and recycled mailers',
    };
    const prospectPrompt = prospect.buildProspectPrompt({ country: 'Germany', count: 3, batch: 2 }, env);
    const researchPrompt = research.buildResearchPrompt({ company: 'Buyer GmbH', website: '', country: 'Germany', type: 'full' }, env);

    expect(prospectPrompt).toContain('Example Trading Company Test Brand');
    expect(prospectPrompt).toContain('custom kraft bags and recycled mailers');
    expect(researchPrompt).toContain('custom sustainable packaging exporter');
    expect(prospectPrompt + researchPrompt).not.toMatch(/Jingseyewear|sunglasses|eyewear/i);
  });

  it('ships the canonical tools and Claude executable dependency in both backend images', () => {
    const backendRoot = path.resolve(__dirname, '..', '..', '..');
    const dockerfile = fs.readFileSync(path.join(backendRoot, 'Dockerfile'), 'utf8');
    const workerDockerfile = fs.readFileSync(path.join(backendRoot, 'Dockerfile.worker'), 'utf8');
    const packageJson = JSON.parse(fs.readFileSync(path.join(backendRoot, 'package.json'), 'utf8'));

    expect(dockerfile).toContain('COPY --from=builder /app/tools ./tools');
    expect(workerDockerfile).toContain('COPY tools/ ./tools/');
    expect(dockerfile).toContain('/app/node_modules/.bin');
    expect(workerDockerfile).toContain('/app/node_modules/.bin');
    expect(packageJson.dependencies['@anthropic-ai/claude-code']).toBe('2.1.152');
  });
});
