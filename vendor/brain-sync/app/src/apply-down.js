import { existsSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { absUnder, atomicWrite } from "./fs-safe.js";

export async function applyDown({ miniRoot, localFiles, plan, fetchBlob, lastWrites }) {
  const written = [];
  const deleted = [];
  const next = (plan && plan.next) || {};
  const sidecars = (plan && plan.sidecars) || [];

  for (const sc of sidecars) {
    const blobPath = sc.from || sc.path;
    const buf = await fetchBlob(sc.meta.sha, blobPath);
    atomicWrite(miniRoot, sc.path, buf);
    if (lastWrites && sc.meta.sha) lastWrites.set(sc.path, sc.meta.sha);
    written.push(sc.path);
  }

  for (const [p, meta] of Object.entries(next)) {
    const local = localFiles && localFiles[p];
    if (local && local.sha === meta.sha) continue;
    const buf = await fetchBlob(meta.sha, p);
    atomicWrite(miniRoot, p, buf);
    if (lastWrites && meta.sha) lastWrites.set(p, meta.sha);
    written.push(p);
  }

  const planned = new Set([...Object.keys(next), ...sidecars.map((s) => s.path)]);
  for (const p of Object.keys(localFiles || {})) {
    if (planned.has(p)) continue;
    const abs = absUnder(miniRoot, p);
    if (existsSync(abs)) {
      unlinkSync(abs);
      deleted.push(p);
    }
  }

  return { written, deleted };
}

export function ensureDir(abs) {
  mkdirSync(abs, { recursive: true });
}

export function removeRel(miniRoot, rel) {
  const abs = absUnder(miniRoot, rel);
  if (existsSync(abs)) rmSync(abs, { recursive: true, force: true });
}
