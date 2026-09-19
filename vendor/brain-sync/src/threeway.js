import { AbortSync, isDenied, isOversized, isSensitiveName, isSubmodule, sidecarPath } from "./acl.js";

function shaOf(entry) {
  return entry && entry.sha ? entry.sha : null;
}

function collect(files) {
  const scoped = {};
  const skips = [];
  for (const [path, entry] of Object.entries(files || {})) {
    if (isSubmodule(entry)) {
      throw new AbortSync(`submodule: ${path}`);
    }
    if (isDenied(path)) continue;
    if (isOversized(entry)) {
      skips.push({ path, reason: "oversized", size: entry.size });
      continue;
    }
    if (isSensitiveName(path)) {
      skips.push({ path, reason: "sensitive" });
      continue;
    }
    scoped[path] = { sha: entry.sha, mode: entry.mode || "100644", size: entry.size || 0, type: "blob" };
  }
  return { scoped, skips };
}

/**
 * policy:
 *   hq-wins — remote (HQ) kept, local losing bytes become a sidecar (copier tests)
 *   keep-local — local kept, remote bytes become a sidecar, base set to remote sha so local pushes next
 * delete vs edit keeps the edit in both policies.
 */
export function planThreeWay({ policy, remote, local, base = {}, now = new Date() }) {
  if (policy !== "hq-wins" && policy !== "keep-local") {
    throw new AbortSync(`unknown policy: ${policy}`);
  }
  const { scoped: remoteScoped, skips: skipR } = collect(remote);
  const { scoped: localScoped, skips: skipL } = collect(local);
  const skips = skipR.concat(skipL);

  const paths = new Set([
    ...Object.keys(remoteScoped),
    ...Object.keys(localScoped),
    ...Object.keys(base || {}),
  ]);

  const next = {};
  const sidecars = [];
  const nextBase = {};

  for (const p of paths) {
    const r = remoteScoped[p];
    const l = localScoped[p];
    const bSha = base && base[p] ? base[p] : null;
    const rSha = shaOf(r);
    const lSha = shaOf(l);
    const rChanged = rSha !== bSha;
    const lChanged = lSha !== bSha;

    if (!rChanged && !lChanged) {
      if (r) {
        next[p] = r;
        nextBase[p] = r.sha;
      }
      continue;
    }
    if (rChanged && !lChanged) {
      if (r) {
        next[p] = r;
        nextBase[p] = r.sha;
      }
      continue;
    }
    if (!rChanged && lChanged) {
      if (l) {
        next[p] = l;
        nextBase[p] = l.sha;
      }
      continue;
    }

    const rDel = !r;
    const lDel = !l;
    if (rDel && lDel) continue;
    if (rDel && !lDel) {
      next[p] = l;
      nextBase[p] = l.sha;
      continue;
    }
    if (!rDel && lDel) {
      next[p] = r;
      nextBase[p] = r.sha;
      continue;
    }
    if (rSha === lSha) {
      next[p] = r;
      nextBase[p] = r.sha;
      continue;
    }

    if (policy === "hq-wins") {
      next[p] = r;
      nextBase[p] = r.sha;
      sidecars.push({
        path: sidecarPath(p, now),
        from: p,
        meta: { sha: l.sha, mode: l.mode, size: l.size, type: "blob" },
      });
    } else {
      next[p] = l;
      nextBase[p] = r.sha;
      sidecars.push({
        path: sidecarPath(p, now),
        from: p,
        meta: { sha: r.sha, mode: r.mode, size: r.size, type: "blob" },
      });
    }
  }

  return { abort: false, next, nextBase, sidecars, skips };
}

export function applyPlan({ remote, local, plan }) {
  if (plan.abort) return plan;
  const newRemote = { ...remote };
  const newLocal = { ...local };
  const planned = new Set(Object.keys(plan.next));
  for (const k of Object.keys(newRemote)) {
    if (!planned.has(k) && !isDenied(k) && !isSensitiveName(k) && !isOversized(newRemote[k])) {
      delete newRemote[k];
    }
  }
  for (const k of Object.keys(newLocal)) {
    if (!planned.has(k) && !isDenied(k) && !isSensitiveName(k) && !isOversized(newLocal[k])) {
      delete newLocal[k];
    }
  }
  for (const [p, meta] of Object.entries(plan.next)) {
    newRemote[p] = meta;
    newLocal[p] = meta;
  }
  for (const sc of plan.sidecars) {
    newLocal[sc.path] = sc.meta;
    newRemote[sc.path] = sc.meta;
  }
  return {
    abort: false,
    newRemote,
    newLocal,
    nextBase: plan.nextBase,
    sidecars: plan.sidecars,
    skips: plan.skips,
  };
}

export function syncTrees({ policy, remote, local, base, now }) {
  try {
    const plan = planThreeWay({ policy, remote, local, base, now });
    return applyPlan({ remote, local, plan });
  } catch (err) {
    if (err instanceof AbortSync) {
      return { abort: true, reason: err.message, extra: err.extra, newRemote: null, newLocal: null };
    }
    throw err;
  }
}

export function treesEqual(a, b) {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false;
    if ((a[ak[i]] && a[ak[i]].sha) !== (b[bk[i]] && b[bk[i]].sha)) return false;
    if ((a[ak[i]] && a[ak[i]].mode) !== (b[bk[i]] && b[bk[i]].mode)) return false;
  }
  return true;
}
