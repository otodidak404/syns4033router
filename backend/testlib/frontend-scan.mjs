// Shared scanner for the "a rejected write looked like it succeeded" class.
//
// fetch() rejects only on a network error. An HTTP 404 or 500 is an ordinary
// response that resolves, so `Promise.all` resolves and `Promise.allSettled`
// reports `fulfilled` with ok === false. Any batch of writes written that way
// can fail completely while the code around it believes it worked.
//
// This found itself on four pages — /dashboard/providers (7 sites),
// /dashboard/combos, /dashboard/usage and /dashboard/media-providers — each in a
// different shape, each found by reading one page at a time. Hence one scanner
// rather than a per-page assertion.
import fs from "node:fs";
import path from "path";

const WRITE = /method:\s*"(PUT|POST|PATCH|DELETE)"/;
// The /g is load-bearing: matchAll rejects a non-global pattern, and the form
// before it — /Promise\.allS?ettled?\s*\(/ — required a literal "settle", so
// `Promise.all(` never matched and the scan silently found nothing.
const BATCH = /Promise\.all(?:Settled)?\s*\(/g;
const GUARDED = /\)\.then\(expectOk\)/;

export function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(jsx|tsx|js|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * Every write inside a Promise.all / allSettled in `src`.
 *
 * A fetch options object spans several lines and the guard is chained past the
 * closing paren, so the batch is cut out by matching its own brackets — a
 * line-window wide enough to hold a multi-line fetch also reaches past the batch
 * and flags writes that were never part of it.
 *
 * @returns {{method: string, guarded: boolean, chained: string}[]}
 */
export function batchedWrites(src) {
  const hits = [];
  for (const m of src.matchAll(BATCH)) {
    const open = m.index + m[0].length - 1;
    let depth = 0, close = -1;
    for (let j = open; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")") { depth--; if (depth === 0) { close = j; break; } }
    }
    if (close < 0) continue;

    const batch = src.slice(open, close + 1);
    let idx = 0;
    while ((idx = batch.indexOf("fetch(", idx)) !== -1) {
      let d = 0, k = batch.indexOf("(", idx);
      while (k < batch.length) {
        if (batch[k] === "(") d++;
        else if (batch[k] === ")") { d--; if (d === 0) break; }
        k++;
      }
      const chained = batch.slice(idx, k + 40);
      const method = chained.match(WRITE);
      if (method) hits.push({ method: method[1], guarded: GUARDED.test(chained), chained });
      idx = k + 1;
    }
  }
  return hits;
}

/** Guarded and unguarded batched writes across a source root, relative paths. */
export function scanForUnguarded(root) {
  const offenders = [];
  let checked = 0;
  for (const f of walk(root)) {
    for (const h of batchedWrites(fs.readFileSync(f, "utf8"))) {
      checked++;
      if (!h.guarded) {
        offenders.push({
          file: path.relative(root, f),
          method: h.method,
          snippet: h.chained.split(/\s+/).join(" ").slice(0, 70),
        });
      }
    }
  }
  return { checked, offenders };
}

/** Render offenders for an assertion message. */
export const describeOffenders = (offenders) =>
  offenders.map((o) => `${o.file}  batched ${o.method}  ${o.snippet}`).join("\n       ");