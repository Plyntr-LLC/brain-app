export function formatWait(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const r = seconds % 60
  return `${m}:${String(r).padStart(2, '0')}`
}

export function WorkPulse({ label, seconds }: { label: string; seconds?: number }) {
  const clock = seconds != null && seconds > 0 ? formatWait(seconds) : ''
  return (
    <div className="worknote" aria-live="polite">
      <span className="wheel" aria-hidden="true" />
      <span>
        {label || 'Working'}
        <span className="dots" />
        {clock ? ` · ${clock}` : ''}
      </span>
    </div>
  )
}
