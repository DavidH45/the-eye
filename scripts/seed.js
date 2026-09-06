'use strict';

// Generates ~14 days of FAKE presence + listening data so you can try the
// dashboard without waiting for real data. It OVERWRITES the real database.
// Run: node scripts/seed.js --force
//
// To get back to real data afterwards: node scripts/reset.js

if (!process.argv.includes('--force')) {
  console.error('Refusing to run: this overwrites your real data with fake data.');
  console.error('Re-run with --force if that is what you want:  node scripts/seed.js --force');
  process.exit(1);
}

const store = require('../src/db');
const { reconcile } = require('../src/tracker');

const DAY = 86400000;
const start = Date.now() - 14 * DAY;

const TRACKS = [
  { details: 'Midnight City', state: 'M83', album: 'Hurry Up, We\'re Dreaming' },
  { details: 'Redbone', state: 'Childish Gambino', album: 'Awaken, My Love!' },
  { details: 'The Less I Know The Better', state: 'Tame Impala', album: 'Currents' },
  { details: 'Nights', state: 'Frank Ocean', album: 'Blonde' },
  { details: 'Motion Sickness', state: 'Phoebe Bridgers', album: 'Stranger in the Alps' },
];
const GAMES = ['Counter-Strike 2', 'Baldur\'s Gate 3', 'Visual Studio Code', 'Factorio'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// wipe existing session data for a clean seed
store.db.exec('DELETE FROM status_sessions; DELETE FROM activity_sessions; DELETE FROM presence_events;');

let ts = start;
while (ts < Date.now()) {
  const hourOfDay = new Date(ts).getHours();
  const asleep = hourOfDay >= 2 && hourOfDay < 9;
  const active = !asleep && Math.random() > 0.25;

  let status = 'offline';
  if (active) status = pick(['online', 'online', 'online', 'idle', 'dnd']);
  else if (!asleep) status = pick(['offline', 'idle']);

  const activities = [];
  if (active && Math.random() > 0.4) {
    const t = pick(TRACKS);
    activities.push({ type: 2, name: 'Spotify', details: t.details, state: t.state, assets: { largeText: t.album }, syncId: t.details.replace(/\s/g, '') });
  }
  if (active && Math.random() > 0.6) {
    activities.push({ type: 0, name: pick(GAMES) });
  }

  reconcile({ status, activities, clientStatus: { desktop: active ? 'online' : undefined } }, ts);
  ts += (10 + Math.floor(Math.random() * 40)) * 60000; // 10–50 min steps
}

store.closeAllOpenStatusSessions(Date.now(), 'change');
store.closeAllOpenActivitySessions(Date.now(), 'change');
store.setMeta('last_heartbeat', Date.now());
store.setMeta('last_status', 'online');

const n = store.db.prepare('SELECT COUNT(*) c FROM status_sessions').get().c;
const a = store.db.prepare('SELECT COUNT(*) c FROM activity_sessions').get().c;
console.log(`seeded ${n} status sessions and ${a} activity sessions from ${new Date(start).toLocaleString()}`);
