// A stand-in for web.whatsapp.com with the structure wa.cjs reads on the real site. Each partition keeps its own
// `localStorage.linked` and `localStorage.sent` (every posted message as { chat, text }).
// `/?link=1` links the partition; an unlinked one shows only the QR.

const CONTACTS = ['Raj Patel', 'Pat', 'Sam Lee', 'Sam Ortiz', 'Decoy', 'Slowpoke', 'Echo', 'Ghost', 'Reader', 'Sticky', 'Fancy']

const APP = `
const contacts = ${JSON.stringify(CONTACTS)}
const header = { Decoy: 'Someone Else' }
const sent = () => JSON.parse(localStorage.sent || '[]')
const record = (chat, text) => { const all = sent(); all.push({ chat, text }); localStorage.sent = JSON.stringify(all) }
let n = 0
const side = document.getElementById('pane-side')
const search = document.querySelector('input[aria-label="Search or start a new chat"]')
function list() {
  const q = search.value.trim().toLowerCase()
  side.innerHTML = ''
  for (const name of contacts.filter((c) => !q || c.toLowerCase().includes(q))) {
    const row = document.createElement('div')
    row.setAttribute('role', 'row')
    row.style.cssText = 'padding:10px;border-bottom:1px solid #ddd;cursor:pointer'
    row.innerHTML = '<span></span><span class="preview">last message</span>'
    row.firstChild.setAttribute('title', name)
    row.firstChild.textContent = name
    row.onclick = () => open(name)
    side.appendChild(row)
  }
}
search.addEventListener('input', list)
search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = side.querySelector('[role="row"]'); if (first) first.click() } })
function bubble(list, text, status, id, drawn) {
  const row = document.createElement('div')
  row.setAttribute('role', 'row')
  row.innerHTML = '<div class="message-out"><span class="text"></span> <span class="status"></span></div>'
  row.firstChild.setAttribute('data-id', id)
  row.querySelector('.text').textContent = text
  // Fancy draws like WhatsApp: *bold* without its marks, emoji as images with the emoji as alt.
  if (drawn) row.querySelector('.text').innerHTML = row.querySelector('.text').innerHTML.replace(/\\*([^*]+)\\*/g, '<b>$1</b>').replace(/\\p{Extended_Pictographic}/gu, (e) => '<img alt="' + e + '" src="data:," width="16" height="16">')
  const s = row.querySelector('.status')
  s.setAttribute('aria-label', ' ' + status + ' ')
  s.textContent = status
  list.appendChild(row)
  return s
}
function open(name) {
  const main = document.getElementById('main')
  main.innerHTML = '<header><span></span></header><div class="msgs"></div><footer><div contenteditable="true" data-tab="10" aria-label="Type a message" role="textbox" style="border:1px solid #888;min-height:30px;width:500px"></div><button aria-label="Send">Send</button></footer>'
  main.querySelector('header span').setAttribute('title', header[name] || name)
  main.querySelector('header span').textContent = header[name] || name
  const msgs = main.querySelector('.msgs')
  if (name === 'Echo') bubble(msgs, 'Echo test', 'Sent', 'old-echo')
  const box = main.querySelector('footer [contenteditable]')
  if (name === 'Raj Patel') box.textContent = 'old draft'
  if (name === 'Sticky') box.addEventListener('input', () => { if (box.innerText.trim() && box.innerText !== 'stuck text') box.textContent = 'stuck text' })
  const post = () => {
    const text = box.innerText.replace(/\\n$/, '')
    if (!text.trim() || name === 'Ghost') return
    record(name, text)
    box.innerHTML = ''
    const s = bubble(msgs, text, 'Pending', 'new-' + ++n, name === 'Fancy')
    if (name === 'Slowpoke' || name === 'Echo') return
    setTimeout(() => { s.setAttribute('aria-label', name === 'Reader' ? ' Read ' : ' Sent '); s.textContent = name === 'Reader' ? 'Read' : 'Sent' }, 300)
  }
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); post() } })
  main.querySelector('footer button').onclick = post
}
list()
`

export function standIn(url: URL): string {
  const linked = url.searchParams.has('link')
  return `<!doctype html><title>WhatsApp</title><body style="margin:0;font:14px sans-serif">
<div id="gate"></div>
<script>
if (${linked}) localStorage.linked = 'yes'
if (!localStorage.linked) {
  document.getElementById('gate').innerHTML = '<h1>Use WhatsApp on your computer</h1><canvas aria-label="Scan this QR code to link a device!" width="200" height="200" style="display:block;background:#000"></canvas>'
} else {
  document.getElementById('gate').innerHTML = '<div style="display:flex"><div style="width:300px"><input aria-label="Search or start a new chat" placeholder="Search" style="width:280px;margin:8px"><div id="pane-side"></div></div><div id="main" style="flex:1"></div></div>'
  ${APP}
}
</script>`
}
