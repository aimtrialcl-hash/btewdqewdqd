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
    guild_id TEXT PRIMARY KEY, announcement_channel_id TEXT, grind_role_id TEXT, vanity_role_id TEXT,
    vanity_code TEXT, weekly_reward_role_id TEXT, monthly_reward_role_id TEXT, leaderboard_channel_id TEXT,
    weekly_message_reward_role_id TEXT, monthly_message_reward_role_id TEXT,
    leaderboard_title TEXT, leaderboard_description TEXT, leaderboard_thumbnail_url TEXT, leaderboard_image_url TEXT
  );
  CREATE TABLE IF NOT EXISTS voice_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT,guild_id TEXT NOT NULL,user_id TEXT NOT NULL,channel_id TEXT NOT NULL,started_at INTEGER NOT NULL,ended_at INTEGER);
  CREATE INDEX IF NOT EXISTS voice_sessions_period_idx ON voice_sessions(guild_id,started_at,ended_at);
  CREATE TABLE IF NOT EXISTS message_events (id INTEGER PRIMARY KEY AUTOINCREMENT,guild_id TEXT NOT NULL,user_id TEXT NOT NULL,created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS message_events_period_idx ON message_events(guild_id,created_at,user_id);
  CREATE TABLE IF NOT EXISTS leaderboard_posts (guild_id TEXT NOT NULL,metric TEXT NOT NULL,period TEXT NOT NULL,channel_id TEXT NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(guild_id,metric,period));
  CREATE TABLE IF NOT EXISTS security_settings (guild_id TEXT PRIMARY KEY,locked INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS inviter_whitelist (guild_id TEXT NOT NULL,user_id TEXT NOT NULL,PRIMARY KEY(guild_id,user_id));
  CREATE TABLE IF NOT EXISTS leaderboard_awards (guild_id TEXT NOT NULL,period TEXT NOT NULL,period_start INTEGER NOT NULL,user_id TEXT,role_id TEXT,awarded_at INTEGER NOT NULL,PRIMARY KEY(guild_id,period,period_start));
  CREATE TABLE IF NOT EXISTS message_leaderboard_awards (guild_id TEXT NOT NULL,period TEXT NOT NULL,period_start INTEGER NOT NULL,user_id TEXT,role_id TEXT,awarded_at INTEGER NOT NULL,PRIMARY KEY(guild_id,period,period_start));
`);
const columns = new Set(db.prepare('PRAGMA table_info(guild_settings)').all().map(row => row.name));
for (const name of ['weekly_reward_role_id','monthly_reward_role_id','leaderboard_channel_id','weekly_message_reward_role_id','monthly_message_reward_role_id','leaderboard_title','leaderboard_description','leaderboard_thumbnail_url','leaderboard_image_url']) {
  if (!columns.has(name)) db.exec(`ALTER TABLE guild_settings ADD COLUMN ${name} TEXT`);
}
const getSettings = db.prepare('SELECT * FROM guild_settings WHERE guild_id=?');
const saveSettings = db.prepare(`INSERT INTO guild_settings
 (guild_id,announcement_channel_id,grind_role_id,vanity_role_id,vanity_code,weekly_reward_role_id,monthly_reward_role_id,leaderboard_channel_id,weekly_message_reward_role_id,monthly_message_reward_role_id,leaderboard_title,leaderboard_description,leaderboard_thumbnail_url,leaderboard_image_url)
 VALUES (@guild_id,@announcement_channel_id,@grind_role_id,@vanity_role_id,@vanity_code,@weekly_reward_role_id,@monthly_reward_role_id,@leaderboard_channel_id,@weekly_message_reward_role_id,@monthly_message_reward_role_id,@leaderboard_title,@leaderboard_description,@leaderboard_thumbnail_url,@leaderboard_image_url)
 ON CONFLICT(guild_id) DO UPDATE SET announcement_channel_id=excluded.announcement_channel_id,grind_role_id=excluded.grind_role_id,vanity_role_id=excluded.vanity_role_id,vanity_code=excluded.vanity_code,weekly_reward_role_id=excluded.weekly_reward_role_id,monthly_reward_role_id=excluded.monthly_reward_role_id,leaderboard_channel_id=excluded.leaderboard_channel_id,weekly_message_reward_role_id=excluded.weekly_message_reward_role_id,monthly_message_reward_role_id=excluded.monthly_message_reward_role_id,leaderboard_title=excluded.leaderboard_title,leaderboard_description=excluded.leaderboard_description,leaderboard_thumbnail_url=excluded.leaderboard_thumbnail_url,leaderboard_image_url=excluded.leaderboard_image_url`);
function settings(guildId) { return getSettings.get(guildId) || {guild_id:guildId,announcement_channel_id:null,grind_role_id:null,vanity_role_id:null,vanity_code:null,weekly_reward_role_id:null,monthly_reward_role_id:null,leaderboard_channel_id:null,weekly_message_reward_role_id:null,monthly_message_reward_role_id:null,leaderboard_title:null,leaderboard_description:null,leaderboard_thumbnail_url:null,leaderboard_image_url:null}; }
function saveGuildSettings(guildId,changes) { saveSettings.run({guild_id:guildId,...settings(guildId),...changes}); return settings(guildId); }
function recordVoiceJoin(guildId,userId,channelId,startedAt=Date.now()) { db.prepare('INSERT INTO voice_sessions(guild_id,user_id,channel_id,started_at) VALUES(?,?,?,?)').run(guildId,userId,channelId,startedAt); }
function recordVoiceLeave(guildId,userId,endedAt=Date.now()) { db.prepare(`UPDATE voice_sessions SET ended_at=? WHERE id=(SELECT id FROM voice_sessions WHERE guild_id=? AND user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1)`).run(endedAt,guildId,userId); }
function closeOpenVoiceSessions(at=Date.now()) { db.prepare('UPDATE voice_sessions SET ended_at=? WHERE ended_at IS NULL').run(at); }
function getVoiceLeaderboard(guildId,start,end,now=Date.now()) { const rows=db.prepare('SELECT user_id,started_at,COALESCE(ended_at,?) AS ended_at FROM voice_sessions WHERE guild_id=? AND started_at<? AND COALESCE(ended_at,?)>?').all(now,guildId,end,now,start);const totals=new Map();for(const r of rows){const ms=Math.max(0,Math.min(r.ended_at,end)-Math.max(r.started_at,start));if(ms)totals.set(r.user_id,(totals.get(r.user_id)||0)+ms);}return[...totals].map(([user_id,score])=>({user_id,score})).sort((a,b)=>b.score-a.score).slice(0,10); }
function recordMessage(guildId,userId,at=Date.now()) { db.prepare('INSERT INTO message_events(guild_id,user_id,created_at) VALUES(?,?,?)').run(guildId,userId,at); }
function getMessageLeaderboard(guildId,start,end) { return db.prepare('SELECT user_id,COUNT(*) AS score FROM message_events WHERE guild_id=? AND created_at>=? AND created_at<? GROUP BY user_id ORDER BY score DESC LIMIT 10').all(guildId,start,end); }
function cleanupMessageEvents(older=Date.now()-100*86400000) { db.prepare('DELETE FROM message_events WHERE created_at<?').run(older); }
function getPost(guildId,metric,period) { return db.prepare('SELECT * FROM leaderboard_posts WHERE guild_id=? AND metric=? AND period=?').get(guildId,metric,period); }
function savePost(guildId,metric,period,channelId,messageId) { db.prepare('INSERT INTO leaderboard_posts(guild_id,metric,period,channel_id,message_id) VALUES(?,?,?,?,?) ON CONFLICT(guild_id,metric,period) DO UPDATE SET channel_id=excluded.channel_id,message_id=excluded.message_id').run(guildId,metric,period,channelId,messageId); }
function awardFns(table) { return {
  get:(guildId,period,start)=>db.prepare(`SELECT * FROM ${table} WHERE guild_id=? AND period=? AND period_start=?`).get(guildId,period,start),
  latest:(guildId,period,start)=>db.prepare(`SELECT * FROM ${table} WHERE guild_id=? AND period=? AND period_start<? ORDER BY period_start DESC LIMIT 1`).get(guildId,period,start),
  record:(guildId,period,start,userId,roleId)=>db.prepare(`INSERT OR IGNORE INTO ${table}(guild_id,period,period_start,user_id,role_id,awarded_at) VALUES(?,?,?,?,?,?)`).run(guildId,period,start,userId||null,roleId,Date.now())
}; }
const voiceAwards=awardFns('leaderboard_awards'),messageAwards=awardFns('message_leaderboard_awards');
function setLocked(guildId,locked){db.prepare('INSERT INTO security_settings(guild_id,locked) VALUES(?,?) ON CONFLICT(guild_id) DO UPDATE SET locked=excluded.locked').run(guildId,locked?1:0);}
function isLocked(guildId){return Boolean(db.prepare('SELECT locked FROM security_settings WHERE guild_id=?').get(guildId)?.locked);}
function whitelistUser(guildId,userId,add){if(add)db.prepare('INSERT OR IGNORE INTO inviter_whitelist(guild_id,user_id) VALUES(?,?)').run(guildId,userId);else db.prepare('DELETE FROM inviter_whitelist WHERE guild_id=? AND user_id=?').run(guildId,userId);}
function isWhitelisted(guildId,userId){return Boolean(db.prepare('SELECT 1 FROM inviter_whitelist WHERE guild_id=? AND user_id=?').get(guildId,userId));}
module.exports={db,settings,saveGuildSettings,recordVoiceJoin,recordVoiceLeave,closeOpenVoiceSessions,getVoiceLeaderboard,recordMessage,getMessageLeaderboard,cleanupMessageEvents,getPost,savePost,voiceAwards,messageAwards,setLocked,isLocked,whitelistUser,isWhitelisted};
