import { planThreeWay } from "../../src/threeway.js";
import { isUnderAnyRoot } from "../../src/acl.js";

function shaOf(entry) {
  return entry && entry.sha ? entry.sha : null;
}

/** Decide up (local changed vs base) and down (keep-local three-way). Paths are HQ-relative. */
export function planCycle({ localFiles, remoteFiles, base = {}, roots, now = new Date() }) {
  const local = {};
  const remote = {};
  for (const [p, meta] of Object.entries(localFiles || {})) {
    if (isUnderAnyRoot(roots, p)) local[p] = meta;
  }
  for (const [p, meta] of Object.entries(remoteFiles || {})) {
    if (isUnderAnyRoot(roots, p)) remote[p] = meta;
  }
  const uploads = [];
  for (const [p, meta] of Object.entries(local)) {
    if (shaOf(meta) !== (base[p] || null)) {
      uploads.push({ path: p, sha: meta.sha, mode: meta.mode, size: meta.size });
    }
  }
  for (const p of Object.keys(base)) {
    if (!isUnderAnyRoot(roots, p)) continue;
    if (!local[p] && base[p]) uploads.push({ path: p, delete: true });
  }
  const down = planThreeWay({ policy: "keep-local", remote, local, base, now });
  return { uploads, down };
}
