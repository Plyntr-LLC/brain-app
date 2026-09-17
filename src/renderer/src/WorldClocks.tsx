import { useEffect, useState } from 'react'

type Zone = { id: string; label: string; tz?: string }

const ZONES: Zone[] = [
  { id: 'local', label: 'Local' },
  { id: 'et', label: 'Eastern', tz: 'America/New_York' },
  { id: 'ct', label: 'Central', tz: 'America/Chicago' },
  { id: 'pt', label: 'Pacific', tz: 'America/Los_Angeles' }
]

function clockParts(now: Date, tz?: string): { time: string; abbr: string } {
  const opts: Intl.DateTimeFormatOptions = {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short'
  }
  if (tz) opts.timeZone = tz
  const parts = new Intl.DateTimeFormat('en-US', opts).formatToParts(now)
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value || ''
  const hour = get('hour')
  const minute = get('minute')
  const period = get('dayPeriod')
  return {
    time: period ? `${hour}:${minute} ${period}` : `${hour}:${minute}`,
    abbr: get('timeZoneName')
  }
}

export function WorldClocks() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(id)
  }, [])
  return (
    <div className="clockstrip" aria-label="Times">
      {ZONES.map((z) => {
        const { time, abbr } = clockParts(now, z.tz)
        return (
          <div className="clock" key={z.id}>
            <span className="zone">
              {z.label}
              {abbr ? ` · ${abbr}` : ''}
            </span>
            <span className="t">{time}</span>
          </div>
        )
      })}
    </div>
  )
}
