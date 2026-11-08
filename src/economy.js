require('dotenv').config();

const { Client, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const store = require('./database');
const db = store.db;

const COMMAND_COOLDOWN_MS = 10_000;
const COIN = '🪙';
const COLOR = 0x7C5CFC;
const DAILY_REWARD_MIN = 100;
const DAILY_REWARD_MAX = 250;
const WORK_REWARD_MIN = 20;
const WORK_REWARD_MAX = 100;
const FISH_REWARD_MIN = 15;
const FISH_REWARD_MAX = 90;
const SCAVENGE_REWARD_MIN = 40;
const SCAVENGE_REWARD_MAX = 160;
const MAX_BET = 100000;

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

const getAccount = db.prepare('SELECT * FROM economy_accounts WHERE guild_id=? AND user_id=?');
const ensureAccount = db.prepare('INSERT OR IGNORE INTO economy_accounts(guild_id,user_id) VALUES(?,?)');
const prefixQuery = db.prepare('SELECT prefix FROM economy_guild_settings WHERE guild_id=?');
const setPrefixQuery = db.prepare(`
  INSERT INTO economy_guild_settings(guild_id,prefix) VALUES(?,?)
  ON CONFLICT(guild_id) DO UPDATE SET prefix=excluded.prefix
`);

const economyCooldowns = new Map();
const unicodeEmoji = /\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?|\p{Emoji_Modifier}|\uFE0F)*/gu;

function prefixFor(guildId) {
  return prefixQuery.get(guildId)?.prefix || '!';
}

function formatCoins(value) {
  return `${Number(value).toLocaleString()} ${COIN} NxtCoin`;
}

function remainingText(ms) {
  const mins = Math.max(1, Math.ceil(ms / 60000));
  const hours = Math.floor(mins / 60);
  return hours ? `${hours}h ${mins % 60}m` : `${mins}m`;
}

function account(guildId, userId) {
  ensureAccount.run(guildId, userId);
  return getAccount.get(guildId, userId);
}

function makeEmbed(title, description, user, overrideColor = COLOR) {
  const embed = new EmbedBuilder()
    .setColor(overrideColor)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp()
    .setFooter({ text: 'NxtCoin • Community economy' });

  if (user) embed.setThumbnail(user.displayAvatarURL({ size: 128 }));
  return embed;
}

function animatedEmojis(guild) {
  if (!guild || !guild.emojis || !guild.emojis.cache) return [];
  return guild.emojis.cache
    .filter(emoji => emoji.animated && emoji.available !== false)
    .map(emoji => emoji.toString());
}

let emojiCursor = 0;

function animatedMarkup(guild) {
  const emojis = animatedEmojis(guild);
  if (!emojis.length) return '';
  const emoji = emojis[emojiCursor % emojis.length];
  emojiCursor += 1;
  return emoji;
}

function replaceEmojiText(text, guild) {
  if (typeof text !== 'string') return text;
  const emojis = animatedEmojis(guild);
  if (!emojis.length) return text;
  return text.replace(unicodeEmoji, () => animatedMarkup(guild));
}

function animateEmbedPayload(payload, guild) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.embeds)) {
    return payload;
  }

  return {
    ...payload,
    embeds: payload.embeds.map(embed => {
      if (!embed || typeof embed.toJSON !== 'function') return embed;

      const value = embed.toJSON();
      const isEconomy = value?.footer?.text?.includes('NxtCoin • Community economy');
      if (!isEconomy) return embed;

      const animated = animatedEmojis(guild);
      if (!animated.length) return embed;

      const next = {
        ...value,
        title: replaceEmojiText(value.title, guild),
        description: replaceEmojiText(value.description, guild),
        author: value.author ? { ...value.author, name: replaceEmojiText(value.author.name, guild) } : value.author,
        footer: value.footer ? { ...value.footer, text: replaceEmojiText(value.footer.text, guild) } : value.footer
      };

      if (Array.isArray(value.fields)) {
        next.fields = value.fields.map(field => ({
          ...field,
          name: replaceEmojiText(field.name, guild),
          value: replaceEmojiText(field.value, guild)
        }));
      }

      return next;
    })
  };
}

function getCooldownKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function isOnCooldown(guildId, userId) {
  const key = getCooldownKey(guildId, userId);
  const now = Date.now();
  const previous = economyCooldowns.get(key);

  if (!previous) return false;
  return now - previous < COMMAND_COOLDOWN_MS;
}

function setCooldown(guildId, userId) {
  economyCooldowns.set(getCooldownKey(guildId, userId), Date.now());
}

