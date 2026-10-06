// Renders a real renderer component page (scripts/render-ui/<name>.tsx) with the app's CSS in headless
// Chrome, prints the page's own asserts, and saves a screenshot. Exits 1 when any assert fails.
// node --experimental-strip-types scripts/render-ui.ts away [outDir]   (RENDER_UI_SIZE=1440,900 sets the screenshot size)
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const name = process.argv[2] || 'away'
const outDir = process.argv[3] || join(tmpdir(), 'brain-render-ui')
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const esbuild = createRequire(import.meta.url)('esbuild') as typeof import('esbuild')

mkdirSync(outDir, { recursive: true })
const js = join(outDir, `${name}.js`)
esbuild.buildSync({
  entryPoints: [join(root, 'scripts/render-ui', `${name}.tsx`)],
  bundle: true,
  outfile: js,
  jsx: 'automatic',
  format: 'iife',
  logLevel: 'error',
  define: { 'process.env.NODE_ENV': '"production"' },
  alias: { '@shared': join(root, 'src/shared'), '@renderer': join(root, 'src/renderer/src') }
})
const css = ['tokens.css', 'shell.css'].map((f) => `<link rel="stylesheet" href="${pathToFileURL(join(root, 'src/renderer/src/styles', f)).href}">`).join('')
const page = join(outDir, `${name}.html`)
writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8">${css}</head><body><div id="root"></div><pre id="out"></pre><script src="${pathToFileURL(js).href}"></script></body></html>`)

const flags = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', '--virtual-time-budget=6000']
const dom = execFileSync(chrome, [...flags, '--dump-dom', pathToFileURL(page).href], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const raw = (dom.match(/<pre id="out">([\s\S]*?)<\/pre>/) || [])[1] || ''
const text = raw.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const shot = join(outDir, `${name}.png`)
execFileSync(chrome, [...flags, `--window-size=${process.env.RENDER_UI_SIZE || '1100,1400'}`, `--screenshot=${shot}`, pathToFileURL(page).href], { stdio: 'ignore' })

let results: { name: string; ok: boolean; detail?: string }[] = []
try {
  results = JSON.parse(text)
} catch {
  console.log(`RENDER_UI_FAIL ${name}: the page wrote no results`)
  process.exit(1)
}
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? `  ${r.detail}` : ''}`)
const pass = results.length > 0 && results.every((r) => r.ok)
console.log(`\n${pass ? 'RENDER_UI_PASS' : 'RENDER_UI_FAIL'} ${name} (${results.length} checks)\nscreenshot: ${shot}`)
process.exit(pass ? 0 : 1)
