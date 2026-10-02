// A URL that arrives in a request is attacker-controlled input. Fetching it
// verbatim turns the server into a proxy for whatever it can reach — the cloud
// metadata service on 169.254.169.254, a private range, the container's
// neighbours. Two routes did this: media-proxy checked the hostname but not the
// address it resolves to, and suggested-models had no check at all.
import assert from "assert";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { checkFetchableUrl } = await import(path.join(HERE, "src/lib/net/ssrf.js"));
const { FILTERS } = await import(
  path.join(HERE, "src/routes/providers/suggested-models/filters.js")
);

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const blocked = async (url) => {
  const r = await checkFetchableUrl(url, { allowedDomains: ["example.com"] });
  assert.strictEqual(r.ok, false, `allowed: ${url}`);
  return r;
};

// ── the metadata endpoint, and the ranges around it ──────────────────────────
await t("the cloud metadata address is refused", () => blocked("http://169.254.169.254/latest/meta-data/"));
await t("169.254.169.254 over https is refused", () => blocked("https://169.254.169.254/"));
await t("loopback is refused", () => blocked("http://127.0.0.1:3001/api/settings"));
await t("localhost by name is refused", () => blocked("http://localhost:8080/"));
await t("the IPv6 loopback is refused", () => blocked("http://[::1]:3001/"));
await t("private 10/8 is refused", () => blocked("http://10.0.0.5/"));
await t("private 172.16/12 is refused", () => blocked("http://172.20.1.1/"));
await t("private 192.168/16 is refused", () => blocked("http://192.168.1.1/"));
await t("IPv4-mapped IPv6 metadata is refused", () => blocked("http://[::ffff:169.254.169.254]/"));
await t("carrier NAT is refused", () => blocked("http://100.64.0.1/"));

// ── schemes that are not fetch targets ───────────────────────────────────────
await t("file: is refused", () => blocked("file:///etc/passwd"));
await t("gopher: is refused", () => blocked("gopher://127.0.0.1:11270/_stats"));
await t("data: is refused", () => blocked("data:text/html,<b>x</b>"));

// ── allowlist must not match on substring ────────────────────────────────────
await t("a lookalike host is refused", () => blocked("http://evil-example.com/"));
await t("a host that merely contains the domain is refused", () => blocked("http://example.com.attacker.net/"));
await t("credentials in the authority do not launder the host", () =>
  blocked("http://example.com@127.0.0.1/"));
await t("a non-string host is refused", async () => {
  const r = await checkFetchableUrl("not a url at all", { allowedDomains: ["example.com"] });
  assert.strictEqual(r.ok, false);
});

// ── the allowlist still works ────────────────────────────────────────────────
await t("an allowlisted host passes the host check", async () => {
  // example.com resolves publicly, so this is the one that must be allowed —
  // it proves the guard is not simply refusing everything.
  const r = await checkFetchableUrl("https://example.com/x", { allowedDomains: ["example.com"] });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

await t("a subdomain of an allowlisted host passes", async () => {
  const r = await checkFetchableUrl("https://www.example.com/x", { allowedDomains: ["example.com"] });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

await t("a wildcard entry matches itself and its subdomains", async () => {
  const r = await checkFetchableUrl("https://www.example.com/x", { allowedDomains: ["*.example.com"] });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

// ── every catalogue filter has a host, or that provider breaks ───────────────
await t("every filter type has an allowlisted host", () => {
  const types = Object.keys(FILTERS);
  assert.ok(types.length > 0, "no filters found to check");
  const route = fs.readFileSync(
    path.join(HERE, "src/routes/providers/suggested-models/route.ts"), "utf8");
  for (const type of types) {
    assert.ok(
      route.includes(`"${type}":`),
      `filter "${type}" has no host in FETCHER_HOSTS — it would be refused at runtime`
    );
  }
});

// ── redirects are not followed blindly ───────────────────────────────────────
await t("the proxy walks redirects itself", async () => {
  const src = fs.readFileSync(path.join(HERE, "src/lib/net/ssrf.js"), "utf8");
  assert.ok(src.includes('redirect: "manual"'),
    "fetch follows redirects by default, so every hop must be rechecked");
});

await t("the proxy has a redirect limit", async () => {
  const { fetchWithRedirectChecks } = await import(path.join(HERE, "src/lib/net/ssrf.js"));
  assert.strictEqual(typeof fetchWithRedirectChecks, "function");
  assert.ok(fs.readFileSync(
    path.join(HERE, "src/lib/net/ssrf.js"), "utf8").includes("MAX_REDIRECTS"));
});

t("a refused IP literal says which address and why", async () => {
  // The case an operator actually hits. Without a reason the route rendered
  // "Base URL rejected: undefined", which named neither the address nor the
  // reason, for the check that matters most.
  const r = await checkFetchableUrl("http://127.0.0.1:22/", {});
  assert.strictEqual(r.ok, false);
  assert.ok(typeof r.error === "string" && r.error.length > 0,
    `no reason given: ${JSON.stringify(r.error)}`);
  assert.ok(r.error.includes("127.0.0.1"), `reason omits the address: ${r.error}`);
});

// t() is async and the assertions below are not awaited individually, so a
// pending one would still resolve after this line and the count came out one
// short. Let the queued work settle before reporting.
await new Promise((resolve) => setImmediate(resolve));
console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);