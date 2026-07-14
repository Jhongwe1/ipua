# uaip — an edge-native LLM gateway & personal portal

[![CI](https://github.com/Jhongwe1/ipua/actions/workflows/ci.yml/badge.svg)](https://github.com/Jhongwe1/ipua/actions/workflows/ci.yml)
&nbsp;Live: **<https://uaip.cc.cd>** · 繁體中文版說明：**[README.zh-TW.md](./README.zh-TW.md)**

A single-maintainer engineering case study: a **zero-framework, zero-runtime-dependency
LLM gateway with member management, metering/quotas, observability and a full content portal**,
running entirely on Cloudflare Pages Functions + one D1 (SQLite) database. No servers,
no containers, no build step for the runtime — `git push` is the whole supply chain.

## What it does

| Service | Path | Notes |
|---|---|---|
| **LLM gateway (relay)** | `/relay/{channel}/…` | Members use one `uak-` key + one base URL for any upstream (OpenAI / Anthropic / Gemini / self-hosted). Upstream keys never leave the server. Streaming passthrough, per-user daily quotas + rate limits, token/latency metering scanned from the **response** stream. |
| **LLM playground** | `/playground` | Web chat over the same channels; conversations persisted in D1; SSE streaming with provider-identity sanitization for members. |
| **VPN subscription** | `/vpn` | Multi-upstream merge behind one member URL. **Invisible** to anyone not granted the service (menu, page, and API fields all hide). |
| **Content portal** | `/news` `/articles` `/p/{slug}` | SSR news/article CMS with D1-stored images, RSS, sitemap, OG/JSON-LD; custom pages creatable via API. |
| **Tools** | `/` `/ip` `/ua` | The original IP/UA lookup SPA. |
| **Admin** | `/members` `/admin` `/logs` `/api-docs` | Member/service/quota management, article CMS, visitor + error + usage dashboards, self-hosted API docs. |

Identity: Google OAuth → HttpOnly session (hashed sids). Per-service grants (`relay` / `vpn` /
`playground`) per member; admin = env-pinned email list. Everything admin-mutable is audit-logged.

## Architecture

```
                      Cloudflare edge
┌────────────────────────────────────────────────────────┐
│ static SPA (public/)          Pages Functions          │
│  /, /ip, /ua                  functions/**             │
│  CSP: sha256 inline hash       ├─ SSR shell lib/site.js│
│                                │   (per-request CSP    │
│  _headers ──────────┐          │    nonce, one exit)   │
│                     ▼          ├─ /relay pump ─────────┼──► any LLM upstream
│               ┌──────────┐     ├─ /vpn/sub merge ──────┼──► airports
│               │    D1    │◄────┤─ /api/** (JSON)       │
│               │ (SQLite) │     └─ middleware: visits   │
│               └──────────┘                             │
│  users·sessions·req_log·errlog·audit_log·content       │
└────────────────────────────────────────────────────────┘
```

Design decisions are recorded as ADRs — the honest trade-offs, not just the wins:

- [ADR-0001 Zero framework, zero runtime dependencies](./docs/adr/0001-zero-framework.md)
- [ADR-0002 One D1 database for everything](./docs/adr/0002-d1-only.md)
- [ADR-0003 Shared upstream keys + quotas, not BYOK](./docs/adr/0003-shared-key-quota-not-byok.md)
- [ADR-0004 CSP: per-request nonce (SSR) + sha256 (static)](./docs/adr/0004-csp-nonce-plus-hash.md)
- [ADR-0005 Relay metering via pump, not tee()](./docs/adr/0005-relay-pump-metering-not-tee.md)

Also: [Threat model (STRIDE)](./docs/THREAT-MODEL.md) · [Honest comparison vs one-api / LiteLLM / OpenRouter / AI Gateway](./docs/COMPARISON.md) · [Known debt](./DEBT.md) · [Latency/cost report skeleton](./docs/REPORT-SKELETON.md) · [Security policy](./SECURITY.md)

## Engineering evidence (v1.0.0)

- **170+ tests** running inside **workerd** (`@cloudflare/vitest-pool-workers`) — the same
  runtime as production, real D1, real `crypto.subtle`, real streams. Handlers are imported
  directly (bracket filenames and all) and driven with hand-built contexts; upstreams are
  mocked with `fetchMock` so tests assert *what actually got forwarded* (header stripping,
  key swapping, byte-for-byte stream fidelity).
- **CI** (GitHub Actions): typecheck → tests → apidoc drift check → CSP hash drift check.
  Deploys stay local by design (`npm run deploy`).
- **Metering**: every relay/playground request writes one `req_log` row (status, duration,
  TTFB, tokens in/out scanned from the response tail — request bodies are never buffered).
  `/logs` has visitor / error / usage dashboards with p50/p95.
- **Schema as code**: `migrations/` is the single source of truth; tests apply migrations
  before every run; production migration = `npm run migrate:remote` (incremental-only).

## Repository layout

```
functions/        Pages Functions: APIs, SSR pages, relay engine, middleware
lib/              shared server code (site shell, auth, quota, observe, chrome, playground)
public/           deployed static assets (SPA + client scripts + _headers CSP)
migrations/       D1 schema, the only source of truth
test/             vitest-pool-workers suites (unit + integration)
tools/            build-apidoc / check-csp / seed-local
docs/             ADRs, threat model, comparison, report skeleton
API.md            full API reference (source of the live /api-docs page)
AGENTS.md         operating guide for AI agents
ADMIN.md          maintainer notes (secrets live in gitignored ADMIN.local.md)
```

## Develop / test / deploy

```bash
npm ci                    # dev toolchain (vitest, wrangler, tsc) — runtime has zero deps
npm run migrate:local     # create local D1 from migrations/
npm run seed              # optional: local admin/member/channel seed
npm run dev               # http://localhost:8788 (admin APIs need no token on localhost)
npm run checks            # typecheck + full test suite
npm run deploy            # rebuild apidoc + wrangler pages deploy  (never pass ".")
npm run migrate:remote    # apply new migrations to production (run BEFORE deploy)
```

First-time setup (Cloudflare login, Google OAuth secrets, admin emails): see
[ADMIN.md](./ADMIN.md). Quick API tour (publish a post, create a page, wire the menu):
see [API.md](./API.md) — machine-readable and served live at `/api-docs`.

---

*Personal project of a single maintainer; the repo doubles as its own backup.*
