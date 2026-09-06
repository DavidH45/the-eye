'use strict';

const store = require('./db');

/**
 * Build a stable de-dupe key for an activity so we can tell whether the
 * "same" activity is still running between two presence updates.
 */
function activityKey(a) {
  const type = a.type ?? 0;
  if (type === 4) return `4|${a.state || a.name || ''}`;            // Custom status
  if (type === 2) return `2|${a.name}|${a.details || ''}|${a.state || ''}|${a.syncId || a.sync_id || ''}`; // Listening
  return `${type}|${a.name || ''}`;
}

function normalizeActivity(a) {
  const assets = a.assets || null;
  return {
    akey: activityKey(a),
    type: a.type ?? 0,
    name: a.name || 'Unknown',
    details: a.details || null,
    state: a.state || null,
    sync_id: a.syncId || a.sync_id || null,
    album: (assets && (assets.largeText || assets.large_text)) || null,
    url: a.url || null,
  };
}

/**
 * Reconcile the DB's open sessions with a fresh presence snapshot.
 *
 * @param {object|null} presence  discord.js Presence, or null when the user is offline / not found
 * @param {number} ts             timestamp (unix ms) to attribute the change to
 */
function reconcile(presence, ts = Date.now()) {
  const status = presence ? presence.status : 'offline';
  const activities = presence ? (presence.activities || []) : [];

  reconcileStatus(status, ts);
  reconcileActivities(activities, ts);

  store.insertPresenceEvent({
    ts,
    status,
    desktop: presence?.clientStatus?.desktop || null,
    mobile: presence?.clientStatus?.mobile || null,
    web: presence?.clientStatus?.web || null,
    activities: JSON.stringify(activities.map(normalizeActivity)),
  });

  store.setMeta('last_status', status);
  store.setMeta('last_seen', ts);
}

function reconcileStatus(status, ts) {
  const open = store.getOpenStatusSession();
  if (open && open.status === status) return; // unchanged
  if (open) store.closeStatusSession(open.id, ts, 'change');
  store.openStatusSession(status, ts);
}

function reconcileActivities(activities, ts) {
  const normalized = activities.map(normalizeActivity);
  const seen = new Set(normalized.map((a) => a.akey));
  const open = store.getOpenActivitySessions();
  const openByKey = new Map(open.map((row) => [row.akey, row]));

  // Close activities that are no longer present.
  for (const row of open) {
    if (!seen.has(row.akey)) store.closeActivitySession(row.id, ts, 'change');
  }
  // Open activities that just started.
  for (const a of normalized) {
    if (!openByKey.has(a.akey)) store.openActivitySession({ ...a, started_at: ts });
  }
}

/**
 * On startup, decide how to treat sessions that were left open when the bot
 * last stopped. Anything still open is closed at the last heartbeat so bot
 * downtime is never counted as active / listening time.
 */
function closeStaleSessions() {
  const lastHeartbeat = Number(store.getMeta('last_heartbeat') || 0);
  const cutoff = lastHeartbeat || Date.now();
  const s = store.closeAllOpenStatusSessions(cutoff, 'downtime');
  const a = store.closeAllOpenActivitySessions(cutoff, 'downtime');
  return { statusClosed: s, activitiesClosed: a, cutoff };
}

module.exports = { reconcile, closeStaleSessions, activityKey, normalizeActivity };
