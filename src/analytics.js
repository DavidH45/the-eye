'use strict';

const { db } = require('./db');

const HOUR = 3600000;
const DAY = 86400000;

const selectStatus = db.prepare(`
  SELECT * FROM status_sessions
  WHERE started_at < @to AND (ended_at IS NULL OR ended_at > @from)
  ORDER BY started_at
`);
const selectActivity = db.prepare(`
  SELECT * FROM activity_sessions
  WHERE started_at < @to AND (ended_at IS NULL OR ended_at > @from)
  ORDER BY started_at
`);
const selectEvents = db.prepare(`
  SELECT ts, desktop, mobile, web FROM presence_events
  WHERE ts >= ? AND ts <= ? ORDER BY ts
`);

const now = () => Date.now();

const CLIENTS = ['desktop', 'mobile', 'web'];
const CLIENT_GAP = 15 * 60000; // treat a > 15 min hole in the log as "no data"

// Collapse the raw presence log covering [from, to] into spans annotated with
// the set of Discord clients that were reported online during each one.
function clientSpans(from, to) {
  const rows = selectEvents.all(from - CLIENT_GAP, to + CLIENT_GAP);
  const spans = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const gap = rows[i + 1].ts - rows[i].ts;
    if (gap <= 0 || gap > CLIENT_GAP) continue;
    const on = CLIENTS.filter((k) => rows[i][k]);
    if (on.length) spans.push({ a: rows[i].ts, b: rows[i + 1].ts, on });
  }
  return spans;
}

// Which clients covered a session window [start, end], ranked by how much of it
// each one was online for. Returns [] when there's nothing to attribute.
function clientsFor(spans, start, end) {
  const ms = { desktop: 0, mobile: 0, web: 0 };
  for (const s of spans) {
    const a = Math.max(s.a, start);
    const b = Math.min(s.b, end);
    if (b <= a) continue;
    for (const k of s.on) ms[k] += b - a;
  }
  return CLIENTS
    .filter((k) => ms[k] > 0)
    .sort((x, y) => ms[y] - ms[x])
    .map((k) => ({ client: k, seconds: Math.round(ms[k] / 1000) }));
}