function getCooldownSeconds(guildId, userId) {
  const key = getCooldownKey(guildId, userId);
  const previous = economyCooldowns.get(key);
  if (!previous) return 0;
  return Math.max(1, Math.ceil((COMMAND_COOLDOWN_MS - (Date.now() - previous)) / 1000));
}

function payDailyReward(guildId, userId, now) {
  const row = account(guildId, userId);
  const wait = 24 * 60 * 60 * 1000 - (now - row.daily_at);
  if (wait > 0) return { ok: false, wait };

  const reward = DAILY_REWARD_MIN + Math.floor(Math.random() * (DAILY_REWARD_MAX - DAILY_REWARD_MIN + 1));
  db.prepare('UPDATE economy_accounts SET balance=balance+?,daily_at=? WHERE guild_id=? AND user_id=?')
    .run(reward, now, guildId, userId);

  return { ok: true, reward, newBalance: row.balance + reward };
}

function payWorkReward(guildId, userId, now) {
  const row = account(guildId, userId);
  const wait = 30 * 60 * 1000 - (now - row.work_at);
  if (wait > 0) return { ok: false, wait };

  const reward = WORK_REWARD_MIN + Math.floor(Math.random() * (WORK_REWARD_MAX - WORK_REWARD_MIN + 1));
  db.prepare('UPDATE economy_accounts SET balance=balance+?,work_at=? WHERE guild_id=? AND user_id=?')
    .run(reward, now, guildId, userId);

  return { ok: true, reward, newBalance: row.balance + reward };
}

function payFishReward(guildId, userId, now) {
  const row = account(guildId, userId);
  const wait = 15 * 60 * 1000 - (now - row.fish_at);
  if (wait > 0) return { ok: false, wait };

  const reward = FISH_REWARD_MIN + Math.floor(Math.random() * (FISH_REWARD_MAX - FISH_REWARD_MIN + 1));
  db.prepare('UPDATE economy_accounts SET balance=balance+?,fish_at=? WHERE guild_id=? AND user_id=?')
    .run(reward, now, guildId, userId);

  return { ok: true, reward, newBalance: row.balance + reward };
}

function payScavengeReward(guildId, userId, now) {
  const row = account(guildId, userId);
  const wait = 60 * 60 * 1000 - (now - row.scavenge_at);
  if (wait > 0) return { ok: false, wait };

  const reward = SCAVENGE_REWARD_MIN + Math.floor(Math.random() * (SCAVENGE_REWARD_MAX - SCAVENGE_REWARD_MIN + 1));
  db.prepare('UPDATE economy_accounts SET balance=balance+?,scavenge_at=? WHERE guild_id=? AND user_id=?')
    .run(reward, now, guildId, userId);

  return { ok: true, reward, newBalance: row.balance + reward };
}

function transferCoins(guildId, fromId, toId, amount) {
  const sender = account(guildId, fromId);
  if (sender.balance < amount) return { ok: false, balance: sender.balance };

  ensureAccount.run(guildId, toId);
  db.prepare('UPDATE economy_accounts SET balance=balance-? WHERE guild_id=? AND user_id=?')
    .run(amount, guildId, fromId);

  db.prepare('UPDATE economy_accounts SET balance=balance+? WHERE guild_id=? AND user_id=?')
    .run(amount, guildId, toId);

  return { ok: true, balance: sender.balance - amount };
}

function placeBet(guildId, userId, bet, payout) {
  const row = account(guildId, userId);
  if (row.balance < bet) return { ok: false, balance: row.balance };

  const nextBalance = row.balance - bet + payout;
  db.prepare('UPDATE economy_accounts SET balance=? WHERE guild_id=? AND user_id=?')
    .run(nextBalance, guildId, userId);

  return { ok: true, balance: nextBalance, net: payout - bet };
}

function parseBet(raw, balance) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BET || value > balance) return null;
  return value;
}

function leaderboard(guildId) {
  return db.prepare(`
    SELECT user_id, balance
    FROM economy_accounts
    WHERE guild_id=?
    ORDER BY balance DESC
    LIMIT 10
  `).all(guildId);
}

