import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readState } from "./setup.js";
import { seatDir, stateRoot } from "./paths.js";

export function listSeats() {
  const root = stateRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => n !== "logs");
}

export function statusText(seatId) {
  const ids = seatId ? [seatId] : listSeats();
  if (!ids.length) return "Brain Bridge is not set up on this computer yet.";
  const lines = [];
  for (const id of ids) {
    const dir = seatDir(id);
    const state = readState(dir);
    const hasToken = existsSync(join(dir, "token"));
    if (!state) {
      lines.push(id + ": no state file");
      continue;
    }
    const when = state.last_sync_at || "never";
    const held = state.held ? Object.keys(state.held).length : 0;
    const health = state.offline ? "offline" : hasToken ? "ok" : "no token";
    lines.push(
      `${state.brain_label || id}: ${health}. Last sync ${when}. Folder ${state.mini_root}. Held ${held}.`
    );
    if (state.last_error) lines.push("  last error: " + state.last_error);
  }
  return lines.join("\n");
}