function clip(s, from, to) {
  const a = Math.max(s.started_at, from);
  const b = Math.min(s.ended_at ?? now(), to);
  return b > a ? [a, b] : null;
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Split [a, b] on local-day boundaries. `shift` = tzOffsetMin * 60000.
// Returns [[localDayStartMs, segmentMs], ...].
function splitByLocalDay(a, b, shift) {
  const out = [];
  let cur = a;
  while (cur < b) {
    const dayStartLocal = Math.floor((cur - shift) / DAY) * DAY;
    const dayEndUtc = dayStartLocal + DAY + shift;
    const segEnd = Math.min(b, dayEndUtc);
    out.push([dayStartLocal, segEnd - cur]);
    cur = segEnd;
  }
  return out;
}

// Raw millisecond totals per status for a window.
function statusTotals(from, to) {
  const per = { online: 0, idle: 0, dnd: 0, offline: 0 };
  for (const s of selectStatus.all({ from, to })) {
    const c = clip(s, from, to);
    if (!c) continue;
    per[s.status] = (per[s.status] || 0) + (c[1] - c[0]);
  }
  const tracked = per.online + per.idle + per.dnd + per.offline;
  const active = per.online + per.idle + per.dnd;
  return { per, tracked, active };
}

function activeRatioOver(from, to) {
  const { tracked, active } = statusTotals(from, to);
  return tracked ? active / tracked : 0;
}

/* ------------------------------- summary -------------------------------- */

const STATUSES = ['online', 'idle', 'dnd', 'offline'];

function summary(from, to, tzOffsetMin = 0) {
  const shift = tzOffsetMin * 60000;
  const sessions = selectStatus.all({ from, to });
  const perStatus = { online: 0, idle: 0, dnd: 0, offline: 0 };
  let longestOnline = 0;
  let statusChanges = 0;

  // per-status session durations (for avg / median / extremes)
  const durs = { online: [], idle: [], dnd: [], offline: [] };
  // status -> status transition counts (real changes only, not tracker downtime)
  const transitions = new Map();
  // active seconds per local day
  const daily = new Map();
  let prevReal = null;

  for (const s of sessions) {
    const c = clip(s, from, to);
    if (!c) continue;
    const dur = c[1] - c[0];
    perStatus[s.status] = (perStatus[s.status] || 0) + dur;
    durs[s.status]?.push(dur / 1000);
    if (s.status === 'online' && dur > longestOnline) longestOnline = dur;
    if (s.started_at >= from && s.closed_reason !== 'downtime') statusChanges++;

    if (prevReal && prevReal.closed_reason !== 'downtime' && prevReal.status !== s.status && s.started_at >= from) {
      const key = `${prevReal.status}>${s.status}`;
      transitions.set(key, (transitions.get(key) || 0) + 1);
    }
    prevReal = s;

    for (const [day, seg] of splitByLocalDay(c[0], c[1], shift)) {
      const rec = daily.get(day) || { day, online: 0, idle: 0, dnd: 0, offline: 0, listening: 0, gaming: 0 };
      rec[s.status] += seg;
      daily.set(day, rec);
    }
  }

  const tracked = perStatus.online + perStatus.idle + perStatus.dnd + perStatus.offline;
  const active = perStatus.online + perStatus.idle + perStatus.dnd;

  const acts = selectActivity.all({ from, to });
  let listeningMs = 0;
  const tracks = new Set();
  const artists = new Set();
  let gameMs = 0;
  const games = new Map();
  for (const a of acts) {
    const c = clip(a, from, to);
    if (!c) continue;
    const dur = c[1] - c[0];
    if (a.type === 2) {
      listeningMs += dur;
      if (a.details) tracks.add(`${a.details} — ${a.state || ''}`);
      if (a.state) a.state.split(/[;,]| and /i).forEach((x) => x.trim() && artists.add(x.trim()));
    } else if (a.type !== 4) {
      gameMs += dur;
      games.set(a.name, (games.get(a.name) || 0) + dur);
    }
    if (a.type === 2 || a.type !== 4) {
      const bucket = a.type === 2 ? 'listening' : 'gaming';
      for (const [day, seg] of splitByLocalDay(c[0], c[1], shift)) {
        const rec = daily.get(day) || { day, online: 0, idle: 0, dnd: 0, offline: 0, listening: 0, gaming: 0 };
        rec[bucket] += seg;
        daily.set(day, rec);
      }
    }
  }
  const topGame = [...games.entries()].sort((x, y) => y[1] - x[1])[0];

  const sessionStats = {};
  for (const k of STATUSES) {
    const d = durs[k];
    const total = d.reduce((a, b) => a + b, 0);
    sessionStats[k] = {
      count: d.length,
      totalSeconds: Math.round(total),
      avgSeconds: d.length ? Math.round(total / d.length) : 0,
      medianSeconds: Math.round(median(d)),
      longestSeconds: d.length ? Math.round(Math.max(...d)) : 0,
      shortestSeconds: d.length ? Math.round(Math.min(...d)) : 0,
    };
  }

  const dailyOut = [...daily.values()]
    .sort((a, b) => a.day - b.day)
    .map((r) => {
      const t = r.online + r.idle + r.dnd + r.offline;
      return {
        day: r.day,
        online: Math.round(r.online / 1000),
        idle: Math.round(r.idle / 1000),
        dnd: Math.round(r.dnd / 1000),
        offline: Math.round(r.offline / 1000),
        active: Math.round((r.online + r.idle + r.dnd) / 1000),
        listening: Math.round(r.listening / 1000),
        gaming: Math.round(r.gaming / 1000),
        coverage: t / DAY,
      };
    });

  return {
    range: { from, to, span: to - from },
    now: Date.now(),
    seconds: {
      online: Math.round(perStatus.online / 1000),
      idle: Math.round(perStatus.idle / 1000),
      dnd: Math.round(perStatus.dnd / 1000),
      offline: Math.round(perStatus.offline / 1000),
      tracked: Math.round(tracked / 1000),
      active: Math.round(active / 1000),
      listening: Math.round(listeningMs / 1000),
      gaming: Math.round(gameMs / 1000),
    },
    coverage: tracked / (to - from),
    activeRatio: tracked ? active / tracked : 0,
    longestOnlineSeconds: Math.round(longestOnline / 1000),
    statusChanges,
    changesPerDay: statusChanges / Math.max(1, (to - from) / DAY),
    uniqueTracks: tracks.size,
    uniqueArtists: artists.size,
    topGame: topGame ? { name: topGame[0], seconds: Math.round(topGame[1] / 1000) } : null,
    sessionStats,
    transitions: [...transitions.entries()]
      .map(([k, count]) => ({ from: k.split('>')[0], to: k.split('>')[1], count }))
      .sort((a, b) => b.count - a.count),
    byClient: clientTotals(from, to),
    daily: dailyOut,
  };
}

// Approximate time spent on each Discord client (desktop / mobile / web) by
// walking the raw presence_events and attributing each < 15 min gap to whatever
// clients were reported at the start of it.
function clientTotals(from, to) {
  if (to - from > 120 * DAY) return null; // too many rows to be worth it
  const rows = db
    .prepare('SELECT ts, desktop, mobile, web FROM presence_events WHERE ts >= ? AND ts <= ? ORDER BY ts')
    .all(from, to);
  const out = { desktop: 0, mobile: 0, web: 0, multi: 0, any: 0 };
  for (let i = 0; i < rows.length - 1; i++) {
    const gap = rows[i + 1].ts - rows[i].ts;
    if (gap <= 0 || gap > 15 * 60000) continue;
    const on = ['desktop', 'mobile', 'web'].filter((k) => rows[i][k]);
    for (const k of on) out[k] += gap;
    if (on.length) out.any += gap;
    if (on.length > 1) out.multi += gap;
  }
  for (const k of Object.keys(out)) out[k] = Math.round(out[k] / 1000);
  return out;
}

/* ------------------------------ timeline -------------------------------- */

function timeline(from, to) {
  const spans = to - from <= 120 * DAY ? clientSpans(from, to) : [];
  return selectStatus.all({ from, to }).map((s) => {
    const c = clip(s, from, to);
    const start = c ? c[0] : s.started_at;
    const end = c ? c[1] : (s.ended_at ?? now());
    return {
      status: s.status,
      start,
      end: c ? c[1] : s.ended_at,
      ongoing: s.ended_at == null,
      seconds: c ? Math.round((c[1] - c[0]) / 1000) : 0,
      clients: clientsFor(spans, start, end),
    };
  });
}

/* ----------------------------- breakdown -------------------------------- */

function bucketize(sessions, from, to, bucketMs, tzOffsetMin) {
  const shift = tzOffsetMin * 60000;
  const out = new Map();
  for (const s of sessions) {
    const c = clip(s, from, to);
    if (!c) continue;
    let cur = c[0];
    const end = c[1];
    while (cur < end) {
      const localCur = cur - shift;
      const bStartLocal = Math.floor(localCur / bucketMs) * bucketMs;
      const bEndUtc = bStartLocal + bucketMs + shift;
      const segEnd = Math.min(end, bEndUtc);
      const rec = out.get(bStartLocal) || { online: 0, idle: 0, dnd: 0, offline: 0 };
      rec[s.status] += segEnd - cur;
      out.set(bStartLocal, rec);
      cur = segEnd;
    }
  }
  return [...out.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, v]) => ({
      bucketStart: k,
      online: Math.round(v.online / 1000),
      idle: Math.round(v.idle / 1000),
      dnd: Math.round(v.dnd / 1000),
      offline: Math.round(v.offline / 1000),
      active: Math.round((v.online + v.idle + v.dnd) / 1000),
    }));
}

