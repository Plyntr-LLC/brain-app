import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isDenied, isSensitiveName, MAX_BLOB_BYTES, normalizeRel } from "../../src/acl.js";

export function gitBlobSha(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const header = Buffer.from(`blob ${buf.length}\0`);
  return createHash("sha1").update(header).update(buf).digest("hex");
}

export function scanTree(miniRoot, roots) {
  const files = {};
  const skipped = [];
  const absRoot = miniRoot;
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      const rel = relative(absRoot, abs).split("\\").join("/");
      let hq;
      try {
        hq = normalizeRel(rel);
      } catch (err) {
        skipped.push({ path: rel, reason: err.message });
        continue;
      }
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        skipped.push({ path: hq, reason: "symlink" });
        continue;
      }
      if (st.isDirectory()) {
        if (isDenied(hq + "/placeholder")) {
          skipped.push({ path: hq, reason: "denylist" });
          continue;
        }
        walk(abs);
        continue;
      }
      if (!st.isFile()) continue;
      if (isDenied(hq)) {
        skipped.push({ path: hq, reason: "denylist" });
        continue;
      }
      if (isSensitiveName(hq)) {
        skipped.push({ path: hq, reason: "sensitive" });
        continue;
      }
      if (st.size > MAX_BLOB_BYTES) {
        skipped.push({ path: hq, reason: "oversized", size: st.size });
        continue;
      }
      const bytes = readFileSync(abs);
      files[hq] = {
        sha: gitBlobSha(bytes),
        mode: st.mode & 0o111 ? "100755" : "100644",
        size: st.size,
        type: "blob",
      };
    }
  }
  walk(absRoot);
  const under = {};
  for (const [p, meta] of Object.entries(files)) {
    if (roots && roots.length && !roots.some((r) => p.startsWith(r.replace(/\/?$/, "/")))) {
      skipped.push({ path: p, reason: "outside roots" });
      continue;
    }
    under[p] = meta;
  }
  return { files: under, skipped };
}

export function refuseGitRoot(miniRoot) {
  try {
    const st = lstatSync(join(miniRoot, ".git"));
    if (st.isDirectory() || st.isFile()) {
      throw new Error("mini root contains .git");
    }
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }
}
