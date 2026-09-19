import assert from 'node:assert/strict'
import test from 'node:test'
import { grokAcpArgs, grokLeaderSocket, grokTuiArgs } from './grok-args.ts'

test('isolated socket is not the default grok leader.sock', () => {
  const sock = grokLeaderSocket()
  assert.match(sock, /leader-brain-app\.sock$/)
  assert.equal(sock.includes('leader.sock') && !sock.includes('leader-brain-app.sock'), false)
})

test('ACP args use custom socket when leader is up', () => {
  const args = grokAcpArgs('/tmp/lab', true)
  assert.equal(args.includes('--no-leader'), false)
  assert.ok(args.includes('--leader'))
  assert.ok(args.includes('--leader-socket'))
  assert.ok(args.includes(grokLeaderSocket()))
  assert.equal(args.at(-1), 'stdio')
})

test('ACP args stay --no-leader if leader did not start', () => {
  const args = grokAcpArgs('/tmp/lab', false)
  assert.ok(args.includes('--no-leader'))
  assert.equal(args.includes('--leader'), false)
})

test('TUI args resume a session on the isolated socket', () => {
  const args = grokTuiArgs('/tmp/lab', 'sess-1', true)
  assert.ok(args.includes('--leader'))
  assert.ok(args.includes('--leader-socket'))
  assert.ok(args.includes('--resume'))
  assert.ok(args.includes('sess-1'))
  assert.equal(args.includes('-l'), false)
})

test('TUI without resume still uses the isolated leader', () => {
  const args = grokTuiArgs('/tmp/lab', undefined, true)
  assert.ok(args.includes('--leader'))
  assert.ok(args.includes('--leader-socket'))
  assert.equal(args.includes('--resume'), false)
  assert.equal(args.includes('--no-leader'), false)
})

test('TUI stays --no-leader if the isolated leader did not start', () => {
  const args = grokTuiArgs('/tmp/lab', undefined, false)
  assert.ok(args.includes('--no-leader'))
  assert.equal(args.includes('--leader'), false)
  assert.equal(args.includes('--resume'), false)
})
