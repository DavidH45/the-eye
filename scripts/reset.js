'use strict';

// Wipes ALL tracked data from the database (status/activity sessions, raw
// events, meta). Use this to clear seeded/fake data before collecting real
// data. Run: node scripts/reset.js

const store = require('../src/db');

const counts = () => ({
  status: store.db.prepare('SELECT COUNT(*) c FROM status_sessions').get().c,
  activities: store.db.prepare('SELECT COUNT(*) c FROM activity_sessions').get().c,
  events: store.db.prepare('SELECT COUNT(*) c FROM presence_events').get().c,
});

const before = counts();
store.db.exec(`
  DELETE FROM status_sessions;
  DELETE FROM activity_sessions;
  DELETE FROM presence_events;
  DELETE FROM meta;
  DELETE FROM sqlite_sequence;
`);
store.db.exec('VACUUM;');

console.log('removed:', before);
console.log('database is now empty — start the bot to collect real data.');
