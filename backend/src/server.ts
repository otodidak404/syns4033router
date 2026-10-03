import express, { type Request } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authMiddleware, requiresAuth } from "./middleware/auth.js";
import { buildAutoRouter } from "./autoRouter.js";
import { runFirstRunBootstrap } from "./lib/bootstrap/firstRun.js";
import { getSettings, updateSettings } from "./lib/localDb.js";

// Load backend/.env before anything reads process.env. Platform deploys inject
// real env vars and Node applies those on top, so an explicit value there still
// wins — this only fills the gaps for local runs and Docker builds where the
// file is the operator's own configuration.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.resolve(__dirname, "../.env");
if (fs.existsSync(ENV_FILE)) {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch (e) {
    console.warn(`[env] could not read ${ENV_FILE}: ${e.message}`);
  }
}

const PORT = Number(process.env.PORT) || 3001;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5177";
const FRONTEND_DIST = path.resolve(__dirname, "../../frontend/dist");

const app = express();

// ─── Security ─────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// ─── CORS ─────────────────────────────────────────────────────────────────────
// The dashboard is served by this same Express app, so its own requests are
// same-origin and need no CORS header at all. The only genuine cross-origin
// clients are the Vite dev server during `npm run dev`, and anyone who explicitly
// lists a host in CORS_ALLOWED_ORIGINS.
//
// This used to reflect any Origin together with credentials:true. Measured
// against the deployed instance, `Origin: https://evil.example` came back as
// `access-control-allow-origin: https://evil.example` +
// `access-control-allow-credentials: true`, as did `Origin: null`. SameSite=Lax
// on the session cookie kept that from becoming a session read, but it is not a
// control anyone should have to rely on, and a null origin is a sandboxed iframe
// or a file:// page. Reflect only what is actually expected; send no header
// otherwise, which is what "not allowed" looks like to a browser.
//
// Note that /v1 route handlers set their own `Access-Control-Allow-Origin: *`
// (about 70 sites). That is normal for a token-authenticated public API and this
// middleware does not override it -- the two surfaces authenticate differently,
// cookies here, bearer headers there.
const corsAllowlist = (process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const DEV_CORS_ORIGINS = [
  "http://localhost:5177", "http://127.0.0.1:5177",
  "http://localhost:5173", "http://127.0.0.1:5173",
];
if (process.env.NODE_ENV !== "production") {
  for (const o of DEV_CORS_ORIGINS) if (!corsAllowlist.includes(o)) corsAllowlist.push(o);
}

const sameOrigin = (req: Request): boolean => {
  const host = req.headers.host;
  if (!host) return false;
  return (req.headers.origin || "").replace(/^https?:\/\//i, "") === host;
};

app.use(cors((req, callback) => {
  const origin = req.headers.origin;
  const allowed = !origin || sameOrigin(req) || corsAllowlist.includes(origin);
  callback(null, {
    origin: allowed && origin ? origin : false,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-api-key", "x-9r-cli-token"],
  });
}));

// ─── Cache Policy ─────────────────────────────────────────────────────────────
// Nothing under /api, /v1 or /v1beta is cacheable. /api/settings returns
// JWT_SECRET, API_KEY_SECRET and MACHINE_ID_SALT in plaintext, and
// /api/settings/database returns those plus the full configuration. With no
// Cache-Control a browser or an intermediary is free to keep them, and a shared
// proxy then holds the session signing secret. Set here rather than per route so
// a response a route forgot to mark is still not stored.
// because the body differs per viewer and must not be revalidated by a cache.
app.use((req, res, next) => {
  const p = req.path.toLowerCase();
  if (p === "/api" || p.startsWith("/api/") ||
      p === "/v1" || p.startsWith("/v1/") ||
      p === "/v1beta" || p.startsWith("/v1beta/")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    // No ETag handling here on purpose. Express generates one while sending the
    // body, which is after this middleware runs, so removing it at this point
    // does nothing — the header is still present in the response. It is also
    // harmless: no-store forbids a cache from storing the response at all, so
    // there is nothing to revalidate against.
  }
  next();
});

// ─── Body Parsing ─────────────────────────────────────────────────────────────
app.use(cookieParser());
app.use(express.json({ limit: "128mb" }));
app.use(express.urlencoded({ extended: true, limit: "128mb" }));

// ─── Health Check (no auth) ────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", version: "3.0.0", ts: Date.now() });
});

// ─── Auth Middleware ───────────────────────────────────────────────────────────
// Authentication only applies to API/proxy traffic. Applying it globally would
// prevent the login page and SPA assets from loading when login is required.
//
// requiresAuth is shared with the middleware and the tests so the gate cannot
// drift from what it protects. It must stay case-insensitive: Express matches
// the /api and /v1 mounts case-insensitively, so /API/keys reaches the same
// handlers as /api/keys. A case-sensitive gate here skipped authMiddleware
// entirely for the uppercase spelling.
app.use((req, res, next) => {
  if (requiresAuth(req.path)) return authMiddleware(req, res, next);
  return next();
});

// ─── Auto-mount all routes ────────────────────────────────────────────────────
async function start() {
  // Before anything reads a secret, so the first request never sees a half
  // configured process.
  try {
    await runFirstRunBootstrap({ getSettings, updateSettings });
  } catch (err) {
    console.error("[bootstrap] failed to auto-configure:", err);
  }

  const apiRouter = await buildAutoRouter();
  app.use("/api", (req, res, next) => {
    console.log("API request:", req.method, req.url, req.originalUrl);
    apiRouter(req, res, next);
  });

  // LLM proxy remaps: /v1/* → /api/v1/*
  app.use("/v1", (req, res, next) => {
    req.url = "/v1" + req.url;
    apiRouter(req, res, next);
  });
  app.use("/v1beta", (req, res, next) => {
    req.url = "/v1beta" + req.url;
    apiRouter(req, res, next);
  });

  app.use(["/api", "/v1", "/v1beta"], (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // Serve the production SPA from the same origin as the API.
  app.use(express.static(FRONTEND_DIST, { index: false, redirect: false }));
  app.use((req, res, next) => {
    if (req.method === "GET" && req.accepts("html")) {
      return res.sendFile(path.join(FRONTEND_DIST, "index.html"));
    }
    return next();
  });

  // ─── 404 Fallback ──────────────────────────────────────────────────────────
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));

  // ─── Error Handler ─────────────────────────────────────────────────────────
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[server] unhandled error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  });

  app.listen(PORT, () => {
    console.log(`\n🚀 SYNS4033ROUTER Backend running on http://localhost:${PORT}`);
    console.log(`   Frontend origin: ${FRONTEND_ORIGIN}`);
    console.log(`   Environment: ${process.env.NODE_ENV || "development"}\n`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

export { app };
