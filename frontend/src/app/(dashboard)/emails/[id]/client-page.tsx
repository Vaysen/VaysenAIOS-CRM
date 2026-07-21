'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import { useRuntimeRouteParam } from '@/lib/use-runtime-route-param';
import { ArrowLeft, RefreshCw, Eye, MousePointer, AlertTriangle } from 'lucide-react';
import { sanitizeRichHtml } from '@/lib/sanitize-rich-html';

const STATUS_COLORS: Record<string, string> = {
  Draft: 'bg-gray-100 text-gray-700',
  DraftPending: 'bg-sky-100 text-sky-700',
  Drafting: 'bg-cyan-100 text-cyan-700',
  DraftReady: 'bg-blue-100 text-blue-700',
  ValidationFailed: 'bg-orange-100 text-orange-700',
  QueuedToSend: 'bg-blue-100 text-blue-700',
  Queued: 'bg-blue-100 text-blue-700',
  Sending: 'bg-yellow-100 text-yellow-700',
  Sent: 'bg-green-100 text-green-700',
  Failed: 'bg-red-100 text-red-700',
  DraftFailed: 'bg-red-100 text-red-700',
  Bounced: 'bg-red-200 text-red-800',
  Opened: 'bg-purple-100 text-purple-700',
  Clicked: 'bg-indigo-100 text-indigo-700',
  Replied: 'bg-emerald-100 text-emerald-700',
  Skipped: 'bg-amber-100 text-amber-700',
};

