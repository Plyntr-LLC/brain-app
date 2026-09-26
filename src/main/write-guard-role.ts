import { roleForBrainWriteFromVault } from './shell-vault'

/** Seat role Brain.app file helpers use: the key this shell holds on that brain. Empty when there is none, and the guard then refuses protected paths. */
export function roleForBrainWrite(brainId: string): string {
  return roleForBrainWriteFromVault(brainId)
}
