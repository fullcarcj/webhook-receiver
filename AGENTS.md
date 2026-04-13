# AGENTS.md

## Cursor Cloud specific instructions

### Overview

Single-service Node.js (CommonJS) webhook receiver — entry point `server.js`, native HTTP server (no Express). See `CLAUDE.md` for full architecture and module reference.

### Prerequisites (already in VM snapshot)

- **Node.js >= 18** (system has v22)
- **PostgreSQL 16** — must be running (`sudo pg_ctlcluster 16 main start`)
- Database `webhook_receiver` owned by `postgres:postgres` on `localhost:5432`

### Environment variables

Set these before starting the server (already in `~/.bashrc`):

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/webhook_receiver
ADMIN_SECRET=dev-admin-secret
PORT=3001
```

### Starting the server

```bash
# Development (file watcher)
npm run dev

# Or plain
node server.js
```

The server auto-creates core tables on first start via `ensureSchema()` in `db-postgres.js`. Additional module tables require running SQL migrations **after** the server has started at least once (so that base tables like `productos`, `customers`, `ml_orders` exist).

### Migrations

Run these after the server has created the base schema:

```bash
# Sales module (uses pg driver, no psql needed)
npm run db:sales-all

# Other modules (also pg driver)
npm run db:crm
npm run db:loyalty
npm run db:vehicles-compat
npm run db:mostrador
npm run db:whatsapp-hub
npm run db:crm-wa-welcome
npm run db:phone-normalization
npm run db:customers-name-suggested
```

For psql-based migrations (currency, shipping, WMS, etc.), see `sql/run-migrations.md`. These have minor FK errors on fresh DBs (e.g., `users` table doesn't exist) — the core tables still get created.

### Running tests

No formal test framework (Jest/Mocha). Tests use Node's built-in `assert`:

```bash
npm run test:resolve-customer   # Unit: name sanitization, phone normalization, dedup
node tests/wasender-payload-parser.test.js  # Unit: Wasender payload parsing
```

### Key endpoints for verification

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/health` | GET | None | Basic health check (`{"status":"ok"}`) |
| `/api/v1/health` | GET | None | Public API health |
| `/webhook` | POST | None | Receive ML webhooks |
| `/api/sales?k=ADMIN_SECRET` | GET | Query/Header | Sales orders list |
| `/oauth/token-status` | GET | None | OAuth token info |

### Gotchas

- **PostgreSQL must be running** before `node server.js` — the app crashes immediately if the `pg` Pool can't connect.
- `ensureSchema()` runs once on first DB query; SQL migrations that reference `productos`, `customers`, `sales_orders` etc. will fail if run before the server has ever started.
- The `postinstall` script downloads Playwright Chromium (~112 MB) — this runs automatically on `npm install` and is needed only for the Banesco bank monitor feature.
- `oauth-env.json` is `.gitignore`d — use environment variables directly in Cloud Agent.
- No linter (ESLint/Prettier) is configured in this repo.
- `better-sqlite3` is listed as a dependency but **not used** at runtime (historical code; `db.js` always loads `db-postgres.js`).
