import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Auto-store keeps the local file. Drives the real maybeAutoStore; only ./session.ts is served by a
// fake whose mediaAdd writes the same pointer liveAdd writes. Prints AUTO_STORE_PASS only if every check passes.

type Add = { folder: string; root: string; path: string }
type Fake = { adds: Add[]; answer: (a: Add) => Promise<{ ok: boolean; status?: number }> }
const fake = ((globalThis as { __autoStoreFake?: Fake }).__autoStoreFake = { adds: [], answer: async () => ({ ok: true }) })

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === './session.ts' && ctx.parentURL?.endsWith('/media/auto-store.ts')) return { url: 'stub:media-session', shortCircuit: true }
    return next(spec, ctx)
  },
  load(url, ctx, next) {
    if (url === 'stub:media-session') {
      const source = `const f = globalThis.__autoStoreFake
export function mediaAutoStoreReady() { return true }
export async function mediaAdd(o) { f.adds.push(o); return f.answer(o) }`
      return { format: 'module', shortCircuit: true, source }
    }
    return next(url, ctx)
  }
})

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const auto = (await import(join(root, 'src/main/media/auto-store.ts'))) as typeof import('../src/main/media/auto-store.ts')
const pointer = (await import(join(root, 'src/main/media/pointer.ts'))) as typeof import('../src/main/media/pointer.ts')
const media = (await import(join(root, 'src/shared/media.ts'))) as typeof import('../src/shared/media.ts')

const results: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail })

const old = new Date(Date.now() - 5 * 60_000)
function brain(files: Record<string, number>): string {
  const folder = mkdtempSync(join(tmpdir(), 'auto-store-check-'))
  for (const [rel, bytes] of Object.entries(files)) put(folder, rel, bytes)
  return folder
}
function put(folder: string, rel: string, bytes: number, fill = 7): void {
  const p = join(folder, ...rel.split('/'))
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, Buffer.alloc(bytes, fill))
  utimesSync(p, old, old)
}
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
const snap = (p: string) => ({ sha: sha(p), mtime: statSync(p).mtimeMs, size: statSync(p).size })
const pointerAnswer = async (a: Add) => {
  pointer.writePointer({
    folder: a.folder,
    root: a.root,
    fields: { brain_media: 1, media_id: randomUUID(), title: auto.autoStoreTitle(a.path.slice(a.folder.length + 1)), mime: 'application/octet-stream', bytes: statSync(a.path).size, added: '2026-09-29' }
  })
  return { ok: true }
}
const pointers = (folder: string, rootRel: string) => {
  const d = join(folder, ...rootRel.split('/'), 'media')
  return existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.media.md')) : []
}

// a–d on one brain.
{
  const folder = brain({ 'projects/demo/clip.mp4': 40 * 1024, 'clients/acme/deck.pdf': 300 * 1024, 'projects/demo/notes.md': 400 * 1024 })
  const clip = join(folder, 'projects/demo/clip.mp4')
  const deck = join(folder, 'clients/acme/deck.pdf')
  const notes = join(folder, 'projects/demo/notes.md')
  const before = { clip: snap(clip), deck: snap(deck), notes: snap(notes) }
  fake.answer = pointerAnswer
  fake.adds = []
  const first = await auto.maybeAutoStore(folder, { force: true })
  const same = (p: string, s: ReturnType<typeof snap>) => existsSync(p) && JSON.stringify(snap(p)) === JSON.stringify(s)
  check('a stores clip.mp4 and deck.pdf, two mediaAdd calls', JSON.stringify([...first.stored].sort()) === JSON.stringify(['clients/acme/deck.pdf', 'projects/demo/clip.mp4']) && fake.adds.length === 2, JSON.stringify({ stored: first.stored, adds: fake.adds.length }))
  check('a both originals still exist with the same bytes and mtime', same(clip, before.clip) && same(deck, before.deck))
  check('a pointers written in projects/demo/media and clients/acme/media', pointers(folder, 'projects/demo').length === 1 && pointers(folder, 'clients/acme').length === 1)
  check('a notes.md (brain text) untouched and never offered', same(notes, before.notes) && !fake.adds.some((x) => x.path === notes))
  fake.adds = []
  const second = await auto.maybeAutoStore(folder, { force: true })
  check('b an immediate second run uploads nothing', fake.adds.length === 0 && second.stored.length === 0)
  const realNow = Date.now
  Date.now = () => realNow() + 10 * 60_000
  fake.adds = []
  const third = await auto.maybeAutoStore(folder)
  Date.now = realNow
  check('c past the retry window, the kept files are still not uploaded again', fake.adds.length === 0 && third.stored.length === 0, JSON.stringify(fake.adds.map((x) => x.path)))
  put(folder, 'projects/demo/clip.mp4', 41 * 1024, 9)
  fake.adds = []
  Date.now = () => realNow() + 20 * 60_000
  const fourth = await auto.maybeAutoStore(folder)
  Date.now = realNow
  check('d changed bytes are stored once as new content; the original stays', fake.adds.length === 1 && fake.adds[0].path === clip && fourth.stored.length === 1 && existsSync(clip) && statSync(clip).size === 41 * 1024, JSON.stringify(fake.adds.map((x) => x.path)))
}

// e. Brain-wide backoff: a 409 stops the scan, and a call without force inside the minute tries nothing.
{
  auto.resetAutoStoreState()
  const folder = brain({ 'projects/one/a.mp4': 10 * 1024, 'projects/one/b.mp4': 20 * 1024 })
  const a = join(folder, 'projects/one/a.mp4')
  const b = join(folder, 'projects/one/b.mp4')
  const before = { a: snap(a), b: snap(b) }
  fake.answer = async () => ({ ok: false, status: 409 })
  fake.adds = []
  await auto.maybeAutoStore(folder, { force: true })
  const firstCalls = fake.adds.length
  fake.adds = []
  await auto.maybeAutoStore(folder)
  check('e 409: one mediaAdd, then no call without force inside the minute; both files unchanged', firstCalls === 1 && fake.adds.length === 0 && JSON.stringify(snap(a)) === JSON.stringify(before.a) && JSON.stringify(snap(b)) === JSON.stringify(before.b), JSON.stringify({ firstCalls, second: fake.adds.length }))
}

// f. Static.
{
  const src = readFileSync(join(root, 'src/main/media/auto-store.ts'), 'utf8')
  check('f auto-store.ts has no unlinkSync, rmSync, or renameSync', !/\b(unlinkSync|rmSync|renameSync)\b/.test(src))
  const want = 'Images, videos, and other large files in a project or client folder are copied here on their own. The file stays where it is, and a note is added beside it in media/.'
  check('f Settings copy is the new sentence and never says move, remove, or delete', media.MEDIA_AUTO_STORE === want && !/\bmov(e|es|ed)\b|remov|delet/i.test(media.MEDIA_AUTO_STORE), media.MEDIA_AUTO_STORE)
}

const pass = results.every((r) => r.ok)
console.log([...results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok || !r.detail ? '' : `  ${r.detail}`}`), '', pass ? 'AUTO_STORE_PASS' : 'AUTO_STORE_FAIL'].join('\n'))
process.exit(pass ? 0 : 1)
