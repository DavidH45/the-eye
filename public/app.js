'use strict';

const TZ = new Date().getTimezoneOffset();
const COLORS = {
  online: '#3ba55d', idle: '#faa61a', dnd: '#ed4245', offline: '#747f8d',
  active: '#5865f2', listen: '#1db954',
};
const STATUSES = ['online', 'idle', 'dnd', 'offline'];
const CLIENT_LABEL = { desktop: 'Desktop', mobile: 'Mobile', web: 'Web' };
const CLIENT_ICON = { desktop: '🖥️', mobile: '📱', web: '🌐' };
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const RANGES = {
  '1h': 3600e3, '6h': 6 * 3600e3, '12h': 12 * 3600e3, '24h': 86400e3,
  '3d': 3 * 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3, '90d': 90 * 86400e3,
};

let state = {
  from: Date.now() - 7 * 86400e3,
  to: Date.now(),
  bucket: 'hour',
  rangeKey: '7d',
};
const charts = {};

/* ----------------------------- helpers ------------------------------ */

function human(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return sec + 's';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return [d && d + 'd', (h || d) && h + 'h', !d && m + 'm'].filter(Boolean).join(' ');
}
const pct = (x) => (100 * (x || 0)).toFixed(1) + '%';
const dt = (ms) => new Date(ms).toLocaleString();
const tm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function ago(ms) {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

async function api(path, params = {}) {
  const q = new URLSearchParams({ from: Math.round(state.from), to: Math.round(state.to), tz: TZ, ...params });
  const r = await fetch(`/api/${path}?${q}`);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

const toLocalInput = (ms) => new Date(ms - TZ * 60000).toISOString().slice(0, 16);
const fromLocalInput = (v) => new Date(v).getTime();

/* ------------------------------ tooltip ---------------------------- */

const tip = $('#tip');
document.addEventListener('mousemove', (e) => {
  const t = e.target.closest && e.target.closest('[data-tip]');
  if (!t) { tip.hidden = true; return; }
  tip.innerHTML = t.dataset.tip;
  tip.hidden = false;
  const pad = 14;
  const r = tip.getBoundingClientRect();
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + r.width > innerWidth) x = e.clientX - r.width - pad;
  if (y + r.height > innerHeight) y = e.clientY - r.height - pad;
  tip.style.left = Math.max(4, x) + 'px';
  tip.style.top = Math.max(4, y) + 'px';
});

/* ----------------------------- right now --------------------------- */

async function refreshNow() {
  let c;
  try {
    c = await api('current');
  } catch {
    $('#now-status').textContent = 'tracker not reporting';
    return;
  }
  $('#now-dot').className = 'now-dot ' + c.status;
  $('#now-status').textContent = cap(c.status);

  const since = c.since
    ? `${cap(c.status)} for ${human(c.sinceSeconds)} · since ${tm(c.since)}`
    : '';
  const clients = ['desktop', 'mobile', 'web'].filter((k) => c.clientStatus && c.clientStatus[k]);
  $('#now-since').textContent = [since, clients.length ? 'on ' + clients.join(', ') : ''].filter(Boolean).join('  ·  ');

  const chips = [];
  const listening = c.activities.find((a) => a.type === 2);
  if (listening) {
    chips.push(`<span class="chip spotify" data-tip="Listening on Spotify since ${tm(listening.since)}">
      ♪ <span class="t"><b>${esc(listening.details || '')}</b> — ${esc(listening.state || '')}</span></span>`);
  }
  for (const a of c.activities.filter((x) => x.type !== 2 && x.type !== 4)) {
    chips.push(`<span class="chip" data-tip="Since ${tm(a.since)}">🎮 <span class="t">${esc(a.name)}</span></span>`);
  }
  const custom = c.activities.find((a) => a.type === 4);
  if (custom && (custom.state || custom.name)) {
    chips.push(`<span class="chip"><span class="t">💬 ${esc(custom.state || custom.name)}</span></span>`);
  }
  $('#now-activities').innerHTML = chips.join('') || '<span class="muted">no activity</span>';

  $('#now-today').textContent = human(c.today.activeSeconds);
  $('#now-today').parentElement.dataset.tip =
    `Online ${human(c.today.onlineSeconds)} · tracked ${human(c.today.trackedSeconds)} today`;
  $('#now-lastonline').textContent = c.status === 'online' ? 'now' : ago(c.lastOnline);
  $('#now-avail').textContent = pct(c.availability.day);
  $('#now-avail').parentElement.dataset.tip = `Active ${pct(c.availability.day)} of the last 24h · ${pct(c.availability.week)} of the last 7d`;

  const tr = $('#now-tracker');
  if (c.botOnline) {
    tr.textContent = 'live';
    tr.className = 'v';
    tr.parentElement.dataset.tip = `Last heartbeat ${c.heartbeatAgeSeconds}s ago`;
  } else {
    tr.textContent = 'offline ' + (c.lastHeartbeat ? ago(c.lastHeartbeat) : '');
    tr.className = 'v warn';
    tr.parentElement.dataset.tip = 'The tracker bot is not running — new data is not being recorded';
  }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

/* ------------------------------ devices ---------------------------- */

const cname = (k) => CLIENT_LABEL[k] || cap(k);

// Table cell: one badge per client, most-used first, with a per-client tooltip.
function devices(list) {
  if (!list || !list.length) return '<span class="muted">&mdash;</span>';
  return list.map((c) =>
    `<span class="dev" data-tip="${cname(c.client)} &middot; ${human(c.seconds)}">${CLIENT_ICON[c.client] || ''} ${cname(c.client)}</span>`
  ).join(' ');
}

// Tooltip line: "on Desktop, Mobile".
function deviceLine(list) {
  return list && list.length ? 'on ' + list.map((c) => cname(c.client)).join(', ') : '';
}

/* ------------------------------ cards ------------------------------- */

function renderCards(s) {
  const ss = s.sessionStats;
  const cards = [
    { label: 'Active', value: human(s.seconds.active), sub: pct(s.activeRatio) + ' of tracked', accent: true },
    { label: 'Online', value: human(s.seconds.online), sub: `${ss.online.count} sessions` },
    { label: 'Idle', value: human(s.seconds.idle) },
    { label: 'Do not disturb', value: human(s.seconds.dnd) },
    { label: 'Offline', value: human(s.seconds.offline) },
    { label: 'Longest online', value: human(s.longestOnlineSeconds) },
    { label: 'Avg online session', value: human(ss.online.avgSeconds), sub: 'median ' + human(ss.online.medianSeconds) },
    { label: 'Status changes', value: s.statusChanges, sub: s.changesPerDay.toFixed(1) + ' / day' },
    { label: 'Data coverage', value: pct(s.coverage), sub: 'tracker uptime in range' },
    { label: 'Listening', value: human(s.seconds.listening), sub: `${s.uniqueTracks} tracks · ${s.uniqueArtists} artists` },
    { label: 'In games / apps', value: human(s.seconds.gaming), sub: s.topGame ? `top: ${s.topGame.name}` : '' },
  ];
  $('#cards').innerHTML = cards.map((c) => `
    <div class="card${c.accent ? ' accent' : ''}">
      <div class="value">${c.value}</div>
      <div class="label">${c.label}</div>
      ${c.sub ? `<div class="sub">${esc(c.sub)}</div>` : ''}
    </div>`).join('');
}

/* ---------------------------- status pie ---------------------------- */

function renderStatusChart(s) {
  draw('status', '#statusChart', {
    type: 'doughnut',
    data: {
      labels: STATUSES.map((d) => d.toUpperCase()),
      datasets: [{ data: STATUSES.map((d) => s.seconds[d]), backgroundColor: STATUSES.map((d) => COLORS[d]), borderWidth: 0 }],
    },
    options: {
      cutout: '62%',
      plugins: {
        legend: { position: 'right', labels: { color: '#e6e9ef', boxWidth: 12 } },
        tooltip: { callbacks: { label: (c) => `${c.label}: ${human(c.raw)} (${pct(c.raw / (s.seconds.tracked || 1))})` } },
      },
    },
  });
}

/* ------------------------- status over time ---------------------- */

function renderTimeChart(b) {
  if (!b || !b.points) { charts.time?.destroy(); return; }
  // bucketStart encodes local wall-clock in UTC space, so format it as UTC
  const fmt = {
    timeZone: 'UTC',
    ...(state.bucket === 'day'
      ? { month: 'short', day: 'numeric' }
      : state.bucket === 'hour'
        ? { month: 'short', day: 'numeric', hour: '2-digit' }
        : { hour: '2-digit', minute: '2-digit' }),
  };
  draw('time', '#timeChart', {
    type: 'bar',
    data: {
      labels: b.points.map((p) => new Date(p.bucketStart).toLocaleString([], fmt)),
      datasets: STATUSES.map((k) => ({
        label: k.toUpperCase(),
        data: b.points.map((p) => p[k] / 60),
        backgroundColor: COLORS[k],
      })),
    },
    options: {
      responsive: true,
      barPercentage: 1, categoryPercentage: 1,
      scales: {
        x: { stacked: true, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
        y: { stacked: true, ticks: { callback: (v) => v + 'm' }, title: { display: true, text: 'minutes / bucket' } },
      },
      plugins: {
        legend: { labels: { color: '#e6e9ef', boxWidth: 12 } },
        tooltip: { mode: 'index', callbacks: { label: (c) => `${c.dataset.label}: ${human(c.raw * 60)}` } },
      },
    },
  });
}

/* --------------------- hour-of-day / day-of-week ------------------ */

function renderHourChart(h) {
  // normalise to "per day"; for sub-day ranges just show the totals
  const days = Math.max(1, Math.round((state.to - state.from) / 86400e3));
  draw('hour', '#hourChart', {
    type: 'bar',
    data: {
      labels: [...Array(24)].map((_, i) => i),
      datasets: [{ data: h.byHour.map((v) => v / 60 / days), backgroundColor: COLORS.active, borderWidth: 0 }],
    },
    options: {
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: (c) => `${c[0].label}:00–${c[0].label}:59`, label: (c) => human(c.raw * 60) + ' active / day' } },
      },
      scales: {
        x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }, grid: { display: false } },
        y: { ticks: { callback: (v) => v + 'm' } },
      },
    },
  });
}

