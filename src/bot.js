'use strict';

const { Client, GatewayIntentBits, IntentsBitField, Partials, Events } = require('discord.js');
const config = require('./config');
const store = require('./db');
const { reconcile, closeStaleSessions } = require('./tracker');

const TARGET = config.TARGET_USER_ID;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.GuildMember, Partials.User],
});

const STATUS_RANK = { online: 4, idle: 3, dnd: 2, invisible: 1, offline: 0 };

function presenceIntentEnabled() {
  return new IntentsBitField(client.options.intents).has(GatewayIntentBits.GuildPresences);
}

// Guild ids where the target has been seen as a member. Once known, routine
// checks only hit these guilds instead of scanning every server the bot is in.
let targetGuildIds = null;

/**
 * Look the target up and return the "most online" presence found across the
 * guilds they share with the bot. `withPresences: true` asks the gateway for a
 * fresh presence; it comes back only when the PRESENCE intent is enabled and
 * the user is not offline, so a null presence means "offline or not visible".
 *
 * @param {{full?: boolean}} opts  full = rescan every guild (startup / periodic)
 * @returns {{found: boolean, presence: object|null, guild: object|null, diag: string[], scanned: number}}
 */
async function findPresence({ full = false } = {}) {
  const diag = [];
  const useScoped = !full && targetGuildIds && targetGuildIds.size > 0;
  const guilds = useScoped
    ? [...targetGuildIds].map((id) => client.guilds.cache.get(id)).filter(Boolean)
    : [...client.guilds.cache.values()];

  let found = false;
  let best = null;
  let bestGuild = null;
  const foundIds = new Set();

  for (const guild of guilds) {
    let member = null;
    try {
      const fetched = await guild.members.fetch({ user: [TARGET], withPresences: true });
      member = fetched.get(TARGET) || null;
    } catch (err) {
      diag.push(`${guild.name}: fetch failed (${err.message})`);
      continue;
    }
    if (!member) {
      if (!useScoped) diag.push(`${guild.name}: target is not a member`);
      continue;
    }
    found = true;
    foundIds.add(guild.id);
    const p = member.presence || guild.presences.resolve(TARGET) || null;
    diag.push(
      `${guild.name}: presence=${p ? p.status : 'none'} ` +
        `(guild presence cache: ${guild.presences.cache.size}, members cached: ${guild.members.cache.size})`
    );
    const rank = p ? STATUS_RANK[p.status] ?? 0 : -1;
    const bestRank = best ? STATUS_RANK[best.status] ?? 0 : -1;
    if (rank > bestRank) {
      best = p;
      bestGuild = guild;
    }
  }

  if (full || targetGuildIds === null) {
    targetGuildIds = foundIds;
  } else {
    for (const id of foundIds) targetGuildIds.add(id);
  }

  return { found, presence: best, guild: bestGuild, diag, scanned: guilds.length };
}

let checkCount = 0;
let checking = false;

/**
 * Actively re-read the target's presence, reconcile it into the DB and log a
 * one-line summary. Runs on startup and on every heartbeat tick, so the log
 * shows the bot is alive even when the user's presence never changes.
 */
