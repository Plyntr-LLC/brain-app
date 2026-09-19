import { readFileSync } from "node:fs";
import { importVerdictPublicKey, randomHex, verifyVerdict, fromB64Url } from "../../src/tokens.js";
import { planCycle } from "./cycle.js";
import { scanTree } from "./scan.js";
import { applyDown, removeRel } from "./apply-down.js";
import { absUnder } from "./fs-safe.js";
import { shouldWipe, wipeMini } from "./wipe.js";
import { nextBackoff } from "./watch.js";
import { rewriteGuides, overlayPack } from "./compose.js";

function tokenPayload(token) {
  try {
    const body = String(token || "").split(".")[0];
    return JSON.parse(new TextDecoder().decode(fromB64Url(body)));
  } catch {
    return null;
  }
}

function toB64(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return buf.toString("base64");
}

export async function runCycle({
  api,
  state,
  token,
  miniRoot,
  lastWrites,
  now = Date.now(),
  debounceOk = true,
}) {
  const nonce = randomHex(16);
  const cfg = await api.json("/install/config");
  if (!cfg.ok || !cfg.body.verdict_public_key) {
    return { ok: false, reason: "no verdict key", backoff: nextBackoff(state.backoffMs), offline: true };
  }
  const pub = await importVerdictPublicKey(cfg.body.verdict_public_key);
  const seatRes = await api.json("/seat?nonce=" + nonce);
  if (seatRes.status === 401 || seatRes.status === 403) {
    return { ok: false, reason: "auth", backoff: nextBackoff(state.backoffMs), offline: true };
  }
  if (!seatRes.ok) {
    return { ok: false, reason: "seat " + seatRes.status, backoff: nextBackoff(state.backoffMs), offline: true };
  }
  const verified = await verifyVerdict(seatRes.body, pub, { nonce, now });
  if (!verified.ok) {
    return { ok: false, reason: "verdict " + verified.reason, backoff: nextBackoff(state.backoffMs), offline: true };
  }
  const verdict = verified.verdict;
  if (shouldWipe(verdict)) {
    const wiped = wipeMini({ miniRoot, roots: state.roots || [], stateDir: state.stateDir });
    return { ok: true, wiped: true, message: wiped.message };
  }

  const roots = verdict.roots || [];
  const dropped = (state.roots || []).filter((r) => !roots.includes(r));
  for (const root of dropped) {
    removeRel(miniRoot, String(root).replace(/\/+$/, ""));
    if (state.base) {
      const prefix = String(root).replace(/\/?$/, "/");
      for (const p of Object.keys(state.base)) {
        if (p.startsWith(prefix)) delete state.base[p];
      }
    }
  }
  state.roots = roots;
  const wanted = verdict.skeleton_version || "";
  if (wanted && state.skeleton_version && wanted !== state.skeleton_version) {
    const pack = await api.bytes("/skeleton?version=" + encodeURIComponent(wanted));
    if (pack.ok) {
      overlayPack(miniRoot, pack.bytes);
      state.skeleton_version = wanted;
    }
  }
  rewriteGuides({
    miniRoot,
    seat: {
      brain_label: state.brain_label || "Brain",
      roots,
      owner_email: "",
      seat_id: verdict.seat_id,
      kind: "client-project",
    },
    skeletonVersion: verdict.skeleton_version,
  });

  const payload = tokenPayload(token);
  if (payload && payload.exp && payload.exp * 1000 - now < 7 * 24 * 3600 * 1000) {
    const refreshed = await api.json("/auth/refresh", { method: "POST", body: "{}" });
    if (refreshed.ok && refreshed.body.seat_token) {
      state.newToken = refreshed.body.seat_token;
    }
  }

  const scanned = scanTree(miniRoot, roots);
  const localFiles = scanned.files;
  const man = await api.json("/manifest");
  if (!man.ok) {
    return { ok: false, reason: "manifest " + man.status, backoff: nextBackoff(state.backoffMs), offline: true };
  }
  const remoteFiles = {};
  for (const f of man.body.files || []) {
    remoteFiles[f.path] = { sha: f.sha, mode: f.mode || "100644", size: f.size || 0, type: "blob" };
  }
  const plan = planCycle({
    localFiles,
    remoteFiles,
    base: state.base || {},
    roots,
    now: new Date(now),
  });

  const held = state.held || {};
  const uploads = (debounceOk ? plan.uploads : []).filter((u) => {
    const h = held[u.path];
    if (!h) return true;
    return h.sha !== u.sha;
  });

  if (uploads.length) {
    const batch = uploads.slice(0, 50);
    const entries = batch.map((u) => {
      if (u.delete) return { path: u.path, delete: true };
      const bytes = readFileSync(absUnder(miniRoot, u.path));
      return { path: u.path, mode: u.mode || "100644", content_b64: toB64(bytes) };
    });
    const commit = await api.json("/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base_commit: man.body.commit, entries }),
    });
    if (commit.status === 409) {
      return { ok: false, reason: "conflict", retryDown: true };
    }
    if (commit.status === 403 && commit.body && commit.body.held) {
      for (const row of commit.body.held) {
        const local = localFiles[row.path];
        held[row.path] = { reason: row.reason, sha: local && local.sha };
      }
      state.held = held;
    } else if (!commit.ok) {
      return { ok: false, reason: "commit " + commit.status, backoff: nextBackoff(state.backoffMs), offline: true };
    } else {
      state.base = state.base || {};
      for (const f of commit.body.files || []) {
        if (f.sha) state.base[f.path] = f.sha;
        else delete state.base[f.path];
      }
      state.manifest_commit = commit.body.commit;
    }
  }

  async function fetchBlob(sha, path) {
    const q =
      "/blob?commit=" +
      encodeURIComponent(man.body.commit) +
      "&path=" +
      encodeURIComponent(path) +
      "&sha=" +
      encodeURIComponent(sha);
    const got = await api.bytes(q);
    if (!got.ok) throw new Error("blob " + got.status);
    return got.bytes;
  }

  const down = await applyDown({
    miniRoot,
    localFiles,
    plan: plan.down,
    fetchBlob,
    lastWrites,
  });
  state.base = plan.down.nextBase || state.base;
  state.manifest_commit = man.body.commit;
  state.backoffMs = 0;
  state.last_sync_at = new Date(now).toISOString();
  state.offline = false;
  if (!state.skeleton_version && man.body.skeleton_version) {
    state.skeleton_version = man.body.skeleton_version;
  }
  return { ok: true, down, skipped: scanned.skipped };
}
