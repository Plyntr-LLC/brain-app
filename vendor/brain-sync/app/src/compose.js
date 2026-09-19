import { existsSync, mkdirSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { renderClaudeMd, renderBrainJson } from "../../src/skeleton.js";
import { gitBlobSha } from "./scan.js";

const PACK_OVERLAY = [
  "CLAUDE.md.tmpl",
  "VERSION",
  "skills.json",
  "docs",
  "tools",
  ".claude",
  ".team-config",
];

export function extractTgz(bytes, dest) {
  mkdirSync(dest, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "bb-skel-"));
  const tgz = join(dir, "pack.tgz");
  writeFileSync(tgz, bytes);
  execFileSync("tar", ["-xzf", tgz, "-C", dest], { stdio: "pipe" });
}

export function overlayPack(miniRoot, packBytes) {
  const tmp = mkdtempSync(join(tmpdir(), "bb-pack-"));
  extractTgz(packBytes, tmp);
  for (const name of PACK_OVERLAY) {
    const from = join(tmp, name);
    if (!existsSync(from)) continue;
    cpSync(from, join(miniRoot, name), { recursive: true, force: true });
  }
}

export function rewriteGuides({ miniRoot, seat, skeletonVersion }) {
  const tmplPath = join(miniRoot, "CLAUDE.md.tmpl");
  if (existsSync(tmplPath)) {
    const claudeTmpl = readFileSync(tmplPath, "utf8");
    writeFileSync(
      join(miniRoot, "CLAUDE.md"),
      renderClaudeMd(claudeTmpl, {
        brain_label: seat.brain_label,
        roots: seat.roots,
        owner_email: seat.owner_email,
      })
    );
  }
  const localPath = join(miniRoot, "CLAUDE.local.md");
  if (existsSync(localPath)) {
    let local = readFileSync(localPath, "utf8");
    if (/^- roots:.*$/m.test(local)) {
      local = local.replace(/^- roots:.*$/m, `- roots: ${(seat.roots || []).join(", ")}`);
      writeFileSync(localPath, local);
    }
  }
  if (existsSync(join(miniRoot, ".team-config", "brain.json.tmpl"))) {
    const tmpl = readFileSync(join(miniRoot, ".team-config", "brain.json.tmpl"), "utf8");
    writeFileSync(
      join(miniRoot, ".team-config", "brain.json"),
      renderBrainJson(tmpl, {
        brain_label: seat.brain_label,
        seat_id: seat.seat_id,
        kind: seat.kind,
        roots: seat.roots,
        skeleton_version: skeletonVersion,
      })
    );
  }
}

export function composeMini({
  miniRoot,
  packBytes,
  seat,
  skeletonVersion,
}) {
  mkdirSync(miniRoot, { recursive: true });
  extractTgz(packBytes, miniRoot);
  const local = [
    `# ${seat.name || seat.email}`,
    "",
    `- name: ${seat.name || seat.email}`,
    `- email: ${seat.email}`,
    `- role: project`,
    `- brain_label: ${seat.brain_label}`,
    `- seat_id: ${seat.seat_id}`,
    `- roots: ${(seat.roots || []).join(", ")}`,
    `- Before work: read CLAUDE.md in each project folder listed in roots.`,
    "",
  ].join("\n");
  writeFileSync(join(miniRoot, "CLAUDE.local.md"), local);
  rewriteGuides({ miniRoot, seat, skeletonVersion });
  mkdirSync(join(miniRoot, "personal"), { recursive: true });
  const packSha = {};
  packSha["CLAUDE.md"] = gitBlobSha(readFileSync(join(miniRoot, "CLAUDE.md")));
  return { packSha };
}