function buildHelpEmbed(guild, prefix) {
  const animated = animatedEmojis(guild);
  const titleIcon = animated.length ? animatedMarkup(guild) : '🪙';
  const lines = [
    `${animated.length ? animatedMarkup(guild) || '🎁' : '🎁'} **${prefix}daily** — claim 100–250 NxtCoin every 24h`,
    `${animated.length ? animatedMarkup(guild) || '💼' : '💼'} **${prefix}work** — earn 20–100 NxtCoin every 30m`,
    `${animated.length ? animatedMarkup(guild) || '🎣' : '🎣'} **${prefix}fish** — earn 15–90 NxtCoin every 15m`,
    `${animated.length ? animatedMarkup(guild) || '🔎' : '🔎'} **${prefix}scavenge** — earn 40–160 NxtCoin every hour`,
    `${animated.length ? animatedMarkup(guild) || '👛' : '👛'} **${prefix}balance** — check wallet`,
    `${animated.length ? animatedMarkup(guild) || '💸' : '💸'} **${prefix}pay** @member amount — transfer coins`,
    `${animated.length ? animatedMarkup(guild) || '🪙' : '🪙'} **${prefix}coinflip** amount heads|tails — gamble`,
    `${animated.length ? animatedMarkup(guild) || '🎰' : '🎰'} **${prefix}slots** amount — spin the slots`,
    `${animated.length ? animatedMarkup(guild) || '🏆' : '🏆'} **${prefix}rich** — top wallet leaderboard`,
    `${animated.length ? animatedMarkup(guild) || '⚙️' : '⚙️'} **${prefix}prefix** <new> — change prefix`
  ];

  const helpText = [
    ...lines,
    '',
    '⏱️ Shared 10-second cooldown on all NxtCoin commands.',
    animated.length ? '✨ Animated server emojis are active.' : 'Add animated server emojis to make the help embed animate.'
  ].join('\n');

  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`${titleIcon} NxtCoin • Command guide`)
    .setDescription(helpText)
    .setFooter({ text: `NxtCoin • Prefix: ${prefix}` })
    .setTimestamp();
}

