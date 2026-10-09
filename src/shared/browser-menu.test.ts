import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addressFor } from './browser-menu.ts'

test('the address field: web addresses open, words search, other schemes open nothing', () => {
  const cases: [string, string | null][] = [
    ['example.com', 'https://example.com/'],
    ['example.com:8443/a', 'https://example.com:8443/a'],
    ['example.com?q=1', 'https://example.com/?q=1'],
    ['example.com#x', 'https://example.com/#x'],
    ['localhost:3000?a=b', 'http://localhost:3000/?a=b'],
    ['https://a.example/b', 'https://a.example/b'],
    ['localhost:3000', 'http://localhost:3000/'],
    ['127.0.0.1:8080', 'http://127.0.0.1:8080/'],
    ['192.168.1.5', 'http://192.168.1.5/'],
    ['Re: meeting notes', 'https://www.google.com/search?q=Re%3A%20meeting%20notes'],
    ['plain words', 'https://www.google.com/search?q=plain%20words'],
    ['javascript:alert(1)', null],
    ['JAVASCRIPT:alert(1)', null],
    ['file:///etc/hosts', null],
    ['data:text/html,x', null],
    ['myapp://x', null],
    ['', null]
  ]
  for (const [typed, want] of cases) assert.equal(addressFor(typed), want, typed)
})
