export type LivePassphraseWrap = {
  salt?: string
  N?: number
  r?: number
  p?: number
  wrap?: string
  nonce?: string
  ciphertext?: string
  tag?: string
}

const HEX = /^(?:[0-9a-f]{2})*$/i

function hex(value: unknown): string {
  const text = String(value || '').trim()
  return HEX.test(text) ? text : ''
}

// Reclaim/start returns the sealed brain key as one `wrap` hex (nonce||ciphertext||tag, the Mac format)
// or as separate nonce, ciphertext, and tag hex. Both become the sealed blob unwrapBrainKeyWithPassphrase opens.
export function sealedPassphraseWrap(wrap: LivePassphraseWrap | null | undefined): Buffer {
  if (!wrap || typeof wrap !== 'object') return Buffer.alloc(0)
  const combined = hex(wrap.wrap)
  if (combined) return Buffer.from(combined, 'hex')
  const nonce = hex(wrap.nonce)
  const ciphertext = hex(wrap.ciphertext)
  const tag = hex(wrap.tag)
  if (!nonce || !tag) return Buffer.alloc(0)
  return Buffer.from(nonce + ciphertext + tag, 'hex')
}
