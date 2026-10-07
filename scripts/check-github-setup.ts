import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(here, '..')

if (process.argv.includes('--dry-run')) {
  process.stdout.write('GITHUB_SETUP_DRY_RUN\n')
  process.exit(0)
}

const mod = await import(pathToFileURL(resolve(here, '../../brain-sync/scripts/github-setup-check.js')).href)
const result = await mod.runGithubSetupCheck({ appRoot })
if (result.ok) {
  process.stdout.write('GITHUB_SETUP_PASS\n')
  process.exit(0)
}
process.stderr.write(`${result.failures.join('\n')}\n`)
process.exit(1)
