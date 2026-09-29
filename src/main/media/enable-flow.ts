const ID_RE = /^[A-Za-z0-9_-]{8,80}$/

export const CONFLICT_DETAIL =
  'This brain already has storage. Enter the new email code and the six-word passphrase from when you first turned storage on.'
export const NO_BRAIN_DETAIL =
  'No storage was found for this brain. Check your email for a new code, enter it, then turn storage on again.'

export type ReclaimStartOutcome = 'ok' | 'bad_code' | 'no_brain' | 'other'

// Create 409 spent the email code. Only a real id the worker named (not the one we just made up) is kept.
export function conflictBrainId(json: Record<string, unknown> | null | undefined, generatedId: string): string {
  const id = String(json?.id || '')
  if (!ID_RE.test(id) || id === generatedId) return ''
  return id
}

// Worker: 401/410 come from consumeMediaCode (code untouched or already used). 403 means the code was
// valid and is now spent, but no brain or builder seat matched, so media.json points at nothing.
export function reclaimStartOutcome(status: number): ReclaimStartOutcome {
  if (status === 200) return 'ok'
  if (status === 401 || status === 410) return 'bad_code'
  if (status === 403) return 'no_brain'
  return 'other'
}

export const EXISTS_DETAIL =
  'This brain already has Plyntr storage. It finishes on its own when an owner or scout computer is online. If no computer has it, use Emergency restore.'
