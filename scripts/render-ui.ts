// Renders a real renderer component page (scripts/render-ui/<name>.tsx) with the app's CSS in headless
// Chrome, prints the page's own asserts, and saves a screenshot. Exits 1 when any assert fails.
// node --experimental-strip-types scripts/render-ui.ts away [outDir]   (RENDER_UI_SIZE=1440,900 sets the screenshot size)
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
await esbuild.build({
  entryPoints: [join(root, 'scripts/render-ui', `${name}.tsx`)],
  bundle: true,
  outfile: js,
  jsx: 'automatic',
  format: 'iife',
  logLevel: 'error',
  define: { 'process.env.NODE_ENV': '"production"' },
  alias: { '@shared': join(root, 'src/shared'), '@renderer': join(root, 'src/renderer/src') },
  plugins: name === 'desk' ? [{
    name: 'node-stub',
    setup(build) {
      build.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, namespace: 'node-stub' }))
      build.onLoad({ filter: /.*/, namespace: 'node-stub' }, () => ({
        contents: 'export function readdirSync(){ throw new Error("no fs") }\nexport function statSync(){ throw new Error("no fs") }\nexport function join(){ return "" }\n',
        loader: 'js'
      }))
    }
  }] : name === 'shared-browser' ? [{
    name: 'shared-stub',
    setup(build) {
      const node = [
        'export function existsSync(){ return true }',
        'export function readFileSync(){ return "" }',
        'export function readdirSync(){ return [] }',
        'export function statSync(){ return { isDirectory(){ return false } } }',
        'export function homedir(){ return "/tmp" }',
        'export function tmpdir(){ return "/tmp" }',
        'export function join(...p){ return p.filter(Boolean).join("/") }',
        'export function dirname(p){ return String(p).split("/").slice(0,-1).join("/") }',
        'export function resolve(...p){ return p.join("/") }',
        'export function basename(p, ext){ const b = String(p).split("/").pop(); return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b }',
        'export function extname(p){ const m = /\\.[^./]*$/.exec(String(p)); return m ? m[0] : "" }'
      ].join('\n')
      const electron = `
        const handlers = (globalThis.__ipcHandlers = globalThis.__ipcHandlers || new Map())
        export const app = { getPath(){ return "/tmp" }, getAppPath(){ return "/tmp" }, getVersion(){ return "0" }, isPackaged: false, on(){}, quit(){} }
        export const BrowserWindow = { getAllWindows(){ return [] }, fromWebContents(){ return null } }
        export const ipcMain = { handle(channel, fn){ handlers.set(channel, fn) }, on(){} }
        export const ipcRenderer = {
          invoke(channel, ...args){
            globalThis.__ipcLog = globalThis.__ipcLog || []
            globalThis.__ipcLog.push([channel, ...args])
            const fn = handlers.get(channel)
            return fn ? Promise.resolve(fn(null, ...args)) : Promise.resolve(undefined)
          },
          on(){}, removeListener(){}, send(){}
        }
        export const contextBridge = { exposeInMainWorld(name, api){ if (name === "brain") window.brain = api } }
        export const webUtils = { getPathForFile(){ return "" } }
        export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
        export const shell = { openExternal(){}, openPath: async () => "" }
        export const clipboard = { readText(){ return "" }, writeText(){} }
        export default { app, BrowserWindow, ipcMain, ipcRenderer, contextBridge, webUtils }
      `
      const fakeInit = `
        globalThis.__browserFake = globalThis.__browserFake || { views: [], hosts: [], partitions: [], resized: [], captureSize: null, actions: [], pages: [], shotIds: [], entered: [], holds: [], nextId: 1 }
        ;(() => {
          const canvas = document.createElement("canvas")
          canvas.width = 1100
          canvas.height = 800
          const g = canvas.getContext("2d")
          g.fillStyle = "#f4f1ea"
          g.fillRect(0, 0, 1100, 800)
          g.fillStyle = "#222"
          g.fillRect(40, 40, 240, 80)
          const url = canvas.toDataURL("image/jpeg", 0.8)
          const bin = atob(url.slice(url.indexOf(",") + 1))
          const bytes = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
          globalThis.__browserFake.jpeg = bytes
        })()
      `
      const browserFake = fakeInit + readFileSync(join(root, 'scripts', 'fakes', 'electron-browser.js'), 'utf8')
      build.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, namespace: 'node-stub' }))
      build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }))
      build.onLoad({ filter: /.*/, namespace: 'node-stub' }, () => ({ contents: node, loader: 'js' }))
      build.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({ contents: electron + browserFake, loader: 'js' }))
    }
  }] : []
  ,
  banner: name === 'shared-browser' ? { js: 'globalThis.process = globalThis.process || { env: {}, platform: "darwin", resourcesPath: "", versions: { chrome: "138.0.0.0" } };' } : undefined
})
const css = ['tokens.css', 'shell.css'].map((f) => `<link rel="stylesheet" href="${pathToFileURL(join(root, 'src/renderer/src/styles', f)).href}">`).join('')
const page = join(outDir, `${name}.html`)
writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8">${css}</head><body><div id="root"></div><pre id="out"></pre><script src="${pathToFileURL(js).href}"></script></body></html>`)

const flags = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', '--virtual-time-budget=12000']
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
