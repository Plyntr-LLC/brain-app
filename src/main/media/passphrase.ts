import { randomBytes } from 'node:crypto'
import { PASSPHRASE_SHORT_FAIL } from './keys.ts'
import { EFF_WORDS } from './eff-words.ts'

const COMMON = new Set(
  [
    'password',
    'passwordpassword',
    '1234567890123456',
    'qwertyuiopasdfgh',
    'letmeinletmein12',
    'iloveyouiloveyou',
    'adminadminadmin1',
    'welcomewelcome12',
    'abc123abc123abc1',
    'passw0rdpassw0rd',
    'footballfootball',
    'baseballbaseball',
    'monkeymonkeymonk',
    'dragonflydragon1',
    'sunshineSunshine',
    'princessprincess',
    'trustno1trustno1',
    'starwarsstarwars',
    'whateverwhatever',
    'mastermastermast'
  ].map((w) => w.toLowerCase())
)

export const PASSPHRASE_COMMON_FAIL = 'Choose a passphrase that is not a common password.'

export function generatePassphrase(): string {
  const n = EFF_WORDS.length
  const limit = Math.floor(0x10000 / n) * n
  const words: string[] = []
  while (words.length < 6) {
    const r = randomBytes(2).readUInt16BE(0)
    if (r >= limit) continue
    words.push(EFF_WORDS[r % n])
  }
  const phrase = words.join(' ')
  if (phrase.length < 16) return generatePassphrase()
  return phrase
}

export function assertPassphrase(raw: string): string {
  const pass = String(raw || '')
  if (pass.length < 16) throw new Error(PASSPHRASE_SHORT_FAIL)
  if (COMMON.has(pass.toLowerCase())) throw new Error(PASSPHRASE_COMMON_FAIL)
  return pass
}
