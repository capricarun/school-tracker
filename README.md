# School Tracker

Schools send everything on WhatsApp groups and school apps: projects, PTMs, fees, things to bring, celebrations. It is easy to miss one.
School Tracker turns those messages into a shared list for the family and **sends push reminders to both parents** before each item.

- **Paste → extract.** Paste (or, on Android, *Share*) a school message. Claude pulls out every dated item: title, type, child, date, time and place. You review and save.
- **Smart reminders.** Each type gets a sensible default schedule (3 days before, the evening before at 7 PM, the morning of at 7 AM, 1 hour before), editable per item.
- **Shared by the family.** Invite your partner or a grandparent with a link. Everyone sees the same list. When one person marks something done, reminders stop for everyone, and the others get a quiet "handled" note.
- **Custom reminders.** Add up to 10 reminders per item at any date and time you choose, on top of the default schedule (also available while reviewing extracted items).
- **Documents & notes.** Attach photos of circulars, PDFs and Office files (up to 4 MB each; phone photos are shrunk automatically), or paste content as a note, or paste a screenshot. Everyone in the family can open them in the built-in viewer, with Download, Open, Share, Copy and Delete. Files are stored in the database, so this works on Render free + Turso too.
- **Actionable notifications.** *Mark done* and *Snooze 1 hr* right from the notification.
- **Installable PWA.** It works on Android (Chrome) and iPhone (Safari → Add to Home Screen, iOS 16.4+). It has an offline shell and dark mode.

## Architecture

```
 Phone (PWA)                       Server (one Docker container)
 ───────────                       ─────────────────────────────
 index.html / app.js  ── HTTPS ──▶ Express API ──▶ SQLite (/data volume)
 sw.js (service worker)              │
   ▲  push + action buttons          ├─ /api/extract ──▶ Claude API (optional; rule parser fallback)
   └──────── Web Push ◀──────────────└─ scheduler (every 60 s): due reminders → web-push (VAPID)
```

| Piece | Choice | Why |
|---|---|---|
| API | Node 22.13+ (24 LTS recommended) + Express | Small, no build step |
| Storage | SQLite: built-in `node:sqlite` file, or Turso (hosted libSQL) when `TURSO_DATABASE_URL` is set | One file, easy backups, plenty for families |
| Reminders | In-process scheduler, idempotent `sent` table, grace window for downtime | No extra queue/cron service |
| Push | Web Push + VAPID (keys auto-generated and stored in the DB) | Works on Android and installed iOS PWAs, no app store |
| Extraction | Claude (`claude-haiku-5-5` by default) → rule parser fallback | Cheap and fast; still works with no key |
| Auth | Per-device random tokens (SHA-256 hashed at rest), single-use invite links | No passwords for parents to forget |
| Delivery | Multi-arch image on GHCR via GitHub Actions; Compose + Caddy for auto-HTTPS | Runs on any Docker host |

## Run locally

```bash
npm install
npm test
ANTHROPIC_API_KEY=sk-ant-... npm run dev   # key optional
open http://localhost:3000
```

Push works on `http://localhost` in Chrome. Phones need HTTPS (see below).

## Deploy (any Docker host)

You need a small Linux VM (1 vCPU / 512 MB is enough) and a domain or subdomain pointing at it.

```bash
git clone https://github.com/capricarun/school-tracker.git && cd school-tracker
cp .env.example .env
#   DOMAIN=school.yourdomain.com
#   PUBLIC_URL=https://school.yourdomain.com
#   ANTHROPIC_API_KEY=...        (from platform.claude.com)
docker compose up -d             # pulls ghcr.io/capricarun/school-tracker:latest + Caddy (HTTPS)
docker compose logs -f app
```

Then open `https://school.yourdomain.com` on your phone, create the family, and **set `ALLOW_SIGNUP=false`** in `.env` and run `docker compose up -d` again, so nobody else can create families on your server.

### Render free (no cost, no server to manage)

Render's free plan has no disk and sleeps after 15 idle minutes, so this setup adds two free services:

