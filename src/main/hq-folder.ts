import { resolve, sep } from 'node:path'

export function sameFolder(a?: string | null, b?: string | null): boolean {
  const x = String(a || '').trim()
  const y = String(b || '').trim()
  if (!x || !y) return false
  try {
    return resolve(x) === resolve(y)
  } catch {
    return false
  }
}

export function seatMatchesFolder(state: { mini_root?: string }, folder: string): boolean {
  const want = String(folder || '').trim()
  const mini = String(state.mini_root || '').trim()
  if (!want || !mini) return false
  if (sameFolder(mini, want)) return true
  try {
    const root = resolve(mini)
    const path = resolve(want)
    return path === root || path.startsWith(root + sep)
  } catch {
    return false
  }
}

export type SeatRow = {
  id?: string
  mini_root?: string
  brain_label?: string
  last_sync_at?: string
  offline?: boolean
  last_error?: string
}

/** Match the open/watched folder. Never fall back to some other company's seat. */
export function pickSeatForFolder<T extends SeatRow>(seats: T[], folder: string): T | null {
  const want = String(folder || '').trim()
  if (!want) return null
  for (const s of seats) {
    if (!s.mini_root) continue
    if (seatMatchesFolder(s, want)) return s
  }
  return null
}
