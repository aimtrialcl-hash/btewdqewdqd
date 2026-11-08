require('dotenv').config();

const { Client, EmbedBuilder, PermissionFlagsBits, Message } = require('discord.js');
const { db } = require('./database');

const COOLDOWN = 10_000;
const COIN = '🪙';
const COLOR = 0x7C5CFC;
const MAX_BET = 100_000;
const cooldowns = new Map();
let emojiIndex = 0;

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
const emojiPattern = /\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?|\p{Emoji_Modifier}|\uFE0F)*/gu;
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
function embed(title, description, user, color = COLOR) {
  const result = new EmbedBuilder().setColor(color).setTitle(title).setDescription(description)
    .setTimestamp().setFooter({ text: 'NxtCoin • Community economy' });
  if (user) result.setThumbnail(user.displayAvatarURL({ size: 128 }));
  return result;
}
function animatedEmojis(guild) {
  return guild?.emojis?.cache?.filter(item => item.animated && item.available !== false)
    .map(item => item.toString()) || [];
}
function animatedEmoji(guild) {
  const list = animatedEmojis(guild);
  if (!list.length) return '';
  return list[emojiIndex++ % list.length];
}
function animateEmbedPayload(payload, guild) {
  if (!payload || !Array.isArray(payload.embeds)) return payload;
  const available = animatedEmojis(guild);
  if (!available.length) return payload;
  const replace = text => typeof text === 'string'
    ? text.replace(emojiPattern, () => animatedEmoji(guild))
    : text;
  return {
    ...payload,
    embeds: payload.embeds.map(item => {
      const value = typeof item?.toJSON === 'function' ? item.toJSON() : item;
      if (!value?.footer?.text?.includes('NxtCoin • Community economy')) return item;
      return {
        ...value,
        title: replace(value.title),
        description: replace(value.description),
        footer: value.footer ? { ...value.footer, text: replace(value.footer.text) } : value.footer,
        author: value.author ? { ...value.author, name: replace(value.author.name) } : value.author,
        fields: value.fields?.map(field => ({ ...field, name: replace(field.name), value: replace(field.value) }))
      };
    })
  };
}

