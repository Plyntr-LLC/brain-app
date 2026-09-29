import { createHash } from 'node:crypto'

export type Split = 'train' | 'holdout'

/** Fixed by the case id alone: one in five cases is held out, the same ones every run, in any order. */
export function splitOf(id: string): Split {
  const n = createHash('sha1').update(String(id)).digest().readUInt32BE(0)
  return n % 5 === 0 ? 'holdout' : 'train'
}
