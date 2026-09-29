import { currentBrainFolder } from '../brains.ts'
import { liveMediaCheckIn, mediaWipeBrain, runMediaCheckIn } from './session.ts'
import { isMediaDryRun } from './transport.ts'

const POLL_MS = 10 * 60 * 1000
const LIVE_POLL_MS = 15 * 1000
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
  if (!isMediaDryRun()) return liveMediaCheckIn(path)
  const result = runMediaCheckIn(path)
  return { status: result.status, wiped: result.wiped }
}

export function startMediaStatePoll(): void {
  if (timer) return
  const tick = () => {
    void pollMediaState()
  }
  timer = setInterval(tick, isMediaDryRun() ? POLL_MS : LIVE_POLL_MS)
  if (typeof timer === 'object' && timer && 'unref' in timer) timer.unref()
  // Session start: join storage on the normal sign-in without waiting ten minutes.
  const first = setTimeout(tick, 5000)
  if (typeof first === 'object' && first && 'unref' in first) first.unref()
}

export function stopMediaStatePoll(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}
