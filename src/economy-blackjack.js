'use strict';

// Blackjack for NxtCoin's virtual-credit economy. Credits have no cash value.
const { Client, Message, EmbedBuilder } = require('discord.js');
const { db } = require('./database');

const MAX_WAGER = 100_000;
const GAME_TTL = 5 * 60_000;
const COLOR = 0x7C5CFC;
const COIN = '🪙 NxtCoin';
const GIF = process.env.BLACKJACK_GIF_URL || 'https://media.giphy.com/media/3o7aD4pQpn7WkA0i1C/giphy.gif';
const hookedClients = new WeakSet();
const prefixQuery = db.prepare('SELECT prefix FROM economy_guild_settings WHERE guild_id=?');

db.exec(`
  CREATE TABLE IF NOT EXISTS economy_blackjack_games (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    wager INTEGER NOT NULL CHECK(wager > 0),
    player_hand TEXT NOT NULL,
    dealer_hand TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  )
`);
const getGame = db.prepare('SELECT * FROM economy_blackjack_games WHERE guild_id=? AND user_id=?');
const insertGame = db.prepare(`INSERT INTO economy_blackjack_games
  (guild_id,user_id,wager,player_hand,dealer_hand,expires_at) VALUES(?,?,?,?,?,?)`);
const updateGame = db.prepare(`UPDATE economy_blackjack_games SET player_hand=?,dealer_hand=?,expires_at=?
  WHERE guild_id=? AND user_id=?`);
const deleteGame = db.prepare('DELETE FROM economy_blackjack_games WHERE guild_id=? AND user_id=?');
const ensureAccount = db.prepare('INSERT OR IGNORE INTO economy_accounts(guild_id,user_id) VALUES(?,?)');
const balanceQuery = db.prepare('SELECT balance FROM economy_accounts WHERE guild_id=? AND user_id=?');
const debit = db.prepare('UPDATE economy_accounts SET balance=balance-? WHERE guild_id=? AND user_id=? AND balance>=?');
const credit = db.prepare('UPDATE economy_accounts SET balance=balance+? WHERE guild_id=? AND user_id=?');

