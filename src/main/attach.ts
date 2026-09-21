import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'

export type Attach = { path: string; name: string; mime: string }

export const MAX_ATTACH = 20 * 1024 * 1024

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.caf': 'audio/x-caf'
}

export function guessMime(name: string, fallback = 'application/octet-stream'): string {
  return MIME[extname(name).toLowerCase()] || fallback
}

function mimeOf(a: Attach): string {
  if (a.mime && a.mime !== 'application/octet-stream') return a.mime
  return guessMime(a.name, a.mime || 'application/octet-stream')
}

export function isImage(a: Attach): boolean {
  const mime = mimeOf(a)
  return mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|heic)$/i.test(a.name)
}

function claudeImage(a: Attach): boolean {
  const mime = mimeOf(a)
  return /image\/(png|jpe?g|gif|webp)/i.test(mime) || /\.(png|jpe?g|gif|webp)$/i.test(a.name)
}

function isPdf(a: Attach): boolean {
  return mimeOf(a) === 'application/pdf' || /\.pdf$/i.test(a.name)
}

function texty(a: Attach): boolean {
  const mime = mimeOf(a)
  return /^(text\/|application\/json)/.test(mime) || /\.(md|txt|csv|json|html|htm)$/i.test(a.name)
}

function usable(a: Attach): boolean {
  try {
    return existsSync(a.path) && statSync(a.path).isFile()
  } catch {
    return false
  }
}

function tooBig(a: Attach): boolean {
  try {
    return statSync(a.path).size > MAX_ATTACH
  } catch {
    return true
  }
}

function readB64(path: string): string {
  const st = statSync(path)
  if (st.size > MAX_ATTACH) throw new Error(`${basename(path)} is larger than 20 MB`)
  return readFileSync(path).toString('base64')
}

function unzipInner(path: string, inner: string): string {
  return execFileSync('unzip', ['-p', path, inner], {
    encoding: 'utf8',
    maxBuffer: 2_000_000,
    timeout: 8000
  })
}

function stripXml(xml: string): string {
  return xml
    .replace(/<w:p[ >]/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, 80_000)
}

function pdfText(a: Attach): string {
  if (!isPdf(a)) return ''
  try {
    return execFileSync('pdftotext', ['-layout', a.path, '-'], {
      encoding: 'utf8',
      maxBuffer: 2_000_000,
      timeout: 8000
    }).slice(0, 80_000)
  } catch {
    return ''
  }
}

function officeText(a: Attach): string {
  const ext = extname(a.name).toLowerCase()
  if (!['.docx', '.doc', '.rtf', '.xlsx', '.xls'].includes(ext)) return ''
  try {
    if (process.platform === 'darwin' && ext !== '.xlsx' && ext !== '.xls') {
      return execFileSync('textutil', ['-convert', 'txt', '-stdout', a.path], {
        encoding: 'utf8',
        maxBuffer: 2_000_000,
        timeout: 8000
      }).slice(0, 80_000)
    }
    if (ext === '.docx') return stripXml(unzipInner(a.path, 'word/document.xml'))
    if (ext === '.xlsx') return stripXml(unzipInner(a.path, 'xl/sharedStrings.xml'))
  } catch {
    return ''
  }
  return ''
}

export function asAttachBuf(bytes: unknown): Buffer {
  if (Buffer.isBuffer(bytes)) return bytes
  if (bytes instanceof Uint8Array) return Buffer.from(bytes)
  if (ArrayBuffer.isView(bytes)) {
    const v = bytes as ArrayBufferView
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
  }
  if (Array.isArray(bytes)) return Buffer.from(bytes as number[])
  if (bytes && typeof bytes === 'object' && Array.isArray((bytes as { data?: unknown }).data)) {
    return Buffer.from((bytes as { data: number[] }).data)
  }
  throw new Error('Could not read that file.')
}

