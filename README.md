# SYNS4033ROUTER

> A self-hosted AI gateway: one endpoint, many providers, automatic fallback.

SYNS4033ROUTER is a self-hosted AI gateway with a focus on portable deployment, persistent storage, secure configuration, and a reliable dashboard. It is a jailbreak-router: you attach a system prompt and skill docs per model, and they are injected into every matching customer request.

## Lineage and attribution

This project is built on the work of others, and it would be wrong to present it otherwise:

1. [decolua/9router](https://github.com/decolua/9router) — the original 9Router project, routing engine, and provider integrations.
2. [ahwanulm/9router-v2](https://github.com/ahwanulm/9router-v2) — the Express backend and Vite + React frontend rewrite.
3. **SYNS4033ROUTER** — packaging that turns the V2 architecture into a standalone template for local machines, Docker, VPS, and supported PaaS environments.

The routing engine and provider integrations remain upstream work. SYNS4033ROUTER covers deployment, reliability, configuration, and the per-model prompt/skill injection layer.

---

## What SYNS4033ROUTER adds over the upstream versions

| Capability | Upstream single-binary | V2 architecture | SYNS4033ROUTER |
|---|:---:|:---:|:---:|
| OpenAI-compatible API | ✅ | ✅ | ✅ |
| Multi-provider routing and fallback | ✅ | ✅ | ✅ |
| Separate backend and frontend | ❌ | ✅ | ✅ |
| Express backend with a Vite/React dashboard | ❌ | ✅ | ✅ |
| Multi-stage production Docker image | ❌ | ❌ | ✅ |
| API and dashboard in one service | ❌ | ❌ | ✅ |
| Local development workflow | ✅ | ✅ | ✅ |
| Docker deployment | ❌ | ❌ | ✅ |
| VPS deployment guide | ❌ | ✅ | ✅ |
| Heroku `Procfile` support | ❌ | ❌ | ✅ |
| Configurable persistent data directory | ❌ | ✅ | ✅ |
| Railway deployment configuration | ❌ | ❌ | ✅ |
| Self-hosted Material Symbols | ❌ | ❌ | ✅ |
| API-key dialog with loading and error feedback | ❌ | ❌ | ✅ |
| SYNS4033ROUTER branding, logo, and login experience | ❌ | ❌ | ✅ |
| Generated browser profiles excluded from Git | ❌ | ❌ | ✅ |

SYNS4033ROUTER does not claim authorship of the routing engine or provider integrations. Those remain upstream work; the focus here is packaging, deployment, reliability, and per-model prompt injection.

---

## Features

- **OpenAI-compatible REST API** for chat, image generation, audio, embeddings, web search, and related endpoints.
- **Multi-provider routing** with load balancing, fallback, and key rotation.
- **Modern dashboard** for providers, connections, proxy pools, CLI tools, automation, usage, and security settings.
- **Password and OIDC authentication** for dashboard access.
- **SQLite or PostgreSQL persistence**, selected automatically through `DATABASE_URL`.
- **Cloudflare Workers AI automation** with Playwright, CAPTCHA providers, and temporary email.
- **Agent Skills** for Claude, Gemini, Codex, and other coding agents.
- **Portable deployment** for local machines, Docker, Railway, Heroku, and Linux VPS hosts.

---

## Architecture

```text
9router-v3/
├── backend/
│   └── src/
│       ├── routes/       # API and auto-routed endpoints
│       ├── lib/db/       # SQLite/PostgreSQL repositories and adapters
│       └── automation/   # Browser automation
├── frontend/
│   ├── public/branding/  # V3 logo and favicon
│   └── src/              # Vite + React dashboard
├── skills/               # Agent SKILL.md files
├── Dockerfile
├── Procfile
└── railway.toml
```

---

## Deployment Options

### Common Environment Variables

Start from [`backend/.env.example`](./backend/.env.example). The main runtime variables are:

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | Signs dashboard sessions |
| `INITIAL_PASSWORD` | Initial dashboard password; required until a password is stored |
| `API_KEY_SECRET` | Signs generated API keys |
| `DATABASE_URL` | Optional PostgreSQL connection string; when set, PostgreSQL replaces SQLite |
| `DATA_DIR` | Stores SQLite data, logs, and runtime files; still used for non-database runtime files with PostgreSQL |
| `NODE_ENV` | Use `production` outside local development |
| `PORT` | HTTP port; most PaaS providers inject this automatically |

Never commit real secrets.

### Run Locally

Requirements:

- Node.js 20+
- Python 3.10+ for automation features
- Chromium or Camoufox for browser automation

Install:

```bash
git clone https://github.com/otodidak404/syns4033router.git syns4033router
cd 9router-v3
npm install
cp backend/.env.example backend/.env
```

Replace PaaS expressions such as `${{secret(32)}}` with normal random secrets in `backend/.env`.

Development commands:

```bash
npm run dev       # Backend and frontend with development servers
npm run backend   # Backend only
npm run frontend  # Frontend only
```

Local production mode:

```bash
npm run build
npm start
```

The production server listens on `PORT` and serves both the API and built frontend.

### Run with Docker

Build and start the image:

```bash
docker build -t 9router-v3 .
docker run --rm -p 3001:3001 \
  -e PORT=3001 \
  -e NODE_ENV=production \
  -e DATA_DIR=/data \
  -e JWT_SECRET=replace-with-a-random-secret \
  -e INITIAL_PASSWORD=replace-with-a-secure-password \
  -e API_KEY_SECRET=replace-with-a-random-secret \
  -v 9router-data:/data \
  9router-v3
```

Open `http://localhost:3001`.

### Deploy to a VPS

This works on providers such as **Hetzner, Contabo, DigitalOcean, Linode, Vultr, AWS EC2**, or any Debian/Ubuntu server.

Recommended options:

- Run the Docker image behind Nginx or Caddy.
- Run Node.js directly with systemd and Nginx.
- Store `DATA_DIR` on a persistent disk.
- Add TLS through Caddy, Certbot, or Cloudflare.

See the complete [`Linux deployment guide`](./docs/deployment-linux.md) for systemd, Nginx, backups, updates, and troubleshooting.

### Deploy to Heroku

The included [`Procfile`](./Procfile) starts the production server, while `heroku-postbuild` compiles the frontend and backend.

```bash
heroku create your-9router-v3
heroku config:set \
  NODE_ENV=production \
  JWT_SECRET=replace-with-a-random-secret \
  INITIAL_PASSWORD=replace-with-a-secure-password \
  API_KEY_SECRET=replace-with-a-random-secret \
  DATA_DIR=/tmp/9router-v3
git push heroku main
```

Heroku injects `PORT` automatically.

> Heroku's dyno filesystem is ephemeral. Set `DATABASE_URL` to a managed PostgreSQL database for persistent application data, or use Heroku only for testing with SQLite.

### Deploy to Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https%3A%2F%2Fgithub.com%2Fotodidak404%2Fsyns4033router)

**OR**

1. Create a service from this repository.
2. Copy variables from `backend/.env.example` into the **Variables** tab.
3. Add a Railway PostgreSQL service and expose its `DATABASE_URL` to SYNS4033ROUTER, or attach a Railway Volume at `/data` to keep using SQLite.
4. Generate a public domain under **Settings → Networking**.

Railway builds the included Dockerfile. It supplies `RAILWAY_PUBLIC_DOMAIN`, `RAILWAY_PRIVATE_DOMAIN`, and `PORT` automatically. The Dockerfile intentionally omits the unsupported Docker `VOLUME` instruction.

### Switching Between SQLite and PostgreSQL

- Without `DATABASE_URL`, SYNS4033ROUTER uses SQLite at `DATA_DIR/db/data.sqlite`.
- With a non-empty `DATABASE_URL`, SYNS4033ROUTER initializes and uses PostgreSQL.
- SQLite and PostgreSQL are separate data stores. Before switching an existing installation, export the database from the dashboard, set or remove `DATABASE_URL`, restart, then import the exported data.

---

## Main API Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Health check |
| `GET /v1/models` | List models |
| `POST /v1/chat/completions` | Chat completions |
| `POST /v1/images/generations` | Image generation |
| `POST /v1/audio/speech` | Text-to-speech |
| `POST /v1/audio/transcriptions` | Speech-to-text |
| `POST /v1/embeddings` | Embeddings |
| `GET /v1/search` | Web search |

---

## Agent Skills

Start with the entry skill:

```text
https://raw.githubusercontent.com/otodidak404/syns4033router/refs/heads/master/skills/9router/SKILL.md
```

Additional skills are available in [`skills/`](./skills/).

---


## License and Attribution

This project is licensed under the MIT License. See [`LICENSE`](./LICENSE).

Thanks to:

- [decolua/9router](https://github.com/decolua/9router) for the original project, routing logic, and provider integrations.
- [ahwanulm/9router-v2](https://github.com/ahwanulm/9router-v2) for the V2 rewrite and Express + Vite/React architecture.
- **codestorm** as the creator and maintainer of the **SYNS4033ROUTER** continuation.

Upstream copyright notices remain intact out of respect for the original authors and in compliance with the license.
