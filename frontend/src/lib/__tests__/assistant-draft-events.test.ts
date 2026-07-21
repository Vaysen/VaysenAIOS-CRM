import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ASSISTANT_FILL_EMAIL_DRAFT_EVENT,
  dispatchAssistantEmailDraft,
  subscribeAssistantEmailDraft,
} from '../assistant-draft-events';

describe('assistant email draft bridge', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
  });

  it('returns true only when an active composer accepts the draft', () => {
    expect(dispatchAssistantEmailDraft('Hello')).toBe(false);

    const onDraft = vi.fn();
    cleanups.push(subscribeAssistantEmailDraft(onDraft));

    expect(dispatchAssistantEmailDraft('  Hello buyer  ')).toBe(true);
    expect(onDraft).toHaveBeenCalledWith('Hello buyer');
  });

  it('does not acknowledge when the mail page has no open composer', () => {
    cleanups.push(subscribeAssistantEmailDraft(() => false));
    expect(dispatchAssistantEmailDraft('Hello buyer')).toBe(false);
  });

  it('ignores empty and malformed custom events', () => {
    const onDraft = vi.fn();
    cleanups.push(subscribeAssistantEmailDraft(onDraft));

    window.dispatchEvent(new CustomEvent(ASSISTANT_FILL_EMAIL_DRAFT_EVENT));
    expect(dispatchAssistantEmailDraft('   ')).toBe(false);
    expect(onDraft).not.toHaveBeenCalled();
  });
});
