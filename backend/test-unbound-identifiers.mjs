// A scope-aware check for one specific fault, the one that kept escaping.
//
// Four separate endpoints answered 500 for every caller because of an
// unbound identifier on the first line of the body:
//
//   backend/src/sse/handlers/tts.js      apiKey      (removed by fd8fd30)
//   backend/src/sse/handlers/search.js    modelStr    (written by fd8fd30)
//   backend/src/routes/v1beta/models/…    request     (never declared)
//   backend/src/lib/db/index.js          hashApiKey  (only re-exported)
//
// In every case the module imported cleanly, `tsc --noEmit` was green, and the
// full suite passed -- because no suite called a request handler and no linter
// ran over the JavaScript. Import-time checks cannot see this class at all; it
// lives in function bodies.
//
// The rule is deliberately narrow: an identifier that is read, and that has no
// binding in any enclosing scope, and is not a property key or a member access.
// Nothing else. eslint's no-undef also works, but it needs a curated list of
// runtime globals to avoid flagging ReadableStream, TransformStream, navigator
// and friends, and each of those additions is a chance to let a real finding
// through. This has no globals list, so it has nothing to get wrong.

import assert from "assert";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";

const traverse = _traverse.default || _traverse;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOTS = ["src", "open-sse", "../frontend/src"];

// .ts is not optional here. Three of the four past defects lived in a .ts route
// file, and a .js-only check would have missed `headers: request.headers` in
// v1beta/models/[...path] outright -- verified by mutation: reintroducing that
// exact line left the .js-only guard green.
const EXTS = [".js", ".jsx", ".ts", ".tsx"];

// Node and web globals the runtime really provides. Anything read that is not in
// here and has no local binding is a finding.
const GLOBALS = new Set([
  // language
  "undefined", "NaN", "Infinity", "globalThis", "eval", "arguments",
  // node
  "process", "Buffer", "console", "setTimeout", "clearTimeout", "setInterval",
  "clearInterval", "setImmediate", "clearImmediate", "queueMicrotask",
  "structuredClone", "crypto", "performance", "module", "require", "exports",
  "__dirname", "__filename", "global", "URL", "URLSearchParams", "TextEncoder",
  "TextDecoder", "atob", "btoa", "AbortController", "AbortSignal", "fetch",
  "Request", "Response", "Headers", "FormData", "Blob", "File", "Event",
  "EventTarget", "CustomEvent", "MessageChannel", "MessagePort",
  "BroadcastChannel", "DOMException", "navigator", "WebSocket",
  "ReadableStream", "WritableStream", "TransformStream", "ByteLengthQueuingStrategy",
  "CountQueuingStrategy", "CompressionStream", "DecompressionStream",
  // the browser globals three frontend files under src/ use
  "document", "window", "location", "localStorage", "Node", "NodeFilter",
  "MutationObserver", "HTMLElement", "requestAnimationFrame",
  "cancelAnimationFrame",
  // browser globals the dashboard uses; a missing one here would bury the
  // findings under 65 alert()/confirm() hits
  "alert", "confirm", "prompt", "EventSource", "FileReader", "FileList",
  "ResizeObserver", "IntersectionObserver", "IntersectionObserverEntry",
  "getComputedStyle", "matchMedia", "requestIdleCallback", "history",
  "screen", "frames", "parent", "top", "scrollTo", "scrollBy", "getSelection",
  "Image", "Audio", "Notification", "ClipboardEvent", "CustomEvent",
  "FormData", "Headers", "Response", "Request", "AbortSignal",
  // probed with `typeof` by open-sse/executors/cursor.js to detect edge runtimes
  "caches", "EdgeRuntime",
]);

// `typeof x` on an undeclared name is legal and never throws -- that is the whole
// point of the pattern -- so a name read only inside typeof is not a fault. This
// is why caches and EdgeRuntime are listed anyway, but a name used nowhere else
// is correctly ignored without being special-cased into the list.
// TypeScript type syntax contains Identifiers that are not value reads:
// `import type { A } from ...`, `const x: Foo = ...`, `interface I { b: C }`.
// They never throw, so reporting them would bury the real findings.
const insideTypes = (p) => {
  let node = p;
  while (node) {
    if (/^TS|^ImportType|^TSType/.test(node.node?.type || "")) return true;
    node = node.parentPath;
  }
  return false;
};

const onlyInsideTypeof = (p) => {
  let node = p;
  while (node) {
    const parent = node.parentPath;
    if (!parent) return false;
    if (
      parent.node.type === "UnaryExpression" &&
      parent.node.operator === "typeof" &&
      parent.node.argument === node.node
    ) return true;
    node = parent;
  }
  return false;
};

// A key is a name, not a read. The value side is a read, and skipping it is how
// the check would have missed the search.js bug, whose whole shape was
// `clientApiKeyRequired({ model: modelStr })`.
const isNonComputedKey = (parent, node) =>
  !!parent && "key" in parent && parent.key === node && !parent.computed;

