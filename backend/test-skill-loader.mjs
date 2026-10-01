// skillLoader: file discovery, frontmatter stripping, mtime cache, id safety.
// Injection is covered by test-model-skill.mjs, which owns that decision.
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.env.NINEROUTER_SKILLS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9r-skills-"));

const { readSkill, listSkillIds, clearSkillCache } =
  await import(path.join(HERE, "open-sse/rtk/skillLoader.js"));

const DIR = process.env.NINEROUTER_SKILLS_DIR;

function writeSkill(id, body, frontmatter = true) {
  fs.mkdirSync(path.join(DIR, id), { recursive: true });
  const fm = frontmatter ? `---\nname: ${id}\ndescription: test skill\n---\n\n` : "";
  fs.writeFileSync(path.join(DIR, id, "SKILL.md"), `${fm}${body}`);
  clearSkillCache();
}

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

writeSkill("demo", "DEMO-BODY-XYZ");

console.log("skillLoader");

t("reads skill body and strips frontmatter", () => {
  const c = readSkill("demo");
  assert.ok(c.includes("DEMO-BODY-XYZ"), "body present");
  assert.ok(!c.includes("name: demo"), "frontmatter stripped");
});

t("body without frontmatter is returned trimmed", () => {
  writeSkill("plain", "  NO-FRONTMATTER  ");
  assert.strictEqual(readSkill("plain"), "NO-FRONTMATTER");
});

t("missing skill returns null", () => {
  assert.strictEqual(readSkill("__nope__"), null);
});

t("listSkillIds returns only dirs with SKILL.md", () => {
  fs.mkdirSync(path.join(DIR, "empty-dir"), { recursive: true });
  clearSkillCache();
  const ids = listSkillIds();
  assert.ok(ids.includes("demo"));
  assert.ok(!ids.includes("empty-dir"), "dir without SKILL.md excluded");
  fs.rmSync(path.join(DIR, "empty-dir"), { recursive: true });
  clearSkillCache();
});

t("unsafe ids are rejected before touching disk", () => {
  assert.strictEqual(readSkill("../../../etc/passwd"), null);
  assert.strictEqual(readSkill("a/b"), null);
  assert.strictEqual(readSkill(".."), null);
  assert.strictEqual(readSkill("with space"), null);
});

t("cache invalidates when file changes", () => {
  writeSkill("demo", "FIRST-VERSION");
  assert.ok(readSkill("demo").includes("FIRST-VERSION"));
  const file = path.join(DIR, "demo", "SKILL.md");
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(file, future, future);
  assert.ok(readSkill("demo").includes("FIRST-VERSION"), "cache hit, no reread");
  writeSkill("demo", "SECOND-VERSION");
  fs.utimesSync(file, future, future);
  assert.ok(readSkill("demo").includes("SECOND-VERSION"), "cache busted on change");
});

t("oversized skill is truncated at the cap", () => {
  writeSkill("huge", "X".repeat(70_000));
  const c = readSkill("huge");
  assert.ok(c.length < 70_000, "truncated");
  assert.ok(c.endsWith("[skill truncated]"), "marked as truncated");
});

writeSkill("demo", "DEMO-BODY-XYZ");
fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);