import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { PACK_MAX_EXCERPT, PACK_MAX_FILES } from '../../shared/desk.ts'
import { packPaths } from './pack.ts'

function put(root: string, rel: string, body: string | Buffer): void {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, body)
}

function fixture(): string {
  const brain = mkdtempSync(join(tmpdir(), 'desk-pack-'))
  put(brain, 'clients/summit/notes.md', '# Summit\n\nSeptember numbers are in.\n')
  put(brain, '.git/config', '[core]\n')
  put(brain, 'vendor/lib/.git/HEAD', 'ref: refs/heads/main\n')
  put(brain, '.env', 'KEY=secret\n')
  put(brain, 'clients/summit/.env.local', 'KEY=secret\n')
  put(brain, 'reports/chart.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a]))
  put(brain, 'reports/late-null.txt', `hello\n${'a'.repeat(2000)}\u0000`)
  return brain
}

test('a real file comes back with its brain-relative path and whole text when short', () => {
  const brain = fixture()
  const pack = packPaths(brain, ['clients/summit/notes.md'], 'Summit asked for numbers.')
  assert.deepEqual(pack, {
    why: 'Summit asked for numbers.',
    files: [{ path: 'clients/summit/notes.md', excerpt: '# Summit\n\nSeptember numbers are in.\n' }],
    dropped: []
  })
})

test('a missing path goes into dropped as given; a real one stays', () => {
  const brain = fixture()
  const pack = packPaths(brain, ['clients/summit/notes.md', 'clients/summit/missing.md'], 'why')
  assert.deepEqual(pack.files.map((f) => f.path), ['clients/summit/notes.md'])
  assert.deepEqual(pack.dropped, ['clients/summit/missing.md'])
})

test('paths outside the brain are dropped, through .. and absolute paths', () => {
  const brain = fixture()
  const outside = mkdtempSync(join(tmpdir(), 'desk-pack-out-'))
  put(outside, 'secret.md', 'not in the brain\n')
  const named = ['../secret.md', 'clients/../../secret.md', join(outside, 'secret.md'), '/etc/hosts', '..', '.']
  const pack = packPaths(brain, named, 'why')
  assert.deepEqual(pack.files, [])
  assert.deepEqual(pack.dropped, named)
})

test('a symlink that lands outside the brain is dropped; one that stays inside is read', () => {
  const brain = fixture()
  const outside = mkdtempSync(join(tmpdir(), 'desk-pack-out-'))
  put(outside, 'secret.md', 'not in the brain\n')
  symlinkSync(join(outside, 'secret.md'), join(brain, 'clients/summit/link-out.md'))
  symlinkSync(outside, join(brain, 'linked-dir'))
  symlinkSync(join(brain, 'clients/summit/notes.md'), join(brain, 'notes-link.md'))
  const pack = packPaths(brain, ['clients/summit/link-out.md', 'linked-dir/secret.md', 'notes-link.md'], 'why')
  assert.deepEqual(pack.files.map((f) => f.path), ['notes-link.md'])
  assert.match(pack.files[0].excerpt, /September numbers/)
  assert.deepEqual(pack.dropped, ['clients/summit/link-out.md', 'linked-dir/secret.md'])
})

test('a symlink into .git or onto a .env file is dropped, and so is a link named .env', () => {
  const brain = fixture()
  symlinkSync(join(brain, '.git/config'), join(brain, 'git-config.md'))
  symlinkSync(join(brain, '.env'), join(brain, 'env.md'))
  symlinkSync(join(brain, 'clients/summit/notes.md'), join(brain, 'clients/.env.notes'))
  const named = ['git-config.md', 'env.md', 'clients/.env.notes']
  const pack = packPaths(brain, named, 'why')
  assert.deepEqual(pack.files, [])
  assert.deepEqual(pack.dropped, named)
})

test('.git paths and .env* files are dropped, including nested and dotted spellings', () => {
  const brain = fixture()
  const named = ['.git/config', 'vendor/lib/.git/HEAD', 'clients/../.git/config', './.git/config', '.env', 'clients/summit/.env.local']
  const pack = packPaths(brain, named, 'why')
  assert.deepEqual(pack.files, [])
  assert.deepEqual(pack.dropped, named)
})

test('a file with a null byte is not text and is dropped, even past the excerpt', () => {
  const brain = fixture()
  const pack = packPaths(brain, ['reports/chart.png', 'reports/late-null.txt'], 'why')
  assert.deepEqual(pack.files, [])
  assert.deepEqual(pack.dropped, ['reports/chart.png', 'reports/late-null.txt'])
})

test('a directory is not a file and is dropped; an empty path is dropped', () => {
  const brain = fixture()
  const pack = packPaths(brain, ['clients/summit', '   '], 'why')
  assert.deepEqual(pack.files, [])
  assert.deepEqual(pack.dropped, ['clients/summit', '   '])
})

test('an excerpt is the first 1,500 characters cut back to the last line break', () => {
  const brain = fixture()
  const line = `${'x'.repeat(99)}\n`
  put(brain, 'long.md', line.repeat(30))
  put(brain, 'crlf.md', `${'y'.repeat(98)}\r\n`.repeat(30))
  const pack = packPaths(brain, ['long.md', 'crlf.md'], 'why')
  const long = pack.files[0].excerpt
  assert.equal(long, line.repeat(14) + 'x'.repeat(99))
  assert.ok(long.length <= PACK_MAX_EXCERPT)
  assert.ok(!long.endsWith('\n'))
  const crlf = pack.files[1].excerpt
  assert.ok(crlf.length <= PACK_MAX_EXCERPT)
  assert.ok(!crlf.endsWith('\r') && !crlf.endsWith('\n'))
  assert.equal(crlf, `${'y'.repeat(98)}\r\n`.repeat(14) + 'y'.repeat(98))
})

test('one long line with no line break keeps the hard 1,500 cut', () => {
  const brain = fixture()
  put(brain, 'one-line.md', 'z'.repeat(3000))
  const pack = packPaths(brain, ['one-line.md'], 'why')
  assert.equal(pack.files[0].excerpt, 'z'.repeat(PACK_MAX_EXCERPT))
})

test('a file of exactly 1,500 characters is kept whole', () => {
  const brain = fixture()
  const body = `${'w'.repeat(PACK_MAX_EXCERPT - 1)}\n`
  put(brain, 'exact.md', body)
  assert.equal(packPaths(brain, ['exact.md'], 'why').files[0].excerpt, body)
})

test('a ninth readable file is dropped; missing files do not use up the eight', () => {
  const brain = fixture()
  const nine = Array.from({ length: 9 }, (_, i) => `notes/n${i + 1}.md`)
  for (const p of nine) put(brain, p, `${p}\n`)
  const pack = packPaths(brain, ['gone-1.md', ...nine.slice(0, 4), 'gone-2.md', ...nine.slice(4)], 'why')
  assert.equal(pack.files.length, PACK_MAX_FILES)
  assert.deepEqual(pack.files.map((f) => f.path), nine.slice(0, 8))
  assert.deepEqual(pack.dropped, ['gone-1.md', 'gone-2.md', 'notes/n9.md'])
})

test('an absolute path inside the brain is read and reported brain-relative', () => {
  const brain = fixture()
  const pack = packPaths(brain, [join(brain, 'clients/summit/notes.md')], 'why')
  assert.deepEqual(pack.files.map((f) => f.path), ['clients/summit/notes.md'])
  assert.deepEqual(pack.dropped, [])
})

test('the pack records why, and no paths is an empty pack', () => {
  const brain = fixture()
  assert.deepEqual(packPaths(brain, [], 'Joe wants the September recap.'), { why: 'Joe wants the September recap.', files: [], dropped: [] })
})

test('a brain folder that does not exist drops every path', () => {
  const brain = join(tmpdir(), 'desk-pack-nope', String(Date.now()))
  assert.deepEqual(packPaths(brain, ['notes.md'], 'why'), { why: 'why', files: [], dropped: ['notes.md'] })
})
