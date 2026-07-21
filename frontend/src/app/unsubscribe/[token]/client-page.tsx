'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import { useRuntimeRouteParam } from '@/lib/use-runtime-route-param';

export default function UnsubscribePage() {
  const token = useRuntimeRouteParam('token');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!token) return;
    const load = async () => {
      try {
        setLoading(true);
        const res = await api.get(`/unsubscribe/${token}`);
        setData(res.data);
      } catch (err: any) {
        setError(err.response?.data?.message || 'Invalid unsubscribe link');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [token]);

  const handleUnsubscribe = async () => {
    try {
      setSubmitting(true);
      setError(null);
      await api.post(`/unsubscribe/${token}`, { reason: reason || undefined });
      setSuccess(true);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to unsubscribe');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto" />
          <p className="mt-3 text-gray-500">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 p-4">
      <div className="w-full max-w-md bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm p-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-1">
          Unsubscribe
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
          Example Trading Company — Email Preferences
        </p>

        {error && (
          <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-600 dark:text-red-400 mb-4">
            {error}
          </div>
        )}

        {success ? (
          <div className="text-center py-6">
            <div className="rounded-full bg-green-100 dark:bg-green-900/20 h-12 w-12 flex items-center justify-center mx-auto mb-4">
              <svg className="h-6 w-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">
              Successfully Unsubscribed
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              You have been unsubscribed from marketing emails.
              {data?.lead?.contactEmail && (
                <> No further emails will be sent to <strong>{data.lead.contactEmail}</strong>.</>
              )}
            </p>
          </div>
        ) : data?.alreadyUnsubscribed ? (
          <div className="text-center py-6">
            <div className="rounded-full bg-amber-100 dark:bg-amber-900/20 h-12 w-12 flex items-center justify-center mx-auto mb-4">
              <svg className="h-6 w-6 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">
              Already Unsubscribed
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              This email address has already been unsubscribed from marketing emails.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {data?.lead && (
              <div className="rounded-lg bg-gray-50 dark:bg-gray-800 p-4 text-sm">
                <p className="text-gray-600 dark:text-gray-400">
                  Unsubscribing will remove{' '}
                  <strong className="text-gray-900 dark:text-white">
                    {data.lead.contactEmail || 'your email'}
                  </strong>
                  {data.lead.companyName && (
                    <> ({data.lead.companyName})</>
                  )}{' '}
                  from marketing emails. You will no longer receive outreach emails from us.
                </p>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Reason (optional)
              </label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                placeholder="Why are you unsubscribing?"
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none resize-none"
              />
            </div>

            <button
              onClick={handleUnsubscribe}
              disabled={submitting}
              className="w-full rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
            >
              {submitting ? 'Processing...' : 'Confirm Unsubscribe'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
