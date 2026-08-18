import { getAssistantTool, listAssistantTools } from './assistant-tool.registry';

describe('LAN assistant tool registry', () => {
  it('contains only fixed, schema-described tools and marks mutations for confirmation', () => {
    const tools = listAssistantTools();
    expect(tools).toHaveLength(7);
    expect(tools.every((tool) => tool.name && tool.schema.type === 'object')).toBe(true);
    expect(getAssistantTool('task_follow_up_create')?.confirmationRequired).toBe(true);
    expect(getAssistantTool('quote_draft_create')?.confirmationRequired).toBe(true);
    expect(getAssistantTool('message_draft_prepare')?.confirmationRequired).toBe(true);
    expect(getAssistantTool('customer_asset_read')?.confirmationRequired).toBe(false);
  });

  it('does not expose arbitrary URLs, SQL, or send tools', () => {
    const names = listAssistantTools().map((tool) => tool.name);
    expect(names).not.toContain('whatsapp_send');
    expect(names).not.toContain('email_send');
    expect(names.join(' ')).not.toMatch(/sql|url|shell/i);
  });

  it('keeps the deterministic planner available without a provider key', () => {
    expect(listAssistantTools().some((tool) => tool.name === 'message_draft_prepare')).toBe(true);
  });
});
