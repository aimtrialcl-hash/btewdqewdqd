require('dotenv').config();

const { Client, EmbedBuilder, PermissionFlagsBits, Message } = require('discord.js');
const { db } = require('./database');

const COOLDOWN = 10_000;
const COIN = '🪙';
const COLOR = 0x7C5CFC;
const MAX_BET = 100_000;
const GOOGLE_EMOJI_CDN = 'https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@main/png/128';
const cooldowns = new Map();
const emojiIndex = 0;

// CREATE TABLE leaves existing databases untouched, so migrate older account
// tables before any commands query the newer earning cooldown columns.
db.exec(`
  CREATE TABLE IF NOT EXISTS economy_accounts (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
    daily_at INTEGER NOT NULL DEFAULT 0,
    work_at INTEGER NOT NULL DEFAULT 0,
    fish_at INTEGER NOT NULL DEFAULT 0,
    scavenge_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS economy_guild_settings (
    guild_id TEXT PRIMARY KEY,
    prefix TEXT NOT NULL DEFAULT '!'
  );
`);
const columns = new Set(db.prepare('PRAGMA table_info(economy_accounts)').all().map(row => row.name));
for (const name of ['daily_at', 'work_at', 'fish_at', 'scavenge_at']) {
  if (!columns.has(name)) db.exec(`ALTER TABLE economy_accounts ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`);
}

const getAccount = db.prepare('SELECT * FROM economy_accounts WHERE guild_id=? AND user_id=?');
const ensureAccount = db.prepare('INSERT OR IGNORE INTO economy_accounts(guild_id,user_id) VALUES(?,?)');
const getPrefix = db.prepare('SELECT prefix FROM economy_guild_settings WHERE guild_id=?');
const savePrefix = db.prepare(`INSERT INTO economy_guild_settings(guild_id,prefix) VALUES(?,?)
  ON CONFLICT(guild_id) DO UPDATE SET prefix=excluded.prefix`);
const commandNames = new Set([
  'help','nxthelp','earn','earning','earnhelp','prefix','balance','bal','wallet','daily','work',
  'fish','scavenge','pay','give','coinflip','flip','slots','spin','rich','nxttop'
]);

