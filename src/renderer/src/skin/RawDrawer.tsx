import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export function RawDrawer({
  id,
  cwd,
  open,
  onHide
}: {
  id: string
  cwd: string
  open: boolean
  onHide: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!open || !host.current) return
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      theme: { background: '#1a1612', foreground: '#f3eee8', cursor: '#f0810e' }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current)
    fit.fit()
    termRef.current = term
    fitRef.current = fit
    let live = true
    const ptyId = 'skin-raw-' + id
    void window.brain.pty.create({ id: ptyId, cwd, cols: term.cols, rows: term.rows, shell: true })
    const offData = window.brain.pty.onData((ev) => {
      if (live && ev.id === ptyId) term.write(ev.data)
    })
    const offExit = window.brain.pty.onExit((ev) => {
      if (live && ev.id === ptyId) term.write(`\r\n[session ended ${ev.exitCode}]\r\n`)
    })
    const sub = term.onData((data) => {
      if (live) void window.brain.pty.write(ptyId, data)
    })
    const onResize = () => {
      try {
        fit.fit()
        void window.brain.pty.resize(ptyId, term.cols, term.rows)
      } catch {
        /* */
      }
    }
    window.addEventListener('resize', onResize)
    const ro = new ResizeObserver(onResize)
    ro.observe(host.current)
    return () => {
      live = false
      offData()
      offExit()
      sub.dispose()
      window.removeEventListener('resize', onResize)
      ro.disconnect()
      void window.brain.pty.kill(ptyId)
      term.dispose()
      termRef.current = null
    }
  }, [open, id, cwd])

  if (!open) return null
  return (
    <div className="skin-raw">
      <div className="skin-raw-bar">
        <span>Raw · the real CLI TUI on this folder</span>
        <button type="button" className="linkish" onClick={onHide}>
          hide
        </button>
      </div>
      <div className="skin-raw-host" ref={host} />
    </div>
  )
}
