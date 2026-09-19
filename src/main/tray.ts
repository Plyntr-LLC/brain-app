import { crc32, deflateSync } from 'node:zlib'
import { BrowserWindow, Menu, Tray, app, nativeImage } from 'electron'
import { readSyncHealth, type SyncHealth } from './sync-health'

const ORANGE = [0xf0, 0x81, 0x0e] as const
const GREY = [0x9a, 0x90, 0x86] as const

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const head = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(head) >>> 0, 0)
  return Buffer.concat([len, head, crc])
}

function pngCircle(rgb: readonly [number, number, number], size: number): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  const cx = (size - 1) / 2
  const r = size * 0.38
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1)
    raw[row] = 0
    for (let x = 0; x < size; x++) {
      const dx = x - cx
      const dy = y - cx
      const on = dx * dx + dy * dy <= r * r
      const i = row + 1 + x * 4
      raw[i] = rgb[0]
      raw[i + 1] = rgb[1]
      raw[i + 2] = rgb[2]
      raw[i + 3] = on ? 255 : 0
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function light(ok: boolean) {
  return nativeImage.createFromBuffer(pngCircle(ok ? ORANGE : GREY, 32), { scaleFactor: 2 })
}

let tray: Tray | null = null

export function startTray(getWin: () => BrowserWindow | null): void {
  if (tray) return
  tray = new Tray(light(false))
  tray.setToolTip('Brain')
  const show = () => {
    const win = getWin()
    if (!win || win.isDestroyed()) return
    win.show()
    win.focus()
  }
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Brain', click: show },
      { type: 'separator' },
      {
        label: 'Quit Brain',
        click: () => {
          app.quit()
        }
      }
    ])
  )
  tray.on('click', show)
}

export function paintTray(health: SyncHealth): void {
  if (!tray) return
  tray.setImage(light(health.ok))
  tray.setToolTip(health.line)
}

export async function refreshTray(): Promise<SyncHealth> {
  const health = await readSyncHealth()
  paintTray(health)
  return health
}
