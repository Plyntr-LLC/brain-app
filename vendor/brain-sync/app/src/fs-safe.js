import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export function absUnder(root, rel) {
  const cleaned = String(rel || "").replace(/^\/+/, "").split("/").filter(Boolean);
  const abs = resolve(join(root, ...cleaned));
  const rootRes = resolve(root);
  if (abs !== rootRes && !abs.startsWith(rootRes + sep)) {
    throw new Error("path escapes mini root");
  }
  return abs;
}

export function atomicWrite(root, rel, bytes) {
  const dest = absUnder(root, rel);
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = dest + ".bb-tmp";
  writeFileSync(tmp, bytes);
  renameSync(tmp, dest);
  return dest;
}
