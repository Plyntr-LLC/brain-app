// Counts tests and asserts in every unit test file, so a cleanup can show what it removed.
// node scripts/audit/count-tests.mjs > out.json
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', 'src', 'scripts'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.test\.(ts|cjs|mjs|js)$/.test(f) && existsSync(f))
const out = {}
for (const f of files) {
  const src = readFileSync(f, 'utf8')
  const names = [...src.matchAll(/^\s*test\((['"`])(.*?)\1/gm)].map((m) => m[2])
  out[f] = { tests: names.length, asserts: (src.match(/\bassert\.\w+\(/g) || []).length, names }
}
console.log(JSON.stringify(out, null, 1))
