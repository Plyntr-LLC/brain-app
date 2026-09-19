/** Path ACL. Fail closed. Trailing-slash containment: projects/bible does not match projects/bible2. */

export const MAX_BLOB_BYTES = 50 * 1024 * 1024;
export const SYNC_MARKER = "[brain-sync]";
export const SUBMODULE_MODE = "160000";
export const SYMLINK_MODE = "120000";
export const ALLOWED_FILE_MODES = new Set(["100644", "100755"]);
export const ALLOWED_ROOT_PREFIXES = ["projects/", "clients/"];

const DENY_SEGMENTS = new Set([
  ".git",
  ".github",
  ".team-config",
  "personal",
  "node_modules",
  "__pycache__",
  "sessions",
]);

export class AbortSync extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = "AbortSync";
    this.extra = extra;
  }
}

export function normalizeRel(rel) {
  if (typeof rel !== "string") throw new AbortSync("path is not a string");
  if (rel.includes("\0")) throw new AbortSync("path contains a null byte");
  if (rel.includes("\\")) throw new AbortSync(`path contains a backslash: ${rel}`);
  const trimmed = rel.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) throw new AbortSync("path is empty");
  const parts = trimmed.split("/");
  if (parts.some((s) => s === "" || s === "." || s === "..")) {
    throw new AbortSync(`path has illegal segments: ${rel}`);
  }
  return parts.join("/");
}

/** Stored form: projects/bible/ or clients/foo/. At least two segments. */
export function normalizeRoot(root) {
  if (typeof root !== "string") throw new AbortSync("root is not a string");
  let trimmed = root.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!trimmed) throw new AbortSync("root is empty");
  if (trimmed === "/" || trimmed === ".") throw new AbortSync("root is not a folder");
  if (!trimmed.endsWith("/")) trimmed += "/";
  const inner = trimmed.slice(0, -1);
  const parts = inner.split("/");
  if (parts.some((s) => s === "" || s === "." || s === "..")) {
    throw new AbortSync(`root has illegal segments: ${root}`);
  }
  if (parts.length < 2) throw new AbortSync(`root must have at least two segments: ${root}`);
  const ok = ALLOWED_ROOT_PREFIXES.some((p) => trimmed.startsWith(p) && trimmed !== p);
  if (!ok) throw new AbortSync(`root must be under projects/ or clients/: ${root}`);
  return trimmed;
}

export function isUnderRoot(root, hqPath) {
  const r = normalizeRoot(root);
  let raw;
  try {
    raw = normalizeRel(hqPath);
  } catch {
    return false;
  }
  return raw.startsWith(r);
}

export function isUnderAnyRoot(roots, hqPath) {
  if (!Array.isArray(roots) || roots.length === 0) return false;
  return roots.some((root) => {
    try {
      return isUnderRoot(root, hqPath);
    } catch {
      return false;
    }
  });
}

export function rootsOverlap(a, b) {
  const x = normalizeRoot(a);
  const y = normalizeRoot(b);
  return x === y || x.startsWith(y) || y.startsWith(x);
}

export function isDenied(hqPath) {
  let rel;
  try {
    rel = normalizeRel(hqPath);
  } catch {
    return true;
  }
  const parts = rel.split("/");
  if (parts.some((seg) => DENY_SEGMENTS.has(seg))) return true;
  if (parts.includes(".claude") && parts.includes("sessions")) return true;
  const base = parts[parts.length - 1] || "";
  if (base === "CLAUDE.local.md" || base === ".DS_Store") return true;
  if (isCredentialName(base)) return true;
  return false;
}

const CREDENTIAL_BASENAMES = new Set([
  "credentials.json",
  "token.json",
  "oauth-token.json",
  "service-account.json",
  "google-ads.yaml",
  "gads-proxy.yaml",
  "cloudflare.yaml",
  ".dev.vars",
  ".doppler.yaml",
  "settings.local.json",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
]);

export function isCredentialName(base) {
  const name = String(base || "");
  if (!name) return false;
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (CREDENTIAL_BASENAMES.has(name)) return true;
  if (name.endsWith(".secret")) return true;
  if (/^token-.+\.json$/i.test(name)) return true;
  if (/\.pem$/i.test(name)) return true;
  return false;
}

const SENSITIVE_TOKEN = /(^|[^a-z0-9])(salary|salaries|payroll|private)([^a-z0-9]|$)/i;

export function isSensitiveName(hqPath) {
  let rel;
  try {
    rel = normalizeRel(hqPath);
  } catch {
    return true;
  }
  const base = rel.split("/").pop() || "";
  return SENSITIVE_TOKEN.test(base);
}

export function isOversized(entry) {
  const size = Number(entry && entry.size);
  return Number.isFinite(size) && size > MAX_BLOB_BYTES;
}

export function isSubmodule(entry) {
  return Boolean(entry && (entry.mode === SUBMODULE_MODE || entry.type === "commit"));
}

export function isSymlink(entry) {
  return Boolean(entry && entry.mode === SYMLINK_MODE);
}

export function sidecarPath(hqPath, date = new Date()) {
  const rel = normalizeRel(hqPath);
  const slash = rel.lastIndexOf("/");
  const dir = slash === -1 ? "" : rel.slice(0, slash + 1);
  const base = slash === -1 ? rel : rel.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  const day = date.toISOString().slice(0, 10);
  let name;
  if (dot > 0) {
    name = `${base.slice(0, dot)}__from-remote-${day}${base.slice(dot)}`;
  } else {
    name = `${base}__from-remote-${day}`;
  }
  return `${dir}${name}`;
}

export function isSyncCommitMessage(message) {
  return typeof message === "string" && message.includes(SYNC_MARKER);
}

/**
 * Worker commit gate. Returns {ok:true} or {ok:false, reason}.
 * Never accepts a tree sha or parent from the client (caller must not pass them).
 */
export function validateCommitEntry(path, entry, roots) {
  let rel;
  try {
    rel = normalizeRel(path);
  } catch (err) {
    return { ok: false, path, reason: err.message };
  }
  if (!isUnderAnyRoot(roots, rel)) {
    return { ok: false, path: rel, reason: "outside allowed roots" };
  }
  if (isDenied(rel)) {
    return { ok: false, path: rel, reason: "denylist" };
  }
  if (isSensitiveName(rel)) {
    return { ok: false, path: rel, reason: "sensitive" };
  }
  if (entry && entry.delete === true) {
    return { ok: true, path: rel, delete: true };
  }
  const mode = entry && entry.mode;
  if (!ALLOWED_FILE_MODES.has(mode)) {
    return { ok: false, path: rel, reason: `mode not allowed: ${mode}` };
  }
  if (isSubmodule(entry) || isSymlink(entry)) {
    return { ok: false, path: rel, reason: "symlink or submodule" };
  }
  if (isOversized(entry)) {
    return { ok: false, path: rel, reason: "oversized" };
  }
  if (entry && (entry.tree_sha || entry.parent || entry.base_tree)) {
    return { ok: false, path: rel, reason: "client tree sha not accepted" };
  }
  return { ok: true, path: rel };
}

export function filterManifest(files, roots) {
  const out = [];
  for (const f of files || []) {
    const path = f && f.path;
    if (!path) continue;
    try {
      const rel = normalizeRel(path);
      if (!isUnderAnyRoot(roots, rel)) continue;
      if (isDenied(rel)) continue;
      out.push({ ...f, path: rel });
    } catch {
      continue;
    }
  }
  return out;
}
