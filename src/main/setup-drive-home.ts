import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'

if (process.env.BRAIN_APP_SETUP_DRIVE === '1') {
  app.setPath('userData', mkdtempSync(join(tmpdir(), 'brain-setup-drive-')))
}
