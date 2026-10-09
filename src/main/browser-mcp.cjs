'use strict'
// The brain-browser MCP server. A chat CLI starts it over stdio; each tool call goes to Brain over its socket.
// No dependencies: Brain runs this file with its own executable and ELECTRON_RUN_AS_NODE=1.
const net = require('node:net')
const readline = require('node:readline')

const SOCK = process.env.BRAIN_BROWSER_SOCK || ''
const TOKEN = process.env.BRAIN_BROWSER_TOKEN || ''
const OWNER = process.env.BRAIN_BROWSER_OWNER || ''
const CALL_MS = 75_000

const WHERE =
  'The browser inside Brain. It shows live in this chat thread, and logins (WhatsApp Web and any site) stay saved for every chat. ' +
  'Use it for every web page instead of Chrome, control-chrome, Playwright, puppeteer, or `open`.'

const TOOLS = [
  {
    name: 'browser_open',
    description:
      `${WHERE} Opens a web address and returns the page text and its numbered links, buttons, and fields. ` +
      'For WhatsApp Web, each number has its own login: leave account out for the main WhatsApp, or pass a name such as india for another number. A new name shows a QR code to link that number.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http or https address' },
        account: {
          type: 'string',
          description: 'Only for https://web.whatsapp.com. Leave it out for the main WhatsApp. A name such as india opens that number\'s own WhatsApp; a new name shows a QR code to link it.'
        }
      },
      required: ['url']
    }
  },
  {
    name: 'browser_read',
    description: 'Reads the page that is open in the browser inside Brain again: text from the current scroll position and the numbered controls.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'browser_click',
    description: 'Clicks one control on the open page, by its number from the last read ("#3") or its name. A control that pays, buys, sends, posts, or changes an account is never pressed by this tool; the person clicks it themselves in the picture.',
    inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] }
  },
  {
    name: 'browser_type',
    description: 'Types text into one field on the open page, by its number ("#2") or its name. It replaces what the field held. Sending a message still needs the person\'s yes.',
    inputSchema: { type: 'object', properties: { target: { type: 'string' }, text: { type: 'string' } }, required: ['target', 'text'] }
  },
  {
    name: 'browser_key',
    description: 'Presses one key in the open page: Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, or Space. Enter in a message box sends it, so ask the person first.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] }
  },
  {
    name: 'browser_scroll',
    description: 'Scrolls the open page one screen, then reads it.',
    inputSchema: { type: 'object', properties: { direction: { type: 'string', enum: ['down', 'up'] } }, required: ['direction'] }
  },
  {
    name: 'browser_screenshot',
    description: 'A picture of the open page, the same one the person sees in the thread.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'whatsapp_send',
    description:
      'Sends one WhatsApp message, only after the person presses Send. It puts a Send card in this chat thread (which WhatsApp, to whom, the text) and answers at once. ' +
      'Nothing is sent until the person presses Send on the card, and the card shows whether WhatsApp sent it. Draft the message first. ' +
      'It goes to an existing chat or contact whose name matches to; it never starts a new chat.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'The chat or contact name as WhatsApp shows it, such as Raj Patel.' },
        text: { type: 'string', description: 'The message. Line breaks stay line breaks in one message.' },
        account: { type: 'string', description: 'Leave it out for the main WhatsApp. A name such as india sends from that number.' }
      },
      required: ['to', 'text']
    }
  },
  {
    name: 'browser_close',
    description: 'Closes this chat\'s page. WhatsApp windows stay open, every account.',
    inputSchema: { type: 'object', properties: {} }
  }
]

function ask(tool, args) {
  return new Promise((resolve) => {
    if (!SOCK || !TOKEN || !OWNER) {
      resolve({ ok: false, error: 'Brain did not give this tool its browser. Restart the chat in Brain.' })
      return
    }
    let buf = ''
    let done = false
    const finish = (reply) => {
      if (done) return
      done = true
      clearTimeout(timer)
      sock.destroy()
      resolve(reply)
    }
    const sock = net.createConnection(SOCK)
    const timer = setTimeout(() => finish({ ok: false, error: 'Brain\'s browser did not answer in 75 s.' }), CALL_MS)
    sock.on('connect', () => sock.write(JSON.stringify({ token: TOKEN, owner: OWNER, tool, args }) + '\n'))
    sock.on('data', (d) => {
      buf += d
      const n = buf.indexOf('\n')
      if (n < 0) return
      try {
        finish(JSON.parse(buf.slice(0, n)))
      } catch {
        finish({ ok: false, error: 'Brain sent a reply this tool could not read.' })
      }
    })
    sock.on('error', () => finish({ ok: false, error: 'Brain is not running, or its browser is closed.' }))
    sock.on('close', () => finish({ ok: false, error: 'Brain closed the connection before answering.' }))
  })
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: { protocolVersion: (params && params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'brain-browser', version: '1' } }
    })
    return
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    return
  }
  if (method === 'tools/call') {
    const name = String((params && params.name) || '')
    if (!TOOLS.some((t) => t.name === name)) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `No tool named ${name}.` }], isError: true } })
      return
    }
    const reply = await ask(name, (params && params.arguments) || {})
    const content = []
    if (reply.text) content.push({ type: 'text', text: reply.text })
    if (reply.image) content.push({ type: 'image', data: reply.image, mimeType: 'image/jpeg' })
    if (!reply.ok) content.push({ type: 'text', text: reply.error || 'The browser could not do that.' })
    send({ jsonrpc: '2.0', id, result: { content, isError: !reply.ok } })
    return
  }
  if (id === undefined || id === null) return
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} })
    return
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method ${method}` } })
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  void handle(msg)
})
