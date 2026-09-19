import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { AiKind } from '@shared/contracts'
import { extractFiles, stripAnsi, type FileHit } from '../ptyChat'

export function skinPtyId(tabId: string): string {
  return 'skin-tui-' + tabId
}

const THEME = {
  background: '#1a1612',
  foreground: '#f3eee8',
  cursor: '#f0810e',
  black: '#1a1612',
  red: '#c45f00',
  green: '#2c6e3a',
  yellow: '#f0810e',
  blue: '#5c534a',
  magenta: '#8a5a12',
  cyan: '#5c534a',
  white: '#f3eee8'
}

export function SkinTerm({
  id,
  cwd,
  kind,
  visible,
  interactive,
  onFiles
}: {
  id: string
  cwd: string
  kind: AiKind
  visible: boolean
  interactive: boolean
  onFiles: (hits: FileHit[], live: boolean) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const visibleRef = useRef(visible)
  const interactiveRef = useRef(interactive)
  const onFilesRef = useRef(onFiles)
  visibleRef.current = visible
  interactiveRef.current = interactive
  onFilesRef.current = onFiles

  useEffect(() => {
    if (!host.current) return
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      theme: THEME,
      allowProposedApi: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current)
    fit.fit()
    termRef.current = term
    fitRef.current = fit
    let live = true
    const ptyId = skinPtyId(id)
    let idle: ReturnType<typeof setTimeout> | undefined
    const offData = window.brain.pty.onData((ev) => {
      if (!live || ev.id !== ptyId) return
      term.write(ev.data)
      if (interactiveRef.current) term.scrollToBottom()
      const hits = extractFiles(cwd, stripAnsi(ev.data))
      if (hits.length) onFilesRef.current(hits, true)
      if (idle) clearTimeout(idle)
      idle = setTimeout(() => onFilesRef.current([], false), 1200)
    })
    const offExit = window.brain.pty.onExit((ev) => {
      if (live && ev.id === ptyId) term.write(`\r\n[session ended ${ev.exitCode}]\r\n`)
    })
    const sub = term.onData((data) => {
      if (live && interactiveRef.current) void window.brain.pty.write(ptyId, data)
    })
    const onResize = () => {
      if (!visibleRef.current) return
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
      if (idle) clearTimeout(idle)
      offData()
      offExit()
      sub.dispose()
      window.removeEventListener('resize', onResize)
      ro.disconnect()
      void window.brain.pty.kill(ptyId)
      term.dispose()
      termRef.current = null
    }
  }, [id, cwd, kind])

  useEffect(() => {
    if (!interactive) return
    const term = termRef.current
    if (!term) return
    const ptyId = skinPtyId(id)
    let live = true
    void window.brain.pty
      .create({
        id: ptyId,
        cwd,
        kind,
        cols: term.cols,
        rows: term.rows
      })
      .catch((err: unknown) => {
        if (live) term.write('\r\n' + String((err as Error).message || err) + '\r\n')
      })
    return () => {
      live = false
    }
  }, [interactive, id, cwd, kind])

  useEffect(() => {
    if (!visible) return
    const t = setTimeout(() => {
      try {
        fitRef.current?.fit()
        const term = termRef.current
        if (term) void window.brain.pty.resize(skinPtyId(id), term.cols, term.rows)
        if (interactive) {
          term?.scrollToBottom()
          term?.focus()
        }
      } catch {
        /* */
      }
    }, 30)
    return () => clearTimeout(t)
  }, [visible, interactive, id])

  return <div className="skin-term-host" ref={host} />
}
