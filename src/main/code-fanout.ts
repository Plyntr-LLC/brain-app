import { CODE_NOT_LIVE, CODE_UNREACHABLE, pickCodeError } from '../shared/plyntr-org-copy.ts'

/** Every system that can email a sign-in code. One address may be on all three at once. */
export type CodeSystem = 'ads2ai' | 'hq-sync' | 'plyntr'

export const SEND_TIMEOUT_MS = 8000

const UNREACHABLE = /timeout|timed out|aborted|fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network/i

export const MAIL_FAILED = 'We found that email, but the code did not send. Ask the person who invited you for a fresh code.'

function errText(err: unknown): string {
  const e = err as { name?: string; message?: string }
  return `${e?.name || ''} ${e?.message || String(err || '')}`.trim()
}

export function withTimeout<T>(work: Promise<T>, ms = SEND_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

/**
 * Start every send at once. A slow system never holds up the others.
 * A sender resolves `true` when mail went out, `false` when it found the address but mail failed,
 * and `null` when the system always answers ok and so says nothing about this address.
 * It throws when the address is not on that system (or the system did not answer).
 */
export async function sendCodesEverywhere(
  senders: Partial<Record<CodeSystem, () => Promise<boolean | null>>>,
  timeoutMs = SEND_TIMEOUT_MS
): Promise<{ sent: CodeSystem[] }> {
  const legs = (Object.keys(senders) as CodeSystem[]).filter((k) => senders[k])
  const settled = await Promise.allSettled(legs.map((k) => withTimeout(senders[k]!(), timeoutMs)))
  const answer = (i: number) => (settled[i].status === 'fulfilled' ? (settled[i] as PromiseFulfilledResult<boolean | null>).value : undefined)
  const sent = legs.filter((_, i) => answer(i) === true)
  if (sent.length) return { sent }
  if (legs.some((_, i) => answer(i) === false)) throw new Error(MAIL_FAILED)
  const reasons = settled.filter((r) => r.status === 'rejected').map((r) => errText((r as PromiseRejectedResult).reason))
  if (reasons.length && reasons.every((m) => UNREACHABLE.test(m))) throw new Error(CODE_UNREACHABLE)
  throw new Error(CODE_NOT_LIVE)
}

/** Agency Brain and Plyntr both missed. Still ask project sync so a new Mac can sign a project person in. */
export async function sendCodesOrProjectFallback(
  senders: Partial<Record<CodeSystem, () => Promise<boolean | null>>>,
  projectSend: () => Promise<unknown>,
  timeoutMs = SEND_TIMEOUT_MS
): Promise<{ sent: CodeSystem[]; hedge: boolean }> {
  try {
    const out = await sendCodesEverywhere(senders, timeoutMs)
    return { sent: out.sent, hedge: false }
  } catch (err) {
    if (String((err as Error)?.message || err) !== CODE_NOT_LIVE) throw err
    await withTimeout(projectSend(), timeoutMs)
    return { sent: ['hq-sync'], hedge: true }
  }
}

/** Try one code on each system in order. First success wins; otherwise show the most useful failure. */
export async function tryCodeEverywhere<T>(tries: Array<() => Promise<T>>): Promise<T> {
  const errors: string[] = []
  for (const attempt of tries) {
    try {
      return await attempt()
    } catch (err) {
      errors.push(String((err as Error)?.message || err || ''))
    }
  }
  throw new Error(pickCodeError(errors))
}
