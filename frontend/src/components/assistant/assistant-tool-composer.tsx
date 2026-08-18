'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { cancelAssistantTool, confirmAssistantTool, planAssistantTool, type AssistantToolExecution } from '@/lib/assistant-tool-api';

export function AssistantToolComposer({ companyId }: { companyId: string }) {
  const [leadId, setLeadId] = useState('');
  const [body, setBody] = useState('');
  const [channel, setChannel] = useState<'email' | 'whatsapp'>('email');
  const [execution, setExecution] = useState<AssistantToolExecution | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const plan = async () => {
    setBusy(true);
    setError(null);
    try {
      setExecution(await planAssistantTool({
        companyId,
        toolName: 'message_draft_prepare',
        requestId: `ui-draft-${Date.now()}`,
        parameters: { leadId: leadId.trim(), channel, body: body.trim() },
      }));
    } catch (nextError: any) {
      setError(nextError?.response?.data?.message || nextError?.message || 'Unable to plan the draft');
    } finally {
      setBusy(false);
    }
  };

  const act = async (action: 'confirm' | 'cancel') => {
    if (!execution) return;
    setBusy(true);
    setError(null);
    try {
      setExecution(action === 'confirm' ? await confirmAssistantTool(execution.id) : await cancelAssistantTool(execution.id));
    } catch (nextError: any) {
      setError(nextError?.response?.data?.message || nextError?.message || 'Unable to update the execution');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-slate-200 p-4" data-testid="assistant-tool-composer">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Prepare a real message draft</h2>
          <p className="text-[10px] text-slate-400">Plans are persisted first; confirmation never sends email or WhatsApp.</p>
        </div>
        {execution && <span data-testid="assistant-tool-composer-state" className="text-[10px] font-semibold text-indigo-700">{execution.state}</span>}
      </div>
      <div className="mt-3 grid gap-2">
        <input data-testid="assistant-tool-lead-id" value={leadId} onChange={(event) => setLeadId(event.target.value)} placeholder="Customer lead ID" className="rounded border px-2 py-1.5 text-xs" />
        <div className="flex gap-2">
          <select data-testid="assistant-tool-channel" value={channel} onChange={(event) => setChannel(event.target.value as 'email' | 'whatsapp')} className="rounded border px-2 py-1.5 text-xs">
            <option value="email">Email draft</option>
            <option value="whatsapp">WhatsApp draft</option>
          </select>
          <button data-testid="assistant-tool-plan" type="button" disabled={busy || !leadId.trim() || !body.trim()} onClick={() => void plan()} className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40">Plan draft</button>
        </div>
        <textarea data-testid="assistant-tool-body" value={body} onChange={(event) => setBody(event.target.value)} placeholder="Draft body" rows={3} className="rounded border px-2 py-1.5 text-xs" />
      </div>
      {execution?.state === 'AWAITING_CONFIRMATION' && <div className="mt-2 flex gap-2"><button data-testid="assistant-tool-confirm" type="button" disabled={busy} onClick={() => void act('confirm')} className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white">Confirm draft</button><button data-testid="assistant-tool-cancel" type="button" disabled={busy} onClick={() => void act('cancel')} className="rounded border px-3 py-1.5 text-xs">Cancel</button></div>}
      {execution?.result?.draftId != null && <p data-testid="assistant-tool-draft-result" className="mt-2 text-[10px] text-emerald-700">Draft persisted: {String(execution.result.draftId)}</p>}
      {execution?.errorCode && <p data-testid="assistant-tool-error" className="mt-2 text-[10px] text-red-600">{execution.errorCode}</p>}
      {error && <p role="alert" className="mt-2 text-[10px] text-red-600">{error}</p>}
    </Card>
  );
}
