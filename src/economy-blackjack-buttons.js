'use strict';

// Attach single-message Hit / Stand / Cancel buttons to blackjack embed replies.
const { Client, Message, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { db } = require('./database');
const hooked = new WeakSet();
const prefixQuery = db.prepare('SELECT prefix FROM economy_guild_settings WHERE guild_id=?');
const getGame = db.prepare('SELECT * FROM economy_blackjack_games WHERE guild_id=? AND user_id=?');
const updateGame = db.prepare('UPDATE economy_blackjack_games SET player_hand=?,dealer_hand=?,expires_at=? WHERE guild_id=? AND user_id=?');
const deleteGame = db.prepare('DELETE FROM economy_blackjack_games WHERE guild_id=? AND user_id=?');
const ensureAccount = db.prepare('INSERT OR IGNORE INTO economy_accounts(guild_id,user_id) VALUES(?,?)');
const credit = db.prepare('UPDATE economy_accounts SET balance=balance+? WHERE guild_id=? AND user_id=?');
const balanceQuery = db.prepare('SELECT balance FROM economy_accounts WHERE guild_id=? AND user_id=?');
const GIF = process.env.BLACKJACK_GIF_URL || 'https://media.giphy.com/media/3o7aD4pQpn7WkA0i1C/giphy.gif';
const cards = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const suits = ['♠','♥','♦','♣'];
function draw() { return { rank: cards[Math.floor(Math.random() * cards.length)], suit: suits[Math.floor(Math.random() * suits.length)] }; }
function value(hand) {
  let total = 0, aces = 0;
  for (const card of hand) { if (card.rank === 'A') { total += 11; aces++; } else if (['J','Q','K'].includes(card.rank)) total += 10; else total += Number(card.rank); }
  while (total > 21 && aces) { total -= 10; aces--; }
  return total;
}
function cardText(hand) { return hand.map(card => `${card.rank}${card.suit}`).join('  '); }
function gameEmbed(game, reveal = false, title = '🃏 Blackjack') {
  const player = JSON.parse(game.player_hand), dealer = JSON.parse(game.dealer_hand);
  const shownDealer = reveal ? `${cardText(dealer)} (**${value(dealer)}**)` : `${cardText([dealer[0]])}  🂠`;
  const e = new EmbedBuilder().setColor(0x7C5CFC).setTitle(title)
    .setDescription(`**Your hand:** ${cardText(player)} (**${value(player)}**)\n**Dealer:** ${shownDealer}\n**Wager:** ${Number(game.wager).toLocaleString()} 🪙 NxtCoin`)
    .setTimestamp().setFooter({ text: 'Virtual coins only • No cash value' });
  if (/^https:\/\//i.test(GIF)) e.setImage(GIF);
  return e;
}
function buttons(ownerId, disabled = false) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`blackjack:hit:${ownerId}`).setLabel('Hit').setStyle(ButtonStyle.Primary).setEmoji('🃏').setDisabled(disabled),
    new ButtonBuilder().setCustomId(`blackjack:stand:${ownerId}`).setLabel('Stand').setStyle(ButtonStyle.Success).setEmoji('✋').setDisabled(disabled),
    new ButtonBuilder().setCustomId(`blackjack:cancel:${ownerId}`).setLabel('Cancel / refund').setStyle(ButtonStyle.Secondary).setEmoji('↩️').setDisabled(disabled)
  )];
}
function hasActiveHand(payload) {
  const all = payload.embeds.map(item => typeof item?.toJSON === 'function' ? item.toJSON() : item);
  return all.some(e => /Your turn|Card dealt|Hand in progress/i.test(e?.title || ''));
}
async function handleButton(interaction) {
  if (!interaction.isButton?.() || !interaction.customId.startsWith('blackjack:')) return;
  const [, action, ownerId] = interaction.customId.split(':');
  if (interaction.user.id !== ownerId) {
    await interaction.reply({ content: 'This blackjack hand belongs to someone else.', ephemeral: true }).catch(() => {});
    return;
  }
  const guildId = interaction.guildId;
  if (!guildId || !['hit','stand','cancel'].includes(action)) {
    await interaction.reply({ content: 'This hand is unavailable here.', ephemeral: true }).catch(() => {});
    return;
  }
  const game = getGame.get(guildId, ownerId);
  if (!game) {
    await interaction.update({ content: 'This hand has ended or expired.', embeds: [], components: [] }).catch(() => {});
    return;
  }
  if (game.expires_at <= Date.now()) {
    const refund = db.transaction(() => {
      const current = getGame.get(guildId, ownerId);
      if (!current || current.expires_at > Date.now()) return null;
      ensureAccount.run(guildId, ownerId); credit.run(current.wager, guildId, ownerId); deleteGame.run(guildId, ownerId);
      return balanceQuery.get(guildId, ownerId).balance;
    })();
    await interaction.update({ content: refund === null ? 'This hand changed; try again.' : `Hand expired; ${Number(game.wager).toLocaleString()} coins were refunded. Wallet: ${refund.toLocaleString()}.`, embeds: [], components: [] }).catch(() => {});
    return;
  }
  if (action === 'cancel') {
    const balance = db.transaction(() => {
      const current = getGame.get(guildId, ownerId); if (!current) return null;
      ensureAccount.run(guildId, ownerId); credit.run(current.wager, guildId, ownerId); deleteGame.run(guildId, ownerId);
      return balanceQuery.get(guildId, ownerId).balance;
    })();
    await interaction.update({ embeds: [new EmbedBuilder().setColor(0xF0B232).setTitle('↩️ Hand cancelled').setDescription(`Wager refunded. Wallet: **${(balance ?? 0).toLocaleString()} 🪙 NxtCoin**.`)], components: [] }).catch(() => {});
    return;
  }
  let player = JSON.parse(game.player_hand), dealer = JSON.parse(game.dealer_hand);
  if (action === 'hit') {
    player.push(draw());
    if (value(player) > 21) {
      const balance = db.transaction(() => { deleteGame.run(guildId, ownerId); return balanceQuery.get(guildId, ownerId)?.balance ?? 0; })();
      const ended = { ...game, player_hand: JSON.stringify(player) };
      await interaction.update({ embeds: [gameEmbed(ended, true, '💥 Bust!')], content: `You lost ${Number(game.wager).toLocaleString()} coins. Wallet: ${balance.toLocaleString()}.`, components: [] }).catch(() => {});
      return;
    }
    updateGame.run(JSON.stringify(player), game.dealer_hand, Date.now() + 5 * 60_000, guildId, ownerId);
    const updated = getGame.get(guildId, ownerId);
    await interaction.update({ embeds: [gameEmbed(updated, false, '🃏 Card dealt')], components: buttons(ownerId) }).catch(() => {});
    return;
  }
  while (value(dealer) < 17) dealer.push(draw());
  const playerTotal = value(player), dealerTotal = value(dealer);
  const natural = player.length === 2 && playerTotal === 21 && !(dealer.length === 2 && dealerTotal === 21);
  const payout = natural ? Math.floor(game.wager * 2.5) : playerTotal > dealerTotal ? game.wager * 2 : playerTotal === dealerTotal ? game.wager : 0;
  const description = playerTotal > dealerTotal ? 'You beat the dealer!' : playerTotal === dealerTotal ? 'Push — wager returned.' : 'The dealer wins.';
  const balance = db.transaction(() => {
    if (payout) credit.run(payout, guildId, ownerId);
    deleteGame.run(guildId, ownerId);
    return balanceQuery.get(guildId, ownerId)?.balance ?? 0;
  })();
  const completed = { ...game, player_hand: JSON.stringify(player), dealer_hand: JSON.stringify(dealer) };
  await interaction.update({ embeds: [gameEmbed(completed, true, '🃏 Hand complete')], content: `${natural ? 'Blackjack pays 3:2. ' : ''}${description} Payout: ${payout.toLocaleString()}. Wallet: ${balance.toLocaleString()}.`, components: [] }).catch(() => {});
}

if (Message?.prototype?.reply) {
  const originalReply = Message.prototype.reply;
  Message.prototype.reply = function replyWithBlackjackButtons(...args) {
    const payload = args[0];
    if (payload && Array.isArray(payload.embeds) && hasActiveHand(payload)) {
      args[0] = { ...payload, components: buttons(this.author.id) };
    }
    return originalReply.apply(this, args);
  };
}
const originalLogin = Client.prototype.login;
Client.prototype.login = function loginWithBlackjackButtons(token) {
  if (!hooked.has(this)) { hooked.add(this); this.on('interactionCreate', interaction => { void handleButton(interaction); }); }
  return originalLogin.call(this, token);
};
