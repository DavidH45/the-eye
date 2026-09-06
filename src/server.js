'use strict';

const path = require('path');
const express = require('express');
const config = require('./config');
const a = require('./analytics');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- param parsing helpers ----
function range(req) {
  const to = req.query.to ? Number(req.query.to) : Date.now();
  const from = req.query.from ? Number(req.query.from) : to - 7 * 86400000;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    throw Object.assign(new Error('Invalid from/to'), { status: 400 });
  }
  return { from, to };
}
const tz = (req) => {
  const v = Number(req.query.tz);
  return Number.isFinite(v) ? v : 0;
};

function wrap(fn) {
  return (req, res) => {
    try {
      res.json(fn(req));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
      if (!err.status) console.error(err);
    }
  };
}

app.get('/api/meta', wrap(() => ({ targetUserId: safeTarget(), extent: a.extent() })));
app.get('/api/current', wrap((req) => a.current(tz(req))));
app.get('/api/summary', wrap((req) => { const { from, to } = range(req); return a.summary(from, to, tz(req)); }));
app.get('/api/timeline', wrap((req) => { const { from, to } = range(req); return a.timeline(from, to); }));
app.get('/api/breakdown', wrap((req) => {
  const { from, to } = range(req);
  const bucket = ['minute', 'hour', 'day'].includes(req.query.bucket) ? req.query.bucket : 'hour';
  return a.breakdown(from, to, bucket, tz(req));
}));
app.get('/api/heatmap', wrap((req) => { const { from, to } = range(req); return a.heatmap(from, to, tz(req)); }));
app.get('/api/listening', wrap((req) => { const { from, to } = range(req); return a.listening(from, to); }));
app.get('/api/activities', wrap((req) => { const { from, to } = range(req); return a.activities(from, to); }));

function safeTarget() {
  try { return config.TARGET_USER_ID; } catch { return null; }
}

app.listen(config.PORT, () => {
  console.log(`[web] dashboard on http://localhost:${config.PORT}`);
});
