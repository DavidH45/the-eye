'use strict';

const path = require('path');
require('dotenv').config();

function required(name) {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  }
  return v.trim();
}

const DB_PATH = path.resolve(process.env.DB_PATH || './data/theeye.db');

module.exports = {
  DB_PATH,
  PORT: Number(process.env.PORT || 3000),
  HEARTBEAT_SECONDS: Number(process.env.HEARTBEAT_SECONDS || 30),

  // Only needed by the bot process; the web process can run without a token.
  get DISCORD_TOKEN() {
    return required('DISCORD_TOKEN');
  },
  get TARGET_USER_ID() {
    return required('TARGET_USER_ID');
  },

  // status values that count as "active"
  ACTIVE_STATUSES: ['online', 'idle', 'dnd'],
  ALL_STATUSES: ['online', 'idle', 'dnd', 'offline'],
};
