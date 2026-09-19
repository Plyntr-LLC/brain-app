import { refuseGitRoot } from "./scan.js";

export const PULL_MS = 60_000;
export const PUSH_IDLE_MS = 90_000;

export function debounceReady({ lastLocalWriteAt, now, idleMs = PUSH_IDLE_MS }) {
  if (!lastLocalWriteAt) return true;
  return now - lastLocalWriteAt >= idleMs;
}

export function shouldIgnoreEcho({ path, sha, lastWrites }) {
  if (!path || !sha || !lastWrites) return false;
  return lastWrites.get(path) === sha;
}

/** 60s, then 5 min, then 15 min. A signed verdict is never this path. */
export function nextBackoff(prevMs) {
  if (!prevMs || prevMs < PULL_MS) return PULL_MS;
  if (prevMs < 5 * 60_000) return 5 * 60_000;
  return 15 * 60_000;
}

export function rememberWrite(lastWrites, path, sha, cap = 200) {
  lastWrites.set(path, sha);
  if (lastWrites.size > cap) {
    const first = lastWrites.keys().next().value;
    lastWrites.delete(first);
  }
}

export function assertAgentRoot(miniRoot) {
  refuseGitRoot(miniRoot);
}
