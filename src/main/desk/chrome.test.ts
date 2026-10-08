import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { BROWSE_MAX_CONTROLS, BROWSE_TEXT_CHARS } from '../../shared/desk.ts'
import { pageSnapshot } from './chrome.ts'

/** 400 numbered lines, about 18,000 characters. */
const BODY = Array.from({ length: 400 }, (_, i) => `Line ${String(i + 1).padStart(3, '0')} of the Summit page, plain words.`).join('\n')
const CONTROLS = ['link Pricing', 'field Search', 'button Search', 'button Pay now']

test('the evaluate body: scrollY 0 is the top, cut at 8,000 on a line break; a later scrollY starts on a whole line', () => {
  const doc = { bodyText: BODY, controls: CONTROLS, hasPassword: false, scrollY: 0 }
  const top = pageSnapshot(doc, BROWSE_TEXT_CHARS, BROWSE_MAX_CONTROLS)
  assert.ok(top.text.length <= BROWSE_TEXT_CHARS && top.text.length > BROWSE_TEXT_CHARS - 80)
  assert.equal(top.text, BODY.slice(0, top.text.length))
  assert.equal(BODY[top.text.length], '\n')
  assert.deepEqual(top.controls, CONTROLS)
  assert.equal(top.hasPassword, false)
  assert.equal(top.title, '')

  const mid = pageSnapshot({ ...doc, scrollY: 9000 }, BROWSE_TEXT_CHARS, BROWSE_MAX_CONTROLS)
  assert.match(mid.text, /^Line \d{3} of the Summit page/)
  assert.ok(BODY.includes(mid.text))
  assert.ok(BODY.indexOf(mid.text) <= 9000 && BODY.indexOf(mid.text) > 9000 - 60)

  const end = pageSnapshot({ ...doc, scrollY: BODY.length + 500 }, BROWSE_TEXT_CHARS, BROWSE_MAX_CONTROLS)
  assert.equal(end.text, 'Line 400 of the Summit page, plain words.')
})

test('the evaluate body keeps at most 40 controls, in order', () => {
  const many = Array.from({ length: 55 }, (_, i) => `link Note ${i + 1}`)
  const got = pageSnapshot({ bodyText: 'short', controls: many, hasPassword: true, scrollY: 0 }, BROWSE_TEXT_CHARS, BROWSE_MAX_CONTROLS)
  assert.equal(got.controls.length, BROWSE_MAX_CONTROLS)
  assert.equal(got.controls[0], 'link Note 1')
  assert.equal(got.controls[39], 'link Note 40')
  assert.equal(got.hasPassword, true)
  assert.equal(got.text, 'short')
})

test('nothing in the browser path imports puppeteer', () => {
  for (const file of ['chrome.ts', 'browser.ts', 'inapp.ts', '../shared-browser.ts']) {
    const src = readFileSync(join(import.meta.dirname, file), 'utf8')
    assert.doesNotMatch(src, /from\s+['"]puppeteer|require\(\s*['"]puppeteer|import\(\s*['"]puppeteer/, file)
  }
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf8'))
  assert.equal('puppeteer-core' in { ...pkg.dependencies, ...pkg.devDependencies }, false)
})