function breakdown(from, to, bucket, tzOffsetMin) {
  const bucketMs = bucket === 'minute' ? 60000 : bucket === 'hour' ? HOUR : DAY;
  const points = Math.ceil((to - from) / bucketMs);
  if (points > 20000) {
    throw Object.assign(new Error('Range too large for that resolution. Pick a shorter range or a bigger bucket.'), { status: 400 });
  }
  return {
    bucket,
    tzOffsetMin,
    points: bucketize(selectStatus.all({ from, to }), from, to, bucketMs, tzOffsetMin),
  };
}

/* ------------------------------ heatmap -------------------------------- */

function heatmap(from, to, tzOffsetMin) {
  const hours = bucketize(selectStatus.all({ from, to }), from, to, HOUR, tzOffsetMin);
  // grid[dow][hour] = active seconds ; dow 0 = Sunday (local wall clock)
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const h of hours) {
    const d = new Date(h.bucketStart); // bucketStart encodes local wall-clock in UTC space
    grid[d.getUTCDay()][d.getUTCHours()] += h.active;
  }

  const byHour = new Array(24).fill(0);
  const byDay = new Array(7).fill(0);
  let peak = { day: 0, hour: 0, seconds: 0 };
  grid.forEach((row, d) =>
    row.forEach((v, h) => {
      byHour[h] += v;
      byDay[d] += v;
      if (v > peak.seconds) peak = { day: d, hour: h, seconds: v };
    })
  );

  return { grid, byHour, byDay, peak, weeks: Math.max(1, (to - from) / (7 * DAY)), tzOffsetMin };
}

