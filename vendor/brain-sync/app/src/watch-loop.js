import { watch as fsWatch } from "node:fs";
import { join } from "node:path";
import { createApi } from "./api.js";
import { runCycle } from "./run-cycle.js";
import { assertAgentRoot, debounceReady, nextBackoff, PULL_MS } from "./watch.js";
import { readState, readToken, writeState } from "./setup.js";
import { seatDir } from "./paths.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function watchLoop({ seatId, fetchImpl, once = false }) {
  const dir = seatDir(seatId);
  const token0 = readToken(dir);
  if (!token0) throw new Error("no token; run setup first");
  let state = readState(dir);
  if (!state) throw new Error("no state.json");
  assertAgentRoot(state.mini_root);
  const origin = state.origin || process.env.BRAIN_SYNC_ORIGIN || "https://brain-sync.joe-84a.workers.dev";
  let token = token0;
  const lastWrites = new Map();
  let lastLocalWriteAt = 0;

  try {
    fsWatch(state.mini_root, { recursive: true }, () => {
      lastLocalWriteAt = Date.now();
    });
  } catch {
    /* recursive watch missing on some systems */
  }

  let delay = PULL_MS;
  for (;;) {
    const api = createApi({ origin, getToken: () => token, fetchImpl });
    const debounceOk = debounceReady({ lastLocalWriteAt, now: Date.now() });
    let result;
    try {
      result = await runCycle({
        api,
        state,
        token,
        miniRoot: state.mini_root,
        lastWrites,
        debounceOk,
      });
    } catch (err) {
      result = { ok: false, reason: String(err && err.message), backoff: nextBackoff(state.backoffMs), offline: true };
    }
    if (result.wiped) {
      writeState(dir, state);
      return result;
    }
    if (state.newToken) {
      const { writeFileSync, chmodSync } = await import("node:fs");
      const p = join(dir, "token");
      writeFileSync(p, state.newToken, { mode: 0o600 });
      try {
        chmodSync(p, 0o600);
      } catch {
        /* windows */
      }
      token = state.newToken;
      delete state.newToken;
    }
    state.offline = Boolean(result.offline);
    if (!result.ok) {
      delay = result.backoff || nextBackoff(state.backoffMs);
      state.backoffMs = delay;
      state.last_error = result.reason;
    } else {
      delay = PULL_MS;
      state.backoffMs = 0;
      state.last_error = "";
    }
    writeState(dir, state);
    if (once) return result;
    await sleep(delay);
  }
}
