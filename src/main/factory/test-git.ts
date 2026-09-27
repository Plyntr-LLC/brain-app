import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Test helper: tmp git repos isolated from this Mac's git config (no signing, no hooks path).
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

export function sh(cwd: string, args: string[]): string {
  return execFileSync('/usr/bin/git', ['-c', 'user.name=Factory Test', '-c', 'user.email=factory@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

export function tmpRepo(prefix: string, files: Record<string, string> = { 'README.md': 'hello\n' }): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  sh(dir, ['init', '-q', '-b', 'main'])
  sh(dir, ['config', 'user.name', 'Factory Test'])
  sh(dir, ['config', 'user.email', 'factory@example.com'])
  sh(dir, ['config', 'commit.gpgsign', 'false'])
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  sh(dir, ['add', '-A'])
  sh(dir, ['commit', '-q', '-m', 'init'])
  return dir
}
