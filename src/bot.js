'use strict';

const { Client, GatewayIntentBits, Partials, Events } = require('discord.js');
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

async function findPresence() {
  for (const guild of client.guilds.cache.values()) {
    try {
      const member = await guild.members.fetch({ user: TARGET, withPresences: true, force: true });
      if (member) {
        // member.presence is null when the user is offline in this guild
        return { guild, presence: member.presence || null, found: true };
      }
    } catch {
      // target is not a member of this guild
    }
  }
  return { guild: null, presence: null, found: false };
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
    const { guild, presence, found } = await findPresence();
    const ts = Date.now();
    reconcile(presence, ts);
    store.setMeta('last_heartbeat', ts);

    const status = presence ? presence.status : 'offline';
    const acts = presence?.activities?.map((a) => a.name).join(', ') || 'none';
    const clients = presence?.clientStatus
      ? Object.keys(presence.clientStatus).join('+')
      : 'none';
    console.log(
      `[bot] ${new Date(ts).toISOString()} check #${n} (${reason}): ` +
        `status=${status} clients=${clients} activities=[${acts}] ` +
        `guild=${guild ? guild.name : '-'} guilds=${client.guilds.cache.size} ` +
        `took=${ts - startedAt}ms`
    );
    if (!found) {
      console.warn(
        `[bot] check #${n}: target ${TARGET} not found in any shared server ` +
          `(invite the bot to a server they are in, and enable the SERVER MEMBERS + PRESENCE intents)`
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

client.login(config.DISCORD_TOKEN).catch((err) => {
  console.error('[bot] login failed:', err.message);
  console.error('[bot] check DISCORD_TOKEN in .env, and that the privileged intents are enabled.');
  process.exitCode = 1;
});