function prefixFor(guildId) { return getPrefix.get(guildId)?.prefix || '!'; }
function account(guildId, userId) {
  ensureAccount.run(guildId, userId);
  return getAccount.get(guildId, userId);
}
function coins(value) { return `${Number(value).toLocaleString()} ${COIN} NxtCoin`; }
function timeLeft(ms) {
  const mins = Math.max(1, Math.ceil(ms / 60_000));
  const hours = Math.floor(mins / 60);
  return hours ? `${hours}h ${mins % 60}m` : `${mins}m`;
}
function googleEmoji(codepoint) {
  return `${GOOGLE_EMOJI_CDN}/emoji_u${codepoint}.png`;
}
function googleIconFor(title) {
  const titleText = String(title || '').toLowerCase();
  if (/fish|fishing/.test(titleText)) return googleEmoji('1f41f');
  if (/scavenge|treasure/.test(titleText)) return googleEmoji('1f4a0');
  if (/daily|gift/.test(titleText)) return googleEmoji('1f381');
  if (/work|shift/.test(titleText)) return googleEmoji('1f4bc');
  if (/wallet|balance/.test(titleText)) return googleEmoji('1f45b');
  if (/rich|leaderboard/.test(titleText)) return googleEmoji('1f3c6');
  if (/slots|spin/.test(titleText)) return googleEmoji('1f3b0');
  if (/flip|coin/.test(titleText)) return googleEmoji('1fa99');
  if (/help|command/.test(titleText)) return googleEmoji('1f3ae');
  if (/cooldown|wait/.test(titleText)) return googleEmoji('23f3');
  if (/transfer|send/.test(titleText)) return googleEmoji('1f4b8');
  return googleEmoji('1fa99');
}
function embed(title, description, user, color = COLOR) {
  const result = new EmbedBuilder().setColor(color).setTitle(title).setDescription(description)
    .setAuthor({ name: 'NxtCoin • Community economy', iconURL: googleIconFor(title) })
    .setTimestamp().setFooter({ text: 'Google Noto Emoji artwork • NxtCoin' });
  if (user) result.setThumbnail(user.displayAvatarURL({ size: 128 }));
  return result;
}
function helpEmbed(prefix) {
  const rows = [
    `🎁 **${prefix}daily** — 100–250 NxtCoin every 24h`,
    `💼 **${prefix}work** — 20–100 NxtCoin every 30m`,
    `🎣 **${prefix}fish** — 15–90 NxtCoin every 15m`,
    `🔎 **${prefix}scavenge** — 40–160 NxtCoin every hour`,
    `👛 **${prefix}balance** [@member] — check a wallet`,
    `💸 **${prefix}pay** @member amount — send coins`,
    `🪙 **${prefix}coinflip** amount heads|tails — flip for coins`,
    `🎰 **${prefix}slots** amount — play slots`,
    `🏆 **${prefix}rich** — top wallets`,
    `✨ **${prefix}earn** — earning methods`,
    `⚙️ **${prefix}prefix** <new> — change prefix (Manage Server)`
  ];
  return embed('🎮 NxtCoin • Command guide', `${rows.join('\n')}\n\n⏱️ Shared command cooldown: **10 seconds**.`, null)
    .setFooter({ text: `NxtCoin • Prefix: ${prefix} • Google Noto Emoji artwork` });
}
function award(guildId, userId, now, field, cooldown, min, max) {
  const transaction = db.transaction(() => {
    const row = account(guildId, userId);
    const wait = cooldown - (now - row[field]);
    if (wait > 0) return { ok: false, wait };
    const amount = min + Math.floor(Math.random() * (max - min + 1));
    db.prepare(`UPDATE economy_accounts SET balance=balance+?,${field}=? WHERE guild_id=? AND user_id=?`)
      .run(amount, now, guildId, userId);
    return { ok: true, amount, balance: row.balance + amount };
  });
  return transaction();
}
function transfer(guildId, senderId, recipientId, amount) {
  const transaction = db.transaction(() => {
    const sender = account(guildId, senderId);
    if (sender.balance < amount) return { ok: false, balance: sender.balance };
    ensureAccount.run(guildId, recipientId);
    db.prepare('UPDATE economy_accounts SET balance=balance-? WHERE guild_id=? AND user_id=?').run(amount, guildId, senderId);
    db.prepare('UPDATE economy_accounts SET balance=balance+? WHERE guild_id=? AND user_id=?').run(amount, guildId, recipientId);
    return { ok: true, balance: sender.balance - amount };
  });
  return transaction();
}
function betCoins(guildId, userId, bet, payout) {
  const transaction = db.transaction(() => {
    const row = account(guildId, userId);
    if (row.balance < bet) return { ok: false, balance: row.balance };
    const balance = row.balance - bet + payout;
    db.prepare('UPDATE economy_accounts SET balance=? WHERE guild_id=? AND user_id=?').run(balance, guildId, userId);
    return { ok: true, balance };
  });
  return transaction();
}
function validBet(raw, balance) {
  const amount = Number(raw);
  return Number.isSafeInteger(amount) && amount >= 1 && amount <= MAX_BET && amount <= balance ? amount : 0;
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function sendAnimatedReward(message, title, action, result, frames) {
  const reply = await message.reply({ embeds: [embed(title, `${frames[0].text}\n\nSearching for your reward…`, message.author)] });
  for (const frame of frames.slice(1)) {
    await pause(500);
    await reply.edit({ embeds: [embed(title, `${frame.text}\n\nSearching for your reward…`, message.author)] }).catch(() => {});
  }
  await pause(350);
  return reply.edit({ embeds: [embed('✨ Reward collected!', `${action}\n\n**+${coins(result.amount)}**\nWallet balance: **${coins(result.balance)}**`, message.author, 0x57F287)] });
}

async function handleMessage(message) {
  if (!message.guild || message.author.bot || message.system) return;
  const prefix = prefixFor(message.guild.id);
  if (!message.content.startsWith(prefix)) return;
  const [rawCommand, ...args] = message.content.slice(prefix.length).trim().split(/\s+/);
  if (!rawCommand) return;
  const command = rawCommand.toLowerCase();
  if (!commandNames.has(command)) return;

  const key = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
  const last = cooldowns.get(key);
  if (last && now - last.at < COOLDOWN) {
    if (!last.notified) {
      last.notified = true;
      const seconds = Math.max(1, Math.ceil((COOLDOWN - (now - last.at)) / 1000));
      await message.reply({ embeds: [embed('⏳ Command cooldown', `Please wait **${seconds} seconds** before using another NxtCoin command.`, message.author, 0xF0B232)], allowedMentions: { repliedUser: false } }).catch(() => {});
    }
    return;
  }
  cooldowns.set(key, { at: now, notified: false });

  try {
    const guildId = message.guild.id;
    const user = message.author;
    if (command === 'help' || command === 'nxthelp') return await message.reply({ embeds: [helpEmbed(prefix)] });
    if (['earn','earning','earnhelp'].includes(command)) {
      return await message.reply({ embeds: [embed('✨ Ways to earn NxtCoin', `🎁 **${prefix}daily** — 100–250, every 24h\n💼 **${prefix}work** — 20–100, every 30m\n🎣 **${prefix}fish** — 15–90, every 15m\n🔎 **${prefix}scavenge** — 40–160, every hour\n🎰 Games can win or lose coins.`, user)] });
    }
    if (command === 'prefix') {
      if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) return await message.reply({ embeds: [embed('🔒 Admin only', 'Manage Server permission is required to change the prefix.', user)] });
      const next = args[0];
      if (!next) return await message.reply({ embeds: [embed('⌨️ Current prefix', `Prefix: \`${prefix}\`\nUsage: \`${prefix}prefix <new-prefix>\``, user)] });
      if (next.length > 3 || /\s/.test(next) || /[\u0000-\u001f]/.test(next)) return await message.reply({ embeds: [embed('⚠️ Invalid prefix', 'Use 1–3 visible characters with no spaces.', user)] });
      savePrefix.run(guildId, next);
      return await message.reply({ embeds: [embed('✅ Prefix updated', `Commands now start with \`${next}\`.`, user)] });
    }
    if (['balance','bal','wallet'].includes(command)) {
      const target = message.mentions.users.first() || user;
      return await message.reply({ embeds: [embed(`👛 ${target.username}'s wallet`, `Balance: **${coins(account(guildId, target.id).balance)}**`, target)] });
    }
    if (['daily','work','fish','scavenge'].includes(command)) {
      const options = {
        daily: ['daily_at', 86_400_000, 100, 250, '🎁 Daily bonus', [{ text: '🎁 Opening your daily NxtCoin drop…' }, { text: '✨ Your coins are sparkling…' }]],
        work: ['work_at', 1_800_000, 20, 100, '💼 Shift complete', [{ text: '💼 Starting your shift…' }, { text: '⚙️ Finishing one last task…' }]],
        fish: ['fish_at', 900_000, 15, 90, '🎣 Fishing haul', [{ text: '🎣 Casting your line…' }, { text: '🌊 Something is nibbling!' }, { text: '🐟 Reel it in!' }]],
        scavenge: ['scavenge_at', 3_600_000, 40, 160, '💎 Treasure found', [{ text: '🔎 Searching the area…' }, { text: '🗺️ A clue appears!' }, { text: '💎 A hidden stash!' }]]
      }[command];
      const result = award(guildId, user.id, now, ...options.slice(0, 4));
      if (!result.ok) return await message.reply({ embeds: [embed('⏳ Reward cooldown', `Try again in **${timeLeft(result.wait)}**.`, user, 0xF0B232)] });
      return await sendAnimatedReward(message, options[4], `You completed **${command}** and earned NxtCoin!`, result, options[5]);
    }
    if (command === 'pay' || command === 'give') {
      const recipient = message.mentions.users.first();
      const amount = Number(args.find(arg => /^\d+$/.test(arg)));
      if (!recipient || recipient.bot || recipient.id === user.id || !Number.isSafeInteger(amount) || amount < 1 || amount > MAX_BET) return await message.reply({ embeds: [embed('💸 Send NxtCoin', `Usage: \`${prefix}pay @member amount\``, user)] });
      const result = transfer(guildId, user.id, recipient.id, amount);
      if (!result.ok) return await message.reply({ embeds: [embed('🪙 Not enough coins', `Wallet balance: **${coins(result.balance)}**`, user)] });
      return await message.reply({ embeds: [embed('💸 Transfer complete', `Sent **${coins(amount)}** to ${recipient}.\nBalance: **${coins(result.balance)}**`, user)] });
    }
    if (command === 'coinflip' || command === 'flip' || command === 'slots' || command === 'spin') {
      const wallet = account(guildId, user.id);
      const bet = validBet(args[0], wallet.balance);
      const flip = command === 'coinflip' || command === 'flip';
      if (!bet || (flip && !['heads','tails'].includes((args[1] || '').toLowerCase()))) return await message.reply({ embeds: [embed(flip ? '🪙 Coin flip' : '🎰 Slots', flip ? `Usage: \`${prefix}coinflip amount heads|tails\`` : `Usage: \`${prefix}slots amount\``, user)] });
      let outcome;
      let payout;
      if (flip) {
        outcome = Math.random() < 0.5 ? 'heads' : 'tails';
        payout = outcome === args[1].toLowerCase() ? bet * 2 : 0;
      } else {
        const symbols = ['🍒','🍋','🔔','💎','⭐'];
        const roll = () => symbols[Math.floor(Math.random() * symbols.length)];
        outcome = [roll(), roll(), roll()];
        payout = outcome.every(symbol => symbol === outcome[0]) ? bet * 5 : (outcome[0] === outcome[1] || outcome[1] === outcome[2] || outcome[0] === outcome[2]) ? Math.floor(bet * 1.5) : 0;
      }
      const result = betCoins(guildId, user.id, bet, payout);
      if (!result.ok) return await message.reply({ embeds: [embed('🪙 Bet not placed', `Balance: **${coins(result.balance)}**`, user)] });
      const text = flip ? `Landed on **${outcome.toUpperCase()}**.` : `Result: **${outcome.join(' | ')}**`;
      return await message.reply({ embeds: [embed(payout ? '✨ You won!' : '🎲 Game complete', `${text}\n${payout ? `Prize: **${coins(payout)}**` : `You lost **${coins(bet)}**.`}\n\nBalance: **${coins(result.balance)}**`, user)] });
    }
    if (command === 'rich' || command === 'nxttop') {
      const rows = db.prepare('SELECT user_id,balance FROM economy_accounts WHERE guild_id=? ORDER BY balance DESC LIMIT 10').all(guildId);
      const text = rows.length ? rows.map((row, i) => `${['🥇','🥈','🥉'][i] || `**${i + 1}.**`} <@${row.user_id}> — **${coins(row.balance)}**`).join('\n') : 'No wallets yet. Start earning!';
      return await message.reply({ embeds: [embed('🏆 NxtCoin rich list', text, user)] });
    }
  } catch (error) {
    console.error('NxtCoin economy error:', error);
    await message.reply({ embeds: [embed('⚠️ Economy error', 'Something went wrong. Please try again.', message.author, 0xED4245)] }).catch(() => {});
  }
}

const originalLogin = Client.prototype.login;
Client.prototype.login = function loginWithEconomy(token) {
  if (!this.__nxtCoinEconomyAttached) {
    this.__nxtCoinEconomyAttached = true;
    this.on('messageCreate', handleMessage);
  }
  return originalLogin.call(this, token);
};

// Google Noto artwork is static PNG, shown as the embed's author icon. Message
// edit frames in reward commands create a simple animation-like sequence.
if (Message?.prototype?.reply) {
  const originalReply = Message.prototype.reply;
  Message.prototype.reply = function replyWithGoogleNotoEmoji(...args) {
    return originalReply.call(this, ...args);
  };
}

setInterval(() => {
  const cutoff = Date.now() - COOLDOWN * 2;
  for (const [key, value] of cooldowns) if (value.at < cutoff) cooldowns.delete(key);
}, COOLDOWN * 10).unref();
