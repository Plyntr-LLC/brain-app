import { readFileSync } from "node:fs";
import { join } from "node:path";

export function skeletonVersion(packRoot) {
  return readFileSync(join(packRoot, "VERSION"), "utf8").trim();
}

export function renderTemplate(tmpl, vars) {
  let out = String(tmpl);
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(String(v));
  }
  return out;
}

export function folderPrefix(root) {
  return String(root || "").replace(/\/+$/, "");
}

export function readFirstFromRoots(roots) {
  if (!Array.isArray(roots) || !roots.length) return "- (none yet)";
  const lines = [];
  for (const r of roots) {
    const p = folderPrefix(r);
    if (!p) continue;
    lines.push(`- \`${p}/CLAUDE.md\``);
    lines.push(`- \`${p}/context.md\``);
    lines.push(`- \`${p}/README.md\``);
  }
  return lines.join("\n");
}

export function renderClaudeMd(tmpl, { brain_label, roots, owner_email }) {
  const list = (roots || []).map((r) => `- \`${r}\``).join("\n") || "- (none)";
  return renderTemplate(tmpl, {
    brain_label,
    roots: list,
    read_first: readFirstFromRoots(roots),
    owner_email: owner_email || "",
  });
}

export function renderBrainJson(tmpl, { brain_label, seat_id, kind, roots, skeleton_version }) {
  return renderTemplate(tmpl, {
    brain_label,
    seat_id,
    kind,
    roots_json: JSON.stringify(roots || []),
    skeleton_version,
  });
}
