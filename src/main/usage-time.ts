/** Local wall time for a `/usage` reset. Takes an ISO string, a Date, or unix seconds. Empty when unreadable. */
export function resetLabel(when: unknown, timeZone?: string): string {
  const d = typeof when === 'number' ? new Date(when * 1000) : new Date(String(when || ''))
  if (Number.isNaN(d.getTime()) || (typeof when === 'number' && when <= 0)) return ''
  return d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {})
  })
}
