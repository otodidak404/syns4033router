// Reads SKILL.md documents off disk. Injection decisions live in modelSkill.js —
// this module only knows how to find and parse a skill.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// <repo>/backend/open-sse/rtk -> <repo>
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

// Cap a single skill at ~60k chars. A runaway file should not eat the context window.
const MAX_SKILL_CHARS = 60_000;

const cache = new Map(); // id -> { mtimeMs, content } | null

// Skill ids reach here from the dashboard and from DB assignments; they land in
// a filesystem path, so validate before touching disk.
function isSafeSkillId(id) {
  return typeof id === "string"
    && id.length > 0
    && id.length <= 64
    && /^[a-zA-Z0-9._-]+$/.test(id)
    && !id.includes("..");
}

function skillsDir() {
  return process.env.NINEROUTER_SKILLS_DIR
    ? path.resolve(process.env.NINEROUTER_SKILLS_DIR)
    : path.join(REPO_ROOT, "skills");
}

function stripFrontmatter(raw) {
  if (!raw.startsWith("---")) return raw.trim();
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return raw.trim();
  const after = raw.indexOf("\n", end + 1); // skip past the closing delimiter line
  return (after === -1 ? "" : raw.slice(after + 1)).trim();
}

/** Skill ids available on disk (directories containing SKILL.md). */
export function listSkillIds() {
  try {
    return fs.readdirSync(skillsDir(), { withFileTypes: true })
      .filter(e => e.isDirectory() && isSafeSkillId(e.name))
      .map(e => e.name)
      .filter(id => fs.existsSync(path.join(skillsDir(), id, "SKILL.md")))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Read a skill's markdown body, cached by mtime so on-disk edits apply without
 * a restart. Frontmatter is agent-tooling metadata and is stripped — injecting it
 * would spend tokens on fields the model never reads.
 * Returns null when the skill does not exist.
 */
export function readSkill(id) {
  if (!isSafeSkillId(id)) return null;

  const file = path.join(skillsDir(), id, "SKILL.md");
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    cache.set(id, null);
    return null;
  }

  const hit = cache.get(id);
  if (hit && hit.mtimeMs === mtimeMs) return hit.content;

  let content;
  try {
    const body = stripFrontmatter(fs.readFileSync(file, "utf8"));
    content = body.length > MAX_SKILL_CHARS
      ? `${body.slice(0, MAX_SKILL_CHARS)}\n\n[skill truncated]`
      : body;
  } catch {
    content = null;
  }

  cache.set(id, { mtimeMs, content });
  return content;
}

/** Test seam — drops the mtime cache. */
export function clearSkillCache() {
  cache.clear();
}