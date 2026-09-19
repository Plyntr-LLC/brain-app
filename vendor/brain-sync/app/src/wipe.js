import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const WIPE_TOP = [
  "CLAUDE.md",
  "CLAUDE.local.md",
  ".claude",
  ".team-config",
  "docs",
  "tools",
];

export function shouldWipe(verdict) {
  return Boolean(verdict && verdict.status === "revoked");
}

/** Only call after verifyVerdict said ok AND status is revoked. */
export function wipeMini({ miniRoot, roots, stateDir }) {
  for (const top of WIPE_TOP) {
    const p = join(miniRoot, top);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
  for (const root of roots || []) {
    const rel = String(root).replace(/\/+$/, "");
    const p = join(miniRoot, rel);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
  if (stateDir && existsSync(stateDir)) {
    rmSync(join(stateDir, "token"), { force: true });
    rmSync(join(stateDir, "state.json"), { force: true });
    rmSync(join(stateDir, "held.json"), { force: true });
  }
  const personal = join(miniRoot, "personal");
  return {
    keptPersonal: existsSync(personal),
    message: "Your access was removed. Your personal folder is untouched.",
  };
}
