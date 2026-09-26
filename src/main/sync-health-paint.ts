export type HqAgentHealth = {
  present: boolean
  label: string
  lastSync: string
  offline: boolean
  error: string
  openOnly?: boolean
}

export type SyncHealth = {
  ok: boolean
  line: string
  lastSync: string
  offline: boolean
  error: string
}

export function whenSync(raw: string): string {
  const s = String(raw || '').trim()
  if (!s) return 'never'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function syncLine(hq: HqAgentHealth): string {
  if (hq.offline) return 'Offline'
  if (hq.error === 'unauthorized') return 'Not syncing'
  if (hq.error) return hq.error
  if (hq.openOnly) return 'Open in this window'
  if (!hq.lastSync) return 'Waiting for first sync'
  return `Last sync ${whenSync(hq.lastSync)}`
}

export function paintHealth(hq: HqAgentHealth, watching: boolean): SyncHealth {
  if (hq.present) {
    const line = syncLine(hq)
    const ok = !hq.offline && !hq.error && (hq.openOnly || Boolean(hq.lastSync))
    return { ok, line, lastSync: hq.lastSync, offline: hq.offline, error: hq.error }
  }
  if (watching) {
    return { ok: true, line: 'Agency Brain · watching this folder', lastSync: '', offline: false, error: '' }
  }
  return { ok: false, line: 'Folder not syncing', lastSync: '', offline: false, error: '' }
}