// Member accesses, labels and import/export specifiers are not free variable
// reads. Object/Class members are listed by key position only -- see
// isNonComputedKey.
// JSX braces hold ordinary expressions, so a name read there throws exactly like
// any other read. `{actionError && ...}` in a component that never declared it is
// a ReferenceError on render -- and it is invisible to `Identifier` traversal,
// because babel parses JSX names as JSXIdentifier. The detail page of every media
// provider rendered blank for exactly this reason while `tsc --noEmit` passed and
// a source scan for the string `actionError` also passed.
const JSX_SKIP = new Set(["JSXIdentifier", "JSXAttribute", "JSXMemberExpression",
                          "JSXNamespacedName", "JSXSpreadAttribute", "JSXSpreadChild"]);

const SKIP_PARENT_TYPES = new Set([
  "ImportSpecifier", "ImportDefaultSpecifier", "ImportNamespaceSpecifier",
  "ExportSpecifier", "ExportNamespaceSpecifier", "ExportDefaultSpecifier",
  "LabeledStatement", "BreakStatement", "ContinueStatement", "JSXAttribute",
  // import.meta and new.target -- MetaProperty, not a variable
  "MetaProperty",
]);

function collectFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // node_modules and test fixtures hold no source of ours
      if (entry.name === "node_modules" || entry.name === "fixtures") continue;
      collectFiles(full, acc);
    } else if (EXTS.some((e) => entry.name.endsWith(e)) && !entry.name.includes(".test.")) {
      acc.push(full);
    }
  }
  return acc;
}

/** @returns {{file: string, line: number, name: string}[]} */
export function unboundIdentifiers(file) {
  const code = fs.readFileSync(file, "utf8");
  const isTs = /\.tsx?$/.test(file);
  let ast;
  try {
    ast = parse(code, {
      sourceType: "unambiguous",
      allowReturnOutsideFunction: true,
      errorRecovery: true,
      plugins: [
        ...(isTs ? ["typescript"] : ["jsx"]),
        "classProperties", "topLevelAwait", "dynamicImport",
      ],
    });
  } catch {
    // JSX in a .js file, or syntax this parser will not take. eslint reported the
    // same three files; they are not part of the finding either way.
    return [];
  }

  const found = [];
  const filePath = path.relative(HERE, file);

  traverse(ast, {
    // `{someName}` inside JSX
    JSXExpressionContainer(p) {
      let inner = p.get("expression");
      while (inner && (inner.isJSXEmptyExpression() || inner.isJSXElement())) {
        inner = inner.get?.("expression") || null;
      }
      if (!inner || !inner.isIdentifier()) return;
      const name = inner.node.name;
      if (GLOBALS.has(name)) return;
      if (inner.scope.hasBinding(name)) return;
      if (onlyInsideTypeof(inner)) return;
      if (isTs && insideTypes(inner)) return;
      found.push({
        file: filePath,
        line: inner.node.loc?.start?.line ?? 0,
        name,
        jsx: true,
      });
    },

    Identifier(p) {
      const { node, parent } = p;
      if (node.type !== "Identifier") return;
      if (SKIP_PARENT_TYPES.has(parent?.type)) return;
      if (isNonComputedKey(parent, node)) return;
      // `foo.bar` reads foo; only the property name is not a read. Skipping the
      // whole MemberExpression is how `modelStr.includes` and `request.headers`
      // would slip through, which is the shape of every bug here.
      if (
        (parent?.type === "MemberExpression" ||
          parent?.type === "OptionalMemberExpression") &&
        parent.property === node && !parent.computed
      ) return;
      // import attributes: `with { type: "json" }`
      if (parent?.type === "ImportAttribute" && parent.key === node) return;
      if (onlyInsideTypeof(p)) return;
      if (isTs && insideTypes(p)) return;
      // A declaration is a write, not a read.
      if (
        (parent.type === "VariableDeclarator" && parent.id === node) ||
        (parent.type === "FunctionDeclaration" && parent.id === node) ||
        (parent.type === "FunctionExpression" && parent.id === node) ||
        (parent.type === "ClassDeclaration" && parent.id === node) ||
        (parent.type === "ClassExpression" && parent.id === node) ||
        parent.type === "AssignmentExpression" && parent.left === node
      ) return;

      if (p.scope.hasBinding(node.name)) return;
      if (GLOBALS.has(node.name)) return;

      found.push({
        file: filePath,
        line: node.loc?.start?.line ?? 0,
        name: node.name,
        jsx: false,
      });
    },
  });

  return found;
}

let pass = 0;
const pending = [];
const t = (name, fn) => {
  pending.push((async () => {
    try {
      await fn();
      pass++;
      console.log(`  ok   ${name}`);
    } catch (e) {
      process.exitCode = 1;
      console.log(`  FAIL ${name}\n       ${e?.message || e}`);
    }
  })());
};

