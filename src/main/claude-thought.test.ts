import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import test from 'node:test'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// node --test strips types on this file, but claude-stream.ts imports extensionless paths and electron.
// The same hook the replay check uses loads that module so these lines hit the real parser.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const esbuild = createRequire(join(root, 'package.json'))('esbuild') as {
  transformSync: (code: string, opts: Record<string, unknown>) => { code: string }
}
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: 'stub:electron', shortCircuit: true }
    if (
      (spec.startsWith('./') || spec.startsWith('../')) &&
      ctx.parentURL?.startsWith('file:') &&
      !/\.(ts|js|mjs|cjs|json)$/.test(spec)
    ) {
      const base = resolve(dirname(fileURLToPath(ctx.parentURL)), spec)
      for (const file of [`${base}.ts`, join(base, 'index.ts')]) {
        if (existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true }
      }
    }
    return next(spec, ctx)
  },
  load(url, ctx, next) {
    if (url === 'stub:electron') {
      const source = `export const app = { getPath: () => '/tmp', getVersion: () => '0.0.0', isPackaged: false }
export const BrowserWindow = { getAllWindows: () => [] }
export default { app, BrowserWindow }`
      return { format: 'module', shortCircuit: true, source }
    }
    if (url.startsWith('file:') && url.endsWith('.ts') && url.includes('/src/')) {
      const source = esbuild.transformSync(readFileSync(fileURLToPath(url), 'utf8'), {
        loader: 'ts',
        format: 'esm',
        target: 'node22'
      }).code
      return { format: 'module', shortCircuit: true, source }
    }
    return next(url, ctx)
  }
})

const { collectClaudeEvents } = await import('./claude-stream.ts')

function line(value: unknown): string {
  return JSON.stringify(value)
}

function thoughts(lines: string[]): string[] {
  return collectClaudeEvents(lines).flatMap((ev) => (ev.kind === 'thought' ? [ev.data] : []))
}

function texts(lines: string[]): string[] {
  return collectClaudeEvents(lines).flatMap((ev) => (ev.kind === 'text' ? [ev.data] : []))
}

const ridge = line({
  type: 'stream_event',
  event: { delta: { type: 'thinking_delta', thinking: 'the ridge is open' } }
})

test('a Claude thinking delta is one thought', () => {
  assert.deepEqual(thoughts([ridge]), ['the ridge is open'])
})

test('a streamed thought is not repeated by the later thinking block', () => {
  const block = line({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: 'the ridge is open', signature: 'sig' }] }
  })
  assert.deepEqual(thoughts([ridge, block]), ['the ridge is open'])
})

test('a thinking block with no deltas is one thought', () => {
  const block = line({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: 'the ridge is open' }] }
  })
  assert.deepEqual(thoughts([block]), ['the ridge is open'])
})

test('empty thinking, a signature, and redacted thinking show nothing', () => {
  assert.deepEqual(
    thoughts([line({ type: 'stream_event', event: { delta: { type: 'thinking_delta', thinking: '' } } })]),
    []
  )
  assert.deepEqual(
    thoughts([line({ type: 'stream_event', event: { delta: { type: 'signature_delta', signature: 'abc' } } })]),
    []
  )
  assert.deepEqual(
    thoughts([line({ type: 'stream_event', event: { delta: { type: 'redacted_thinking', data: 'x' } } })]),
    []
  )
  assert.deepEqual(
    thoughts([line({ type: 'assistant', message: { content: [{ type: 'thinking', signature: 'only' }] } })]),
    []
  )
  assert.deepEqual(
    thoughts([line({ type: 'assistant', message: { content: [{ type: 'redacted_thinking', data: 'x' }] } })]),
    []
  )
})

test('a text delta stays text', () => {
  assert.deepEqual(texts([line({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'done' } } })]), ['done'])
})
