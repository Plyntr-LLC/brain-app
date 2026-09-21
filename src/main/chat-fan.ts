import { BrowserWindow } from 'electron'
import type { StreamEvent } from './ai-cli'
import { captureEvent, skinHint } from './skin/capture'
import { chatTransport } from './phone-lib'

export type ChatFanPayload = {
  tabId: string
  kind: string
  data?: string
  path?: string
  tool?: string
  used?: number
  total?: number
  percent?: number
  commands?: { name: string; description: string; hint?: string }[]
  title?: string
  options?: { id: string; label: string }[]
  requestId?: string
  steps?: { title: string; status?: string }[]
  fingerprint?: string
  skinLabel?: string | null
}

type Fan = (ev: ChatFanPayload) => void
const extra: Fan[] = []
const busyTabs = new Set<string>()

export function addChatFan(fn: Fan): () => void {
  extra.push(fn)
  return () => {
    const i = extra.indexOf(fn)
    if (i >= 0) extra.splice(i, 1)
  }
}

export function markChatBusy(tabId: string, on: boolean): void {
  if (on) busyTabs.add(tabId)
  else busyTabs.delete(tabId)
}

export function isChatBusy(tabId: string): boolean {
  return busyTabs.has(tabId)
}

export function busyMap(): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const id of busyTabs) out[id] = true
  return out
}

export function emitChat(opts: {
  tabId: string
  cli: string
  sessionId?: string
  ev: StreamEvent
}): ChatFanPayload {
  const transport = chatTransport(opts.cli)
  captureEvent({
    cli: opts.cli,
    sessionId: opts.sessionId || opts.tabId,
    ev: opts.ev,
    transport
  })
  const hint = skinHint({ cli: opts.cli, ev: opts.ev })
  const payload: ChatFanPayload = {
    tabId: opts.tabId,
    ...opts.ev,
    fingerprint: hint.fingerprint,
    skinLabel: hint.label
  }
  if (opts.ev.kind === 'done' || opts.ev.kind === 'error') markChatBusy(opts.tabId, false)
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('chat:event', payload)
  }
  for (const fn of extra) fn(payload)
  return payload
}

export function sendIncoming(
  tabId: string,
  text: string,
  extra?: {
    files?: { path: string; name: string; mime: string }[]
    queued?: boolean
    queueId?: string
  }
): void {
  const payload = {
    tabId,
    text,
    files: extra?.files || [],
    queued: Boolean(extra?.queued),
    queueId: extra?.queueId || ''
  }
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('phone:incoming', payload)
  }
}

export function sendPhoneTab(ev: { op: 'new' | 'close'; id: string; kind?: string }): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('phone:tab', ev)
  }
}

export function sendPhoneStop(tabId: string): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('phone:stop', { tabId })
  }
}

export function sendPhoneQueue(ev: { op: 'drop' | 'now'; tabId: string; id: string }): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('phone:queue', ev)
  }
}
