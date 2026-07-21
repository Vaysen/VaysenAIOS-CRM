import fs from 'fs';
import path from 'path';

describe('AI business assistant desktop bridge contract', () => {
  const preloadSource = fs.readFileSync(
    path.resolve(__dirname, '..', 'src', 'preload', 'app-preload.ts'),
    'utf8',
  );
  const normalizedPreloadSource = preloadSource.replace(/\r\n?/g, '\n');
  const bridgeStart = normalizedPreloadSource.indexOf('  agentBridge: {');
  const bridgeEnd = normalizedPreloadSource.indexOf('\n  },\n};', bridgeStart);
  const bridgeBlock = bridgeStart >= 0 && bridgeEnd > bridgeStart
    ? normalizedPreloadSource.slice(bridgeStart, bridgeEnd + '\n  },'.length)
    : null;

  it('exposes only capability reads, quote preparation, and the exact human-confirmed text send', () => {
    expect(bridgeBlock).not.toBeNull();
    expect(bridgeBlock).toContain('getCapabilities');
    expect(bridgeBlock).toContain('getHeartbeat');
    expect(bridgeBlock).toContain('prepareQuoteDelivery');
    expect(bridgeBlock).toContain('sendWhatsappText');
    expect(bridgeBlock).toContain('AGENT_SEND_WHATSAPP_TEXT');
    expect(bridgeBlock).not.toMatch(/execute|retry|catchUp|inject/i);
    expect(bridgeBlock).not.toMatch(/sendDocument|sendEmail|sendMessage|sendArbitrary/i);
  });

  it('does not define an agent task execution IPC channel', () => {
    const channelsSource = fs.readFileSync(
      path.resolve(__dirname, '..', 'src', 'shared', 'ipc-channels.ts'),
      'utf8',
    );
    expect(channelsSource).not.toMatch(/AGENT_(?:TASK_)?EXECUTE/);
    expect(channelsSource).not.toMatch(/agent:(?:task-)?execute/);
    expect(channelsSource).toContain("AGENT_PREPARE_QUOTE_DELIVERY: 'agent:prepare-quote-delivery'");
    expect(channelsSource).toContain("AGENT_SEND_WHATSAPP_TEXT: 'agent:send-whatsapp-text'");
  });

  it('does not expose the legacy automatic document sender to the renderer', () => {
    expect(preloadSource).not.toContain('sendDocument');
    expect(preloadSource).not.toContain('IPC_CHANNELS.WA_SEND_DOCUMENT');
  });
});
