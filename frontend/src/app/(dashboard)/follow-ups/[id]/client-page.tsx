'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';
import { useRuntimeRouteParam } from '@/lib/use-runtime-route-param';
import { ArrowLeft, Check, X, Clock, Mail, Building2, User } from 'lucide-react';

const STATUS_COLORS: Record<string, string> = {
  Pending: 'bg-yellow-100 text-yellow-700',
  Completed: 'bg-green-100 text-green-700',
  Ignored: 'bg-gray-100 text-gray-600',
  Snoozed: 'bg-blue-100 text-blue-700',
  Cancelled: 'bg-red-100 text-red-500',
};

const PRIORITY_COLORS: Record<string, string> = {
  Urgent: 'bg-red-100 text-red-700',
  High: 'bg-orange-100 text-orange-700',
  Medium: 'bg-blue-100 text-blue-700',
  Low: 'bg-gray-100 text-gray-600',
};

export default function FollowUpDetailPage() {
  const id = useRuntimeRouteParam('id');
  const router = useRouter();
  const [reminder, setReminder] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const fetchReminder = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.get(`/follow-up-reminders/${id}`);
      setReminder(res.data);
    } catch (err: any) {
      setError('Failed to load reminder');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchReminder();
  }, [fetchReminder]);

  const handleAction = async (action: 'complete' | 'ignore') => {
    try {
      setActionLoading(true);
      await api.patch(`/follow-up-reminders/${id}/${action}`);
      fetchReminder();
    } catch (err: any) {
      setError(err.response?.data?.message || `Failed to ${action}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleSnooze = async () => {
    const date = prompt('Snooze until (YYYY-MM-DD):');
    if (!date) return;
    try {
      setActionLoading(true);
      await api.patch(`/follow-up-reminders/${id}/snooze`, { snoozedUntil: new Date(date).toISOString() });
      fetchReminder();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to snooze');
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  if (error || !reminder) {
    return (
      <div className="space-y-4">
        <Link href="/follow-ups" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ArrowLeft className="h-4 w-4" /> Back to Follow-ups
        </Link>
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-4 text-sm text-red-600">
          {error || 'Reminder not found'}
        </div>
      </div>
    );
  }

  const lead = reminder.lead;
  const emailMsg = reminder.emailMessage;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Link href="/follow-ups" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ArrowLeft className="h-4 w-4" /> Back to Follow-ups
        </Link>
        {reminder.status === 'Pending' && (
          <div className="flex gap-2">
            <button
              onClick={() => handleAction('complete')}
              disabled={actionLoading}
              className="inline-flex items-center gap-1 rounded-lg bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              <Check className="h-4 w-4" /> Complete
            </button>
            <button
              onClick={handleSnooze}
              disabled={actionLoading}
              className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Clock className="h-4 w-4" /> Snooze
            </button>
            <button
              onClick={() => handleAction('ignore')}
              disabled={actionLoading}
              className="inline-flex items-center gap-1 rounded-lg bg-gray-200 dark:bg-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-50"
            >
              <X className="h-4 w-4" /> Ignore
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-600 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-gray-400 hover:text-gray-600">&times;</button>
        </div>
      )}

      {/* Reminder Header */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-white">{reminder.title}</h2>
            <p className="mt-2 text-gray-600 dark:text-gray-400">{reminder.reason}</p>
          </div>
          <div className="flex gap-2">
            <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${STATUS_COLORS[reminder.status] || 'bg-gray-100 text-gray-700'}`}>
              {reminder.status}
            </span>
            <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${PRIORITY_COLORS[reminder.priority] || 'bg-gray-100 text-gray-700'}`}>
              {reminder.priority}
            </span>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-xs text-gray-400">Due Date</p>
            <p className="font-medium text-gray-900 dark:text-white">
              {new Date(reminder.dueAt).toLocaleDateString()}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-400">Created</p>
            <p className="font-medium text-gray-900 dark:text-white">
              {new Date(reminder.createdAt).toLocaleDateString()}
            </p>
          </div>
          {reminder.completedAt && (
            <div>
              <p className="text-xs text-gray-400">Completed</p>
              <p className="font-medium text-green-600">
                {new Date(reminder.completedAt).toLocaleDateString()}
              </p>
            </div>
          )}
          {reminder.snoozedUntil && (
            <div>
              <p className="text-xs text-gray-400">Snoozed Until</p>
              <p className="font-medium text-blue-600">
                {new Date(reminder.snoozedUntil).toLocaleDateString()}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Lead Info */}
      {lead && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
            <Building2 className="h-5 w-5" /> Lead Information
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <div>
              <p className="text-xs text-gray-400">Company</p>
              <Link href={`/leads/${lead.id}`} className="font-medium text-blue-600 hover:text-blue-800">
                {lead.companyName}
              </Link>
            </div>
            <div>
              <p className="text-xs text-gray-400">Contact</p>
              <p className="font-medium text-gray-900 dark:text-white">{lead.contactName || '-'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Email</p>
              <p className="font-medium text-gray-900 dark:text-white">{lead.contactEmail || '-'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Status</p>
              <p className="font-medium text-gray-900 dark:text-white capitalize">{lead.status}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Score</p>
              <p className="font-medium text-gray-900 dark:text-white">
                {lead.leadGrade ? `${lead.leadGrade} (${lead.leadScore})` : '-'}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Country</p>
              <p className="font-medium text-gray-900 dark:text-white">{lead.country || '-'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Last Contacted</p>
              <p className="font-medium text-gray-900 dark:text-white">
                {lead.lastContactedAt ? new Date(lead.lastContactedAt).toLocaleDateString() : 'Never'}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Next Follow-up</p>
              <p className="font-medium text-gray-900 dark:text-white">
                {lead.nextFollowUpAt ? new Date(lead.nextFollowUpAt).toLocaleDateString() : '-'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Related Email */}
      {emailMsg && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
            <Mail className="h-5 w-5" /> Related Email
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-xs text-gray-400">Subject</p>
              <Link href={`/emails/${emailMsg.id}`} className="font-medium text-blue-600 hover:text-blue-800">
                {emailMsg.subject}
              </Link>
            </div>
            <div>
              <p className="text-xs text-gray-400">Status</p>
              <p className="font-medium text-gray-900 dark:text-white">{emailMsg.status}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Sent</p>
              <p className="font-medium text-gray-900 dark:text-white">
                {emailMsg.sentAt ? new Date(emailMsg.sentAt).toLocaleDateString() : '-'}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Opened</p>
              <p className="font-medium text-gray-900 dark:text-white">
                {emailMsg.openedAt ? new Date(emailMsg.openedAt).toLocaleDateString() : '-'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Assignee */}
      {reminder.user && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
            <User className="h-5 w-5" /> Assigned To
          </h3>
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {reminder.user.firstName} {reminder.user.lastName} ({reminder.user.email})
          </p>
        </div>
      )}

      {/* Action buttons for completed/snoozed reminders */}
      {reminder.status === 'Snoozed' && (
        <div className="flex gap-2">
          <button
            onClick={() => handleAction('complete')}
            disabled={actionLoading}
            className="inline-flex items-center gap-1 rounded-lg bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700"
          >
            <Check className="h-4 w-4" /> Mark Complete
          </button>
        </div>
      )}
    </div>
  );
}
