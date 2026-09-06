'use strict';

const TZ = new Date().getTimezoneOffset();
const COLORS = {
  online: '#3ba55d', idle: '#faa61a', dnd: '#ed4245', offline: '#747f8d', active: '#5865f2',
};
const $ = (s) => document.querySelector(s);

let state = {
  from: Date.now() - 7 * 86400000,
  to: Date.now(),
  bucket: 'hour',
};
const charts = {};

/* ----------------------------- helpers ------------------------------ */

function human(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return sec + 's';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return [d && d + 'd', (h || d) && h + 'h', m + 'm'].filter(Boolean).join(' ');
}
const pct = (x) => (100 * (x || 0)).toFixed(1) + '%';
const dt = (ms) => new Date(ms).toLocaleString();
const tm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

async function api(path, params = {}) {
  const q = new URLSearchParams({ from: state.from, to: state.to, tz: TZ, ...params });
  const r = await fetch(`/api/${path}?${q}`);
  if (!r.ok) throw new Error((await r.json()).error || r.statusText);
  return r.json();
}

function toLocalInput(ms) {
  const d = new Date(ms - TZ * 60000);
  return d.toISOString().slice(0, 16);
}
function fromLocalInput(v) {
  return new Date(v).getTime();
}

/* ----------------------------- live badge --------------------------- */

async function refreshLive() {
  try {
    const c = await api('current');
    const dot = $('#live-dot');
    const txt = $('#live-text');
    dot.className = 'dot ' + c.status;
    let s = c.status[0].toUpperCase() + c.status.slice(1);
    const listening = c.activities.find((a) => a.type === 2);
    const playing = c.activities.find((a) => a.type !== 2 && a.type !== 4);
    if (listening) s += ` · ♪ ${listening.details || ''} — ${listening.state || ''}`;
    else if (playing) s += ` · ${playing.name}`;
    if (c.since) s += `  (since ${tm(c.since)})`;
    if (!c.botOnline) s += '  ⚠ tracker offline';
    txt.textContent = s;
  } catch (e) {
    $('#live-text').textContent = 'dashboard up, tracker not reporting';
  }
}

/* ------------------------------ cards ------------------------------- */

async function refreshCards() {
  const s = await api('summary');
  const cards = [
    { label: 'Active time', value: human(s.seconds.active), sub: pct(s.activeRatio) + ' of tracked' },
    { label: 'Online', value: human(s.seconds.online) },
    { label: 'Idle', value: human(s.seconds.idle) },
    { label: 'Do not disturb', value: human(s.seconds.dnd) },
    { label: 'Offline', value: human(s.seconds.offline) },
    { label: 'Longest online', value: human(s.longestOnlineSeconds) },
    { label: 'Status changes', value: s.statusChanges },
    { label: 'Data coverage', value: pct(s.coverage), sub: 'tracker uptime in range' },
    { label: 'Listening', value: human(s.seconds.listening), sub: `${s.uniqueTracks} tracks · ${s.uniqueArtists} artists` },
    { label: 'In games / apps', value: human(s.seconds.gaming), sub: s.topGame ? `top: ${s.topGame.name}` : '' },
  ];
  $('#cards').innerHTML = cards.map((c) => `
    <div class="card">
      <div class="value">${c.value}</div>
      <div class="label">${c.label}</div>
      ${c.sub ? `<div class="sub">${c.sub}</div>` : ''}
    </div>`).join('');

  drawStatusChart(s.seconds);
}

/* ---------------------------- status pie ---------------------------- */

function drawStatusChart(sec) {
  const data = ['online', 'idle', 'dnd', 'offline'];
  charts.status?.destroy();
  charts.status = new Chart($('#statusChart'), {
    type: 'doughnut',
    data: {
      labels: data.map((d) => d.toUpperCase()),
      datasets: [{ data: data.map((d) => sec[d]), backgroundColor: data.map((d) => COLORS[d]), borderWidth: 0 }],
    },
    options: {
      plugins: {
        legend: { labels: { color: '#e6e9ef' } },
        tooltip: { callbacks: { label: (c) => `${c.label}: ${human(c.raw)}` } },
      },
    },
  });
}

/* ------------------------- activity over time ---------------------- */

