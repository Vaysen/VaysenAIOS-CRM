import { NotFoundException } from '@nestjs/common';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { AiCommunicationsController } from './ai-communications.controller';
import { aiDiagnosticsEnabled, buildAiDiagnosticSnapshot } from './ai-diagnostic';

describe('AI diagnostics security', () => {
  it('is disabled unless the explicit switch is exactly true', () => {
    expect(aiDiagnosticsEnabled({})).toBe(false);
    expect(aiDiagnosticsEnabled({ ENABLE_AI_DIAGNOSTICS: 'TRUE' })).toBe(false);
    expect(aiDiagnosticsEnabled({ ENABLE_AI_DIAGNOSTICS: 'true' })).toBe(true);
  });

  it('returns only built-in read-only process and configuration health', () => {
    const snapshot = buildAiDiagnosticSnapshot({ ZHIPU_API_KEY: 'configured' }, process.cwd());
    expect(snapshot.runtime.node).toBe(process.versions.node);
    expect(snapshot.configuration.aiProviderConfigured).toBe(true);
    expect(snapshot).not.toHaveProperty('configuration.apiKey');
    expect(JSON.stringify(snapshot)).not.toContain('configured');
  });

  it('requires the super_admin role and hides the endpoint while disabled', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, AiCommunicationsController.prototype.diagnose);
    expect(roles).toEqual(['super_admin']);

    const controller = new AiCommunicationsController({} as any);
    const original = process.env.ENABLE_AI_DIAGNOSTICS;
    delete process.env.ENABLE_AI_DIAGNOSTICS;
    try {
      expect(() => controller.diagnose()).toThrow(NotFoundException);
    } finally {
      if (original === undefined) delete process.env.ENABLE_AI_DIAGNOSTICS;
      else process.env.ENABLE_AI_DIAGNOSTICS = original;
    }
  });

  it('contains no command-execution diagnostic implementation', () => {
    expect(AiCommunicationsController.prototype.diagnose.toString()).not.toMatch(/exec|spawn|npx|nest\s+build/i);
  });
});
