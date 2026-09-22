import { cpSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const dest = join(homedir(), 'Projects', 'plyntr-fixture-brain')
const src = join(process.cwd(), 'resources/fixtures/plyntr-brain')
mkdirSync(dest, { recursive: true })
cpSync(src, dest, { recursive: true })
spawnSync('git', ['init'], { cwd: dest, stdio: 'ignore' })
spawnSync('git', ['remote', 'remove', 'origin'], { cwd: dest, stdio: 'ignore' })
spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/plyntr-fixture/plyntr-fixture-brain.git'], {
  cwd: dest,
  stdio: 'ignore'
})
console.log(dest)