export function stashBytes(name: string, bytes: Buffer, mime: string): Attach {
  if (bytes.length > MAX_ATTACH) throw new Error('That file is larger than 20 MB.')
  const dir = join(app.getPath('userData'), 'drops')
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, `${Date.now()}-${basename(name).replace(/[^\w.\-]+/g, '_')}`)
  writeFileSync(dest, bytes)
  return { path: dest, name: basename(name) || 'drop', mime: mime || guessMime(name) }
}

export function inspectAttach(path: string): { file?: Attach; skip?: string } {
  try {
    const st = statSync(path)
    if (!st.isFile()) return { skip: `${basename(path)} is a folder` }
    if (st.size > MAX_ATTACH) return { skip: `${basename(path)} is larger than 20 MB` }
    return { file: { path, name: basename(path), mime: guessMime(path) } }
  } catch {
    return { skip: `${basename(path)} could not be read` }
  }
}

function listLine(files: Attach[]): string {
  if (!files.length) return ''
  return '\n\nAttached:\n' + files.map((f) => `- ${f.name} (${f.path})`).join('\n')
}

function inlineText(files: Attach[]): string {
  let out = ''
  for (const f of files) {
    if (!usable(f) || tooBig(f)) continue
    if (texty(f)) {
      out += `\n\n--- ${f.name} ---\n` + readFileSync(f.path, 'utf8').slice(0, 80_000)
      continue
    }
    const extracted = officeText(f) || pdfText(f)
    if (extracted) out += `\n\n--- ${f.name} ---\n` + extracted
  }
  return out
}

function notesFor(files: Attach[]): string {
  let notes = ''
  for (const f of files) {
    if (!usable(f)) notes += `\nMissing file: ${f.name}`
    else if (tooBig(f)) notes += `\n${f.name} is larger than 20 MB.`
  }
  return notes
}

export function acpPromptParts(text: string, files: Attach[]): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [
    { type: 'text', text: (text || 'Look at the attached files.') + listLine(files) + notesFor(files) }
  ]
  for (const f of files) {
    if (!usable(f) || tooBig(f)) continue
    try {
      const uri = pathToFileURL(f.path).href
      const mime = mimeOf(f)
      if (isImage(f)) {
        parts.push({ type: 'image', mimeType: mime || 'image/png', data: readB64(f.path), uri })
        continue
      }
      if (texty(f)) {
        parts.push({
          type: 'resource',
          resource: { uri, mimeType: mime, text: readFileSync(f.path, 'utf8').slice(0, 200_000) }
        })
        continue
      }
      const extracted = officeText(f) || pdfText(f)
      if (extracted) {
        parts.push({
          type: 'resource',
          resource: { uri: uri + '#text', mimeType: 'text/plain', text: extracted }
        })
      }
      parts.push({
        type: 'resource',
        resource: { uri, mimeType: mime, blob: readB64(f.path) }
      })
    } catch {
      parts.push({ type: 'text', text: `\nCould not load ${f.name} at ${f.path}.` })
    }
  }
  return parts
}

export function claudeContent(text: string, files: Attach[]): Record<string, unknown>[] {
  const content: Record<string, unknown>[] = [
    { type: 'text', text: (text || 'Look at the attached files.') + listLine(files) + notesFor(files) + inlineText(files) }
  ]
  for (const f of files) {
    if (!usable(f) || tooBig(f)) continue
    try {
      if (claudeImage(f)) {
        const media = mimeOf(f).startsWith('image/') ? mimeOf(f) : guessMime(f.name, 'image/png')
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: media, data: readB64(f.path) }
        })
        continue
      }
      if (isPdf(f)) {
        content.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: readB64(f.path) }
        })
      }
    } catch {
      /* path and extracted text still in the text block */
    }
  }
  return content
}

export function codexInput(text: string, files: Attach[]): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = [
    { type: 'text', text: (text || 'Look at the attached files.') + listLine(files) + notesFor(files) + inlineText(files) }
  ]
  for (const f of files) {
    if (!usable(f) || tooBig(f)) continue
    if (isImage(f)) input.push({ type: 'localImage', path: f.path })
    else input.push({ type: 'mention', name: f.name, path: f.path })
  }
  return input
}
