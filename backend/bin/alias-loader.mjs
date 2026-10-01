import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const distDir = path.resolve(process.cwd(), "dist");

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith("@/")) {
    return nextResolve(specifier, context);
  }

  const target = path.join(distDir, specifier.slice(2));
  const candidates = [target, `${target}.js`, path.join(target, "index.js")];
  const match = candidates.find((candidate) => fs.existsSync(candidate));

  if (!match) {
    return nextResolve(specifier, context);
  }

  return { shortCircuit: true, url: pathToFileURL(match).href };
}