const suits = ['♠', '♥', '♦', '♣'];
const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
function drawCard() { return { rank: ranks[Math.floor(Math.random() * ranks.length)], suit: suits[Math.floor(Math.random() * suits.length)] }; }
function handText(hand) { return hand.map(card => `${card.rank}${card.suit}`).join('  '); }
function handValue(hand) {
  let total = 0;
  let aces = 0;
  for (const card of hand) {
    if (card.rank === 'A') { total += 11; aces += 1; }
    else if (['K', 'Q', 'J'].includes(card.rank)) total += 10;
    else total += Number(card.rank);
  }
  while (total > 21 && aces > 0) { total -= 10; aces -= 1; }
  return total;
}
function isNatural(hand) { return hand.length === 2 && handValue(hand) === 21; }
function coins(value) { return `${Number(value).toLocaleString()} ${COIN}`; }
function makeEmbed(title, description, color = COLOR, image = true) {
  const embed = new EmbedBuilder().setColor(color).setTitle(title).setDescription(description)
    .setTimestamp().setFooter({ text: 'Blackjack • Virtual coins have no cash value' });
  if (image && /^https:\/\//i.test(GIF)) embed.setImage(GIF);
  return embed;
}
function prefixFor(guildId) { return prefixQuery.get(guildId)?.prefix || '!'; }
function validWager(raw) {
  if (!/^\d+$/.test(raw || '')) return 0;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_WAGER ? value : 0;
}
function beginGame(guildId, userId, wager) {
  return db.transaction(() => {
    ensureAccount.run(guildId, userId);
    if (getGame.get(guildId, userId)) return { ok: false, reason: 'active' };
    const balance = balanceQuery.get(guildId, userId).balance;
    if (balance < wager) return { ok: false, reason: 'funds', balance };
    const player = [drawCard(), drawCard()];
    const dealer = [drawCard(), drawCard()];
    debit.run(wager, guildId, userId, wager);
    insertGame.run(guildId, userId, wager, JSON.stringify(player), JSON.stringify(dealer), Date.now() + GAME_TTL);
    return { ok: true, player, dealer, balance: balance - wager };
  })();
}
function finishGame(guildId, userId, game, payout) {
  return db.transaction(() => {
    const current = getGame.get(guildId, userId);
    if (!current) return null;
    if (payout > 0) credit.run(payout, guildId, userId);
    deleteGame.run(guildId, userId);
    return balanceQuery.get(guildId, userId).balance;
  })();
}
function timeoutRefund(guildId, userId, game) {
  return db.transaction(() => {
    const current = getGame.get(guildId, userId);
    if (!current || current.expires_at > Date.now()) return false;
    credit.run(current.wager, guildId, userId);
    deleteGame.run(guildId, userId);
    return true;
  })();
}
function gameCard(game, revealDealer = false) {
  const player = JSON.parse(game.player_hand);
  const dealer = JSON.parse(game.dealer_hand);
  const dealerDisplay = revealDealer ? `${handText(dealer)} (**${handValue(dealer)}**)` : `${handText([dealer[0]])}  🂠`;
  return `**Your hand:** ${handText(player)} (**${handValue(player)}**)\n**Dealer:** ${dealerDisplay}\n**Wager:** ${coins(game.wager)}`;
}

async function handleBlackjack(message) {
  if (!message.guild || !message.author || message.author.bot || message.system || typeof message.content !== 'string') return;
  const prefix = prefixFor(message.guild.id);
  if (!message.content.startsWith(prefix)) return;
  const [raw, ...args] = message.content.slice(prefix.length).trim().split(/\s+/);
  if (!raw || !['bj', 'blackjack'].includes(raw.toLowerCase())) return;
  const guildId = message.guild.id;
  const userId = message.author.id;
  const action = (args[0] || '').toLowerCase();
  let game = getGame.get(guildId, userId);

  try {
    if (game && game.expires_at <= Date.now()) {
      timeoutRefund(guildId, userId, game);
      game = null;
      if (action !== 'start') {
        await message.reply({ embeds: [makeEmbed('⌛ Game expired', `Your wager was refunded. Start another with **${prefix}bj amount**.`, 0xF0B232, false)] });
        return;
      }
    }

    if (!action || action === 'help') {
      await message.reply({ embeds: [makeEmbed('🃏 Blackjack',
        `**Start:** \`${prefix}bj <bet>\` (1–${MAX_WAGER.toLocaleString()} coins)\n**Play:** \`${prefix}bj hit\` or \`${prefix}bj stand\`\n**Cancel:** \`${prefix}bj cancel\` (refunds your wager)\n\nDealer stands on 17. Blackjack pays 3:2; regular wins pay 1:1. Your game expires after 5 minutes and refunds the wager. Virtual coins have no cash value.`, COLOR, false)] });
      return;
    }

    if (action === 'hit' || action === 'stand' || action === 'cancel') {
      if (!game) {
        await message.reply({ embeds: [makeEmbed('🃏 No active hand', `Start a hand with **${prefix}bj <bet>**.`, 0xF0B232, false)] });
        return;
      }
      const player = JSON.parse(game.player_hand);
      let dealer = JSON.parse(game.dealer_hand);
      if (action === 'cancel') {
        const balance = finishGame(guildId, userId, game, game.wager);
        await message.reply({ embeds: [makeEmbed('↩️ Hand cancelled', `Your **${coins(game.wager)}** wager was returned. Wallet: **${coins(balance)}**`, COLOR, false)] });
        return;
      }
      if (action === 'hit') {
        player.push(drawCard());
        if (handValue(player) > 21) {
          game.player_hand = JSON.stringify(player);
          const balance = finishGame(guildId, userId, game, 0);
          await message.reply({ embeds: [makeEmbed('💥 Bust!', `${gameCard({ ...game, player_hand: JSON.stringify(player) }, true)}\n\nYou went over 21 and lost **${coins(game.wager)}**. Wallet: **${coins(balance)}**`, 0xED4245)] });
          return;
        }
        updateGame.run(JSON.stringify(player), game.dealer_hand, Date.now() + GAME_TTL, guildId, userId);
        const updated = getGame.get(guildId, userId);
        await message.reply({ embeds: [makeEmbed('🃏 Card dealt', `${gameCard(updated)}\n\nChoose **${prefix}bj hit** or **${prefix}bj stand**.`)] });
        return;
      }
      while (handValue(dealer) < 17) dealer.push(drawCard());
      const playerTotal = handValue(player);
      const dealerTotal = handValue(dealer);
      const natural = isNatural(player) && !isNatural(dealer);
      const payout = natural ? Math.floor(game.wager * 2.5) : playerTotal > dealerTotal ? game.wager * 2 : playerTotal === dealerTotal ? game.wager : 0;
      const result = natural ? 'Blackjack! You win 3:2.' : playerTotal > dealerTotal ? 'You beat the dealer!' : playerTotal === dealerTotal ? 'Push — your wager is returned.' : 'The dealer wins this hand.';
      const balance = finishGame(guildId, userId, game, payout);
      const color = payout > game.wager ? 0x57F287 : payout === game.wager ? 0xF0B232 : 0xED4245;
      await message.reply({ embeds: [makeEmbed('🃏 Hand complete', `${gameCard({ ...game, player_hand: JSON.stringify(player), dealer_hand: JSON.stringify(dealer) }, true)}\n\n${result}\nPayout: **${coins(payout)}**\nWallet: **${coins(balance)}**`, color)] });
      return;
    }

    if (game) {
      await message.reply({ embeds: [makeEmbed('🃏 Hand in progress', `Use **${prefix}bj hit**, **${prefix}bj stand**, or **${prefix}bj cancel**.\n\n${gameCard(game)}`, 0xF0B232, false)] });
      return;
    }
    const wager = validWager(action);
    if (!wager) {
      await message.reply({ embeds: [makeEmbed('🃏 Blackjack', `Start with **${prefix}bj <bet>**. Example: \`${prefix}bj 100\`.`, 0xF0B232, false)] });
      return;
    }
    const started = beginGame(guildId, userId, wager);
    if (!started.ok) {
      const description = started.reason === 'active' ? `You already have a hand. Use **${prefix}bj hit** or **${prefix}bj stand**.` : `You need **${coins(wager)}** but have **${coins(started.balance)}**.`;
      await message.reply({ embeds: [makeEmbed('🃏 Cannot start hand', description, 0xF0B232, false)] });
      return;
    }
    game = getGame.get(guildId, userId);
    const playerNatural = isNatural(started.player);
    const dealerNatural = isNatural(started.dealer);
    if (playerNatural || dealerNatural) {
      const payout = playerNatural && dealerNatural ? wager : playerNatural ? Math.floor(wager * 2.5) : 0;
      const balance = finishGame(guildId, userId, game, payout);
      const result = playerNatural && dealerNatural ? 'Both have blackjack — push.' : playerNatural ? 'Blackjack! You win 3:2.' : 'Dealer has blackjack.';
      await message.reply({ embeds: [makeEmbed('🃏 Natural blackjack', `${gameCard(game, true)}\n\n${result}\nPayout: **${coins(payout)}**\nWallet: **${coins(balance)}**`)] });
      return;
    }
    await message.reply({ embeds: [makeEmbed('🃏 Your turn', `${gameCard(game)}\n\nChoose **${prefix}bj hit** or **${prefix}bj stand**.`, COLOR)] });
  } catch (error) {
    console.error('Blackjack command failed:', error);
    await message.reply({ embeds: [makeEmbed('⚠️ Blackjack error', 'Could not complete the hand. Your active hand can be resumed with the blackjack command.', 0xED4245, false)] }).catch(() => {});
  }
}

// Add the blackjack command to both help embeds without altering the existing handlers.
if (Message?.prototype?.reply) {
  const originalReply = Message.prototype.reply;
  Message.prototype.reply = function replyWithBlackjackHelp(...args) {
    const payload = args[0];
    if (payload && Array.isArray(payload.embeds)) {
      const prefix = this.guild ? prefixFor(this.guild.id) : '!';
      payload.embeds = payload.embeds.map(item => {
        const data = typeof item?.toJSON === 'function' ? item.toJSON() : item;
        if (!data || typeof data !== 'object') return item;
        const title = data.title || '';
        if (/command guide/i.test(title)) {
          return { ...data, description: `${data.description || ''}\n\n🕹️ **${prefix}games** — arcade games and minigames\n🃏 **${prefix}bj <bet>** — blackjack; use \`${prefix}bj hit|stand|cancel\` while playing` };
        }
        if (/nxtcoin arcade/i.test(title) && !/blackjack/i.test(data.description || '')) {
          return { ...data, description: `${data.description || ''}\n🃏 **${prefix}bj <bet>** — blackjack (hit, stand, or cancel)` };
        }
        return item;
      });
    }
    return originalReply.apply(this, args);
  };
}

const originalLogin = Client.prototype.login;
Client.prototype.login = function loginWithBlackjack(token) {
  if (!hookedClients.has(this)) {
    hookedClients.add(this);
    this.on('messageCreate', message => { void handleBlackjack(message); });
  }
  return originalLogin.call(this, token);
};

setInterval(() => {
  const now = Date.now();
  const expired = db.prepare('SELECT guild_id,user_id,wager FROM economy_blackjack_games WHERE expires_at<=?').all(now);
  if (!expired.length) return;
  db.transaction(() => {
    for (const game of expired) {
      const stillExpired = db.prepare('SELECT expires_at FROM economy_blackjack_games WHERE guild_id=? AND user_id=?').get(game.guild_id, game.user_id);
      if (!stillExpired || stillExpired.expires_at > Date.now()) continue;
      ensureAccount.run(game.guild_id, game.user_id);
      credit.run(game.wager, game.guild_id, game.user_id);
      deleteGame.run(game.guild_id, game.user_id);
    }
  })();
}, 30_000).unref();