async function handleEconomyMessage(message) {
  if (!message.guild || message.author.bot || message.system) return;

  const prefix = prefixFor(message.guild.id);
  if (!message.content.startsWith(prefix)) return;

  const trimmed = message.content.slice(prefix.length).trim();
  if (!trimmed) return;

  const [rawCommand, ...args] = trimmed.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const guildId = message.guild.id;
  const user = message.author;

  if (isOnCooldown(guildId, user.id)) {
    const waitSeconds = getCooldownSeconds(guildId, user.id);
    const animated = animatedMarkup(message.guild);
    const embed = new EmbedBuilder()
      .setColor(0xF0B232)
      .setTitle(`${animated || '⏳ '}Command cooldown`)
      .setDescription(`Please wait **${waitSeconds} seconds** before using another NxtCoin command.`)
      .setFooter({ text: 'NxtCoin • Community economy' });

    await message.reply({ embeds: [embed] }).catch(() => {});
    return;
  }

  setCooldown(guildId, user.id);

  try {
    if (command === 'prefix') {
      if (!message.member || !message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        await message.reply({
          embeds: [makeEmbed('🔒 Admin only', 'You need **Manage Server** permission to change the prefix.', user)]
        });
        return;
      }

      const next = args[0];
      if (!next) {
        await message.reply({
          embeds: [makeEmbed('⌨️ Server prefix', `Current prefix: \`${prefix}\`\nUsage: \`${prefix}prefix <new>\``, user)]
        });
        return;
      }

      if (next.length > 3 || /\s/.test(next) || /[\u0000-\u001f]/.test(next)) {
        await message.reply({
          embeds: [makeEmbed('⚠️ Invalid prefix', 'Use 1–3 visible characters and no spaces.', user)]
        });
        return;
      }

      setPrefixQuery.run(guildId, next);
      await message.reply({
        embeds: [makeEmbed('✅ Prefix updated', `This server’s NxtCoin commands now start with \`${next}\``, user)]
      });
      return;
    }

    if (command === 'help' || command === 'nxthelp' || command === 'earn' || command === 'earning' || command === 'earnhelp') {
      await message.reply({ embeds: [buildHelpEmbed(message.guild, prefix)] });
      return;
    }

    if (command === 'balance' || command === 'bal' || command === 'wallet') {
      const target = message.mentions.users.first() || user;
      const row = account(guildId, target.id);
      await message.reply({
        embeds: [makeEmbed(`👛 ${target.username}'s wallet`, `**Balance:**\n${formatCoins(row.balance)}`, target)]
      });
      return;
    }

    if (command === 'daily') {
      const result = payDailyReward(guildId, user.id, Date.now());
      if (!result.ok) {
        await message.reply({
          embeds: [makeEmbed('⏳ Daily reward', `Next daily reward in **${remainingText(result.wait)}**.`, user, 0xF0B232)]
        });
        return;
      }

      await message.reply({
        embeds: [makeEmbed('🎁 Daily reward claimed', `You earned **${formatCoins(result.reward)}**!\n\nNew balance: **${formatCoins(result.newBalance)}**`, user)]
      });
      return;
    }

    if (command === 'work') {
      const result = payWorkReward(guildId, user.id, Date.now());
      if (!result.ok) {
        await message.reply({
          embeds: [makeEmbed('🛠️ Work cooldown', `Come back in **${remainingText(result.wait)}**.`, user, 0xF0B232)]
        });
        return;
      }

      const jobs = [
        'helped clean the city market',
        'fixed the arcade system',
        'delivered a supply crate',
        'did a short livestream set',
        'rescued a crate from the docks'
      ];

      const job = jobs[Math.floor(Math.random() * jobs.length)];
      await message.reply({
        embeds: [makeEmbed('💼 Work complete', `You ${job} and earned **${formatCoins(result.reward)}**!\n\nBalance: **${formatCoins(result.newBalance)}**`, user)]
      });
      return;
    }

    if (command === 'fish') {
      const result = payFishReward(guildId, user.id, Date.now());
      if (!result.ok) {
        await message.reply({
          embeds: [makeEmbed('🎣 Fish cooldown', `You can fish again in **${remainingText(result.wait)}**.`, user, 0xF0B232)]
        });
        return;
      }

      await message.reply({
        embeds: [makeEmbed('🎣 Fishing haul', `You caught a shiny prize and earned **${formatCoins(result.reward)}**!\n\nBalance: **${formatCoins(result.newBalance)}**`, user, 0x2ECC71)]
      });
      return;
    }

    if (command === 'scavenge') {
      const result = payScavengeReward(guildId, user.id, Date.now());
      if (!result.ok) {
        await message.reply({
          embeds: [makeEmbed('🔎 Scavenge cooldown', `You can scavenge again in **${remainingText(result.wait)}**.`, user, 0xF0B232)]
        });
        return;
      }

      await message.reply({
        embeds: [makeEmbed('💎 Treasure found', `You found a hidden stash and earned **${formatCoins(result.reward)}**!\n\nBalance: **${formatCoins(result.newBalance)}**`, user, 0xE67E22)]
      });
      return;
    }

    if (command === 'pay' || command === 'give') {
      const recipient = message.mentions.users.first();
      const amount = Number(args.find(arg => /^\d+$/.test(arg)));
      if (!recipient || recipient.bot || recipient.id === user.id || !Number.isSafeInteger(amount) || amount < 1 || amount > MAX_BET) {
        await message.reply({
          embeds: [makeEmbed('💸 Send NxtCoin', `Usage: \`${prefix}pay @member amount\`\nSend 1–${MAX_BET.toLocaleString()} coins.`, user)]
        });
        return;
      }

      const result = transferCoins(guildId, user.id, recipient.id, amount);
      if (!result.ok) {
        await message.reply({
          embeds: [makeEmbed('🪙 Not enough NxtCoin', `You only have **${formatCoins(result.balance)}**.`, user)]
        });
        return;
      }

      await message.reply({
        embeds: [makeEmbed('💸 Transfer complete', `Sent **${formatCoins(amount)}** to ${recipient}.\n\nNew balance: **${formatCoins(result.balance)}**`, user)]
      });
      return;
    }

    if (command === 'coinflip' || command === 'flip') {
      const wallet = account(guildId, user.id);
      const bet = parseBet(args[0], wallet.balance);
      const choice = (args[1] || '').toLowerCase();
      if (!bet || !['heads', 'tails'].includes(choice)) {
        await message.reply({
          embeds: [makeEmbed('🪙 Coin flip', `Usage: \`${prefix}coinflip amount heads|tails\`\nBet up to **${MAX_BET.toLocaleString()}** NxtCoin.`, user)]
        });
        return;
      }

      const landed = Math.random() < 0.5 ? 'heads' : 'tails';
      const won = landed === choice;
      const result = placeBet(guildId, user.id, bet, won ? bet * 2 : 0);

      if (!result.ok) {
        await message.reply({
          embeds: [makeEmbed('🪙 Bet not placed', `You only have **${formatCoins(result.balance)}**.`, user)]
        });
        return;
      }

      await message.reply({
        embeds: [makeEmbed(won ? '✨ You won!' : '💨 You lost', `${won ? `The coin landed on **${landed.toUpperCase()}**.` : `The coin landed on **${landed.toUpperCase()}**.`}\n\nBalance: **${formatCoins(result.balance)}**`, user)]
      });
      return;
    }

    if (command === 'slots' || command === 'spin') {
      const wallet = account(guildId, user.id);
      const bet = parseBet(args[0], wallet.balance);
      if (!bet) {
        await message.reply({
          embeds: [makeEmbed('🎰 Slots', `Usage: \`${prefix}slots amount\`\nBet 1–${MAX_BET.toLocaleString()} NxtCoin.`, user)]
        });
        return;
      }

      const symbols = ['🍒', '🍋', '🔔', '💎', '⭐'];
      const reel = () => symbols[Math.floor(Math.random() * symbols.length)];
      const resultSymbols = [reel(), reel(), reel()];
      let payout = 0;

      if (resultSymbols[0] === resultSymbols[1] && resultSymbols[1] === resultSymbols[2]) {
        payout = bet * 5;
      } else if (
        resultSymbols[0] === resultSymbols[1] ||
        resultSymbols[0] === resultSymbols[2] ||
        resultSymbols[1] === resultSymbols[2]
      ) {
        payout = Math.floor(bet * 1.5);
      }

      const result = placeBet(guildId, user.id, bet, payout);
      if (!result.ok) {
        await message.reply({
          embeds: [makeEmbed('🎰 Spin failed', `You only have **${formatCoins(result.balance)}**.`, user)]
        });
        return;
      }

      const status = payout > 0
        ? `🎉 You won **${formatCoins(payout)}**!`
        : '💨 No match — you lost the spin.';

      await message.reply({
        embeds: [makeEmbed(payout > 0 ? '✨ Nice spin!' : '🎰 Try again', `${status}\n\nResult: **${resultSymbols.join(' | ')}**\n\nBalance: **${formatCoins(result.balance)}**`, user)]
      });
      return;
    }

    if (command === 'rich' || command === 'nxttop') {
      const rows = leaderboard(guildId);
      if (!rows.length) {
        await message.reply({
          embeds: [makeEmbed('🏆 Rich list', 'No one has coins yet. Start earning!', user)]
        });
        return;
      }

      const medals = ['🥇', '🥈', '🥉'];
      const list = rows
        .map((row, i) => `${medals[i] || `**${i + 1}.**`} <@${row.user_id}> — **${formatCoins(row.balance)}**`)
        .join('\n');

      await message.reply({
        embeds: [makeEmbed('🏆 NxtCoin rich list', list, user)]
      });
      return;
    }

    await message.reply({
      embeds: [makeEmbed('❓ Unknown command', `Try **${prefix}help** to see available commands.`, user)]
    });
  } catch (error) {
    console.error('NxtCoin economy error:', error);
    await message.reply({
      embeds: [makeEmbed('⚠️ Economy error', 'Something went wrong. Please try again in a moment.', user)]
    }).catch(() => {});
  }
}

