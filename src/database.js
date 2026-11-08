const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'community-bot.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT PRIMARY KEY,
    announcement_channel_id TEXT,
    grind_role_id TEXT,
    vanity_role_id TEXT,
    vanity_code TEXT,
    weekly_reward_role_id TEXT,
    monthly_reward_role_id TEXT
  );
  CREATE TABLE IF NOT EXISTS voice_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS voice_sessions_period_idx
    ON voice_sessions(guild_id, started_at, ended_at);
  CREATE TABLE IF NOT EXISTS security_settings (
    guild_id TEXT PRIMARY KEY,
    locked INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS inviter_whitelist (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS leaderboard_awards (
    guild_id TEXT NOT NULL,
    period TEXT NOT NULL,
    period_start INTEGER NOT NULL,
    user_id TEXT,
    role_id TEXT,
    awarded_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, period, period_start)
  );
`);

// Upgrade databases created by earlier bot versions without losing existing settings.
const settingColumns = new Set(db.prepare('PRAGMA table_info(guild_settings)').all().map(row => row.name));
for (const [name, type] of [['weekly_reward_role_id', 'TEXT'], ['monthly_reward_role_id', 'TEXT']]) {
  if (!settingColumns.has(name)) db.exec(`ALTER TABLE guild_settings ADD COLUMN ${name} ${type}`);
}

const getSettings = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?');
const saveSettings = db.prepare(`INSERT INTO guild_settings
  (guild_id, announcement_channel_id, grind_role_id, vanity_role_id, vanity_code, weekly_reward_role_id, monthly_reward_role_id)
  VALUES (@guild_id, @announcement_channel_id, @grind_role_id, @vanity_role_id, @vanity_code, @weekly_reward_role_id, @monthly_reward_role_id)
  ON CONFLICT(guild_id) DO UPDATE SET
    announcement_channel_id=excluded.announcement_channel_id,
    grind_role_id=excluded.grind_role_id,
    vanity_role_id=excluded.vanity_role_id,
    vanity_code=excluded.vanity_code,
    weekly_reward_role_id=excluded.weekly_reward_role_id,
    monthly_reward_role_id=excluded.monthly_reward_role_id`);

function settings(guildId) {
  return getSettings.get(guildId) || {
    guild_id: guildId,
    announcement_channel_id: null,
    grind_role_id: null,
    vanity_role_id: null,
    vanity_code: null,
    weekly_reward_role_id: null,
    monthly_reward_role_id: null
  };
}
function saveGuildSettings(guildId, changes) {
  saveSettings.run({ guild_id: guildId, ...settings(guildId), ...changes });
  return settings(guildId);
}
function recordVoiceJoin(guildId, userId, channelId, startedAt = Date.now()) {
  db.prepare('INSERT INTO voice_sessions(guild_id,user_id,channel_id,started_at) VALUES(?,?,?,?)')
    .run(guildId, userId, channelId, startedAt);
}
function recordVoiceLeave(guildId, userId, endedAt = Date.now()) {
  db.prepare(`UPDATE voice_sessions SET ended_at = ? WHERE id = (
    SELECT id FROM voice_sessions WHERE guild_id = ? AND user_id = ? AND ended_at IS NULL
    ORDER BY started_at DESC LIMIT 1)`)
    .run(endedAt, guildId, userId);
}
function closeOpenVoiceSessions(endedAt = Date.now()) {
  db.prepare('UPDATE voice_sessions SET ended_at = ? WHERE ended_at IS NULL').run(endedAt);
}
function getLeaderboard(guildId, startAt, endAt, now = Date.now()) {
  const rows = db.prepare(`SELECT user_id, started_at, COALESCE(ended_at, ?) AS ended_at
    FROM voice_sessions WHERE guild_id = ? AND started_at < ? AND COALESCE(ended_at, ?) > ?`)
    .all(now, guildId, endAt, now, startAt);
  const totals = new Map();
  for (const row of rows) {
    const duration = Math.max(0, Math.min(row.ended_at, endAt) - Math.max(row.started_at, startAt));
    if (duration) totals.set(row.user_id, (totals.get(row.user_id) || 0) + duration);
  }
  return [...totals.entries()].map(([user_id, milliseconds]) => ({ user_id, milliseconds }))
    .sort((a, b) => b.milliseconds - a.milliseconds).slice(0, 10);
}
function getAward(guildId, period, periodStart) {
  return db.prepare('SELECT * FROM leaderboard_awards WHERE guild_id=? AND period=? AND period_start=?')
    .get(guildId, period, periodStart);
}
function latestAward(guildId, period, beforeStart) {
  return db.prepare(`SELECT * FROM leaderboard_awards WHERE guild_id=? AND period=? AND period_start<?
    ORDER BY period_start DESC LIMIT 1`).get(guildId, period, beforeStart);
}
function recordAward(guildId, period, periodStart, userId, roleId) {
  db.prepare(`INSERT OR IGNORE INTO leaderboard_awards(guild_id,period,period_start,user_id,role_id,awarded_at)
    VALUES(?,?,?,?,?,?)`).run(guildId, period, periodStart, userId || null, roleId, Date.now());
}
function setLocked(guildId, locked) {
  db.prepare(`INSERT INTO security_settings(guild_id,locked) VALUES(?,?)
    ON CONFLICT(guild_id) DO UPDATE SET locked=excluded.locked`).run(guildId, locked ? 1 : 0);
}
function isLocked(guildId) {
  return Boolean(db.prepare('SELECT locked FROM security_settings WHERE guild_id=?').get(guildId)?.locked);
}
function whitelistUser(guildId, userId, add) {
  if (add) db.prepare('INSERT OR IGNORE INTO inviter_whitelist(guild_id,user_id) VALUES(?,?)').run(guildId, userId);
  else db.prepare('DELETE FROM inviter_whitelist WHERE guild_id=? AND user_id=?').run(guildId, userId);
}
function isWhitelisted(guildId, userId) {
  return Boolean(db.prepare('SELECT 1 FROM inviter_whitelist WHERE guild_id=? AND user_id=?').get(guildId, userId));
}

module.exports = {
  db, settings, saveGuildSettings, recordVoiceJoin, recordVoiceLeave, closeOpenVoiceSessions,
  getLeaderboard, getAward, latestAward, recordAward, setLocked, isLocked, whitelistUser, isWhitelisted
};
