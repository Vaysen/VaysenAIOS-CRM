import {
  getAssistantCapability,
  resolveAssistantCapabilityDecision,
  validateAssistantOverrides,
} from './assistant-capability.registry';

describe('assistant capability registry', () => {
  it('gives supervisor broad single-customer CRM and external-send rights', () => {
    expect(resolveAssistantCapabilityDecision('SUPERVISOR', 'crm.customer.update')).toBe('ALLOW');
    expect(resolveAssistantCapabilityDecision('SUPERVISOR', 'crm.order.draft.write')).toBe('ALLOW');
    expect(resolveAssistantCapabilityDecision('SUPERVISOR', 'crm.message.send')).toBe('ALLOW');
    expect(resolveAssistantCapabilityDecision('SUPERVISOR', 'crm.email.send')).toBe('ALLOW');
    expect(resolveAssistantCapabilityDecision('SUPERVISOR', 'crm.quote.send')).toBe('ALLOW');
  });

  it('allows a matching temporary grant to release only grantable L3 capabilities', () => {
    expect(resolveAssistantCapabilityDecision('SUPERVISOR', 'crm.message.send', {}, true)).toBe('ALLOW');
    expect(resolveAssistantCapabilityDecision('SUPERVISOR', 'crm.customer.delete', {}, true)).toBe('APPROVAL_REQUIRED');
  });

  it('never opens infrastructure or L4 actions through overrides', () => {
    const overrides = validateAssistantOverrides({
      'infrastructure.shell': 'ALLOW',
      'crm.customer.delete': 'ALLOW',
    });
    expect(overrides['infrastructure.shell']).toBe('DENY');
    expect(overrides['crm.customer.delete']).toBe('APPROVAL_REQUIRED');
  });

  it('fails closed for unknown capabilities and invalid decisions', () => {
    expect(getAssistantCapability('missing')).toBeNull();
    expect(resolveAssistantCapabilityDecision('SUPERVISOR', 'missing')).toBe('DENY');
    expect(() => validateAssistantOverrides({ missing: 'ALLOW' })).toThrow('Unknown assistant capability');
    expect(() => validateAssistantOverrides({ 'crm.customer.read': 'MAYBE' })).toThrow('Invalid policy decision');
  });
});
