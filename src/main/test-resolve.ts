import { existsSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Lets `node --test --experimental-strip-types` load main-process modules that use extensionless imports,
 * TypeScript that type stripping cannot run (parameter properties), or electron at load time.
 * Tests only: import this first, then load the module under test with a dynamic import.
 */

const esbuild = createRequire(import.meta.url)('esbuild') as { transformSync: (code: string, opts: Record<string, unknown>) => { code: string } }

const ELECTRON = `export const app = { getPath: () => ${JSON.stringify(tmpdir())}, getVersion: () => '0.0.0', isPackaged: false, getAppPath: () => ${JSON.stringify(process.cwd())}, on() {}, whenReady: () => Promise.resolve() }
export const BrowserWindow = { getAllWindows: () => [], fromWebContents: () => null }
export const ipcMain = { handle() {}, on() {} }
export const shell = { openExternal: async () => {}, openPath: async () => '' }
export const safeStorage = { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => String(b) }
export default { app, BrowserWindow, ipcMain, shell, safeStorage }`

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: 'stub:electron', shortCircuit: true }
    if ((spec.startsWith('./') || spec.startsWith('../')) && ctx.parentURL?.startsWith('file:') && !/\.(ts|js|mjs|cjs|json|node)$/.test(spec)) {
      const base = resolve(dirname(fileURLToPath(ctx.parentURL)), spec)
      for (const file of [`${base}.ts`, join(base, 'index.ts')]) if (existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true }
    }
    return next(spec, ctx)
  },
  load(url, ctx, next) {
    if (url === 'stub:electron') return { format: 'module', source: ELECTRON, shortCircuit: true }
    if (url.startsWith('file:') && url.endsWith('.ts') && !url.includes('/node_modules/')) {
      const source = esbuild.transformSync(readFileSync(fileURLToPath(url), 'utf8'), { loader: 'ts', format: 'esm', target: 'node22' }).code
      return { format: 'module', source, shortCircuit: true }
    }
    return next(url, ctx)
  }
})
