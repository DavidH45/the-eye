# The Eye

Track a single Discord user's presence over time and explore it on a local dashboard.

- **Bot** (`src/bot.js`) — watches the target user's presence and writes every
  status change, activity and Spotify track to a local SQLite file.
- **Web** (`src/server.js`) — a no-login dashboard at `http://localhost:3000`
  with day / hour / minute breakdowns, total active time, an online heatmap,
  top tracks & artists, and full session logs.

Everything is stored in `./data/theeye.db` on your machine. Nothing leaves it.

## Setup

1. **Create a bot application**
   - <https://discord.com/developers/applications> → *New Application*
   - *Bot* tab → *Reset Token* → copy the token
   - On the same tab enable **Presence Intent** and **Server Members Intent**
     (both required — presence data is invisible without them)
2. **Invite the bot to a server the target user is in**
   - *OAuth2* → *URL Generator* → scope `bot` → open the URL, pick the server.
   - The bot only needs to be *present* in a shared server; no special permissions.
3. **Get the target user's ID**
   - Discord → Settings → Advanced → enable *Developer Mode*
   - Right-click the user → *Copy User ID*
4. **Configure**
   ```
   cp .env.example .env
   ```
   Fill in `DISCORD_TOKEN` and `TARGET_USER_ID`.
5. **Install & run**
   ```
   npm install
   npm start          # runs the bot + dashboard together
   ```
   Or run the parts separately: `npm run bot` and `npm run web`.

Open <http://localhost:3000>.

## Docker

```
cp .env.example .env      # fill in DISCORD_TOKEN and TARGET_USER_ID
docker compose up -d --build
```

Dashboard on <http://localhost:8080> (host `8080` → container `3000`).

- One container runs both the bot and the dashboard (`src/index.js`).
- The SQLite database lives in the named volume `theeye_data` (mounted at
  `/app/data`), so it survives `docker compose down` and rebuilds.
- Inside the container the environment is clean, so the `DISCORD_TOKEN` in
  `.env` is always used (no host env var shadows it).

Useful commands:

```
docker compose logs -f theeye     # follow bot + web logs
docker compose restart theeye
docker compose down               # stop (keeps the volume / data)
docker compose down -v            # stop AND delete the database
```

Reset seeded/real data without removing the volume:

```
docker compose exec theeye node scripts/reset.js
```

### Arcane (easiest — deploy straight from GitHub)

Arcane clones the repo and builds the image for you; nothing to do on the host.

1. **Customization → Git Repositories → Add Repository**
   - URL: `https://github.com/DavidH45/the-eye.git` (public — no token needed)
2. **Projects → Create Project ▾ → From Git Repo**
   - Sync Name: `theeye`
   - Repository: the one you just added · Branch: `main`
   - **Compose File Path:** `docker-compose.arcane.yml`
   - *Auto Sync* optional (polls GitHub and redeploys on new commits)
   - Create Sync
3. On the project page, open the **Environment** editor and add:
   ```
   DISCORD_TOKEN=your-bot-token
   TARGET_USER_ID=549541718840705035
   HEARTBEAT_SECONDS=30
   ```
4. Click **Build & Deploy** (the `build:` directive makes Arcane build first).
5. Dashboard: `http://<host>:8080`. Use the container's **Console/Exec** tab for
   `node scripts/reset.js` or `node scripts/seed.js --force`.
6. **Updating:** push to `main`, then **Build & Deploy** again (or let Auto Sync
   do it).

### Portainer / Dockge / Arcane without git sync

Build the image on the Docker host once, then paste the stack:

1. On the host: `git clone … && cd the-eye && docker build -t theeye:latest .`
2. New stack → paste [`docker-compose.arcane.yml`](docker-compose.arcane.yml) →
   set `DISCORD_TOKEN` / `TARGET_USER_ID` in the env editor → deploy. The
   pre-built `theeye:latest` image is reused.
3. **Updating:** `docker build -t theeye:latest .` again, then recreate the stack.

Prefer a registry? `docker build -t ghcr.io/<you>/theeye:latest . && docker push …`,
then set `image: ghcr.io/<you>/theeye:latest` and drop the `build:` line.

## Trying it without real data

```
node scripts/seed.js --force              # local
docker compose exec theeye node scripts/seed.js --force   # in Docker
```

Generates ~14 days of fake presence and listening history so you can see the
dashboard populated. It **overwrites** existing session data — run
`npm run reset` (or `scripts/reset.js`) to get back to a clean DB.

## Notes

- Discord never sends presence for offline users in a "reliable push" way; the
  bot reconciles on every `presenceUpdate` and on startup, and records a
  heartbeat every `HEARTBEAT_SECONDS`. While the bot is down, time is recorded
  as *untracked* (not offline) — the dashboard shows a **data coverage** figure
  so you know how complete a range is.
- Client status (desktop / mobile / web) is captured in the raw
  `presence_events` table if you want to query it directly.
- Activity types: 0 Playing · 1 Streaming · 2 Listening (Spotify) · 3 Watching ·
  4 Custom status · 5 Competing.

## Data model (`src/db.js`)

| table               | what it holds                                             |
|---------------------|----------------------------------------------------------|
| `status_sessions`   | one row per continuous stretch of one status             |
| `activity_sessions` | one row per continuous stretch of one activity / track   |
| `presence_events`   | append-only raw snapshots (status, client status, JSON)  |
| `meta`              | `last_heartbeat`, `last_status`, `last_seen`             |