1. **Database: Turso** (hosted SQLite, free plan, no card). Sign up at turso.tech with GitHub → **Create database** (pick the region closest to you, e.g. Mumbai if offered) → copy the **database URL** (`libsql://…turso.io`) and create a **token**.
2. **Render:** sign in with GitHub → **New → Blueprint** → pick this repo. `render.yaml` sets up the free web service. Paste `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` and, optionally, `ANTHROPIC_API_KEY` → **Apply**. You get `https://school-tracker-xxxx.onrender.com`; every push to `main` redeploys.
3. **Keep it awake:** at **cron-job.org** or **UptimeRobot** (both free), add a monitor that opens `https://school-tracker-xxxx.onrender.com/healthz` **every 10 minutes**. This keeps the reminder scheduler running. One always-on free service fits in Render's 750 free hours a month.

Limits to know: free tiers can change; if the monitor misses a ping the app sleeps and reminders that fell due are sent as soon as it wakes (up to 3 hours late, `REMINDER_GRACE_MINUTES`). A deploy or restart takes about a minute, during which the app is unavailable.

**Render paid (simplest, ~$7/month):** change `plan: free` to `plan: starter` in `render.yaml`. You can then drop Turso and add a disk (`disk: {name: data, mountPath: /data, sizeGB: 1}`) and skip the uptime monitor.

**Other managed platforms (Railway / Fly.io):** deploy the Dockerfile as a web service. Mount a persistent disk at `/data` and set the env vars from `.env.example`; the platform provides HTTPS, so Caddy isn't needed. Keep it to a **single instance** (SQLite + in-process scheduler) and make sure it doesn't sleep when idle, or reminders will be late.

**Build the image yourself** instead of pulling: `docker compose up -d --build`.

### Operations

- Health: `GET /healthz` (also the Docker `HEALTHCHECK`).
- Backups: `./deploy/backup.sh ./backups` makes a hot SQLite backup. Cron it daily.
- Upgrades: `docker compose pull && docker compose up -d`. The schema is created and updated on start.
- Logs: reminder sends and extraction fallbacks are logged to stdout.
- Time zone: `TZ` (default `Asia/Kolkata`) decides when "7 PM the evening before" is.

## Using it

1. **iPhone:** open the site in Safari → Share → **Add to Home Screen** → open it from the home screen → *Turn on reminders*.
   **Android:** open in Chrome → *Install app* → *Turn on reminders*. After installing, *School Tracker* shows up in WhatsApp's Share sheet.
2. Family tab → **Invite your partner** → send the link on WhatsApp. It is single-use and valid for 7 days.
3. Tap **+** → paste the school message → **Extract details** → check → **Save**.
4. Want it on your laptop too? Family → **Sign in on another device**.

## API (all JSON; `Authorization: Bearer <device token>` unless noted)

| Method | Path | |
|---|---|---|
| POST | `/api/family` | *(public)* create family + first member → token |
| GET | `/api/invites/:code` · POST `/api/join` | *(public)* inspect / accept invite |
| GET | `/api/state` | me, family, members, children, items, activity |
| POST | `/api/extract` | `{text}` → `{engine, items[]}` (drafts, not saved) |
| POST · PATCH · DELETE | `/api/items[/:id]` | create (single or `{items:[]}`), edit, delete |
| POST | `/api/items/:id/done` · `/snooze` | `{done}` · `{minutes}` |
| POST | `/api/items/:id/attachments` | raw file body, `Content-Type`, `X-Filename` → `{id}` |
| POST | `/api/items/:id/notes` | `{text, name?}` pasted content → `{id}` |
| GET · DELETE | `/api/attachments/:id` | download / remove (family members only) |
| POST | `/api/invites` | `{linkDevice?}` → link |
| POST · PATCH · DELETE | `/api/children[/:id]` | manage children |
| | | Item `rem` accepts `3d`, `1d`, `am`, `1h` and custom `c:YYYY-MM-DDTHH:MM` |
| PATCH | `/api/me` | `{name, notify, tellDone}` |
| POST | `/api/push/subscribe` · `/unsubscribe` · `/test` | Web Push |
| POST | `/api/push-action` | *(HMAC-signed)* notification buttons |

## Roadmap ideas

- Photo of a printed circular → extraction (Claude vision)
- Daily 7 AM digest option
- Calendar (.ics) feed per family
- WhatsApp Business / Telegram bot intake so messages can be forwarded instead of pasted

## License

MIT