const originalLogin = Client.prototype.login;
Client.prototype.login = function loginWithEconomy(token) {
  if (!this.__nxtCoinEconomyAttached) {
    this.__nxtCoinEconomyAttached = true;
    this.on('messageCreate', handleEconomyMessage);
  }
  return originalLogin.call(this, token);
};

if (Message && Message.prototype && Message.prototype.reply) {
  const originalReply = Message.prototype.reply;
  Message.prototype.reply = function replyWithAnimatedEconomy(...args) {
    const payload = args[0];
    const guild = this.guild;
    if (payload && typeof payload === 'object' && Array.isArray(payload.embeds)) {
      return originalReply.call(this, animateEmbedPayload(payload, guild), ...args.slice(1));
    }
    return originalReply.call(this, ...args);
  };
}

if (Message && Message.prototype && Message.prototype.edit) {
  const originalEdit = Message.prototype.edit;
  Message.prototype.edit = function editWithAnimatedEconomy(...args) {
    const payload = args[0];
    const guild = this.guild;
    if (payload && typeof payload === 'object' && Array.isArray(payload.embeds)) {
      return originalEdit.call(this, animateEmbedPayload(payload, guild), ...args.slice(1));
    }
    return originalEdit.call(this, ...args);
  };
}

setInterval(() => {
  const cutoff = Date.now() - COMMAND_COOLDOWN_MS * 2;
  for (const [key, value] of economyCooldowns) {
    if (value < cutoff) economyCooldowns.delete(key);
  }
}, COMMAND_COOLDOWN_MS * 10).unref();
