import { homedir } from "node:os";
import { join } from "node:path";

export function stateRoot() {
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "brain-sync");
  }
  return join(homedir(), ".brain-bridge");
}

export function seatDir(seatId) {
  return join(stateRoot(), String(seatId || ""));
}

export function defaultMiniRoot(slug) {
  return join(homedir(), "Brains", slug || "brain");
}

export function brainSlug({ brain_label, hq_repo }) {
  const fromHq = String(hq_repo || "").split("/")[1] || "";
  const raw = (fromHq || String(brain_label || "brain"))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return raw || "brain";
}

export function logDir(seatId) {
  return join(seatDir(seatId), "logs");
}
