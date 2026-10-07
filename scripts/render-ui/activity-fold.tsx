import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useRef } from 'react'
import { SkinPane } from '../../src/renderer/src/skin/SkinPane'

function bridge(path: string[]): unknown {
  const fn = (..._args: unknown[]) => {
    const name = path.join('.')
    if (/\.on[A-Z]/.test(name)) return () => undefined
    return Promise.resolve(undefined)
  }
  return new Proxy(fn, { get: (_t, key) => (typeof key === 'string' ? bridge([...path, key]) : undefined) })
}
;(window as unknown as { brain: unknown }).brain = bridge([])

const results: { name: string; ok: boolean; detail?: string }[] = []
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, ...(ok ? {} : { detail: String(detail).slice(0, 300) }) })

const messages = [
  { who: 'me', text: 'fix the quotes' },
  { who: 'think', text: 'Look at quotes.', at: 1_000, end: 5_000 },
  { who: 'tool', text: '', path: 'src/quotes.ts', tool: 'grep' },
  { who: 'think', text: 'Then the card.', at: 6_000, end: 9_000 },
  { who: 'tool', text: '', path: 'src/QuoteEditCard.tsx', tool: 'search_replace' },
  { who: 'tool', text: '', path: 'src/inventory.ts', tool: 'grep' },
  { who: 'brain', text: 'Done.' }
]

function Page() {
  const threadRef = useRef<HTMLDivElement>(null)
  return (
    <div style={{ height: 640, display: 'flex', flexDirection: 'column' }}>
      <SkinPane
        tabId="fold"
        cwd="/Users/joe/Projects/lotline"
        kind="cursor"
        visible
        restart={0}
        peel={false}
        messages={messages}
        busy={false}
        waitLabel=""
        waitSec={0}
        bgTasks={[]}
        bgNow={0}
        permission={null}
        threadRef={threadRef}
        onScroll={() => undefined}
        onPeel={() => undefined}
        onFiles={() => undefined}
        onAction={() => undefined}
        showPower={false}
        wantPower={false}
        canPeel={false}
        cliName="Cursor"
      />
    </div>
  )
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const root = document.getElementById('root')!
  flushSync(() => {
    createRoot(root).render(<Page />)
  })
  const thread = root.querySelector('.skin-thread')!
  const folds = () => [...thread.querySelectorAll<HTMLButtonElement>('.skin-activity > .think-label')]
  const chips = () => thread.querySelectorAll('.skin-tool')
  check('one activity row', folds().length === 1, String(folds().length))
  check('closed line names the three file steps', folds()[0]?.textContent === 'Thought for 8 s · 3 files · show', folds()[0]?.textContent || '')
  check('chips stay hidden until it opens', chips().length === 0, String(chips().length))
  check('the reply stays its own row', thread.querySelectorAll('.bubble.md').length === 1)
  folds()[0]?.click()
  await tick()
  check('open shows the three chips in that same row', chips().length === 3 && folds().length === 1, `${chips().length} chips, ${folds().length} rows`)
  check('open line drops show', folds()[0]?.textContent === 'Thought for 8 s · 3 files', folds()[0]?.textContent || '')
  document.getElementById('out')!.textContent = JSON.stringify(results)
}

void main().catch((e) => {
  results.push({ name: 'page ran', ok: false, detail: String((e as Error)?.stack || e) })
  document.getElementById('out')!.textContent = JSON.stringify(results)
})