function helpEmbed(guild, prefix) {
  const icon = fallback => animatedEmoji(guild) || fallback;
  const rows = [
    `${icon('🎁')} **${prefix}daily** — 100–250 NxtCoin every 24h`,
    `${icon('💼')} **${prefix}work** — 20–100 NxtCoin every 30m`,
    `${icon('🎣')} **${prefix}fish** — 15–90 NxtCoin every 15m`,
    `${icon('🔎')} **${prefix}scavenge** — 40–160 NxtCoin every hour`,
    `${icon('👛')} **${prefix}balance** [@member] — check a wallet`,
    `${icon('💸')} **${prefix}pay** @member amount — send coins`,
    `${icon('🪙')} **${prefix}coinflip** amount heads|tails — flip for coins`,
    `${icon('🎰')} **${prefix}slots** amount — play slots`,
    `${icon('🏆')} **${prefix}rich** — top wallets`,
    `${icon('⚙️')} **${prefix}prefix** <new> — change prefix (Manage Server)`
  ];
  return new EmbedBuilder().setColor(COLOR)
    .setTitle(`${animatedEmoji(guild) || '🪙'} NxtCoin • Command guide`)
    .setDescription(`${rows.join('\n')}\n\n⏱️ Shared command cooldown: **10 seconds**.\nUse **${prefix}earn** for earning methods.`)
    .setFooter({ text: `NxtCoin • Prefix: ${prefix}` }).setTimestamp();
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
      await message.reply({ embeds: [embed(`${animatedEmoji(message.guild) || '⏳'} Command cooldown`,
        `Please wait **${seconds} seconds** before using another NxtCoin command.`, message.author, 0xF0B232)],
        allowedMentions: { repliedUser: false } }).catch(() => {});
    }
    return;
  }
  cooldowns.set(key, { at: now, notified: false });

  try {
    const guildId = message.guild.id;
    const user = message.author;
    if (command === 'help' || command === 'nxthelp') {
      return await message.reply({ embeds: [helpEmbed(message.guild, prefix)] });
    }
    if (['earn','earning','earnhelp'].includes(command)) {
      return await message.reply({ embeds: [embed('✨ Ways to earn NxtCoin',
        `🎁 **${prefix}daily** — 100–250, every 24h\n💼 **${prefix}work** — 20–100, every 30m\n🎣 **${prefix}fish** — 15–90, every 15m\n🔎 **${prefix}scavenge** — 40–160, every hour\n🎰 Games can win or lose coins.`, user)] });
    }
    if (command === 'prefix') {
      if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return await message.reply({ embeds: [embed('🔒 Admin only', 'Manage Server permission is required to change the prefix.', user)] });
      }
      const next = args[0];
      if (!next) return await message.reply({ embeds: [embed('⌨️ Current prefix', `Prefix: \`${prefix}\`\nUsage: \`${prefix}prefix <new-prefix>\``, user)] });
      if (next.length > 3 || /\s/.test(next) || /[\u0000-\u001f]/.test(next)) {
        return await message.reply({ embeds: [embed('⚠️ Invalid prefix', 'Use 1–3 visible characters with no spaces.', user)] });
      }
      savePrefix.run(guildId, next);
      return await message.reply({ embeds: [embed('✅ Prefix updated', `Commands now start with \`${next}\`.`, user)] });
    }
    if (['balance','bal','wallet'].includes(command)) {
      const target = message.mentions.users.first() || user;
      return await message.reply({ embeds: [embed(`👛 ${target.username}'s wallet`, `Balance: **${coins(account(guildId, target.id).balance)}**`, target)] });
    }
    if (command === 'daily' || command === 'work' || command === 'fish' || command === 'scavenge') {
      const options = {
        daily: ['daily_at', 86_400_000, 100, 250, '🎁 Daily bonus'],
        work: ['work_at', 1_800_000, 20, 100, '💼 Shift complete'],
        fish: ['fish_at', 900_000, 15, 90, '🎣 Fishing haul'],
        scavenge: ['scavenge_at', 3_600_000, 40, 160, '💎 Treasure found']
      }[command];
      const result = award(guildId, user.id, now, ...options.slice(0, 4));
      if (!result.ok) return await message.reply({ embeds: [embed('⏳ Reward cooldown', `Try again in **${timeLeft(result.wait)}**.`, user, 0xF0B232)] });
      return await message.reply({ embeds: [embed(options[4], `You earned **${coins(result.amount)}**!\n\nBalance: **${coins(result.balance)}**`, user, 0x57F287)] });
    }
    if (command === 'pay' || command === 'give') {
      const recipient = message.mentions.users.first();
      const amount = Number(args.find(arg => /^\d+$/.test(arg)));
      if (!recipient || recipient.bot || recipient.id === user.id || !Number.isSafeInteger(amount) || amount < 1 || amount > MAX_BET) {
        return await message.reply({ embeds: [embed('💸 Send NxtCoin', `Usage: \`${prefix}pay @member amount\``, user)] });
      }
      const result = transfer(guildId, user.id, recipient.id, amount);
      if (!result.ok) return await message.reply({ embeds: [embed('🪙 Not enough coins', `Wallet balance: **${coins(result.balance)}**`, user)] });
      return await message.reply({ embeds: [embed('💸 Transfer complete', `Sent **${coins(amount)}** to ${recipient}.\nBalance: **${coins(result.balance)}**`, user)] });
    }
    if (command === 'coinflip' || command === 'flip' || command === 'slots' || command === 'spin') {
      const wallet = account(guildId, user.id);
      const bet = validBet(args[0], wallet.balance);
      const flip = command === 'coinflip' || command === 'flip';
      if (!bet || (flip && !['heads','tails'].includes((args[1] || '').toLowerCase()))) {
        return await message.reply({ embeds: [embed(flip ? '🪙 Coin flip' : '🎰 Slots',
          flip ? `Usage: \`${prefix}coinflip amount heads|tails\`` : `Usage: \`${prefix}slots amount\``, user)] });
      }
      let outcome;
      let payout;
      if (flip) {
        outcome = Math.random() < 0.5 ? 'heads' : 'tails';
        payout = outcome === args[1].toLowerCase() ? bet * 2 : 0;
      } else {
        const symbols = ['🍒','🍋','🔔','💎','⭐'];
        const roll = () => symbols[Math.floor(Math.random() * symbols.length)];
        outcome = [roll(), roll(), roll()];
        payout = outcome.every(symbol => symbol === outcome[0]) ? bet * 5 :
          (outcome[0] === outcome[1] || outcome[1] === outcome[2] || outcome[0] === outcome[2]) ? Math.floor(bet * 1.5) : 0;
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

// Message is explicitly imported above (the missing import caused the reported
// startup ReferenceError). These wrappers keep animated custom server emojis.
if (Message?.prototype?.reply) {
  const originalReply = Message.prototype.reply;
  Message.prototype.reply = function replyWithEconomyEmojis(...args) {
    return originalReply.call(this, animateEmbedPayload(args[0], this.guild), ...args.slice(1));
  };
}
if (Message?.prototype?.edit) {
  const originalEdit = Message.prototype.edit;
  Message.prototype.edit = function editWithEconomyEmojis(...args) {
    return originalEdit.call(this, animateEmbedPayload(args[0], this.guild), ...args.slice(1));
  };
}

setInterval(() => {
  const cutoff = Date.now() - COOLDOWN * 2;
  for (const [key, value] of cooldowns) if (value.at < cutoff) cooldowns.delete(key);
}, COOLDOWN * 10).unref();
