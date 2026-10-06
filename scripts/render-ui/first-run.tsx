import { createRoot } from 'react-dom/client'
import { FirstRun } from '../../src/renderer/src/FirstRun'
import { styleRules, type Violation } from './style-rules'

/** Any bridge call resolves to an empty answer, so the app opens on its first screen. */
function bridge(path: string[]): unknown {
  const fn = (...args: unknown[]) => {
    const name = path.join('.')
    if (/\.on[A-Z]/.test(name)) return () => undefined
    void args
    return Promise.resolve(undefined)
  }
  return new Proxy(fn, { get: (_t, key) => (typeof key === 'string' ? bridge([...path, key]) : undefined) })
}
;(window as unknown as { brain: unknown }).brain = bridge([])

const results: { name: string; ok: boolean; detail?: string }[] = []
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, ...(ok ? {} : { detail: String(detail).slice(0, 600) }) })
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))

async function main() {
  createRoot(document.getElementById('root')!, { onUncaughtError: (e) => check('render error', false, String((e as Error)?.stack || e)) }).render(<FirstRun />)
  let screen = ''
  for (let i = 0; i < 60 && !screen; i++) {
    await tick(50)
    const el = document.querySelector('[data-setup-screen]')
    if (el && (el.textContent || '').trim()) screen = el.getAttribute('data-setup-screen') || ''
  }
  check('the first screen renders', !!screen, document.getElementById('root')?.textContent?.slice(0, 200) || 'empty')
  check('it has a button and a field', !!document.querySelector('[data-setup-screen] button') && !!document.querySelector('[data-setup-screen] input, [data-setup-screen] textarea'), screen)
  const v = styleRules('ui') as Violation[]
  check(`mockup style rules on "${screen}"`, v.length === 0, v.map((x) => `${x.rule} ${x.at} ${x.detail}`).join(' || '))
  document.getElementById('out')!.textContent = JSON.stringify(results)
}

void main().catch((e) => {
  results.push({ name: 'page ran', ok: false, detail: String(e) })
  document.getElementById('out')!.textContent = JSON.stringify(results)
})
