'use strict';

// Casual, virtual-coin minigames for the existing NxtCoin economy.
// This is entertainment software only; coins have no cash value.
const { Client, EmbedBuilder } = require('discord.js');
const { db } = require('./database');

const PREFIX_QUERY = db.prepare('SELECT prefix FROM economy_guild_settings WHERE guild_id=?');
const ENSURE_ACCOUNT = db.prepare('INSERT OR IGNORE INTO economy_accounts(guild_id,user_id) VALUES(?,?)');
const BALANCE = db.prepare('SELECT balance FROM economy_accounts WHERE guild_id=? AND user_id=?');
const SET_BALANCE = db.prepare('UPDATE economy_accounts SET balance=? WHERE guild_id=? AND user_id=?');
const COIN = '🪙 NxtCoin';
const COLOR = 0x7C5CFC;
const MAX_BET = 100_000;
const GAME_GIF = process.env.GAME_GIF_URL || 'https://media.giphy.com/media/3o7aD4pQpn7WkA0i1C/giphy.gif';
const cooldowns = new Map();
const triviaRounds = new Map();
const hookedClients = new WeakSet();
const questions = [
  { q: 'Which planet is known as the Red Planet?', choices: ['A) Venus', 'B) Mars', 'C) Jupiter'], answer: 'b' },
  { q: 'How many sides does a hexagon have?', choices: ['A) 5', 'B) 6', 'C) 8'], answer: 'b' },
  { q: 'What is the largest ocean on Earth?', choices: ['A) Atlantic', 'B) Indian', 'C) Pacific'], answer: 'c' },
  { q: 'Which animal is the largest mammal?', choices: ['A) Blue whale', 'B) Elephant', 'C) Giraffe'], answer: 'a' },
  { q: 'What is 9 × 7?', choices: ['A) 56', 'B) 63', 'C) 72'], answer: 'b' },
  { q: 'Which gas do plants absorb from the atmosphere?', choices: ['A) Oxygen', 'B) Nitrogen', 'C) Carbon dioxide'], answer: 'c' }
];
const eightBallAnswers = [
  'Absolutely! ✨', 'Looks likely. 🎯', 'The odds are in your favor. 🍀',
  'Ask again after a snack. 🍪', 'Hard to tell right now. 🌙', 'Probably not this time. 🌧️'
];

