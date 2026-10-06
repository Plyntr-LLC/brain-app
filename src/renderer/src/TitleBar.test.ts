import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('the app window draws its top row through TitleBar', () => {
  const src = readFileSync(new URL('./FirstRun.tsx', import.meta.url), 'utf8')
  assert.match(src, /<TitleBar\b/)
  assert.doesNotMatch(src, /className="titlebar"/)
})