async function refreshTimeChart() {
  const b = await api('breakdown', { bucket: state.bucket });
  const labels = b.points.map((p) => new Date(p.bucketStart));
  const fmt = state.bucket === 'day'
    ? { month: 'short', day: 'numeric' }
    : state.bucket === 'hour'
      ? { month: 'short', day: 'numeric', hour: '2-digit' }
      : { hour: '2-digit', minute: '2-digit' };
  const stat = ['online', 'idle', 'dnd', 'offline'];
  charts.time?.destroy();
  charts.time = new Chart($('#timeChart'), {
    type: 'bar',
    data: {
      labels: labels.map((d) => d.toLocaleString([], fmt)),
      datasets: stat.map((k) => ({
        label: k.toUpperCase(),
        data: b.points.map((p) => p[k] / 60),
        backgroundColor: COLORS[k],
      })),
    },
    options: {
      responsive: true,
      scales: {
        x: { stacked: true, ticks: { color: '#8b93a7', maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }, grid: { color: '#2a313f' } },
        y: { stacked: true, ticks: { color: '#8b93a7', callback: (v) => v + 'm' }, grid: { color: '#2a313f' }, title: { display: true, text: 'minutes / bucket', color: '#8b93a7' } },
      },
      plugins: {
        legend: { labels: { color: '#e6e9ef' } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${human(c.raw * 60)}` } },
      },
    },
  });
}

/* ------------------------------ heatmap ---------------------------- */

async function refreshHeatmap() {
  const { grid } = await api('heatmap');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let max = 1;
  grid.forEach((row) => row.forEach((v) => { if (v > max) max = v; }));
  let html = '<div></div>';
  for (let h = 0; h < 24; h++) html += `<div class="hlabel">${h}</div>`;
  for (let d = 0; d < 7; d++) {
    html += `<div class="dlabel">${days[d]}</div>`;
    for (let h = 0; h < 24; h++) {
      const v = grid[d][h];
      const alpha = v ? 0.15 + 0.85 * (v / max) : 0;
      html += `<div class="cell" title="${days[d]} ${h}:00 — ${human(v)}" style="background:${v ? `rgba(88,101,242,${alpha.toFixed(3)})` : ''}"></div>`;
    }
  }
  $('#heatmap').innerHTML = html;
}

/* --------------------------- listening ---------------------------- */

async function refreshListening() {
  const l = await api('listening');
  barChart('tracks', l.topTracks.slice(0, 12).map((t) => `${t.title} — ${t.artist}`), l.topTracks.slice(0, 12).map((t) => t.seconds), COLORS.active);
  barChart('artists', l.topArtists.slice(0, 12).map((x) => x.name), l.topArtists.slice(0, 12).map((x) => x.seconds), '#1db954');

  $('#tab-listening').innerHTML = table(
    ['When', 'Track', 'Artist', 'Album', 'Duration'],
    l.sessions.map((s) => [
      dt(s.start), s.title || '?', s.artist || '?', s.album || '', human(s.seconds) + (s.ongoing ? ' …' : ''),
    ]),
  ) || '<p class="muted">No listening data in this range.</p>';
}

function barChart(key, labels, data, color) {
  charts[key]?.destroy();
  charts[key] = new Chart($(`#${key}Chart`), {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: color, borderWidth: 0 }] },
    options: {
      indexAxis: 'y',
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => human(c.raw) } } },
      scales: {
        x: { ticks: { color: '#8b93a7', callback: (v) => human(v) }, grid: { color: '#2a313f' } },
        y: { ticks: { color: '#e6e9ef', autoSkip: false, font: { size: 10 } }, grid: { display: false } },
      },
    },
  });
}

/* --------------------------- activities --------------------------- */

async function refreshActivities() {
  const a = await api('activities');
  $('#tab-activities').innerHTML =
    (a.top.length ? `<h3 style="font-size:13px;color:var(--muted)">Totals</h3>` +
      table(['App / status', 'Kind', 'Total', 'Sessions'], a.top.map((t) => [t.label, t.kind, human(t.seconds), t.sessions])) : '') +
    `<h3 style="font-size:13px;color:var(--muted);margin-top:14px">Sessions</h3>` +
    (table(['When', 'App / status', 'Kind', 'Details', 'Duration'],
      a.sessions.map((s) => [dt(s.start), s.label, s.kind, s.details || '', human(s.seconds) + (s.ongoing ? ' …' : '')]))
      || '<p class="muted">No activity data in this range.</p>');
}

/* ---------------------------- timeline --------------------------- */

async function refreshTimeline() {
  const t = await api('timeline');
  $('#tab-timeline').innerHTML = table(
    ['Status', 'Start', 'End', 'Duration'],
    [...t].reverse().map((s) => [
      `<span class="pill ${s.status}">${s.status}</span>`,
      dt(s.start),
      s.ongoing ? 'ongoing' : dt(s.end),
      human(s.seconds),
    ]),
  ) || '<p class="muted">No data in this range.</p>';
}

/* ----------------------------- table ---------------------------- */

function table(headers, rows) {
  if (!rows.length) return '';
  return `<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

/* --------------------------- orchestration --------------------- */

async function refreshAll() {
  $('#from').value = toLocalInput(state.from);
  $('#to').value = toLocalInput(state.to);
  $('#bucket').value = state.bucket;
  await Promise.allSettled([
    refreshCards(),
    refreshTimeChart(),
    refreshHeatmap(),
    refreshListening(),
    refreshActivities(),
    refreshTimeline(),
  ]);
}

function setPreset(days) {
  document.querySelectorAll('.presets button').forEach((b) => b.classList.toggle('active', b.dataset.preset == String(days)));
  state.to = Date.now();
  if (days === 'all') {
    state.from = window.__firstSeen || (Date.now() - 30 * 86400000);
  } else {
    state.from = state.to - days * 86400000;
    if (days <= 2) state.bucket = 'minute';
    else if (days <= 14) state.bucket = 'hour';
    else state.bucket = 'day';
  }
  refreshAll();
}

/* ------------------------------ init --------------------------- */

async function init() {
  try {
    const m = await fetch('/api/meta').then((r) => r.json());
    if (m.targetUserId) $('#target').textContent = `user ${m.targetUserId}`;
    if (m.extent?.first) {
      window.__firstSeen = m.extent.first;
      $('#target').textContent += `  ·  since ${new Date(m.extent.first).toLocaleDateString()}`;
    }
  } catch {}

  document.querySelectorAll('.presets button').forEach((b) =>
    b.addEventListener('click', () => setPreset(b.dataset.preset === 'all' ? 'all' : Number(b.dataset.preset))));

  $('#apply').addEventListener('click', () => {
    state.from = fromLocalInput($('#from').value);
    state.to = fromLocalInput($('#to').value);
    state.bucket = $('#bucket').value;
    document.querySelectorAll('.presets button').forEach((b) => b.classList.remove('active'));
    refreshAll();
  });

  document.querySelectorAll('.tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
      document.querySelectorAll('.tabpane').forEach((p) => (p.hidden = p.id !== `tab-${b.dataset.tab}`));
    }));

  await refreshLive();
  setInterval(refreshLive, 15000);
  await refreshAll();
}

init();
