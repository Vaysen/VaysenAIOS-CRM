import { Badge } from '@/components/ui/badge';

const statusMap: Record<string, 'default' | 'secondary' | 'outline' | 'muted' | 'success' | 'warning' | 'destructive'> = {
  active: 'success',
  completed: 'success',
  sent: 'success',
  failed: 'destructive',
  skipped: 'warning',
  pending: 'warning',
  queued: 'secondary',
  draft: 'muted',
  inactive: 'muted',
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <Badge variant={statusMap[String(status).toLowerCase()] || 'outline'}>{label || status}</Badge>;
}