/* ------------------------------ listening ----------------------------- */

function listening(from, to) {
  const acts = selectActivity.all({ from, to }).filter((a) => a.type === 2);
  const spans = to - from <= 120 * DAY ? clientSpans(from, to) : [];
  let totalMs = 0;
  const byTrack = new Map();
  const byArtist = new Map();
  const sessions = [];

  for (const a of acts) {
    const c = clip(a, from, to);
    if (!c) continue;
    const dur = c[1] - c[0];
    totalMs += dur;

    const trackKey = `${a.details || '?'} ${a.state || '?'}`;
    const t = byTrack.get(trackKey) || { title: a.details || '?', artist: a.state || '?', album: a.album, ms: 0, plays: 0 };
    t.ms += dur;
    t.plays += 1;
    byTrack.set(trackKey, t);

    for (const raw of (a.state || '').split(/[;,]| and /i)) {
      const name = raw.trim();
      if (!name) continue;
      const ar = byArtist.get(name) || { name, ms: 0, plays: 0 };
      ar.ms += dur;
      ar.plays += 1;
      byArtist.set(name, ar);
    }

    sessions.push({
      title: a.details,
      artist: a.state,
      album: a.album,
      start: c[0],
      end: c[1],
      seconds: Math.round(dur / 1000),
      ongoing: a.ended_at == null,
      clients: clientsFor(spans, c[0], c[1]),
    });
  }

  const fmt = (m) => Math.round(m.ms / 1000);
  return {
    totalSeconds: Math.round(totalMs / 1000),
    uniqueTracks: byTrack.size,
    uniqueArtists: byArtist.size,
    topTracks: [...byTrack.values()].sort((a, b) => b.ms - a.ms).slice(0, 25)
      .map((t) => ({ title: t.title, artist: t.artist, album: t.album, seconds: fmt(t), plays: t.plays })),
    topArtists: [...byArtist.values()].sort((a, b) => b.ms - a.ms).slice(0, 25)
      .map((a) => ({ name: a.name, seconds: fmt(a), plays: a.plays })),
    sessions: sessions.sort((a, b) => b.start - a.start).slice(0, 300),
  };
}

/* ------------------------------ activities ---------------------------- */

