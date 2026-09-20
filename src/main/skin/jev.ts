import { listCaptures, type SkinCapture } from './capture'
import { getProposal, setProposal, type StoredProposal } from './jev-cache'
import { getLearned, setLearned } from './learned'
import {
  buildQuestions,
  decideProposal,
  drainStillOpen,
  jevShouldRun,
  shouldLearn,
  withCurrentPaintPolicy,
  type JevAnswers
} from './jev-propose'
import { askJev, typesafeReady } from './typesafe'

const inFlight = new Set<string>()
const DRAIN_CAP = 20
const DRAIN_BATCHES = 8
let drainRunning: Promise<number> | null = null
let healHook: ((row: { fingerprint: string; cli: string; eventKind: string; component: string }) => void) | null =
  null

export function onCatalogHeal(
  fn: (row: { fingerprint: string; cli: string; eventKind: string; component: string }) => void
): void {
  healHook = fn
}

function tellHeal(row: SkinCapture, proposal: StoredProposal): void {
  if (!shouldLearn(proposal) || !proposal.component) return
  healHook?.({
    fingerprint: row.fingerprint,
    cli: String(row.cli || ''),
    eventKind: row.eventKind,
    component: proposal.component
  })
}

function remember(row: SkinCapture, proposal: StoredProposal): void {
  if (!shouldLearn(proposal) || !proposal.component) return
  setLearned({
    cli: String(row.cli || ''),
    eventKind: row.eventKind,
    component: proposal.component,
    confidence: proposal.confidence,
    fingerprint: row.fingerprint
  })
}

function reuseCached(row: SkinCapture, existing: StoredProposal): StoredProposal {
  const fresh = withCurrentPaintPolicy(existing)
  const stored =
    fresh.paint !== existing.paint || fresh.component !== existing.component || fresh.detail !== existing.detail
      ? setProposal(row.fingerprint, fresh)
      : existing
  remember(row, stored)
  tellHeal(row, stored)
  return stored
}

export async function proposeFromCapture(
  row: SkinCapture,
  opts?: { force?: boolean }
): Promise<StoredProposal | null> {
  if (!jevShouldRun({ matched: row.matched && !opts?.force, eventKind: row.eventKind })) return null
  const fp = row.fingerprint
  if (!opts?.force) {
    const existing = getProposal(fp)
    if (existing) return reuseCached(row, existing)
  }
  if (inFlight.has(fp)) return getProposal(fp)
  inFlight.add(fp)
  try {
    const optionLabels = optionLabelsOf(row)
    const questions = buildQuestions(optionLabels)
    const res = await askJev({
      state: {
        cli: row.cli,
        eventKind: row.eventKind,
        transport: row.transport,
        props: row.propsHint,
        options: optionLabels,
        grid: String(row.grid || '').slice(0, 800),
        note: 'Propose a catalog row. Do not Allow a write. Copy labels from the screen.'
      },
      questions
    })
    if (!res?.answers) return null
    const proposal = decideProposal({
      answers: res.answers as JevAnswers,
      optionLabels
    })
    const stored = setProposal(fp, proposal)
    remember(row, stored)
    tellHeal(row, stored)
    return stored
  } catch (err) {
    console.error('Jev propose failed', err instanceof Error ? err.message : 'error')
    return null
  } finally {
    inFlight.delete(fp)
  }
}

function openRows(): SkinCapture[] {
  const seen = new Set<string>()
  const out: SkinCapture[] = []
  for (const row of listCaptures(500)) {
    const key = `${row.cli}:${row.eventKind}`
    if (seen.has(key)) continue
    seen.add(key)
    if (
      !drainStillOpen({
        learned: Boolean(getLearned(String(row.cli), row.eventKind)),
        matched: row.matched,
        eventKind: row.eventKind,
        cached: getProposal(row.fingerprint)
      })
    ) {
      continue
    }
    out.push(row)
  }
  return out
}

async function drainOnce(): Promise<number> {
  if (!typesafeReady()) return 0
  let added = 0
  let asks = 0
  for (const row of openRows()) {
    const cached = getProposal(row.fingerprint)
    if (!cached) {
      if (asks >= DRAIN_CAP) continue
      asks += 1
    }
    const proposal = await proposeFromCapture({ ...row, matched: false })
    if (proposal && shouldLearn(proposal)) added += 1
  }
  return added
}

export function learnUnmatchedCaptures(): Promise<number> {
  if (!typesafeReady()) return Promise.resolve(0)
  if (drainRunning) return drainRunning
  drainRunning = (async () => {
    let added = 0
    for (let i = 0; i < DRAIN_BATCHES; i++) {
      if (!typesafeReady()) break
      added += await drainOnce()
      if (!openRows().length) break
    }
    return added
  })().finally(() => {
    drainRunning = null
  })
  return drainRunning
}

function optionLabelsOf(row: SkinCapture): string[] {
  const raw = row.propsHint?.options
  if (!Array.isArray(raw)) return []
  return raw.map((o) => String(o || '').trim()).filter(Boolean)
}
