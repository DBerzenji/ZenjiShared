# Envelope Budget

A small shared budget app. Every category is an "envelope" with a monthly planned amount. Add income and expenses, see what's left, and watch changes appear instantly on everyone's devices.

**Stack:** Node.js, Express, Turso / SQLite-compatible remote database, WebSockets (ws), plain HTML/JS frontend. No build step.

## Run locally

Requires Node 18+.

1. Copy `.env.example` and fill in your Turso values, or leave them unset to use the local SQLite fallback.
2. Install dependencies.
3. Start the app.

```bash
cp .env.example .env
npm install
npm start
```

Open http://localhost:3000. To try it on your phone, open `http://<your-computer-ip>:3000` on the same Wi-Fi.

## How sharing works

1. Create a budget. You get an 8-letter code.
2. Others tap **Join with a code** (or open the invite link from the Share button).
3. Everyone sees the same budget. When anyone adds or edits something, the server tells all connected devices, which refresh within a moment. If a connection drops, the app reconnects and refreshes by itself.

The code is the only "password", so share it privately. Anyone with the code can edit the budget. There are no accounts.

## Using it

- **+ button:** add an expense or income. Amount comes first; the last category you used is pre-selected.
- **Budget tab:** each category shows planned, spent this month, and what's left. Tap one to edit or delete it.
- **Transactions tab:** tap any transaction to edit or delete it.
- **Month arrows:** switch months. Planned amounts repeat every month; spending is counted per month.
- **Left to plan:** income this month minus the total planned amounts. Aim for zero.

## Deploy with Render + Turso

Render does not provide persistent disk for this app, so the database should live in Turso. The app reads from `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` and connects to the remote database automatically.

### 1) Create a Turso database

```bash
turso db create envelope-budget --location aws-us-east-1
```

Then copy the database URL and auth token from the Turso dashboard or CLI:

```bash
turso db show envelope-budget --url
turso db tokens create envelope-budget
```

### 2) Configure Render

In your Render service, set these environment variables:

```bash
PORT=3000
TURSO_DATABASE_URL=libsql://your-db-name.turso.io
TURSO_AUTH_TOKEN=your-token-here
```

Use the web service's normal "Build and deploy" flow. Do not rely on local disk or `DATA_DIR` for production data.

### 3) Keep the app on Render without a persistent filesystem

The server is now designed to use Turso for production and falls back to local SQLite only when no Turso variables are present. That makes local development easy without breaking the Render/Turso deployment pattern.

## Local fallback

If you do not set the Turso variables, the app falls back to a local SQLite file in `./data/budget.db` the same way as before. This is useful for development and tests.

## Backups

For a Turso database, use the Turso dashboard or CLI to clone, export, or back up the database. For local SQLite fallback, copy `budget.db` (plus `budget.db-wal` if present) from `DATA_DIR` or run:

```bash
sqlite3 data/budget.db ".backup backup.db"
```

## Files

- `server.js`: API, database, WebSocket sync
- `public/index.html`: the whole interface
- `Dockerfile`: container build
- `.env.example`: Turso config template

## Limits (by design)

No user accounts, no bank import, no recurring transactions, no rollover. Stored amounts are whole cents. If you outgrow the shared-code model, add logins in `server.js` before the `/api/b/:code` middleware.
