import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createApi } from "./api.js";
import { composeMini } from "./compose.js";
import { runCycle } from "./run-cycle.js";
import { assertAgentRoot } from "./watch.js";
import { renderLaunchd, renderWindowsTask, windowsTaskName, launchdLabel } from "./install-service.js";
import { brainSlug, defaultMiniRoot, logDir, seatDir } from "./paths.js";
import { randomHex } from "../../src/tokens.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");

function writeMode600(path, text) {
  writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* windows */
  }
}

export function readState(dir) {
  const p = join(dir, "state.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

export function writeState(dir, state) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
}

export function readToken(dir) {
  const p = join(dir, "token");
  return existsSync(p) ? readFileSync(p, "utf8").trim() : "";
}

export async function exchangeAndCompose({
  origin,
  email,
  code,
  miniRoot: requestedRoot,
  fetchImpl,
  nodePath = process.execPath,
  cliPath = join(here, "cli.js"),
  skipService = false,
}) {
  const devicePathHint = join(homedir(), ".brain-bridge", "device_id");
  let device_id = "";
  if (existsSync(devicePathHint)) device_id = readFileSync(devicePathHint, "utf8").trim();
  if (!/^[a-f0-9]{32}$/i.test(device_id)) device_id = randomHex(16);

  const api = createApi({ origin, getToken: () => "", fetchImpl });
  const ex = await api.json("/auth/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: String(email || "").trim().toLowerCase(),
      code: String(code || "").trim(),
      device_id,
      device_name: process.platform + " " + (process.arch || ""),
    }),
  });
  if (!ex.ok) {
    return { ok: false, detail: (ex.body && ex.body.detail) || "That code did not work." };
  }
  if (ex.body.seat && ex.body.seat.kind === "owner") {
    return { ok: false, detail: "This app is for project people. Owners use the website." };
  }
  const seat = ex.body.seat;
  const token = ex.body.seat_token;
  const slug = brainSlug(seat);
  const miniRoot = requestedRoot || defaultMiniRoot(slug);
  mkdirSync(miniRoot, { recursive: true });
  assertAgentRoot(miniRoot);

  const authed = createApi({ origin, getToken: () => token, fetchImpl });
  const pack = await authed.bytes("/skeleton?version=" + encodeURIComponent(seat.skeleton_version || ""));
  if (!pack.ok) return { ok: false, detail: "Could not download the starter files." };
  composeMini({
    miniRoot,
    packBytes: pack.bytes,
    seat,
    skeletonVersion: seat.skeleton_version,
  });

  const dir = seatDir(seat.seat_id);
  mkdirSync(dir, { recursive: true });
  mkdirSync(logDir(seat.seat_id), { recursive: true });
  writeMode600(join(dir, "token"), token);
  writeMode600(join(dir, "device_id"), device_id);
  mkdirSync(dirname(devicePathHint), { recursive: true });
  writeMode600(devicePathHint, device_id);

  const state = {
    hq_repo: seat.hq_repo,
    mini_root: miniRoot,
    roots: seat.roots,
    manifest_commit: null,
    skeleton_version: seat.skeleton_version,
    base: {},
    held: {},
    brain_label: seat.brain_label,
    origin,
    stateDir: dir,
  };
  writeState(dir, state);

  const cycle = await runCycle({
    api: authed,
    state,
    token,
    miniRoot,
    lastWrites: new Map(),
    debounceOk: false,
  });
  if (state.newToken) {
    writeMode600(join(dir, "token"), state.newToken);
    delete state.newToken;
  }
  writeState(dir, state);
  if (cycle.wiped) return { ok: false, detail: cycle.message };

  if (!skipService) {
    installAgentService({
      seatId: seat.seat_id,
      nodePath,
      cliPath,
      logs: logDir(seat.seat_id),
    });
  }

  return {
    ok: true,
    seat,
    miniRoot,
    last_sync_at: state.last_sync_at,
    cycle_ok: cycle.ok,
    cycle_reason: cycle.reason,
  };
}

export function installAgentService({ seatId, nodePath, cliPath, logs }) {
  mkdirSync(logs, { recursive: true });
  if (process.platform === "win32") {
    const xmlTmpl = readFileSync(join(repoRoot, "windows/brain-sync-task.xml.tmpl"), "utf8");
    const xml = renderWindowsTask(xmlTmpl, { node: nodePath, watchJs: cliPath, seatId });
    const xmlPath = join(seatDir(seatId), "task.xml");
    writeFileSync(xmlPath, xml, { encoding: "utf16le" });
    execFileSync("schtasks", ["/Create", "/TN", windowsTaskName(seatId), "/XML", xmlPath, "/F"], {
      stdio: "pipe",
    });
    return { kind: "schtasks", name: windowsTaskName(seatId) };
  }
  const plistTmpl = readFileSync(join(repoRoot, "launchd/com.plyntr.brain-sync.plist.tmpl"), "utf8");
  const plist = renderLaunchd(plistTmpl, {
    node: nodePath,
    watchJs: cliPath,
    seatId,
    logDir: logs,
  });
  const label = launchdLabel();
  const plistPath = join(homedir(), "Library/LaunchAgents", label + ".plist");
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, plist);
  try {
    execFileSync("launchctl", ["bootout", `gui/${process.getuid()}/${label}`], { stdio: "pipe" });
  } catch {
    /* not loaded */
  }
  execFileSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath], { stdio: "pipe" });
  try {
    execFileSync("launchctl", ["enable", `gui/${process.getuid()}/${label}`], { stdio: "pipe" });
  } catch {
    /* older launchctl */
  }
  execFileSync("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${label}`], { stdio: "pipe" });
  return { kind: "launchd", label, plistPath };
}

export function uninstallAgentService(seatId) {
  if (process.platform === "win32") {
    try {
      execFileSync("schtasks", ["/Delete", "/TN", windowsTaskName(seatId), "/F"], { stdio: "pipe" });
    } catch {
      /* missing */
    }
    return;
  }
  const label = launchdLabel();
  try {
    execFileSync("launchctl", ["bootout", `gui/${process.getuid()}/${label}`], { stdio: "pipe" });
  } catch {
    /* missing */
  }
  const plistPath = join(homedir(), "Library/LaunchAgents", label + ".plist");
  if (existsSync(plistPath)) rmSync(plistPath, { force: true });
}