function renderDowChart(h) {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  draw('dow', '#dowChart', {
    type: 'bar',
    data: {
      labels: names,
      datasets: [{ data: h.byDay.map((v) => v / 3600 / h.weeks), backgroundColor: COLORS.active, borderWidth: 0 }],
    },
    options: {
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => human(c.raw * 3600) + ' active / week' } },
      },
      scales: { x: { grid: { display: false } }, y: { ticks: { callback: (v) => v + 'h' } } },
    },
  });
}

/* ------------------------------ heatmap ---------------------------- */

function renderHeatmap(h) {
  const { grid, byHour, byDay, peak } = h;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let max = 1;
  grid.forEach((row) => row.forEach((v) => { if (v > max) max = v; }));

  let html = '<div></div>';
  for (let hr = 0; hr < 24; hr++) html += `<div class="hlabel">${hr}</div>`;
  html += '<div></div>';

  for (let d = 0; d < 7; d++) {
    html += `<div class="dlabel">${days[d]}</div>`;
    for (let hr = 0; hr < 24; hr++) {
      const v = grid[d][hr];
      const alpha = v ? 0.12 + 0.88 * (v / max) : 0;
      html += `<div class="cell" data-tip="<b>${days[d]} ${hr}:00</b><br>${human(v)} active"
        style="background:${v ? `rgba(88,101,242,${alpha.toFixed(3)})` : ''}"></div>`;
    }
    html += `<div class="rowtot" data-tip="${days[d]} total">${human(byDay[d])}</div>`;
  }

  html += '<div></div>';
  const maxCol = Math.max(1, ...byHour);
  for (let hr = 0; hr < 24; hr++) {
    const a = byHour[hr] ? 0.15 + 0.85 * (byHour[hr] / maxCol) : 0;
    html += `<div class="coltot" data-tip="${hr}:00 total across range"
      style="color:${byHour[hr] ? `rgba(88,101,242,${(0.4 + a).toFixed(2)})` : ''}">${byHour[hr] ? Math.round(byHour[hr] / 3600) + 'h' : ''}</div>`;
  }
  html += '<div></div>';
  $('#heatmap').innerHTML = html;

  $('#heat-peak').textContent = peak.seconds
    ? `peak: ${days[peak.day]} ${peak.hour}:00 (${human(peak.seconds)})` : '';
}

