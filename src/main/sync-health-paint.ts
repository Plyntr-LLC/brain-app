export type HqAgentHealth = {
  present: boolean
  label: string
  lastSync: string
  offline: boolean
  error: string
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

export function paintHealth(hq: HqAgentHealth, watching: boolean): SyncHealth {
  if (hq.present) {
    if (hq.offline) {
      return { ok: false, line: `${hq.label}: offline`, lastSync: hq.lastSync, offline: true, error: hq.error }
    }
    if (hq.error) {
      return { ok: false, line: `${hq.label}: ${hq.error}`, lastSync: hq.lastSync, offline: false, error: hq.error }
    }
    if (!hq.lastSync) {
      return {
        ok: false,
        line: `${hq.label}: waiting for first sync`,
        lastSync: '',
        offline: false,
        error: ''
      }
    }
    return {
      ok: true,
      line: `${hq.label}: last sync ${whenSync(hq.lastSync)}`,
      lastSync: hq.lastSync,
      offline: false,
      error: ''
    }
  }
  if (watching) {
    return { ok: true, line: 'Agency Brain · watching this folder', lastSync: '', offline: false, error: '' }
  }
  return { ok: false, line: 'Folder not syncing', lastSync: '', offline: false, error: '' }
}
