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

client.once(Events.ClientReady, async (c) => {
  console.log(`[bot] logged in as ${c.user.tag}`);
  console.log(`[bot] tracking user ${TARGET} across ${c.guilds.cache.size} guild(s)`);

  const stale = closeStaleSessions();
  if (stale.statusClosed || stale.activitiesClosed) {
    console.log(
      `[bot] closed ${stale.statusClosed} status + ${stale.activitiesClosed} activity session(s) left open at last shutdown`
    );
  }

  const { presence, found } = await findPresence();
  if (!found) {
    console.warn(
      `[bot] WARNING: the bot does not share a server with ${TARGET}, or the SERVER MEMBERS intent is off. ` +
        `Invite the bot to a server the user is in and enable the privileged intents.`
    );
  }
  reconcile(presence, Date.now());
  console.log(`[bot] initial status: ${presence ? presence.status : 'offline'}`);

  store.setMeta('last_heartbeat', Date.now());
  setInterval(() => store.setMeta('last_heartbeat', Date.now()), config.HEARTBEAT_SECONDS * 1000);
});

client.on(Events.PresenceUpdate, (oldPresence, newPresence) => {
  if (!newPresence || newPresence.userId !== TARGET) return;
  const ts = Date.now();
  reconcile(newPresence, ts);
  const act = newPresence.activities?.map((a) => a.name).join(', ') || 'none';
  console.log(`[bot] ${new Date(ts).toISOString()} status=${newPresence.status} activities=[${act}]`);
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
