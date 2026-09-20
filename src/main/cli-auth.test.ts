import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('cliSignedIn grok is existsSync on ~/.grok/auth.json, never a file read', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'cli-auth.ts'), 'utf8')
  assert.match(src, /existsSync\(join\(homedir\(\), ['"]\.grok['"], ['"]auth\.json['"]\)\)/)
  assert.equal(/readFileSync|readFile\(/.test(src), false)
})
