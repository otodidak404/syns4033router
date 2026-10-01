import express from "express";
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
// Origin allowlist is opt-in. Empty (the default) reflects any origin, which is
// what the hosted dashboard and the CLI both need — they reach the gateway from
// arbitrary hostnames. Set CORS_ALLOWED_ORIGINS to a comma-separated list to lock
// it down. SameSite=Lax on the session cookie is what actually blocks cross-site
// state-changing calls in either mode.
const corsAllowlist = (process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (corsAllowlist.length === 0) return callback(null, origin || true);
    if (origin && corsAllowlist.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-api-key", "x-9r-cli-token"],
}));

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