function activities(from, to) {
  const acts = selectActivity.all({ from, to }).filter((a) => a.type !== 2);
  const spans = to - from <= 120 * DAY ? clientSpans(from, to) : [];
  const byName = new Map();
  const sessions = [];
  for (const a of acts) {
    const c = clip(a, from, to);
    if (!c) continue;
    const dur = c[1] - c[0];
    const kind = a.type === 4 ? 'custom-status' : a.type === 1 ? 'streaming' : a.type === 3 ? 'watching' : a.type === 5 ? 'competing' : 'playing';
    const label = a.type === 4 ? (a.state || a.name) : a.name;
    const rec = byName.get(label) || { label, kind, ms: 0, sessions: 0 };
    rec.ms += dur;
    rec.sessions += 1;
    byName.set(label, rec);
    sessions.push({ label, kind, details: a.details, start: c[0], end: c[1], seconds: Math.round(dur / 1000), ongoing: a.ended_at == null, clients: clientsFor(spans, c[0], c[1]) });
  }
  return {
    top: [...byName.values()].sort((a, b) => b.ms - a.ms)
      .map((r) => ({ label: r.label, kind: r.kind, seconds: Math.round(r.ms / 1000), sessions: r.sessions })),
    sessions: sessions.sort((a, b) => b.start - a.start).slice(0, 300),
  };
}

/* ------------------------------- current ------------------------------ */

const getMetaRow = db.prepare('SELECT value FROM meta WHERE key = ?');
const meta = (k) => { const r = getMetaRow.get(k); return r ? r.value : null; };

function current(tzOffsetMin = 0) {
  const nowMs = Date.now();
  const openStatus = db.prepare('SELECT * FROM status_sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1').get();
  const openActs = db.prepare('SELECT * FROM activity_sessions WHERE ended_at IS NULL ORDER BY started_at').all();
  const lastHeartbeat = Number(meta('last_heartbeat') || 0);
  const status = openStatus ? openStatus.status : (meta('last_status') || 'unknown');
  const since = openStatus ? openStatus.started_at : null;

  const lastEv = db.prepare('SELECT desktop, mobile, web FROM presence_events ORDER BY ts DESC LIMIT 1').get();
  const clientStatus = lastEv ? { desktop: lastEv.desktop, mobile: lastEv.mobile, web: lastEv.web } : {};

  let lastOnline = null;
  if (status === 'online') {
    lastOnline = nowMs;
  } else {
    const row = db.prepare("SELECT started_at, ended_at FROM status_sessions WHERE status = 'online' ORDER BY started_at DESC LIMIT 1").get();
    if (row) lastOnline = row.ended_at ?? row.started_at;
  }

  const shift = tzOffsetMin * 60000;
  const todayStart = Math.floor((nowMs - shift) / DAY) * DAY + shift;
  const t = statusTotals(todayStart, nowMs);

  return {
    status,
    since,
    sinceSeconds: since ? Math.round((nowMs - since) / 1000) : null,
    activities: openActs.map((a) => ({
      type: a.type,
      name: a.name,
      details: a.details,
      state: a.state,
      album: a.album,
      since: a.started_at,
    })),
    clientStatus,
    lastOnline,
    today: {
      activeSeconds: Math.round(t.active / 1000),
      onlineSeconds: Math.round(t.per.online / 1000),
      trackedSeconds: Math.round(t.tracked / 1000),
      since: todayStart,
    },
    availability: {
      day: activeRatioOver(nowMs - DAY, nowMs),
      week: activeRatioOver(nowMs - 7 * DAY, nowMs),
    },
    botOnline: nowMs - lastHeartbeat < 90000,
    lastHeartbeat: lastHeartbeat || null,
    heartbeatAgeSeconds: lastHeartbeat ? Math.round((nowMs - lastHeartbeat) / 1000) : null,
    now: nowMs,
  };
}

/* ------------------------------- extent ------------------------------- */

function extent() {
  const row = db.prepare(`
    SELECT MIN(started_at) AS first, MAX(COALESCE(ended_at, started_at)) AS last FROM status_sessions
  `).get();
  return { first: row.first || null, last: row.last || null };
}

module.exports = { summary, timeline, breakdown, heatmap, listening, activities, current, extent };
