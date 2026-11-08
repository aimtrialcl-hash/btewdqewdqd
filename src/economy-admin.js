'use strict';

// Manage Server-only balance administration. Changes are transactionally logged.
const { Client, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { db } = require('./database');
const prefixQuery = db.prepare('SELECT prefix FROM economy_guild_settings WHERE guild_id=?');
db.exec(`CREATE TABLE IF NOT EXISTS economy_admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  target_id TEXT NOT NULL, action TEXT NOT NULL, amount INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
)`);
const ensure = db.prepare('INSERT OR IGNORE INTO economy_accounts(guild_id,user_id) VALUES(?,?)');
const getBalance = db.prepare('SELECT balance FROM economy_accounts WHERE guild_id=? AND user_id=?');
const setBalance = db.prepare('UPDATE economy_accounts SET balance=? WHERE guild_id=? AND user_id=?');
const addAudit = db.prepare('INSERT INTO economy_admin_audit(guild_id,actor_id,target_id,action,amount,reason,created_at) VALUES(?,?,?,?,?,?,?)');
const auditLog = db.prepare('SELECT actor_id,target_id,action,amount,reason,created_at FROM economy_admin_audit WHERE guild_id=? ORDER BY id DESC LIMIT 10');
const hooked = new WeakSet();
function prefixFor(id) { return prefixQuery.get(id)?.prefix || '!'; }
function embed(title, description, color = 0x7C5CFC) { return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setTimestamp().setFooter({ text: 'NxtCoin • Admin economy audit' }); }
function parseAmount(value) { if (!/^\d+$/.test(value || '')) return 0; const n = Number(value); return Number.isSafeInteger(n) && n > 0 && n <= 1_000_000_000 ? n : 0; }
async function handleAdmin(message) {
  if (!message.guild || !message.author || message.author.bot || message.system) return;
  const prefix = prefixFor(message.guild.id);
  if (!message.content.startsWith(prefix)) return;
  const [raw, ...args] = message.content.slice(prefix.length).trim().split(/\s+/);
  const command = (raw || '').toLowerCase();
  if (!['addbal','addcoins','removebal','removecoins','setbal','economylog'].includes(command)) return;
  if (!message.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
    await message.reply({ embeds: [embed('🔒 Admin only', 'You need **Manage Server** permission to use this command.', 0xED4245)] }).catch(() => {}); return;
  }
  if (command === 'economylog') {
    const rows = auditLog.all(message.guild.id);
    const text = rows.length ? rows.map(r => `${r.action === 'remove' ? '−' : r.action === 'set' ? '=' : '+'} **${r.amount.toLocaleString()}** <@${r.target_id}> by <@${r.actor_id}>${r.reason ? ` — ${r.reason}` : ''} (<t:${Math.floor(r.created_at / 1000)}:R>)`).join('\n') : 'No admin adjustments recorded.';
    await message.reply({ embeds: [embed('📋 Recent economy changes', text)], allowedMentions: { users: [] } }).catch(() => {}); return;
  }
  const target = message.mentions.users.first();
  const amountToken = args.find(arg => /^\d+$/.test(arg));
  const amount = parseAmount(amountToken);
  if (!target || target.bot || !amount) {
    await message.reply({ embeds: [embed('🪙 Admin command help', `\`${prefix}addbal @member amount [reason]\`\n\`${prefix}removebal @member amount [reason]\`\n\`${prefix}setbal @member amount [reason]\`\n\`${prefix}economylog\`\nAmount range: 1–1,000,000,000.`)] }).catch(() => {}); return;
  }
  const action = command.startsWith('add') ? 'add' : command.startsWith('remove') ? 'remove' : 'set';
  const reason = args.slice(args.indexOf(amountToken) + 1).join(' ').slice(0, 180);
  const result = db.transaction(() => {
    ensure.run(message.guild.id, target.id);
    const before = getBalance.get(message.guild.id, target.id).balance;
    const after = action === 'add' ? before + amount : action === 'remove' ? before - amount : amount;
    if (!Number.isSafeInteger(after) || after < 0) return { ok: false, balance: before };
    setBalance.run(after, message.guild.id, target.id);
    addAudit.run(message.guild.id, message.author.id, target.id, action, amount, reason, Date.now());
    return { ok: true, before, after };
  })();
  if (!result.ok) { await message.reply({ embeds: [embed('⚠️ Insufficient balance', `Current wallet: **${result.balance.toLocaleString()} NxtCoin**.`, 0xED4245)] }).catch(() => {}); return; }
  await message.reply({ embeds: [embed('✅ Admin balance updated', `<@${target.id}>\nPrevious: **${result.before.toLocaleString()}**\nCurrent: **${result.after.toLocaleString()}**${reason ? `\nReason: ${reason}` : ''}`, 0x57F287)], allowedMentions: { users: [] } }).catch(() => {});
}
const originalLogin = Client.prototype.login;
Client.prototype.login = function loginWithEconomyAdmin(token) {
  if (!hooked.has(this)) { hooked.add(this); this.on('messageCreate', message => { void handleAdmin(message); }); }
  return originalLogin.call(this, token);
};
