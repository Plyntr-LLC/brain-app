import type { SkinCapture } from './capture'
import { getProposal, setProposal, type StoredProposal } from './jev-cache'
import { buildQuestions, decideProposal, jevShouldRun, type JevAnswers } from './jev-propose'
import { askJev } from './typesafe'

const inFlight = new Set<string>()

export async function proposeFromCapture(
  row: SkinCapture,
  opts?: { force?: boolean }
): Promise<StoredProposal | null> {
  if (!jevShouldRun({ matched: row.matched, eventKind: row.eventKind })) return null
  const fp = row.fingerprint
  if (!opts?.force) {
    const existing = getProposal(fp)
    if (existing) return existing
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
    return setProposal(fp, proposal)
  } catch (err) {
    console.error('Jev propose failed', err instanceof Error ? err.message : 'error')
    return null
  } finally {
    inFlight.delete(fp)
  }
}

function optionLabelsOf(row: SkinCapture): string[] {
  const raw = row.propsHint?.options
  if (!Array.isArray(raw)) return []
  return raw.map((o) => String(o || '').trim()).filter(Boolean)
}
