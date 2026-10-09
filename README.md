# Envelope Budget

A small shared budget app. Every category is an "envelope" with a monthly planned amount. Add income and expenses, see what's left, and watch changes appear instantly on everyone's devices.

**Stack:** Node.js, Express, SQLite (better-sqlite3), WebSockets (ws), plain HTML/JS frontend. No build step.

## Run locally

Requires Node 18+.

```bash
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

## Deploy

The app is one process with one SQLite file, so it needs a host with **persistent disk** and a single instance. Set `DATA_DIR` to a folder on that disk. Always serve over HTTPS (the app switches to `wss://` automatically).

### Docker (any host)

```bash
docker build -t envelope-budget .
docker run -d -p 3000:3000 -v budget-data:/data envelope-budget
```

### Fly.io

```bash
fly launch --no-deploy        # accept the Dockerfile
fly volumes create budget_data --size 1
# in fly.toml add:
#   [mounts]
#     source = "budget_data"
#     destination = "/data"
#   [env]
#     DATA_DIR = "/data"
fly deploy
```

### Render / Railway

Create a web service from this folder (Docker or `npm start`), attach a persistent disk mounted at `/data`, and set `DATA_DIR=/data`.

## Backups

Copy `budget.db` (plus `budget.db-wal` if present) from `DATA_DIR`, or run `sqlite3 budget.db ".backup backup.db"` while the app is running.

## Files

- `server.js`: API, database, WebSocket sync
- `public/index.html`: the whole interface
- `Dockerfile`: container build

## Limits (by design)

No user accounts, no bank import, no recurring transactions, no rollover. Stored amounts are whole cents. If you outgrow the shared-code model, add logins in `server.js` before the `/api/b/:code` middleware.
