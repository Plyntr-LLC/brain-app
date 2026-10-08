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
        'export function basename(p){ return String(p).split("/").pop() }'
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
      const pptr = `
        const fake = (globalThis.__browserFake = globalThis.__browserFake || { launches: [], actions: [], pages: [], shotIds: [], nextId: 1 })
        function jpegBytes(){
          if (fake.jpeg) return fake.jpeg
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
          fake.jpeg = bytes
          return bytes
        }
        function makePage(){
          const page = {
            windowId: fake.nextId++,
            viewport: null,
            windowState: "normal",
            _url: "about:blank",
            _closed: false,
            goto(url){ page._url = url; fake.actions.push("goto " + url); return Promise.resolve() },
            url(){ return page._url },
            click(){ return Promise.resolve() },
            type(){ return Promise.resolve() },
            bringToFront(){ fake.actions.push("bringToFront"); return Promise.resolve() },
            close(){ page._closed = true; return Promise.resolve() },
            isClosed(){ return page._closed },
            target(){ return { _targetId: page._targetId } },
            setViewport(v){ page.viewport = v; return Promise.resolve() },
            waitForNetworkIdle(){ return Promise.resolve() },
            screenshot(options){
              const clip = options && options.clip
              const css = options && options.type === "jpeg" && options.quality === 40 && options.fromSurface === false && options.captureBeyondViewport === false && clip && clip.x === 0 && clip.y === 0 && clip.width === 1100 && clip.height === 800 && clip.scale === 1
              const view = page.viewport && page.viewport.width === 1100 && page.viewport.height === 800 && page.viewport.deviceScaleFactor === 1
              fake.shotIds.push(page.windowId)
              return Promise.resolve(css && view && page.windowState === "minimized" ? jpegBytes() : new Uint8Array())
            },
            evaluate(fn){
              if (fn && fn.name === "pageSnapshot") return Promise.resolve({ title: fake.title || "Example", text: "hello", controls: ["link Pricing"], hasPassword: false })
              return Promise.resolve(null)
            },
            createCDPSession(){
              return Promise.resolve({
                send(method, params){
                  if (method === "Browser.getWindowForTarget") return Promise.resolve({ windowId: page.windowId })
                  if (method === "Browser.setWindowBounds" && params && params.bounds){ page.windowState = params.bounds.windowState; return Promise.resolve({}) }
                  if (method === "Target.createTarget"){ const id = "t" + fake.nextId; return Promise.resolve().then(() => { const created = makePage(); created._targetId = id; return { targetId: id } }) }
                  return Promise.resolve({})
                },
                detach(){ return Promise.resolve() }
              })
            },
            mouse: {
              click(x, y){ fake.actions.push("mouse " + x + " " + y + " " + page.windowId); return Promise.resolve() },
              wheel(o){ fake.actions.push("wheel " + (o && o.deltaY) + " " + page.windowId); return Promise.resolve() }
            },
            keyboard: {
              type(t){ fake.actions.push("type " + t + " " + page.windowId); return Promise.resolve() },
              press(k){ fake.actions.push("press " + k + " " + page.windowId); return Promise.resolve() }
            }
          }
          fake.pages.push(page)
          return page
        }
        function launch(options){ fake.launches.push(options); return Promise.resolve({ connected: true, pages(){ return Promise.resolve(fake.pages.filter((p) => !p._closed)) }, newPage(){ return Promise.resolve(makePage()) } }) }
        export { launch }
        export default { launch }
      `
      build.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, namespace: 'node-stub' }))
      build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }))
      build.onResolve({ filter: /^puppeteer-core$/ }, () => ({ path: 'puppeteer-core', namespace: 'pptr-stub' }))
      build.onLoad({ filter: /.*/, namespace: 'node-stub' }, () => ({ contents: node, loader: 'js' }))
      build.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({ contents: electron, loader: 'js' }))
      build.onLoad({ filter: /.*/, namespace: 'pptr-stub' }, () => ({ contents: pptr, loader: 'js' }))
    }
  }] : []
  ,
  banner: name === 'shared-browser' ? { js: 'globalThis.process = globalThis.process || { env: {}, platform: "darwin", resourcesPath: "" };' } : undefined
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