async function check(reason) {
  if (checking) {
    console.log(`[bot] ${new Date().toISOString()} check (${reason}) skipped: previous check still running`);
    return;
  }
  checking = true;
  const n = ++checkCount;
  const startedAt = Date.now();
  try {
    // Full rescan on startup and every 20th check, so newly shared guilds are
    // picked up; otherwise just re-check the guild(s) the target is known in.
    const full = reason === 'startup' || n % 20 === 0;
    let result = await findPresence({ full });
    // A scoped check that lost the target (they left the guild, cache eviction)
    // is retried as a full scan before we record them as offline.
    if (!full && !result.found) {
      result = await findPresence({ full: true });
    }
    const { guild, presence, found, diag, scanned } = result;
    const ts = Date.now();
    reconcile(presence, ts);
    store.setMeta('last_heartbeat', ts);

    const status = presence ? presence.status : found ? 'offline' : 'unknown';
    const acts = presence?.activities?.map((a) => a.name).join(', ') || 'none';
    const clients = presence?.clientStatus
      ? Object.keys(presence.clientStatus).join('+')
      : 'none';
    console.log(
      `[bot] ${new Date(ts).toISOString()} check #${n} (${reason}${full ? ', full scan' : ''}): ` +
        `status=${status} clients=${clients} activities=[${acts}] ` +
        `guild=${guild ? guild.name : '-'} scanned=${scanned}/${client.guilds.cache.size} ` +
        `took=${ts - startedAt}ms`
    );
    for (const line of diag) console.log(`[bot]   - ${line}`);

    if (!presenceIntentEnabled()) {
      console.warn(`[bot] check #${n}: GuildPresences is missing from the client intents — status will always look offline`);
    } else if (!found) {
      console.warn(
        `[bot] check #${n}: target ${TARGET} is not a member of any of the ${client.guilds.cache.size} server(s) the bot is in — ` +
          `invite the bot to a server they are in`
      );
    } else if (!presence) {
      console.warn(
        `[bot] check #${n}: found the member but Discord returned no presence. Either they are genuinely offline, ` +
          `or the PRESENCE INTENT is still off in the Developer Portal (Bot tab -> Presence Intent), ` +
          `or the bot is not in the same server where they are online`
      );
    }
  } catch (err) {
    console.error(`[bot] check #${n} (${reason}) failed:`, err.message);
  } finally {
    checking = false;
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`[bot] logged in as ${c.user.tag}`);
  console.log(`[bot] tracking user ${TARGET} across ${c.guilds.cache.size} guild(s)`);
  console.log(
    `[bot] intents: presences=${presenceIntentEnabled()} ` +
      `members=${new IntentsBitField(client.options.intents).has(GatewayIntentBits.GuildMembers)}`
  );
  for (const g of c.guilds.cache.values()) {
    console.log(`[bot]   guild "${g.name}" (${g.id}): ${g.memberCount} members, presence cache ${g.presences.cache.size}`);
  }
  if (!presenceIntentEnabled()) {
    console.warn('[bot] PRESENCE INTENT is not enabled for this client — every status will be recorded as offline.');
  }

  const stale = closeStaleSessions();
  if (stale.statusClosed || stale.activitiesClosed) {
    console.log(
      `[bot] closed ${stale.statusClosed} status + ${stale.activitiesClosed} activity session(s) left open at last shutdown`
    );
  }

  await check('startup');

  console.log(`[bot] heartbeat every ${config.HEARTBEAT_SECONDS}s`);
  setInterval(() => check('heartbeat'), config.HEARTBEAT_SECONDS * 1000);
});

client.on(Events.PresenceUpdate, (oldPresence, newPresence) => {
  if (!newPresence || newPresence.userId !== TARGET) return;
  const ts = Date.now();
  reconcile(newPresence, ts);
  const from = oldPresence ? oldPresence.status : 'unknown';
  const act = newPresence.activities?.map((a) => a.name).join(', ') || 'none';
  console.log(
    `[bot] ${new Date(ts).toISOString()} presenceUpdate: ${from} -> ${newPresence.status} activities=[${act}]`
  );
});

function shutdown() {
  const ts = Date.now();
  store.closeAllOpenStatusSessions(ts, 'shutdown');
  store.closeAllOpenActivitySessions(ts, 'shutdown');
  store.setMeta('last_heartbeat', ts);
  console.log('[bot] shutting down, sessions closed');
  client.destroy();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.on(Events.Error, (err) => console.error('[bot] client error:', err.message));
client.on(Events.Warn, (msg) => console.warn('[bot] warn:', msg));
client.on(Events.ShardDisconnect, (event) => {
  console.error(`[bot] gateway disconnected (code ${event.code})`);
  if (event.code === 4014) {
    console.error(
      '[bot] code 4014 = disallowed intents: enable "Presence Intent" and "Server Members Intent" ' +
        'on the Bot tab at https://discord.com/developers/applications'
    );
  }
});

client.login(config.DISCORD_TOKEN).catch((err) => {
  console.error('[bot] login failed:', err.message);
  console.error('[bot] check DISCORD_TOKEN in .env, and that the privileged intents are enabled.');
  process.exitCode = 1;
});