const STATUS_LABELS: Record<string, string> = {
  Draft: '草稿',
  DraftPending: '等待AI写信',
  Drafting: 'AI写信中',
  DraftReady: '草稿已完成',
  ValidationFailed: '内容校验失败',
  QueuedToSend: '等待发送',
  Queued: '队列中',
  Sending: '发送中',
  Sent: '已发送',
  Opened: '已打开',
  Clicked: '已点击',
  Replied: '已回复',
  Failed: '失败',
  DraftFailed: 'AI写信失败',
  Bounced: '退信',
  Skipped: '已跳过',
  Deleted: '已删除',
};

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sanitizeInternalEmailPreview(html: string) {
  const restored = (html || '<p>No content</p>')
    .replace(/<img\b[^>]*src=["'][^"']*\/api\/email-track\/open\/[^"']+["'][^>]*>/gi, '')
    .replace(
      /href=(["'])([^"']*\/api\/email-track\/click\/[^"']+\?url=([^"']+))\1/gi,
      (_match, quote, _trackedUrl, encodedUrl) => `href=${quote}${safeDecode(encodedUrl)}${quote}`,
    );
  return sanitizeRichHtml(restored);
}

export default function EmailDetailPage() {
  const id = useRuntimeRouteParam('id');
  const [email, setEmail] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resending, setResending] = useState(false);

  useEffect(() => {
    if (!id) return;
    const load = async () => {
      try {
        setLoading(true);
        const res = await api.get(`/emails/${id}`);
        setEmail(res.data);
      } catch (err: any) {
        setError(err.response?.data?.message || 'Failed to load email');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [id]);

  const handleResend = async () => {
    try {
      setResending(true);
      await api.post(`/emails/${id}/resend`);
      setError(null);
      // Reload
      const res = await api.get(`/emails/${id}`);
      setEmail(res.data);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Resend failed');
    } finally {
      setResending(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Link href="/emails" className="text-gray-400 hover:text-gray-600"><ArrowLeft className="h-5 w-5" /></Link>
        <p className="text-gray-400">Loading...</p>
      </div>
    );
  }

  if (!email) {
    return (
      <div className="space-y-6">
        <Link href="/emails" className="text-gray-400 hover:text-gray-600"><ArrowLeft className="h-5 w-5" /></Link>
        <p className="text-gray-400">Email not found</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-4">
        <Link href="/emails" className="text-gray-400 hover:text-gray-600">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">Email Detail</h2>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-600 dark:text-red-400 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-gray-400 hover:text-gray-600">&times;</button>
        </div>
      )}

      {/* Status & Actions */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${STATUS_COLORS[email.status] || 'bg-gray-100 text-gray-700'}`}>
              {STATUS_LABELS[email.status] || email.status}
            </span>
            {email.failedReason && (
              <span className="text-sm text-red-500 flex items-center gap-1">
                <AlertTriangle className="h-4 w-4" />
                {email.failedReason}
              </span>
            )}
          </div>
          {(email.status === 'Failed' || email.status === 'Bounced') && (
            <button
              onClick={handleResend}
              disabled={resending}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <RefreshCw className="h-4 w-4" />
              {resending ? '重新排队中...' : '重新发送'}
            </button>
          )}
        </div>
      </div>

      {/* Email Info */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6 space-y-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Email Information</h3>

        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-gray-500 text-xs">Subject</p>
            <p className="text-gray-900 dark:text-white font-medium">{email.subject}</p>
          </div>
          <div>
            <p className="text-gray-500 text-xs">To</p>
            <p className="text-gray-900 dark:text-white font-medium">{email.toEmail || email.lead?.contactEmail || '-'}</p>
          </div>
          <div>
            <p className="text-gray-500 text-xs">Lead</p>
            <Link href={`/leads/${email.leadId}`} className="text-blue-600 hover:text-blue-800 font-medium">
              {email.lead?.companyName || 'Unknown'} ({email.lead?.contactName || 'N/A'})
            </Link>
          </div>
          <div>
            <p className="text-gray-500 text-xs">Send Account</p>
            <p className="text-gray-900 dark:text-white">{email.emailAccount?.senderName} ({email.emailAccount?.senderEmail})</p>
          </div>
          <div>
            <p className="text-gray-500 text-xs">Sender</p>
            <p className="text-gray-900 dark:text-white">
              {email.senderUser ? `${email.senderUser.firstName} ${email.senderUser.lastName}` : '-'}
            </p>
          </div>
          <div>
            <p className="text-gray-500 text-xs">Message ID</p>
            <p className="text-gray-900 dark:text-white font-mono text-xs">{email.messageId || '-'}</p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4 text-sm border-t border-gray-200 dark:border-gray-800 pt-4">
          <div>
            <p className="text-gray-500 text-xs">Sent At</p>
            <p className="text-gray-900 dark:text-white">{email.sentAt ? new Date(email.sentAt).toLocaleString() : '-'}</p>
          </div>
          <div>
            <p className="text-gray-500 text-xs">Opened At</p>
            <p className="text-gray-900 dark:text-white">{email.openedAt ? new Date(email.openedAt).toLocaleString() : '-'}</p>
          </div>
          <div>
            <p className="text-gray-500 text-xs">Clicked At</p>
            <p className="text-gray-900 dark:text-white">{email.clickedAt ? new Date(email.clickedAt).toLocaleString() : '-'}</p>
          </div>
          <div>
            <p className="text-gray-500 text-xs">Failed At</p>
            <p className="text-gray-900 dark:text-white">{email.failedAt ? new Date(email.failedAt).toLocaleString() : '-'}</p>
          </div>
          <div>
            <p className="text-gray-500 text-xs">Retries</p>
            <p className="text-gray-900 dark:text-white">{email.retryCount} / {email.maxRetries}</p>
          </div>
        </div>
      </div>

      {/* Email Body */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6 space-y-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Email Body</h3>
        <div
          className="text-sm text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-900 rounded-lg p-4 border border-gray-200 dark:border-gray-800 prose dark:prose-invert max-w-none max-h-[500px] overflow-y-auto"
          dangerouslySetInnerHTML={{ __html: sanitizeInternalEmailPreview(email.renderedBody || email.bodyHtml || '<p>No content</p>') }}
        />
      </div>

      {/* Open Events */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6 space-y-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
          <Eye className="h-5 w-5 text-purple-500" />
          Open Events ({email.openEvents?.length || 0})
        </h3>
        {email.openEvents?.length > 0 ? (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Time</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Count</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">IP</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">User Agent</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
              {email.openEvents.map((evt: any, idx: number) => (
                <tr key={evt.id || idx}>
                  <td className="px-3 py-2 text-xs text-gray-900 dark:text-white">{new Date(evt.openedAt).toLocaleString()}</td>
                  <td className="px-3 py-2 text-xs text-gray-500">{evt.count}</td>
                  <td className="px-3 py-2 text-xs text-gray-500 font-mono">{evt.ipAddress || '-'}</td>
                  <td className="px-3 py-2 text-xs text-gray-400 truncate max-w-[200px]">{evt.userAgent || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-gray-400">No open events recorded</p>
        )}
      </div>

      {/* Click Events */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6 space-y-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
          <MousePointer className="h-5 w-5 text-indigo-500" />
          Click Events ({email.clickEvents?.length || 0})
        </h3>
        {email.clickEvents?.length > 0 ? (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Time</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">URL</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
              {email.clickEvents.map((evt: any, idx: number) => (
                <tr key={evt.id || idx}>
                  <td className="px-3 py-2 text-xs text-gray-900 dark:text-white">{new Date(evt.clickedAt).toLocaleString()}</td>
                  <td className="px-3 py-2 text-xs text-blue-600 truncate max-w-[300px]">{evt.originalUrl || '-'}</td>
                  <td className="px-3 py-2 text-xs text-gray-500 font-mono">{evt.ipAddress || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-gray-400">No click events recorded</p>
        )}
      </div>

      {/* Bounce Events */}
      {email.bounceEvents?.length > 0 && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6 space-y-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-red-500" />
            Bounce Events
          </h3>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Time</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Type</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
              {email.bounceEvents.map((evt: any) => (
                <tr key={evt.id}>
                  <td className="px-3 py-2 text-xs text-gray-900 dark:text-white">{new Date(evt.bouncedAt).toLocaleString()}</td>
                  <td className="px-3 py-2 text-xs">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                      evt.bounceType === 'hard' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'
                    }`}>
                      {evt.bounceType}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500">{evt.reason || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="rounded-lg bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-3 text-xs text-gray-500">
        <p>Open tracking pixel and click tracking links are embedded in each email. Open data may not be 100% accurate due to email client privacy settings.</p>
      </div>
    </div>
  );
}
