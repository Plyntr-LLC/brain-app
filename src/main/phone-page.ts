export function phonePageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="referrer" content="no-referrer" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-title" content="Brain" />
  <title>Brain</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@500;600;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap" rel="stylesheet" />
  <style>
    :root {
      --ink: #1a1612;
      --muted: #5c534a;
      --line: #d9d0c6;
      --paper: #f3eee8;
      --card: #fffdf9;
      --orange-deep: #c45f00;
      --ok: #2c6e3a;
      --warn: #8a5a12;
      --warn-bg: #f8eedc;
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      background: var(--card);
      color: var(--ink);
      font-family: "Source Serif 4", Georgia, serif;
      font-size: 16px;
      line-height: 1.45;
    }
    h1, button, label, select, .kicker { font-family: "Schibsted Grotesk", sans-serif; }
    .app {
      min-height: 100%;
      display: grid;
      grid-template-rows: auto 1fr auto;
      padding: env(safe-area-inset-top) 0 env(safe-area-inset-bottom);
    }
    header, footer { padding: 0.7rem 1rem; }
    header { border-bottom: 1px solid var(--line); background: #efe8df; }
    h1 { font-size: 1.05rem; margin: 0 0 0.2rem; letter-spacing: -0.02em; }
    .kicker { color: var(--orange-deep); font-size: 0.72rem; font-weight: 700; margin: 0 0 0.15rem; }
    .tiny { color: var(--muted); font-size: 0.82rem; margin: 0; }
    .note {
      background: var(--warn-bg);
      color: var(--warn);
      padding: 0.65rem 0.75rem;
      margin: 0.6rem 1rem 0;
      font-size: 0.95rem;
    }
    .note.hidden { display: none; }
    select { width: 100%; margin-top: 0.45rem; padding: 0.4rem 0.5rem; border: 1px solid var(--line); background: #fff; color: var(--ink); }
    .thread { overflow: auto; padding: 0.85rem 1rem 1rem; display: flex; flex-direction: column; gap: 0.7rem; }
    .msg { max-width: 92%; }
    .msg.me { margin-left: auto; }
    .who { font-family: "Schibsted Grotesk", sans-serif; font-size: 0.72rem; font-weight: 700; color: var(--orange-deep); margin: 0 0 0.15rem; }
    .msg.me .who { text-align: right; }
    .bubble { background: var(--paper); padding: 0.55rem 0.7rem; white-space: pre-wrap; word-break: break-word; }
    .msg.me .bubble { background: #efe8df; }
    footer { border-top: 1px solid var(--line); display: grid; grid-template-columns: 1fr auto; gap: 0.5rem; align-items: end; }
    textarea {
      font-family: "Source Serif 4", Georgia, serif;
      font-size: 1.05rem;
      padding: 0.5rem 0.6rem;
      border: 1px solid var(--line);
      width: 100%;
      min-height: 2.8rem;
      max-height: 8rem;
      resize: vertical;
      background: #fff;
      color: var(--ink);
    }
    button {
      font-weight: 600;
      font-size: 0.95rem;
      padding: 0.55rem 0.9rem;
      border-radius: 2px;
      cursor: pointer;
      background: var(--ink);
      color: #fff;
      border: 1px solid var(--ink);
    }
    button:disabled { opacity: 0.4; }
    button.ghost { background: transparent; color: var(--ink); }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <p class="kicker">Brain</p>
      <h1 id="title">This Mac</h1>
      <p class="tiny">Plug the computer in. Closing the lid on battery will sleep.</p>
      <select id="tabs" aria-label="Chat"></select>
    </header>
    <p id="banner" class="note hidden"></p>
    <div id="thread" class="thread"></div>
    <footer>
      <textarea id="say" rows="2" placeholder="Ask…"></textarea>
      <button type="button" id="send">Send</button>
    </footer>
  </div>
  <script>
    const token = new URLSearchParams(location.search).get('t') || ''
    const qs = token ? ('?t=' + encodeURIComponent(token)) : ''
    const thread = document.getElementById('thread')
    const tabsEl = document.getElementById('tabs')
    const say = document.getElementById('say')
    const sendBtn = document.getElementById('send')
    const banner = document.getElementById('banner')
    const title = document.getElementById('title')
    let active = ''
    let busyBy = {}
    let messages = {}
    let tabs = []
    let pending = null
    let eventsOn = false

    function esc(s) {
      return String(s || '').replace(/[&<>"']/g, function (c) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
      })
    }
    function showBanner(text) {
      banner.textContent = text || ''
      banner.classList.toggle('hidden', !text)
    }
    function busy() {
      return Boolean(busyBy[active] || (pending && pending.tabId === active))
    }
    function msgs(id) {
      if (!messages[id]) messages[id] = []
      return messages[id]
    }
    function paint() {
      const list = msgs(active)
      thread.innerHTML = list.map(function (m) {
        const who = m.who === 'me' ? 'You' : m.who === 'think' ? 'Thinking' : 'Brain'
        const cls = m.who === 'me' ? 'msg me' : 'msg'
        return '<div class="' + cls + '"><p class="who">' + who + '</p><div class="bubble">' + esc(m.text) + '</div></div>'
      }).join('')
      thread.scrollTop = thread.scrollHeight
      const tab = tabs.find(function (t) { return t.id === active })
      title.textContent = tab ? (tab.title || 'Chat') : 'This Mac'
      sendBtn.disabled = busy() || !token
    }
    function pinChatId(chatIds, current, macActive) {
      const ids = (chatIds || []).filter(Boolean)
      if (ids.indexOf(current) >= 0) return current
      if (ids.indexOf(macActive) >= 0) return macActive
      return ids[0] || ''
    }
    function pendingLanded(p, all) {
      if (!p) return true
      const list = all[p.tabId] || []
      let n = 0
      for (let i = 0; i < list.length; i++) {
        if (list[i].who === 'me' && list[i].text === p.text) n++
      }
      return n > p.meCount
    }
    function applyState(s) {
      tabs = (s.tabs || []).filter(function (t) { return t.type === 'chat' })
      const incoming = s.messages || {}
      Object.keys(incoming).forEach(function (id) {
        const have = messages[id] || []
        const next = incoming[id] || []
        messages[id] = next.length >= have.length ? next : have
      })
      active = pinChatId(tabs.map(function (t) { return t.id }), active, s.active || '')
      if (pending && pendingLanded(pending, messages)) pending = null
      busyBy = Object.assign({}, s.busy || {})
      if (pending) busyBy[pending.tabId] = true
      tabsEl.innerHTML = tabs.map(function (t) {
        return '<option value="' + esc(t.id) + '"' + (t.id === active ? ' selected' : '') + '>' + esc(t.title || t.kind || 'Chat') + '</option>'
      }).join('')
      paint()
    }
    async function pullState() {
      const r = await fetch('/api/state' + qs)
      if (r.status === 401) {
        showBanner('This link is not paired. Turn Phone on in Brain Settings and open the new link.')
        return false
      }
      if (!r.ok) throw new Error('bad')
      applyState(await r.json())
      return true
    }
    function startPoll() {
      if (eventsOn || !token) return
      eventsOn = true
      let misses = 0
      async function tick() {
        try {
          const ok = await pullState()
          if (ok === false) return
          misses = 0
          if (banner.textContent.indexOf('computer is off') >= 0) showBanner('')
        } catch (e) {
          misses += 1
          if (misses >= 3) showBanner('The computer is off or Brain.app is closed.')
        }
        if (!eventsOn) return
        const hot = Object.keys(busyBy).some(function (id) { return busyBy[id] })
        setTimeout(tick, hot ? 400 : 1500)
      }
      void tick()
    }
    async function load() {
      if (!token) {
        showBanner('This link needs the pairing code from Brain Settings on the computer.')
        return
      }
      try {
        const ok = await pullState()
        if (!ok) return
        showBanner('')
        startPoll()
      } catch (e) {
        showBanner('The computer is off or Brain.app is closed.')
      }
    }
    async function send() {
      const text = say.value.trim()
      const tabId = active
      if (!text || !tabId || busy()) return
      let meCount = 0
      const have = messages[tabId] || []
      for (let i = 0; i < have.length; i++) {
        if (have[i].who === 'me' && have[i].text === text) meCount++
      }
      pending = { tabId: tabId, text: text, meCount: meCount }
      say.value = ''
      busyBy[tabId] = true
      showBanner('')
      paint()
      try {
        const r = await fetch('/api/send' + qs, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: text, tabId: tabId })
        })
        const body = await r.json().catch(function () { return {} })
        if (!r.ok || body.ok === false) {
          if (pending && pending.tabId === tabId && pending.text === text) {
            say.value = pending.text
            pending = null
          }
          showBanner(body.detail || 'Could not send.')
          busyBy[tabId] = false
          paint()
          return
        }
        showBanner('')
      } catch (e) {
        if (pending && pending.tabId === tabId && pending.text === text) {
          say.value = pending.text
          pending = null
        }
        showBanner('The computer is off or Brain.app is closed.')
        busyBy[tabId] = false
        paint()
      }
    }
    tabsEl.addEventListener('change', function () {
      active = tabsEl.value
      paint()
    })
    sendBtn.addEventListener('click', function () { void send() })
    say.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void send()
      }
    })
    void load()
  </script>
</body>
</html>`
}
