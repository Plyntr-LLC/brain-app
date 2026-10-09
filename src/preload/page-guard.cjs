'use strict'
/**
 * Brain's page guard. Every Brain browser session registers it as a frame preload, so it runs before each page's own
 * scripts, in pop-ups and in iframes too (nodeIntegrationInSubFrames; the page stays sandboxed, no Node). It is plain
 * CommonJS because sandboxed preloads cannot be ES modules.
 *
 * - print() becomes a request to Brain. A page's own print would otherwise wait on a print dialog nobody can see, and
 *   the page stops answering. An iframe's print sends that iframe's document, so a receipt prints as itself.
 * - navigator.credentials.create/get with publicKey first ask Brain, which says yes only while a person watches the
 *   page live. Brain can cancel a waiting request (the page sees AbortError).
 * - A window a script reaches without a load (an iframe made on the fly, an empty pop-up) skips preloads, so the
 *   guard also patches each window it hands out through contentWindow, contentDocument and window.open.
 *
 * Main matches every message to its window by the sender, never by anything the page says. This is a courtesy, not a
 * security boundary: a page that works around it gets at most a Touch ID prompt naming its own site.
 */
const { contextBridge, ipcRenderer } = require('electron')

const cancels = new Map()
ipcRenderer.on('page-guard:passkey-cancel', (_e, id) => {
  const fn = cancels.get(id)
  cancels.delete(id)
  if (fn) fn()
})

contextBridge.executeInMainWorld({
  func: (askPrint, askPasskey, passkeyDone, onCancel) => {
    const seen = new WeakSet()
    const MAX_HTML = 5 * 1024 * 1024

    const guard = (win) => {
      let doc = null
      try {
        if (!win || seen.has(win)) return
        doc = win.document
        seen.add(win)
      } catch (e) {
        // Another site's window. Its own guard runs there.
        return
      }

      try {
        const isTop = win === win.top
        win.print = function print() {
          if (isTop) return askPrint(null, '')
          let html = ''
          try {
            html = '<!doctype html>' + doc.documentElement.outerHTML
          } catch (e) {
            html = ''
          }
          if (html.length > MAX_HTML) html = ''
          askPrint(html, String(doc.baseURI || ''))
        }
      } catch (e) {}

      try {
        const creds = win.navigator.credentials
        if (creds) {
          const wrap = (orig, kind) =>
            function (options) {
              if (!options || !options.publicKey) return orig.call(creds, options)
              if (options.mediation === 'conditional') {
                return Promise.reject(new win.DOMException('Brain has no passkey autofill.', 'NotAllowedError'))
              }
              const ac = new win.AbortController()
              const theirs = options.signal
              if (theirs) {
                if (theirs.aborted) ac.abort(theirs.reason)
                else theirs.addEventListener('abort', () => ac.abort(theirs.reason), { once: true })
              }
              return askPasskey(kind).then((id) => {
                if (!id) throw new win.DOMException('A person has to be watching this page in Brain to use a passkey.', 'NotAllowedError')
                onCancel(id, () => ac.abort(new win.DOMException('Cancelled in Brain.', 'AbortError')))
                const ask = Object.assign({}, options, { signal: ac.signal })
                return orig.call(creds, ask).finally(() => passkeyDone(id))
              })
            }
          creds.get = wrap(creds.get, 'get')
          creds.create = wrap(creds.create, 'create')
        }
      } catch (e) {}

      // Windows this window's scripts can reach before any load of their own.
      const through = (proto, prop) => {
        try {
          const d = proto && Object.getOwnPropertyDescriptor(proto, prop)
          if (!d || !d.get) return
          Object.defineProperty(proto, prop, {
            configurable: true,
            enumerable: d.enumerable,
            get() {
              const got = d.get.call(this)
              guard(prop === 'contentDocument' ? got && got.defaultView : got)
              return got
            }
          })
        } catch (e) {}
      }
      for (const name of ['HTMLIFrameElement', 'HTMLFrameElement', 'HTMLObjectElement']) {
        const C = win[name]
        if (!C) continue
        through(C.prototype, 'contentWindow')
        through(C.prototype, 'contentDocument')
      }
      try {
        const open = win.open
        win.open = function () {
          const w = open.apply(this, arguments)
          guard(w)
          return w
        }
      } catch (e) {}
    }

    guard(window)
  },
  args: [
    (html, base) => ipcRenderer.send('page-guard:print', typeof html === 'string' ? html : null, String(base || '')),
    (kind) => ipcRenderer.invoke('page-guard:passkey', kind === 'create' ? 'create' : 'get'),
    (id) => ipcRenderer.send('page-guard:passkey-done', String(id)),
    (id, fn) => {
      cancels.set(String(id), fn)
    }
  ]
})