function prefixFor(guildId) { return PREFIX_QUERY.get(guildId)?.prefix || '!'; }
function coins(amount) { return `${Number(amount).toLocaleString()} ${COIN}`; }
function makeEmbed(title, description, image = true, color = COLOR) {
  const embed = new EmbedBuilder().setColor(color).setTitle(title).setDescription(description)
    .setTimestamp().setFooter({ text: 'NxtCoin Arcade • Virtual coins have no cash value' });
  if (image && /^https:\/\//i.test(GAME_GIF)) embed.setImage(GAME_GIF);
  return embed;
}
function ensureAndGetBalance(guildId, userId) {
  ENSURE_ACCOUNT.run(guildId, userId);
  return BALANCE.get(guildId, userId).balance;
}
function parseWager(raw, balance) {
  if (raw === undefined) return { amount: 0, valid: true };
  if (!/^\d+$/.test(raw)) return { amount: 0, valid: false };
  const amount = Number(raw);
  return { amount, valid: Number.isSafeInteger(amount) && amount >= 1 && amount <= MAX_BET && amount <= balance };
}
function settleWager(guildId, userId, wager, payout) {
  const transaction = db.transaction(() => {
    ENSURE_ACCOUNT.run(guildId, userId);
    const current = BALANCE.get(guildId, userId).balance;
    if (current < wager) return { ok: false, balance: current };
    const next = current - wager + payout;
    if (!Number.isSafeInteger(next) || next < 0) return { ok: false, balance: current };
    SET_BALANCE.run(next, guildId, userId);
    return { ok: true, balance: next };
  });
  return transaction();
}
function award(guildId, userId, amount) {
  const transaction = db.transaction(() => {
    ENSURE_ACCOUNT.run(guildId, userId);
    db.prepare('UPDATE economy_accounts SET balance=balance+? WHERE guild_id=? AND user_id=?').run(amount, guildId, userId);
    return BALANCE.get(guildId, userId).balance;
  });
  return transaction();
}
function cooldown(message, name, duration = 10_000) {
  const key = `${message.guild.id}:${message.author.id}:${name}`;
  const now = Date.now();
  const until = cooldowns.get(key) || 0;
  if (until > now) return Math.ceil((until - now) / 1000);
  cooldowns.set(key, now + duration);
  return 0;
}
function normalizeChoice(raw) {
  const choice = (raw || '').toLowerCase();
  if (['r', 'rock', '🪨'].includes(choice)) return 'rock';
  if (['p', 'paper', '📄'].includes(choice)) return 'paper';
  if (['s', 'scissors', '✂️'].includes(choice)) return 'scissors';
  return null;
}
function randomItem(items) { return items[Math.floor(Math.random() * items.length)]; }

async function handleGameMessage(message) {
  if (!message.guild || !message.author || message.author.bot || message.system || typeof message.content !== 'string') return;
  const prefix = prefixFor(message.guild.id);
  if (!message.content.startsWith(prefix)) return;
  const [raw, ...args] = message.content.slice(prefix.length).trim().split(/\s+/);
  if (!raw) return;
  const command = raw.toLowerCase();
  const userId = message.author.id;
  const guildId = message.guild.id;

  // Trivia answer is accepted only from the player who started that round.
  if (command === 'answer') {
    const key = `${guildId}:${userId}`;
    const round = triviaRounds.get(key);
    if (!round || round.expiresAt < Date.now()) {
      triviaRounds.delete(key);
      await message.reply({ embeds: [makeEmbed('🧠 No active trivia', `Start a round with **${prefix}trivia**.`, false)] }).catch(() => {});
      return;
    }
    triviaRounds.delete(key);
    if ((args[0] || '').toLowerCase() === round.answer) {
      const balance = award(guildId, userId, 50);
      await message.reply({ embeds: [makeEmbed('✅ Correct!', `You earned **${coins(50)}**.\nWallet balance: **${coins(balance)}**`, false, 0x57F287)] }).catch(() => {});
    } else {
      await message.reply({ embeds: [makeEmbed('❌ Not quite', `The correct answer was **${round.answer.toUpperCase()}**. Try another round later!`, false, 0xED4245)] }).catch(() => {});
    }
    return;
  }

  if (command === 'games' || command === 'arcade') {
    const description = [
      `✂️ **${prefix}rps rock|paper|scissors [bet]** — play against the bot`,
      `🎲 **${prefix}dice high|low [bet]** — guess 1–3 or 4–6`,
      `🧠 **${prefix}trivia** then **${prefix}answer A|B|C** — win 50 coins`,
      `🗡️ **${prefix}arena** — battle a random monster for 35 coins`,
      `🔮 **${prefix}8ball question** — get a playful answer`,
      `🎰 **${prefix}slots amount** and **${prefix}coinflip amount heads|tails** are in the economy commands.`
    ].join('\n');
    await message.reply({ embeds: [makeEmbed('🕹️ NxtCoin Arcade', `${description}\n\nGames use virtual coins only; no cash value.`, false)] }).catch(() => {});
    return;
  }

  const supported = new Set(['rps', 'dice', 'trivia', 'arena', '8ball']);
  if (!supported.has(command)) return;
  const duration = command === 'trivia' ? 30_000 : command === 'arena' ? 60_000 : command === '8ball' ? 3_000 : 5_000;
  const wait = cooldown(message, command, duration);
  if (wait) {
    await message.reply({ embeds: [makeEmbed('⏳ Game cooldown', `Try **${prefix}${command}** again in **${wait}s**. Other games are available.`, false, 0xF0B232)] }).catch(() => {});
    return;
  }

  try {
    if (command === 'rps') {
      const choice = normalizeChoice(args[0]);
      const balance = ensureAndGetBalance(guildId, userId);
      const wager = parseWager(args[1], balance);
      if (!choice || !wager.valid) {
        await message.reply({ embeds: [makeEmbed('✂️ Rock Paper Scissors', `Usage: \`${prefix}rps rock|paper|scissors [bet]\`\nOptional bet: 1–${MAX_BET.toLocaleString()} coins.`, false)] });
        return;
      }
      const botChoice = randomItem(['rock', 'paper', 'scissors']);
      const won = (choice === 'rock' && botChoice === 'scissors') || (choice === 'paper' && botChoice === 'rock') || (choice === 'scissors' && botChoice === 'paper');
      const draw = choice === botChoice;
      const payout = wager.amount ? (won ? wager.amount * 2 : draw ? wager.amount : 0) : 0;
      const result = settleWager(guildId, userId, wager.amount, payout);
      const line = draw ? 'It’s a draw — your bet is returned.' : won ? `You win **${coins(payout)}**!` : `The bot wins${wager.amount ? ` — you lose **${coins(wager.amount)}**` : '.'}`;
      await message.reply({ embeds: [makeEmbed(`✂️ You: ${choice} • Bot: ${botChoice}`, `${line}\n\nWallet: **${coins(result.balance)}**`)] });
      return;
    }

    if (command === 'dice') {
      const guess = (args[0] || '').toLowerCase();
      const balance = ensureAndGetBalance(guildId, userId);
      const wager = parseWager(args[1], balance);
      if (!['high', 'low'].includes(guess) || !wager.valid) {
        await message.reply({ embeds: [makeEmbed('🎲 High or Low', `Usage: \`${prefix}dice high|low [bet]\`\nLow = 1–3, High = 4–6. Optional bet up to ${MAX_BET.toLocaleString()}.`, false)] });
        return;
      }
      const roll = 1 + Math.floor(Math.random() * 6);
      const won = (guess === 'low' && roll <= 3) || (guess === 'high' && roll >= 4);
      const payout = wager.amount && won ? wager.amount * 2 : 0;
      const result = settleWager(guildId, userId, wager.amount, payout);
      await message.reply({ embeds: [makeEmbed(`🎲 The die rolled ${roll}`, `${won ? 'Nice guess!' : 'Not this time.'}${wager.amount ? won ? ` You won **${coins(payout)}**!` : ` You lost **${coins(wager.amount)}**.` : ''}\nWallet: **${coins(result.balance)}**`)] });
      return;
    }

    if (command === 'trivia') {
      const key = `${guildId}:${userId}`;
      if (triviaRounds.has(key) && triviaRounds.get(key).expiresAt > Date.now()) {
        await message.reply({ embeds: [makeEmbed('🧠 Round in progress', `Answer with **${prefix}answer A**, **B**, or **C** before starting another round.`, false)] });
        return;
      }
      const item = randomItem(questions);
      triviaRounds.set(key, { answer: item.answer, expiresAt: Date.now() + 30_000 });
      await message.reply({ embeds: [makeEmbed('🧠 Quick trivia • 30 seconds', `**${item.q}**\n\n${item.choices.join('\n')}\n\nAnswer with **${prefix}answer A|B|C** to earn **50 coins**.`, false)] });
      return;
    }

    if (command === 'arena') {
      const monsters = [
        ['Moss Golem', '🪨'], ['Moon Slime', '🌙'], ['Clockwork Crow', '⚙️'], ['Cave Dragon', '🐉']
      ];
      const [monster, icon] = randomItem(monsters);
      const won = Math.random() < 0.55;
      const reward = won ? 35 : 0;
      const balance = reward ? award(guildId, userId, reward) : ensureAndGetBalance(guildId, userId);
      await message.reply({ embeds: [makeEmbed(`${icon} Arena: ${monster}`, `${won ? `Victory! You found **${coins(reward)}**.` : 'The monster got away this time. Try again in a minute.'}\n\nWallet: **${coins(balance)}**`)] });
      return;
    }

    if (command === '8ball') {
      if (!args.length) {
        await message.reply({ embeds: [makeEmbed('🔮 Magic 8-Ball', `Ask a question: \`${prefix}8ball will I win the next game?\``, false)] });
        return;
      }
      await message.reply({ embeds: [makeEmbed('🔮 The 8-Ball says…', `> ${args.join(' ').slice(0, 180)}\n\n**${randomItem(eightBallAnswers)}**`, false)] });
    }
  } catch (error) {
    console.error('NxtCoin arcade error:', error);
    await message.reply({ embeds: [makeEmbed('⚠️ Arcade error', 'Could not finish that game. Please try again.', false, 0xED4245)] }).catch(() => {});
  }
}

const originalLogin = Client.prototype.login;
Client.prototype.login = function loginWithArcade(token) {
  if (!hookedClients.has(this)) {
    hookedClients.add(this);
    this.on('messageCreate', message => { void handleGameMessage(message); });
  }
  return originalLogin.call(this, token);
};

setInterval(() => {
  const now = Date.now();
  for (const [key, expiresAt] of cooldowns) if (expiresAt < now) cooldowns.delete(key);
  for (const [key, round] of triviaRounds) if (round.expiresAt < now) triviaRounds.delete(key);
}, 30_000).unref();
