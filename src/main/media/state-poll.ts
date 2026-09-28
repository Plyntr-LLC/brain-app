import { app } from 'electron'
import { currentBrainFolder } from '../brains.ts'
import { mediaDeviceState, mediaWipeBrain } from './session.ts'

const POLL_MS = 10 * 60 * 1000
let timer: ReturnType<typeof setInterval> | null = null

export function applyMediaState(opts: {
  userData: string
  mediaBrainId: string
  httpStatus: number
}): { wiped: boolean } {
  if (opts.httpStatus === 410) {
    mediaWipeBrain(opts.mediaBrainId, opts.userData)
    return { wiped: true }
  }
  return { wiped: false }
}

export async function pollMediaState(folder?: string): Promise<{ status: number; wiped: boolean }> {
  const path = String(folder || currentBrainFolder() || '')
  if (!path) return { status: 204, wiped: false }
  const snap = mediaDeviceState(path)
  if (!snap) return { status: 204, wiped: false }
  if (snap.status === 'revoked') {
    const userData = app.getPath('userData')
    applyMediaState({ userData, mediaBrainId: snap.mediaBrainId, httpStatus: 410 })
    return { status: 410, wiped: true }
  }
  if (snap.status === 'blocked') return { status: 401, wiped: false }
  return { status: 200, wiped: false }
}

export function startMediaStatePoll(): void {
  if (timer) return
  const tick = () => {
    void pollMediaState()
  }
  timer = setInterval(tick, POLL_MS)
  if (typeof timer === 'object' && timer && 'unref' in timer) timer.unref()
}

export function stopMediaStatePoll(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}
