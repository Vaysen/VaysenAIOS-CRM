import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { completeAiText, getAiProviderStatus, getProviderOrder, AiRouteTask } from '@/common/ai/ai-client.util';

@ApiTags('AI Providers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('ai')
export class AiController {
  @Get('providers/status')
  status() {
    return {
      providers: getAiProviderStatus(),
      routes: {
        clean: getProviderOrder('clean').join(' -> '),
        profile: getProviderOrder('profile').join(' -> '),
        evidence: getProviderOrder('evidence').join(' -> '),
        email: getProviderOrder('email').join(' -> '),
        research: getProviderOrder('research').join(' -> '),
        import: getProviderOrder('import').join(' -> '),
      },
    };
  }

  @Post('providers/test')
  async test(@Body() body: { task?: AiRouteTask }) {
    const startedAt = Date.now();
    const result = await completeAiText({
      purpose: body.task === 'import' ? 'import' : body.task === 'research' ? 'research' : body.task === 'email' ? 'email' : 'prospect',
      task: body.task || 'general',
      messages: [
        { role: 'system', content: 'Return one short JSON object only.' },
        { role: 'user', content: 'Return {"ok":true,"message":"provider connected"}' },
      ],
      temperature: 0,
      maxTokens: 120,
    });
    return {
      ok: true,
      provider: result.provider,
      model: result.model,
      durationMs: Date.now() - startedAt,
      sample: result.text,
    };
  }
}
