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

### Arcane / Portainer / Dockge (UI managers)

Don't make the UI manager build the image (Arcane's compose build is flaky).
Instead let GitHub Actions build it and just pull the result.

1. **One-time:** push this repo to GitHub. The
   [`Publish Docker image`](.github/workflows/docker-publish.yml) workflow builds
   on every push to `main` and pushes `ghcr.io/<you>/the-eye:latest` to GHCR.
2. **One-time:** make the package public — GitHub → your profile → **Packages** →
   `the-eye` → **Package settings** → **Change visibility → Public**. (Or keep it
   private and add a GHCR username + PAT under Arcane → **Settings → Registries**.)
3. In [`docker-compose.arcane.yml`](docker-compose.arcane.yml) set the image line
   to your owner (`ghcr.io/davidh45/the-eye:latest` for this repo).
4. Arcane → **Projects → Create Project**, paste that compose file (or use
   **From Git Repo** with Compose File Path `docker-compose.arcane.yml`).
5. **Environment** editor — add:
   ```
   DISCORD_TOKEN=your-bot-token
   TARGET_USER_ID=549541718840705035
   HEARTBEAT_SECONDS=30
   ```
6. **Deploy.** Dashboard at `http://<host>:8080`. Use the container's
   **Console/Exec** tab for `node scripts/reset.js` / `node scripts/seed.js --force`.
7. **Updating:** push to `main`, wait for the Action, then **Pull + redeploy** the
   project in Arcane (or turn on Auto Sync + Pull Image After Sync).

No GitHub Actions? Build on the Docker host once
(`docker build -t ghcr.io/<you>/the-eye:latest . && docker push …`, or just
`docker build -t theeye:latest .` and set the image to `theeye:latest`), then
deploy the stack.

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