/* ---------------------------- ribbon ----------------------------- */

function renderRibbon(tl) {
  const el = $('#ribbon');
  const span = state.to - state.from || 1;
  const now = Date.now();
  el.innerHTML = '';
  for (const s of tl) {
    const a = Math.max(s.start, state.from);
    const b = Math.min(s.ongoing ? now : (s.end || s.start), state.to);
    if (b <= a) continue;
    const seg = document.createElement('div');
    seg.className = 'seg ' + s.status;
    seg.style.left = (100 * (a - state.from) / span) + '%';
    seg.style.width = Math.max(0.12, 100 * (b - a) / span) + '%';
    seg.dataset.tip = `<b>${cap(s.status)}</b><br>${tm(a)} – ${s.ongoing ? 'now' : tm(b)}<br>${human(s.seconds || (b - a) / 1000)}`
      + (deviceLine(s.clients) ? `<br>${deviceLine(s.clients)}` : '');
    el.appendChild(seg);
  }
  if (now >= state.from && now <= state.to + 5000) {
    const n = document.createElement('div');
    n.className = 'now-line';
    n.style.left = Math.min(100, 100 * (now - state.from) / span) + '%';
    n.dataset.tip = 'now';
    el.appendChild(n);
  }

  const ax = $('#ribbon-axis');
  ax.innerHTML = '';
  const n = 6;
  const fmt = span <= 6 * 3600e3 ? { hour: '2-digit', minute: '2-digit' }
    : span <= 3 * 86400e3 ? { weekday: 'short', hour: '2-digit' }
      : { month: 'short', day: 'numeric' };
  for (let i = 0; i <= n; i++) {
    const sp = document.createElement('span');
    sp.style.left = (100 * i / n) + '%';
    sp.textContent = new Date(state.from + span * i / n).toLocaleString([], fmt);
    ax.appendChild(sp);
  }

  $('#ribbon-legend').innerHTML = STATUSES
    .map((k) => `<span><i style="background:${COLORS[k]}"></i>${cap(k)}</span>`).join('');
}

