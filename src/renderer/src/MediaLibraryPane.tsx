import { useEffect, useRef, useState } from 'react'
import { MEDIA_LIBRARY_FAIL, type MediaLibraryFile, type MediaLibraryResult } from '../../shared/media'

// See files starts the first load and hands it here, so opening the tab does not ask twice.
const primed = new Map<string, Promise<MediaLibraryResult>>()

export function primeMediaLibrary(folder: string, load: Promise<MediaLibraryResult>): void {
  primed.set(folder, load)
}

function takePrimed(folder: string): Promise<MediaLibraryResult> | undefined {
  const hit = primed.get(folder)
  primed.delete(folder)
  return hit
}

function kindOf(mime: string): string {
  const m = String(mime || '').toLowerCase()
  if (m.startsWith('video/')) return 'Video'
  if (m.startsWith('image/')) return 'Image'
  if (m.startsWith('audio/')) return 'Audio'
  if (m === 'application/pdf') return 'PDF'
  return 'File'
}

function sizeOf(n: number): string {
  if (!Number.isFinite(n) || n < 0) return ''
  if (n < 1024) return `${Math.round(n)} B`
  const kb = n / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${Math.round(mb)} MB`
  return `${Math.round((mb / 1024) * 10) / 10} GB`
}

function dayOf(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  return new Date(t).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function folderOf(root: string): string {
  return String(root || '').replace(/\/+$/, '')
}

/** Only an image row gets a picture. Anything else stays text until it is opened. */
function LibraryPicture({ row }: { row: MediaLibraryFile }) {
  if (!row.mime.startsWith('image/')) return null
  return <img className="medialib-pic" src={`brain-media://${row.id}`} alt="" loading="lazy" draggable={false} />
}

export function MediaLibraryPane({
  folder,
  askSeq,
  onOpen
}: {
  folder: string
  /** Bumped by each See files click, so a list it started is taken up even when this tab is already open. */
  askSeq?: number
  onOpen: (row: MediaLibraryFile) => void
}) {
  const [files, setFiles] = useState<MediaLibraryFile[] | null>(null)
  const [line, setLine] = useState('')
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)
  const shown = useRef('')

  async function load(first?: Promise<MediaLibraryResult>) {
    const mine = ++seq.current
    setBusy(true)
    try {
      const res = await (first || window.brain.media.library({ folder }))
      if (mine !== seq.current) return
      if (res.ok) {
        setFiles(res.files)
        setLine('')
      } else setLine(res.detail || MEDIA_LIBRARY_FAIL)
    } catch {
      if (mine === seq.current) setLine(MEDIA_LIBRARY_FAIL)
    } finally {
      if (mine === seq.current) setBusy(false)
    }
  }

  useEffect(() => {
    if (shown.current !== folder) {
      shown.current = folder
      setFiles(null)
      setLine('')
    }
    void load(takePrimed(folder))
  }, [folder, askSeq])

  return (
    <>
      <div className="filetab-head">
        Stored files
        <span className="filetab-actions">
          <button type="button" disabled={busy} onClick={() => void load()}>
            {busy ? 'Loading…' : 'Refresh'}
          </button>
        </span>
      </div>
      {line ? <p className="note">{line}</p> : null}
      <div className="filemedia">
        {files && files.length === 0 ? <p className="tiny">No stored files yet.</p> : null}
        {files && files.length ? (
          <table className="medialib">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Size</th>
                <th>Date</th>
                <th>Folder</th>
              </tr>
            </thead>
            <tbody>
              {files.map((row) => (
                <tr key={row.id} tabIndex={0} onClick={() => onOpen(row)} onKeyDown={(e) => e.key === 'Enter' && onOpen(row)}>
                  <td className="medialib-name">
                    <LibraryPicture row={row} />
                    <span>{row.title || 'Untitled'}</span>
                  </td>
                  <td>{kindOf(row.mime)}</td>
                  <td>{sizeOf(row.bytes)}</td>
                  <td>{dayOf(row.createdAt)}</td>
                  <td>{folderOf(row.root)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </>
  )
}
