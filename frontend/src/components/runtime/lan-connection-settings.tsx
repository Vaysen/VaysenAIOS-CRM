'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, Server, Settings2, WifiOff, X } from 'lucide-react';
import { checkWebApiConnection, type ConnectionCheckResult } from '@/lib/connection-check';
import {
  getRuntimeApiBaseUrl,
  isElectronRenderer,
  saveBrowserApiBaseUrl,
  validateRuntimeApiBaseUrl,
} from '@/lib/runtime-config';

type Props = { required?: boolean; inline?: boolean; onClose?: () => void };

function errorText(result: ConnectionCheckResult): string {
  const detail = result.status ? `（HTTP ${result.status}）` : '';
  return `${result.message}${detail}`;
}

export function LanConnectionSettings({ required = false, inline = false, onClose }: Props) {
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [isElectron, setIsElectron] = useState(false);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<ConnectionCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const electron = isElectronRenderer();
    setIsElectron(electron);
    const load = async () => {
      try {
        const config = electron ? await window.electronAPI!.app.configGet() : { config: { apiBaseUrl: getRuntimeApiBaseUrl() }, valid: true, errors: [] };
        if (!cancelled) {
          setApiBaseUrl(config.config.apiBaseUrl || '');
          if (!config.valid && config.errors[0]) setError(config.errors[0].reason);
        }
      } catch {
        if (!cancelled) setError('无法读取服务器配置，请重试。');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load().catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!isElectron || !window.electronAPI?.app.onNeedRestart) return;
    return window.electronAPI.app.onNeedRestart(() => setRestartRequired(true));
  }, [isElectron]);

  const check = async (value = apiBaseUrl) => {
    setError(null);
    const invalid = validateRuntimeApiBaseUrl(value);
    if (invalid) {
      setResult({ ok: false, code: 'invalid_url', url: value, latencyMs: 0, message: invalid });
      return null;
    }
    setChecking(true);
    try {
      const checked = isElectron
        ? await window.electronAPI!.app.checkConnection(value)
        : await checkWebApiConnection(value);
      setResult(checked);
      return checked;
    } catch {
      const failed: ConnectionCheckResult = { ok: false, code: 'network_error', url: value, message: '连接检测失败，请重试。' };
      setResult(failed);
      return failed;
    } finally {
      setChecking(false);
    }
  };

  const save = async () => {
    setError(null);
    const invalid = validateRuntimeApiBaseUrl(apiBaseUrl);
    if (invalid) { setError(invalid); return; }
    const checked = await check(apiBaseUrl);
    if (!checked?.ok) return;
    setSaving(true);
    try {
      if (isElectron) {
        const saved = await window.electronAPI!.app.configSet({ apiBaseUrl });
        if (!saved.success) { setError(saved.error || '保存服务器地址失败。'); return; }
        setRestartRequired(true);
      } else {
        saveBrowserApiBaseUrl(apiBaseUrl);
        setResult({ ...checked, message: '服务器地址已保存。' });
      }
    } catch {
      setError('保存服务器地址失败，请重试。');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return null;

  const body = (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"><Server className="h-5 w-5" /></div>
          <div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">服务器地址</h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">填写 CRM 后端在本机或局域网中的地址，例如 http://your-lan-host:4000。</p>
          </div>
        </div>
        {!required && onClose && <button onClick={onClose} aria-label="关闭" className="text-gray-400 hover:text-gray-700"><X className="h-5 w-5" /></button>}
      </div>

      <div>
        <label htmlFor="lan-api-base-url" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">API 地址</label>
        <input
          id="lan-api-base-url"
          value={apiBaseUrl}
          onChange={(event) => { setApiBaseUrl(event.target.value); setResult(null); setError(null); }}
          placeholder="http://your-lan-host:4000"
          autoComplete="url"
          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
        />
        <p className="mt-1 text-xs text-gray-400">不要填写用户名、密码、token 或查询参数。Electron 会通过本机代理访问此地址。</p>
      </div>

      {error && <div className="flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</div>}
      {result && <div className={`flex gap-2 rounded-lg border p-3 text-sm ${result.ok ? 'border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300' : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300'}`}>
        {result.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <WifiOff className="h-4 w-4 shrink-0" />}
        <div><div>{errorText(result)}</div>{result.serverVersion && <div className="mt-1 text-xs opacity-80">Server version: {result.serverVersion}{result.latencyMs !== undefined ? ` · ${result.latencyMs} ms` : ''}</div>}</div>
      </div>}
      {restartRequired && <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-300">地址已保存。请退出并重新打开客户端使新地址生效；现有登录和窗口配置会保留。</div>}

      <div className="flex flex-wrap gap-2">
        <button onClick={() => check()} disabled={checking || saving} className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"><RefreshCw className={`h-4 w-4 ${checking ? 'animate-spin' : ''}`} />{checking ? '检测中...' : '测试连接'}</button>
        <button onClick={save} disabled={checking || saving || !!result?.ok && restartRequired} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"><Settings2 className="h-4 w-4" />{saving ? '保存中...' : '保存并使用'}</button>
        {required && onClose && <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">暂不配置</button>}
      </div>
    </div>
  );

  if (inline) return <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-950">{body}</section>;
  return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4"><div className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white p-6 shadow-2xl dark:border-gray-800 dark:bg-gray-950">{body}</div></div>;
}

export function RuntimeConnectionGate({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const inspect = async () => {
      if (!isElectronRenderer()) { if (!cancelled) setChecked(true); return; }
      try {
        const config = await window.electronAPI!.app.configGet();
        if (!cancelled) { setOpen(!config.valid || !config.config.apiBaseUrl); setChecked(true); }
      } catch {
        if (!cancelled) { setOpen(true); setChecked(true); }
      }
    };
    inspect().catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  return <>{children}{checked && open && <LanConnectionSettings required onClose={() => setOpen(false)} />}</>;
}