/* --------------------- online session histogram ----------------- */

function renderSessions(tl) {
  const buckets = [
    ['< 5m', 0, 300], ['5–15m', 300, 900], ['15–30m', 900, 1800], ['30–60m', 1800, 3600],
    ['1–2h', 3600, 7200], ['2–4h', 7200, 14400], ['4h+', 14400, Infinity],
  ];
  const counts = buckets.map(() => 0);
  for (const s of tl) {
    if (s.status !== 'online') continue;
    const i = buckets.findIndex(([, lo, hi]) => s.seconds >= lo && s.seconds < hi);
    if (i >= 0) counts[i]++;
  }
  draw('session', '#sessionChart', {
    type: 'bar',
    data: { labels: buckets.map((b) => b[0]), datasets: [{ data: counts, backgroundColor: COLORS.online, borderWidth: 0 }] },
    options: {
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => c.raw + ' online sessions' } } },
      scales: { x: { grid: { display: false } }, y: { ticks: { precision: 0 }, title: { display: true, text: 'sessions' } } },
    },
  });
}

/* ---------------------------- daily ----------------------------- */

function renderDaily(s) {
  const d = s.daily;
  draw('daily', '#dailyChart', {
    type: 'bar',
    data: {
      labels: d.map((x) => new Date(x.day).toLocaleDateString([], { timeZone: 'UTC', month: 'short', day: 'numeric' })),
      datasets: [
        ...['online', 'idle', 'dnd'].map((k) => ({ label: k.toUpperCase(), data: d.map((x) => x[k] / 60), backgroundColor: COLORS[k] })),
      ],
    },
    options: {
      barPercentage: 1, categoryPercentage: 0.8,
      scales: {
        x: { stacked: true, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 15 }, grid: { display: false } },
        y: { stacked: true, ticks: { callback: (v) => Math.round(v / 60) + 'h' }, title: { display: true, text: 'active time' } },
      },
      plugins: {
        legend: { labels: { color: '#e6e9ef', boxWidth: 12 } },
        tooltip: { mode: 'index', callbacks: { label: (c) => `${c.dataset.label}: ${human(c.raw * 60)}` } },
      },
    },
  });
}

/* --------------------------- devices --------------------------- */

