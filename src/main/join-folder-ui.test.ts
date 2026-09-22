import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...filesUnder(path))
    else if (/\.(tsx|ts)$/.test(name)) out.push(path)
  }
  return out
}

test('renderer does not call auth joinFolder', () => {
  const root = join(process.cwd(), 'src/renderer')
  const hits = filesUnder(root).filter((path) => {
    const text = readFileSync(path, 'utf8')
    return text.includes('joinFolder') || text.includes('auth:joinFolder')
  })
  assert.deepEqual(hits, [])
})
