// An Electron-level stand-in for the browser inside Brain: BaseWindow, WebContentsView, session, webContents.
// src/main/desk/shared-browser.test.ts and scripts/render-ui/shared-browser.tsx append this to their electron stub,
// so the real inapp.ts adapter runs on it. State lives on globalThis.__browserFake, which each harness creates.
const fake = globalThis.__browserFake

function picture(bytes, width, height) {
  return {
    isEmpty: () => !bytes || !bytes.length,
    getSize: () => ({ width, height }),
    resize: (o) => {
      fake.resized.push({ from: { width, height }, to: { width: o.width, height: o.height } })
      return picture(bytes, o.width, o.height)
    },
    toJPEG: () => bytes
  }
}

class FakeContents {
  constructor() {
    this.windowId = fake.nextId++
    this.id = this.windowId
    this._url = 'about:blank'
    this._closed = false
    this._on = {}
    const self = this
    this.debugger = {
      attach() {},
      isAttached: () => true,
      sendCommand: (method, params) => self._cdp(method, params || {})
    }
    fake.pages.push(this)
  }
  loadURL(url) {
    if (url === 'about:blank') return Promise.resolve()
    fake.entered.push(url)
    const finish = () => {
      this._url = url
      fake.url = url
    }
    if (!fake.holdGoto) {
      finish()
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      fake.holds.push({ url, page: this, release() { finish(); resolve() } })
    })
  }
  getURL() { return this._url }
  isLoading() { return false }
  on(ev, fn) { (this._on[ev] = this._on[ev] || []).push(fn) }
  once(ev, fn) { this.on(ev, fn) }
  off(ev, fn) { this._on[ev] = (this._on[ev] || []).filter((f) => f !== fn) }
  executeJavaScript(code) {
    if (code.includes('pageSnapshot')) {
      return Promise.resolve({ title: fake.title || 'Example', text: 'hello', controls: ['link Pricing'], hasPassword: false })
    }
    if (code.includes('scrollIntoView')) return Promise.resolve({ x: 10, y: 10 })
    return Promise.resolve(null)
  }
  capturePage() {
    fake.shotIds.push(this.windowId)
    const size = fake.captureSize || { width: 1100, height: 800 }
    return Promise.resolve(picture(fake.jpeg, size.width, size.height))
  }
  _cdp(method, p) {
    if (method === 'Emulation.setFocusEmulationEnabled') {
      if (!fake.holdPrepare) return Promise.resolve({})
      fake.prepareEntered += 1
      return new Promise((resolve) => fake.prepareWaiters.push(() => resolve({})))
    }
    if (method === 'Input.dispatchMouseEvent') {
      if (p.type === 'mouseWheel') fake.actions.push('wheel ' + p.deltaY + ' ' + this.windowId)
      if (p.type === 'mousePressed') {
        fake.actions.push('mouse ' + p.x + ' ' + p.y + ' ' + this.windowId)
        if (fake.holdClick) {
          fake.clickEntered += 1
          return new Promise((resolve) => fake.clickWaiters.push(() => resolve({})))
        }
      }
      return Promise.resolve({})
    }
    if (method === 'Input.insertText') {
      fake.actions.push('type ' + p.text + ' ' + this.windowId)
      return Promise.resolve({})
    }
    if (method === 'Input.dispatchKeyEvent') {
      if (p.type !== 'keyUp') fake.actions.push('press ' + p.key + ' ' + this.windowId)
      return Promise.resolve({})
    }
    return Promise.resolve({})
  }
  focus() { fake.actions.push('focus') }
  setAudioMuted() {}
  setFrameRate() {}
  setWindowOpenHandler() {}
  isDestroyed() { return this._closed }
  close() { this._end() }
  _end() {
    if (this._closed) return
    this._closed = true
    for (const fn of this._on.destroyed || []) fn()
  }
}

export class WebContentsView {
  constructor(opts) {
    fake.views.push(opts)
    this.webContents = new FakeContents()
  }
  setBounds() {}
}

export class BaseWindow {
  constructor(opts) {
    fake.hosts.push(opts)
    this._destroyed = false
    this._on = {}
    const kids = []
    this.contentView = { children: kids, addChildView: (v) => kids.push(v) }
  }
  on(ev, fn) { (this._on[ev] = this._on[ev] || []).push(fn) }
  isDestroyed() { return this._destroyed }
  isVisible() { return false }
  show() { fake.actions.push('show') }
  focus() { fake.actions.push('focus') }
  destroy() {
    if (this._destroyed) return
    this._destroyed = true
    for (const v of this.contentView.children) v.webContents._end()
    for (const fn of this._on.closed || []) fn()
  }
}

export const session = {
  fromPartition(name) {
    fake.partitions.push(name)
    return { setUserAgent() {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {} }
  }
}
