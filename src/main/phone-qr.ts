import QRCode from 'qrcode'

export function phoneQrSvg(text: string): string {
  const raw = String(text || '')
  if (!raw) return ''
  const qr = QRCode.create(raw, { errorCorrectionLevel: 'M' })
  const n = qr.modules.size
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" aria-hidden="true">`
  ]
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (qr.modules.get(y, x)) parts.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`)
    }
  }
  parts.push('</svg>')
  return parts.join('')
}