function renderClients(s) {
  const bc = s.byClient;
  if (!bc) { charts.client?.destroy(); return; }
  const keys = ['desktop', 'mobile', 'web'];
  draw('client', '#clientChart', {
    type: 'doughnut',
    data: {
      labels: keys.map(cap),
      datasets: [{ data: keys.map((k) => bc[k]), backgroundColor: ['#5865f2', '#3ba55d', '#faa61a'], borderWidth: 0 }],
    },
    options: {
      cutout: '62%',
      plugins: {
        legend: { position: 'right', labels: { color: '#e6e9ef', boxWidth: 12 } },
        tooltip: { callbacks: { label: (c) => `${c.label}: ${human(c.raw)}` } },
      },
    },
  });
}

/* ------------------------ transitions ------------------------- */

function renderTransitions(s) {
  const t = s.transitions.slice(0, 8);
  if (!t.length) { $('#transitions').innerHTML = '<p class="muted">Not enough data in this range.</p>'; return; }
  const max = Math.max(...t.map((x) => x.count));
  $('#transitions').innerHTML = t.map((x) => `
    <div class="trow">
      <span><span class="pill ${x.from}">${x.from}</span> → <span class="pill ${x.to}">${x.to}</span></span>
      <span class="bar" style="width:${(100 * x.count / max).toFixed(1)}%; background:${COLORS[x.to]}"></span>
      <span class="n">${x.count}</span>
    </div>`).join('');
}

/* --------------------------- listening ------------------------- */

function renderListening(l) {
  barChart('tracks', l.topTracks.slice(0, 12).map((t) => `${t.title} — ${t.artist}`), l.topTracks.slice(0, 12).map((t) => t.seconds), COLORS.listen);
  barChart('artists', l.topArtists.slice(0, 12).map((x) => x.name), l.topArtists.slice(0, 12).map((x) => x.seconds), COLORS.listen);

  $('#tab-listening').innerHTML = table(
    ['When', 'Track', 'Artist', 'Album', 'Duration', 'Device'],
    l.sessions.map((s) => [dt(s.start), esc(s.title || '?'), esc(s.artist || '?'), esc(s.album || ''), human(s.seconds) + (s.ongoing ? ' …' : ''), devices(s.clients)]),
  ) || '<p class="muted">No listening data in this range.</p>';
}

function barChart(key, labels, data, color) {
  draw(key, `#${key}Chart`, {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: color, borderWidth: 0 }] },
    options: {
      indexAxis: 'y',
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => human(c.raw) } } },
      scales: {
        x: { ticks: { callback: (v) => human(v) } },
        y: { ticks: { color: '#e6e9ef', autoSkip: false, font: { size: 10 } }, grid: { display: false } },
      },
    },
  });
}

/* --------------------------- activities ------------------------- */

function renderActivities(a) {
  $('#tab-activities').innerHTML =
    (a.top.length
      ? `<h3 class="muted">Totals</h3>` +
        table(['App / status', 'Kind', 'Total', 'Sessions'], a.top.map((t) => [esc(t.label), t.kind, human(t.seconds), t.sessions]))
      : '') +
    `<h3 class="muted" style="margin-top:14px">Sessions</h3>` +
    (table(['When', 'App / status', 'Kind', 'Details', 'Duration', 'Device'],
      a.sessions.map((s) => [dt(s.start), esc(s.label), s.kind, esc(s.details || ''), human(s.seconds) + (s.ongoing ? ' …' : ''), devices(s.clients)]))
      || '<p class="muted">No activity data in this range.</p>');
}

/* ---------------------------- timeline ------------------------- */

function renderTimelineTable(t) {
  $('#tab-timeline').innerHTML = table(
    ['Status', 'Start', 'End', 'Duration', 'Device'],
    [...t].reverse().map((s) => [
      `<span class="pill ${s.status}">${s.status}</span>`,
      dt(s.start),
      s.ongoing ? 'ongoing' : dt(s.end),
      human(s.seconds),
      devices(s.clients),
    ]),
  ) || '<p class="muted">No data in this range.</p>';
}

/* ----------------------------- table -------------------------- */

