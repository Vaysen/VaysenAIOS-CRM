export const ASSISTANT_FILL_EMAIL_DRAFT_EVENT = 'assistant:fill-email-draft';

type EmailDraftFillDetail = {
  text: string;
  acknowledge: () => void;
};

export function dispatchAssistantEmailDraft(text: string): boolean {
  if (typeof window === 'undefined') return false;
  let handled = false;
  window.dispatchEvent(
    new CustomEvent<EmailDraftFillDetail>(ASSISTANT_FILL_EMAIL_DRAFT_EVENT, {
      detail: {
        text,
        acknowledge: () => {
          handled = true;
        },
      },
    }),
  );
  return handled;
}

export function subscribeAssistantEmailDraft(
  onDraft: (text: string) => boolean | void,
): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<EmailDraftFillDetail>).detail;
    const text = typeof detail?.text === 'string' ? detail.text.trim() : '';
    if (!text || onDraft(text) === false) return;
    detail.acknowledge();
  };
  window.addEventListener(ASSISTANT_FILL_EMAIL_DRAFT_EVENT, listener);
  return () => window.removeEventListener(ASSISTANT_FILL_EMAIL_DRAFT_EVENT, listener);
}
