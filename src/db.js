'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { DB_PATH } = require('./config');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per continuous stretch of a single presence status.
CREATE TABLE IF NOT EXISTS status_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  status        TEXT    NOT NULL,          -- online | idle | dnd | offline
  started_at    INTEGER NOT NULL,          -- unix ms
  ended_at      INTEGER,                   -- unix ms, NULL while ongoing
  closed_reason TEXT                       -- change | downtime | shutdown
);
CREATE INDEX IF NOT EXISTS idx_status_started ON status_sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_status_open    ON status_sessions(ended_at) WHERE ended_at IS NULL;

-- One row per continuous stretch of a single activity (game, Spotify track, stream, custom status...).
CREATE TABLE IF NOT EXISTS activity_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  akey          TEXT    NOT NULL,          -- de-dupe key
  type          INTEGER NOT NULL,          -- 0 Playing 1 Streaming 2 Listening 3 Watching 4 Custom 5 Competing
  name          TEXT    NOT NULL,          -- "Spotify", game name, ...
  details       TEXT,                      -- song title / rich-presence line 1
  state         TEXT,                      -- artist(s) / rich-presence line 2
  sync_id       TEXT,                      -- Spotify track id
  album         TEXT,                      -- Spotify album
  url           TEXT,                      -- stream url
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  closed_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_activity_started ON activity_sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_activity_type    ON activity_sessions(type);
CREATE INDEX IF NOT EXISTS idx_activity_open    ON activity_sessions(ended_at) WHERE ended_at IS NULL;

-- Raw append-only log, mostly for debugging / minute-level client status.
CREATE TABLE IF NOT EXISTS presence_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  status   TEXT    NOT NULL,
  desktop  TEXT,
  mobile   TEXT,
  web      TEXT,
  activities TEXT                          -- JSON snapshot
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON presence_events(ts);
`);

const stmt = {
  getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
  setMeta: db.prepare(
    'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ),

  getOpenStatus: db.prepare('SELECT * FROM status_sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1'),
  openStatus: db.prepare('INSERT INTO status_sessions(status, started_at) VALUES(?, ?)'),
  closeStatus: db.prepare('UPDATE status_sessions SET ended_at = ?, closed_reason = ? WHERE id = ?'),
  closeAllOpenStatus: db.prepare(
    'UPDATE status_sessions SET ended_at = ?, closed_reason = ? WHERE ended_at IS NULL'
  ),

  getOpenActivities: db.prepare('SELECT * FROM activity_sessions WHERE ended_at IS NULL'),
  openActivity: db.prepare(`
    INSERT INTO activity_sessions(akey, type, name, details, state, sync_id, album, url, started_at)
    VALUES(@akey, @type, @name, @details, @state, @sync_id, @album, @url, @started_at)
  `),
  closeActivity: db.prepare('UPDATE activity_sessions SET ended_at = ?, closed_reason = ? WHERE id = ?'),
  closeAllOpenActivities: db.prepare(
    'UPDATE activity_sessions SET ended_at = ?, closed_reason = ? WHERE ended_at IS NULL'
  ),

  insertEvent: db.prepare(`
    INSERT INTO presence_events(ts, status, desktop, mobile, web, activities)
    VALUES(@ts, @status, @desktop, @mobile, @web, @activities)
  `),
};

module.exports = {
  db,

  getMeta(key) {
    const row = stmt.getMeta.get(key);
    return row ? row.value : null;
  },
  setMeta(key, value) {
    stmt.setMeta.run(key, String(value));
  },

  getOpenStatusSession() {
    return stmt.getOpenStatus.get();
  },
  openStatusSession(status, ts) {
    return stmt.openStatus.run(status, ts).lastInsertRowid;
  },
  closeStatusSession(id, ts, reason) {
    stmt.closeStatus.run(ts, reason, id);
  },
  closeAllOpenStatusSessions(ts, reason) {
    return stmt.closeAllOpenStatus.run(ts, reason).changes;
  },

  getOpenActivitySessions() {
    return stmt.getOpenActivities.all();
  },
  openActivitySession(row) {
    return stmt.openActivity.run({
      details: null, state: null, sync_id: null, album: null, url: null,
      ...row,
    }).lastInsertRowid;
  },
  closeActivitySession(id, ts, reason) {
    stmt.closeActivity.run(ts, reason, id);
  },
  closeAllOpenActivitySessions(ts, reason) {
    return stmt.closeAllOpenActivities.run(ts, reason).changes;
  },

  insertPresenceEvent(row) {
    stmt.insertEvent.run({
      desktop: null, mobile: null, web: null, activities: null,
      ...row,
    });
  },
};