function table(headers, rows) {
  if (!rows.length) return '';
  return `<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

/* ---------------------------- chart util ---------------------- */

function draw(key, sel, cfg) {
  if (typeof Chart === 'undefined') return;
  charts[key]?.destroy();
  charts[key] = new Chart($(sel), cfg);
}

/* --------------------------- orchestration -------------------- */

async function refreshAll() {
  syncInputs();
  const jobs = {
    summary: api('summary'),
    timeline: api('timeline'),
    breakdown: api('breakdown', { bucket: state.bucket }).catch(() => null),
    heatmap: api('heatmap'),
    listening: api('listening'),
    activities: api('activities'),
  };
  const r = Object.fromEntries(await Promise.all(
    Object.entries(jobs).map(async ([k, p]) => [k, await p.catch((e) => { console.warn(k, e.message); return null; })]),
  ));

  if (r.summary) { renderCards(r.summary); renderStatusChart(r.summary); renderTransitions(r.summary); renderDaily(r.summary); renderClients(r.summary); }
  if (r.timeline) { renderRibbon(r.timeline); renderTimelineTable(r.timeline); renderSessions(r.timeline); }
  renderTimeChart(r.breakdown);
  if (r.heatmap) { renderHourChart(r.heatmap); renderDowChart(r.heatmap); renderHeatmap(r.heatmap); }
  if (r.listening) renderListening(r.listening);
  if (r.activities) renderActivities(r.activities);
}

function syncInputs() {
  $('#from').value = toLocalInput(state.from);
  $('#to').value = toLocalInput(state.to);
  $('#bucket').value = state.bucket;
}

function autoBucket(span) {
  if (span <= 12 * 3600e3) return 'minute';
  if (span <= 21 * 86400e3) return 'hour';
  return 'day';
}

function setRange(key) {
  state.rangeKey = key;
  $$('#presets button').forEach((b) => b.classList.toggle('active', b.dataset.range === key));
  state.to = Date.now();
  state.from = key === 'all'
    ? (window.__firstSeen || state.to - 30 * 86400e3)
    : state.to - RANGES[key];
  state.bucket = autoBucket(state.to - state.from);
  refreshAll();
}

/* ------------------------------ init -------------------------- */

async function init() {
  if (typeof Chart !== 'undefined') {
    Chart.defaults.color = '#8b93a7';
    Chart.defaults.borderColor = '#2a313f';
    Chart.defaults.font.family = '"Segoe UI", system-ui, -apple-system, sans-serif';
    Chart.defaults.maintainAspectRatio = false;
    Chart.defaults.animation = { duration: 250 };
  }

  try {
    const m = await fetch('/api/meta').then((r) => r.json());
    if (m.targetUserId) $('#target').textContent = `user ${m.targetUserId}`;
    if (m.extent?.first) {
      window.__firstSeen = m.extent.first;
      $('#target').textContent += `  ·  since ${new Date(m.extent.first).toLocaleDateString()}`;
    }
  } catch {}

  $$('#presets button').forEach((b) => b.addEventListener('click', () => {
    setRange(b.dataset.range);
    history.replaceState(null, '', '?range=' + b.dataset.range);
  }));

  // allow ?range=6h or ?from=<ms>&to=<ms> to preselect a window
  const qs = new URLSearchParams(location.search);
  if (qs.get('from') && qs.get('to')) {
    state.from = Number(qs.get('from'));
    state.to = Number(qs.get('to'));
    state.bucket = qs.get('bucket') || autoBucket(state.to - state.from);
    state.rangeKey = null;
    $$('#presets button').forEach((b) => b.classList.remove('active'));
  } else if (RANGES[qs.get('range')] || qs.get('range') === 'all') {
    state.rangeKey = qs.get('range');
  }

  $('#apply').addEventListener('click', () => {
    state.from = fromLocalInput($('#from').value);
    state.to = fromLocalInput($('#to').value);
    state.bucket = $('#bucket').value;
    state.rangeKey = null;
    $$('#presets button').forEach((b) => b.classList.remove('active'));
    refreshAll();
  });

  $$('.tabs button').forEach((b) => b.addEventListener('click', () => {
    $$('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    $$('.tabpane').forEach((p) => (p.hidden = p.id !== `tab-${b.dataset.tab}`));
  }));

  await refreshNow();
  if (state.rangeKey) setRange(state.rangeKey);
  else await refreshAll();

  setInterval(() => {
    if (!$('#liveToggle').checked) return;
    refreshNow();
    if (state.rangeKey) setRange(state.rangeKey);
  }, 20000);
}

init();
