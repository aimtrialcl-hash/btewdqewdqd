// Prefix-command NxtCoin economy. Loaded as a Node preload so it can add its
// message commands without changing the existing bot/dashboard command flow.
require('dotenv').config();
const { Client, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const store = require('./database');
const db = store.db;

db.exec(`
  CREATE TABLE IF NOT EXISTS economy_accounts (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
    daily_at INTEGER NOT NULL DEFAULT 0,
    work_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS economy_guild_settings (
    guild_id TEXT PRIMARY KEY,
    prefix TEXT NOT NULL DEFAULT '!'
  );
`);

const getAccount = db.prepare('SELECT * FROM economy_accounts WHERE guild_id=? AND user_id=?');
const ensureAccount = db.prepare('INSERT OR IGNORE INTO economy_accounts(guild_id,user_id) VALUES(?,?)');
const prefixQuery = db.prepare('SELECT prefix FROM economy_guild_settings WHERE guild_id=?');
const setPrefixQuery = db.prepare(`INSERT INTO economy_guild_settings(guild_id,prefix) VALUES(?,?)
  ON CONFLICT(guild_id) DO UPDATE SET prefix=excluded.prefix`);
const DAY = 24 * 60 * 60 * 1000;
const WORK_COOLDOWN = 30 * 60 * 1000;
const MAX_BET = 100000;
const COIN = '🪙';
const COLOR = 0x5865F2;

function prefixFor(guildId) { return prefixQuery.get(guildId)?.prefix || '!'; }
function fmt(amount) { return `${Number(amount).toLocaleString()} ${COIN} NxtCoin`; }
function remainingText(ms) {
  const mins = Math.max(1, Math.ceil(ms / 60000));
  const hours = Math.floor(mins / 60);
  return hours ? `${hours}h ${mins % 60}m` : `${mins}m`;
}
function makeEmbed(title, description, user) {
  const embed = new EmbedBuilder().setColor(COLOR).setTitle(title).setDescription(description).setTimestamp();
  if (user) embed.setThumbnail(user.displayAvatarURL({ size: 128 }));
  embed.setFooter({ text: 'NxtCoin • Community economy' });
  return embed;
}
function account(guildId, userId) {
  ensureAccount.run(guildId, userId);
  return getAccount.get(guildId, userId);
}

const claimDaily = db.transaction((guildId, userId, now, reward) => {
  const row = account(guildId, userId);
  const wait = DAY - (now - row.daily_at);
  if (wait > 0) return { ok: false, wait };
  db.prepare('UPDATE economy_accounts SET balance=balance+?,daily_at=? WHERE guild_id=? AND user_id=?').run(reward, now, guildId, userId);
  return { ok: true, balance: row.balance + reward };
});
const claimWork = db.transaction((guildId, userId, now, reward) => {
  const row = account(guildId, userId);
  const wait = WORK_COOLDOWN - (now - row.work_at);
  if (wait > 0) return { ok: false, wait };
  db.prepare('UPDATE economy_accounts SET balance=balance+?,work_at=? WHERE guild_id=? AND user_id=?').run(reward, now, guildId, userId);
  return { ok: true, balance: row.balance + reward };
});
const transfer = db.transaction((guildId, fromId, toId, amount) => {
  const sender = account(guildId, fromId);
  if (sender.balance < amount) return { ok: false, balance: sender.balance };
  ensureAccount.run(guildId, toId);
  db.prepare('UPDATE economy_accounts SET balance=balance-? WHERE guild_id=? AND user_id=?').run(amount, guildId, fromId);
  db.prepare('UPDATE economy_accounts SET balance=balance+? WHERE guild_id=? AND user_id=?').run(amount, guildId, toId);
  return { ok: true, balance: sender.balance - amount };
});
const placeBet = db.transaction((guildId, userId, bet, payout) => {
  const row = account(guildId, userId);
  if (row.balance < bet) return { ok: false, balance: row.balance };
  const balance = row.balance - bet + payout;
  db.prepare('UPDATE economy_accounts SET balance=? WHERE guild_id=? AND user_id=?').run(balance, guildId, userId);
  return { ok: true, balance, net: payout - bet };
});

function parseBet(raw, balance) {
  const bet = Number(raw);
  if (!Number.isSafeInteger(bet) || bet < 1 || bet > MAX_BET || bet > balance) return null;
  return bet;
}
function leaderboard(guildId) {
  return db.prepare('SELECT user_id,balance FROM economy_accounts WHERE guild_id=? ORDER BY balance DESC LIMIT 10').all(guildId);
}
async function handleMessage(message) {
  if (!message.guild || message.author.bot || message.system) return;
  const prefix = prefixFor(message.guild.id);
  if (!message.content.startsWith(prefix)) return;
  const input = message.content.slice(prefix.length).trim();
  if (!input) return;
  const [rawCommand, ...args] = input.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const user = message.author;
  const guildId = message.guild.id;

  try {
    if (command === 'prefix') {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return message.reply({ embeds: [makeEmbed('🔒 Admin only', 'You need **Manage Server** permission to change the bot prefix.', user)] });
      }
      const next = args[0];
      if (!next) return message.reply({ embeds: [makeEmbed('⌨️ Server prefix', `Current prefix: \`${prefix}\`\nUsage: \`${prefix}prefix <new-prefix>\` (1–3 characters, no spaces)`, user)] });
      if (next.length > 3 || /\s/.test(next) || /[\u0000-\u001f]/.test(next)) {
        return message.reply({ embeds: [makeEmbed('⚠️ Invalid prefix', 'Choose a prefix that is 1–3 visible characters with no spaces.', user)] });
      }
      setPrefixQuery.run(guildId, next);
      return message.reply({ embeds: [makeEmbed('✅ Prefix updated', `This server’s NxtCoin commands now start with \`${next}\`.`, user)] });
    }

    if (command === 'help' || command === 'nxthelp') {
      const text = [
        `\`${prefix}balance\` — check your NxtCoin wallet`,
        `\`${prefix}daily\` — collect a daily coin bonus`,
        `\`${prefix}work\` — earn coins (30-minute cooldown)`,
        `\`${prefix}pay @member amount\` — send coins to a member`,
        `\`${prefix}coinflip amount heads|tails\` — risk coins on a flip`,
        `\`${prefix}slots amount\` — spin the emoji slots`,
        `\`${prefix}rich\` — server NxtCoin leaderboard`,
        `\`${prefix}prefix <new>\` — change this server’s prefix (Manage Server)`
      ].join('\n');
      return message.reply({ embeds: [makeEmbed('🎮 NxtCoin Arcade', `Earn, save, send, and play with **NxtCoin** 🪙\n\n${text}`, user)] });
    }

    if (command === 'balance' || command === 'bal' || command === 'wallet') {
      const target = message.mentions.users.first() || user;
      const row = account(guildId, target.id);
      return message.reply({ embeds: [makeEmbed(`👛 ${target.username}’s NxtCoin wallet`, `**Balance**\n${fmt(row.balance)}\n\nKeep earning and climb the server rich list with \`${prefix}rich\`.`, target)] });
    }

    if (command === 'daily') {
      const reward = 100 + Math.floor(Math.random() * 151);
      const result = claimDaily(guildId, user.id, Date.now(), reward);
      if (!result.ok) return message.reply({ embeds: [makeEmbed('⏳ Daily bonus already collected', `Your next daily NxtCoin bonus is ready in **${remainingText(result.wait)}**.`, user)] });
      return message.reply({ embeds: [makeEmbed('🎁 Daily drop claimed!', `You found **${fmt(reward)}**!\n\nWallet balance: **${fmt(result.balance)}**`, user)] });
    }

    if (command === 'work') {
      const jobs = [
        'delivered a mysterious package 📦', 'fixed the arcade machines 🕹️', 'helped a space miner 🚀',
        'DJ’d the server lounge 🎧', 'found a shiny coin under the couch 🛋️'
      ];
      const reward = 20 + Math.floor(Math.random() * 81);
      const result = claimWork(guildId, user.id, Date.now(), reward);
      if (!result.ok) return message.reply({ embeds: [makeEmbed('🛠️ Take a breather', `You already worked recently. Try again in **${remainingText(result.wait)}**.`, user)] });
      const job = jobs[Math.floor(Math.random() * jobs.length)];
      return message.reply({ embeds: [makeEmbed('💼 Shift complete!', `You ${job} and earned **${fmt(reward)}**.\n\nWallet balance: **${fmt(result.balance)}**`, user)] });
    }

    if (command === 'pay' || command === 'give') {
      const recipient = message.mentions.users.first();
      const amount = Number(args.find(arg => /^\d+$/.test(arg)));
      if (!recipient || recipient.bot || recipient.id === user.id || !Number.isSafeInteger(amount) || amount < 1 || amount > MAX_BET) {
        return message.reply({ embeds: [makeEmbed('💸 Send NxtCoin', `Usage: \`${prefix}pay @member amount\`\nSend 1–${MAX_BET.toLocaleString()} coins to another member.`, user)] });
      }
      const result = transfer(guildId, user.id, recipient.id, amount);
      if (!result.ok) return message.reply({ embeds: [makeEmbed('🪙 Not enough NxtCoin', `Your wallet has **${fmt(result.balance)}**.`, user)] });
      return message.reply({ embeds: [makeEmbed('💸 Transfer complete', `**${fmt(amount)}** sent to ${recipient}.\nYour new balance: **${fmt(result.balance)}**`, user)] });
    }

    if (command === 'coinflip' || command === 'flip') {
      const wallet = account(guildId, user.id);
      const bet = parseBet(args[0], wallet.balance);
      const choice = (args[1] || '').toLowerCase();
      if (!bet || !['heads', 'tails'].includes(choice)) return message.reply({ embeds: [makeEmbed('🪙 NxtCoin coin flip', `Usage: \`${prefix}coinflip amount heads|tails\`\nBet up to **${MAX_BET.toLocaleString()}** NxtCoin. A win pays 2× your bet.`, user)] });
      const landed = Math.random() < 0.5 ? 'heads' : 'tails';
      const won = landed === choice;
      const result = placeBet(guildId, user.id, bet, won ? bet * 2 : 0);
      if (!result.ok) return message.reply({ embeds: [makeEmbed('🪙 Bet not placed', `Your balance is **${fmt(result.balance)}**.`, user)] });
      const game = await message.reply({ embeds: [makeEmbed('🪙 The coin is spinning…', '✨ 🪙 ✨\n\nThe NxtCoin is flipping!', user)] });
      for (const frame of ['🌙 🪙 ☀️', '✨ 🪙 💫', '☀️ 🪙 🌙']) {
        await new Promise(resolve => setTimeout(resolve, 650));
        await game.edit({ embeds: [makeEmbed('🪙 The coin is spinning…', `${frame}\n\nThe NxtCoin is flipping!`, user)] }).catch(() => {});
      }
      const outcome = won ? `🎉 **${landed.toUpperCase()}! You won ${fmt(bet)}.**` : `💨 **${landed.toUpperCase()}!** Better luck next flip.`;
      return game.edit({ embeds: [makeEmbed(won ? '✨ NxtCoin jackpot!' : '🪙 Flip complete', `${outcome}\n\nBalance: **${fmt(result.balance)}**`, user)] });
    }

    if (command === 'slots' || command === 'spin') {
      const wallet = account(guildId, user.id);
      const bet = parseBet(args[0], wallet.balance);
      if (!bet) return message.reply({ embeds: [makeEmbed('🎰 NxtCoin slots', `Usage: \`${prefix}slots amount\`\nBet 1–${MAX_BET.toLocaleString()} NxtCoin. Match three symbols for 5×; any pair pays 1.5×.`, user)] });
      const symbols = ['🍒', '🍋', '🔔', '💎', '⭐'];
      const roll = () => symbols[Math.floor(Math.random() * symbols.length)];
      const resultSymbols = [roll(), roll(), roll()];
      let payout = 0;
      if (resultSymbols[0] === resultSymbols[1] && resultSymbols[1] === resultSymbols[2]) payout = bet * 5;
      else if (resultSymbols[0] === resultSymbols[1] || resultSymbols[0] === resultSymbols[2] || resultSymbols[1] === resultSymbols[2]) payout = Math.floor(bet * 1.5);
      const result = placeBet(guildId, user.id, bet, payout);
      if (!result.ok) return message.reply({ embeds: [makeEmbed('🎰 Spin not placed', `Your balance is **${fmt(result.balance)}**.`, user)] });
      const game = await message.reply({ embeds: [makeEmbed('🎰 NxtCoin slots', '🎲 **[ ❔ | ❔ | ❔ ]**\n\nThe reels are rolling…', user)] });
      for (const frame of ['🍒 | ⭐ | 🔔', '🔔 | 💎 | 🍋', `${resultSymbols[0]} | ${roll()} | ${roll()}`]) {
        await new Promise(resolve => setTimeout(resolve, 600));
        await game.edit({ embeds: [makeEmbed('🎰 NxtCoin slots', `🎲 **[ ${frame} ]**\n\nThe reels are rolling…`, user)] }).catch(() => {});
      }
      const won = payout > 0;
      const status = won ? `🎉 You won **${fmt(payout)}** (${result.net >= 0 ? '+' : ''}${fmt(result.net)} net)!` : `💨 No match — **${fmt(bet)}** spent.`;
      return game.edit({ embeds: [makeEmbed(won ? '✨ Nice spin!' : '🎰 Try again!', `🎲 **[ ${resultSymbols.join(' | ')} ]**\n\n${status}\nBalance: **${fmt(result.balance)}**`, user)] });
    }

    if (command === 'rich' || command === 'nxttop') {
      const rows = leaderboard(guildId);
      if (!rows.length) return message.reply({ embeds: [makeEmbed('🏆 NxtCoin rich list', 'The wallet board is ready — earn some NxtCoin to claim the first spot!', user)] });
      const medals = ['🥇', '🥈', '🥉'];
      const list = rows.map((row, i) => `${medals[i] || `**${i + 1}.**`} <@${row.user_id}> — **${fmt(row.balance)}**`).join('\n');
      return message.reply({ embeds: [makeEmbed('🏆 NxtCoin rich list', list, user)] });
    }
  } catch (error) {
    console.error('NxtCoin command failed:', error);
    await message.reply({ embeds: [makeEmbed('⚠️ NxtCoin error', 'That command could not finish. Please try again in a moment.', user)] }).catch(() => {});
  }
}

const originalLogin = Client.prototype.login;
Client.prototype.login = function loginWithNxtCoin(token) {
  if (!this.__nxtCoinCommandsAttached) {
    this.on('messageCreate', message => { void handleMessage(message); });
    this.__nxtCoinCommandsAttached = true;
  }
  return originalLogin.call(this, token);
};
