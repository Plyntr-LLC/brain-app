#!/usr/bin/env node
import { createServer } from "node:http";
import { exec } from "node:child_process";
import { exchangeAndCompose, uninstallAgentService } from "./setup.js";
import { setupPage } from "./setup-page.js";
import { statusText, listSeats } from "./health.js";
import { watchLoop } from "./watch-loop.js";
import { defaultMiniRoot } from "./paths.js";
import { resolveCliCommand } from "./cli-args.js";

const ORIGIN = process.env.BRAIN_SYNC_ORIGIN || "https://brain-sync.joe-84a.workers.dev";

function arg(name) {
  const i = process.argv.indexOf("--" + name);
  if (i === -1) return "";
  return process.argv[i + 1] || "";
}

function flag(name) {
  return process.argv.includes("--" + name);
}

async function setupFromFlags() {
  const email = arg("email");
  const code = arg("code");
  const folder = arg("dir") || arg("folder");
  if (!email || !code) {
    process.stderr.write("Need --email and --code, or run without flags to open the setup page.\n");
    process.exit(1);
  }
  const out = await exchangeAndCompose({
    origin: ORIGIN,
    email,
    code,
    miniRoot: folder || undefined,
  });
  if (!out.ok) {
    process.stderr.write(out.detail + "\n");
    process.exit(1);
  }
  process.stdout.write("Sync is running. Folder: " + out.miniRoot + "\n");
}

function openUrl(url) {
  const cmd =
    process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd);
}

function runSetupServer() {
  const page = setupPage({ origin: ORIGIN, defaultFolder: defaultMiniRoot("brain") });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/setup")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page);
      return;
    }
    if (req.method === "POST" && url.pathname === "/setup") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        body = {};
      }
      const out = await exchangeAndCompose({
        origin: ORIGIN,
        email: body.email,
        code: body.code,
        miniRoot: body.folder || undefined,
      });
      res.writeHead(out.ok ? 200 : 400, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  server.listen(8788, "127.0.0.1", () => {
    const url = "http://127.0.0.1:8788/";
    process.stdout.write("Open " + url + " and enter your email and code.\n");
    openUrl(url);
  });
}

async function syncOnce(seatId) {
  const id = seatId || listSeats()[0];
  if (!id) {
    process.stderr.write("No seat on this computer. Run setup first.\n");
    process.exit(1);
  }
  const dir = seatDir(id);
  const state = readState(dir);
  const token = readToken(dir);
  const api = createApi({ origin: state.origin || ORIGIN, getToken: () => token });
  const result = await watchLoop({ seatId: id, once: true });
  process.stdout.write((result.ok ? "ok" : result.reason) + "\n");
  if (!result.ok) process.exit(1);
}

const parsed = resolveCliCommand(process.argv);
const seatArg = parsed.seatId || "";

if (parsed.action === "watch") {
  watchLoop({ seatId: parsed.seatId }).catch((err) => {
    process.stderr.write(String(err && err.message) + "\n");
    process.exit(1);
  });
} else if (parsed.action === "status") {
  process.stdout.write(statusText(arg("seat") || seatArg) + "\n");
} else if (parsed.action === "sync") {
  syncOnce(arg("seat") || seatArg).catch((err) => {
    process.stderr.write(String(err && err.message) + "\n");
    process.exit(1);
  });
} else if (parsed.action === "uninstall") {
  const id = arg("seat") || seatArg || listSeats()[0];
  if (!id) {
    process.stderr.write("No seat to uninstall.\n");
    process.exit(1);
  }
  uninstallAgentService(id);
  process.stdout.write("Background sync stopped for " + id + ".\n");
} else if (parsed.action === "setup") {
  if (arg("email") || arg("code")) {
    setupFromFlags().catch((err) => {
      process.stderr.write(String(err && err.message) + "\n");
      process.exit(1);
    });
  } else runSetupServer();
} else {
  process.stderr.write("Brain Bridge: setup | watch | status | sync | uninstall\n");
  process.exit(1);
}
