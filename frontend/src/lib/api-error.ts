export function getApiErrorMessage(error: unknown, fallback: string): string {
  const candidate = error as {
    response?: { data?: { message?: unknown } };
    message?: unknown;
  } | null;
  const value = candidate?.response?.data?.message;
  if (Array.isArray(value)) return value.map(String).join('；');
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof candidate?.message === 'string' && candidate.message.trim()) return candidate.message;
  return fallback;
}