const files = ROOTS.flatMap((r) => collectFiles(path.join(HERE, r)));

t("the sweep actually reaches source files", () => {
  assert.ok(files.length > 200,
    `only found ${files.length} files; the roots are wrong`);
  const byRoot = Object.fromEntries(ROOTS.map((r) =>
    [r, files.filter((f) => f.includes(`${path.sep}${r}${path.sep}`)).length]));
  assert.ok(byRoot["open-sse"] > 50, `open-sse only ${byRoot["open-sse"]}`);
  assert.ok(byRoot["src"] > 50, `src only ${byRoot["src"]}`);

  // The .ts route files are the ones that actually carried the defects.
  const ts = files.filter((f) => f.endsWith(".ts"));
  assert.ok(ts.length > 20, `only ${ts.length} .ts files scanned`);
  const kindRoute = ts.find((f) => f.includes("v1beta") && f.includes("path"));
  assert.ok(kindRoute, "the v1beta route file is not being scanned");

  // The frontend .jsx files matter as much as the routes: a state declared in one
  // component and read in another component's JSX rendered every media-provider
  // detail page blank, and nothing else in the suite could see it.
  const jsx = files.filter((f) => f.endsWith(".jsx"));
  assert.ok(jsx.length > 100, `only ${jsx.length} .jsx files scanned`);
  const connCard = jsx.find((f) => f.endsWith("ConnectionsCard.jsx"));
  assert.ok(connCard, "ConnectionsCard.jsx is not being scanned");
});

t("no identifier is read without a binding", () => {
  const found = files.flatMap(unboundIdentifiers);
  if (found.length) {
    const shown = found.slice(0, 25)
      .map((f) => `${f.file}:${f.line} ${f.name}${f.jsx ? "  (inside JSX)" : ""}`).join("\n       ");
    throw new Error(
      `${found.length} unbound identifier(s) -- each one is a ReferenceError on ` +
      `the line it is read:\n       ${shown}` +
      (found.length > 25 ? `\n       …and ${found.length - 25} more` : ""));
  }
});

t("the check still catches the four bugs it exists for", () => {
  // Each of these is a real past defect, reproduced in memory. If the rule goes
  // quiet this fails, which is the only way to know a rewrite has not broken it.
  const cases = [
    ["const { required } = gate();\n  if (!apiKey) return err();\n", "apiKey"],
    ["if (clientApiKeyRequired({ model: modelStr }).required) {}\n", "modelStr"],
    ["export { x } from './m.js';\nexport async function GET(req) {\n  return use(request.body);\n}\n", "request"],
    ["export { hashApiKey } from './m.js';\nexport async function importDb(o) {\n  return hashApiKey(o.key);\n}\n", "hashApiKey"],
  ];
  const tmp = path.join(HERE, ".unbound-probe.mjs");
  try {
    for (const [code, name] of cases) {
      fs.writeFileSync(tmp, code);
      const found = unboundIdentifiers(tmp).map((f) => f.name);
      assert.ok(found.includes(name),
        `expected "${name}" to be reported, got ${JSON.stringify(found)}`);
    }
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
});

t("the check catches an unbound name used inside JSX", () => {
  // The exact shape that blanked every media-provider detail page: a state
  // declared in one component, read in another component's JSX.
  const tmp = path.join(HERE, ".jsx-probe.jsx");
  try {
    fs.writeFileSync(tmp, [
      "function Child() {",
      '  return <div>{actionError}</div>;',
      "}",
      "function Parent() {",
      "  const [realError, setRealError] = useState('');",
      "  return <Child />;",
      "}",
      "export default function App() {",
      "  const [actionError, setActionError] = useState('');",
      "  return <section>{actionError && <b>{actionError}</b>}</section>;",
      "}",
    ].join("\n"));
    const found = unboundIdentifiers(tmp).filter((f) => f.jsx);
    assert.ok(found.some((f) => f.name === "actionError"),
      "the unbound JSX name was not reported");
    assert.ok(!found.some((f) => f.name === "realError"),
      "a bound name was wrongly reported");
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
});

t("bound names are not reported", () => {
  const tmp = path.join(HERE, ".unbound-probe.mjs");
  try {
    fs.writeFileSync(tmp, [
      "import x from './m.js';",
      "const a = 1, b = a + 1;",
      "function f(p = {}) { const { q } = p; return { q, a, x }; }",
      "class C { constructor() { this.v = 1; } m() { return this.v; } }",
      "const g = (n) => n?.length ?? 0;",
      "const o = { k: 1, b, f };",
      "export { b, f, g };",
      "let h; h ??= b;",
    ].join("\n"));
    const found = unboundIdentifiers(tmp);
    assert.equal(found.length, 0,
      `false positives: ${JSON.stringify(found.map((f) => `${f.line}:${f.name}`))}`);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
});

Promise.all(pending).then(() =>
  console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`));