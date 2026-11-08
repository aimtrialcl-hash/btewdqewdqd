// Extra, cooldown-based NxtCoin earning commands and a focused earnings guide.
// This is a preload hook so it can extend the existing prefix economy safely.
require('dotenv').config();
const { Client, EmbedBuilder } = require('discord.js');
const { db } = require('./database');

const COIN = '🪙 NxtCoin';
const COLOR = 0x7C5CFC;
const FISH_COOLDOWN = 15 * 60 * 1000;
const SCAVENGE_COOLDOWN = 60 * 60 * 1000;

db.exec(`
  CREATE TABLE IF NOT EXISTS economy_earning_cooldowns (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    fish_at INTEGER NOT NULL DEFAULT 0,
    scavenge_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  )
`);
const getPrefix = db.prepare('SELECT prefix FROM economy_guild_settings WHERE guild_id=?');
const ensureCooldown = db.prepare('INSERT OR IGNORE INTO economy_earning_cooldowns(guild_id,user_id) VALUES(?,?)');
const getCooldown = db.prepare('SELECT * FROM economy_earning_cooldowns WHERE guild_id=? AND user_id=?');
const getBalance = db.prepare('SELECT balance FROM economy_accounts WHERE guild_id=? AND user_id=?');
const award = db.prepare('UPDATE economy_accounts SET balance=balance+? WHERE guild_id=? AND user_id=?');

function prefix(guildId) { return getPrefix.get(guildId)?.prefix || '!'; }
function makeEmbed(title, description, user, color = COLOR) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description)
    .setThumbnail(user.displayAvatarURL({ size: 128 })).setTimestamp()
    .setFooter({ text: 'NxtCoin • Community economy' });
}
function waitText(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}
function tryEarn(guildId, userId, now, field, cooldown, min, max) {
  const update = db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO economy_accounts(guild_id,user_id) VALUES(?,?)').run(guildId, userId);
    ensureCooldown.run(guildId, userId);
    const row = getCooldown.get(guildId, userId);
    const wait = cooldown - (now - row[field]);
    if (wait > 0) return { ok: false, wait };
    const amount = min + Math.floor(Math.random() * (max - min + 1));
    db.prepare(`UPDATE economy_earning_cooldowns SET ${field}=? WHERE guild_id=? AND user_id=?`).run(now, guildId, userId);
    award.run(amount, guildId, userId);
    return { ok: true, amount, balance: getBalance.get(guildId, userId).balance };
  });
  return update();
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function animateEarning(message, user, config, result) {
  const steps = config.frames;
  const animation = await message.reply({
    embeds: [makeEmbed(config.title, `> ${steps[0]}\n\n\`\`\`\n${config.bar[0]}░░░░\n\`\`\`\n**NxtCoin expedition started…**`, user)]
  });
  for (let i = 1; i < steps.length; i++) {
    await pause(650);
    const filled = '▰'.repeat(i + 1);
    const empty = '░'.repeat(Math.max(0, 5 - i - 1));
    await animation.edit({
      embeds: [makeEmbed(config.title, `> ${steps[i]}\n\n\`\`\`\n${filled}${empty}\n\`\`\`\n**Searching for NxtCoin…**`, user)]
    }).catch(() => {});
  }
  await pause(450);
  return animation.edit({
    embeds: [makeEmbed(config.successTitle, `> ${config.successEmoji} ${config.successText}\n\n━━━━━━━━━━━━━━━━━━━━\n✨ **+${result.amount.toLocaleString()} ${COIN}**\n👛 Wallet: **${result.balance.toLocaleString()} ${COIN}**\n━━━━━━━━━━━━━━━━━━━━`, user, 0x57F287)]
  });
}

async function handleEarningCommand(message) {
  if (!message.guild || message.author.bot || message.system) return;
  const currentPrefix = prefix(message.guild.id);
  if (!message.content.startsWith(currentPrefix)) return;
  const [name] = message.content.slice(currentPrefix.length).trim().split(/\s+/);
  if (!name) return;
  const command = name.toLowerCase();
  const user = message.author;

  if (command === 'earn' || command === 'earning' || command === 'earnhelp') {
    const guide = [
      `🎁 **${currentPrefix}daily** — 100–250 NxtCoin, once every 24 hours`,
      `💼 **${currentPrefix}work** — 20–100 NxtCoin, once every 30 minutes`,
      `🎣 **${currentPrefix}fish** — 15–90 NxtCoin, once every 15 minutes`,
      `🔎 **${currentPrefix}scavenge** — 40–160 NxtCoin, once every hour`,
      `🎰 **${currentPrefix}slots amount** / **${currentPrefix}coinflip amount heads|tails** — games can win or lose coins`
    ].join('\n');
    return message.reply({ embeds: [makeEmbed('✨ NxtCoin • Ways to earn', `Collect, work, explore, and play!\n\n${guide}\n\nCheck your wallet with **${currentPrefix}balance**. Use **${currentPrefix}help** to see all economy commands.`, user)] });
  }

  const configs = {
    fish: {
      field: 'fish_at', cooldown: FISH_COOLDOWN, min: 15, max: 90,
      title: '🎣 NxtCoin fishing trip', successTitle: '🐟 Catch of the day!',
      successEmoji: '✨', successText: 'A shiny catch turned into NxtCoin!',
      bar: ['🎣', '🌊', '🐟'], frames: ['🎣 Cast your line…', '🌊 Something is nibbling!', '🐟 Reel it in!']
    },
    scavenge: {
      field: 'scavenge_at', cooldown: SCAVENGE_COOLDOWN, min: 40, max: 160,
      title: '🔎 NxtCoin scavenger hunt', successTitle: '💎 Treasure uncovered!',
      successEmoji: '🎉', successText: 'You found a forgotten NxtCoin stash!',
      bar: ['🔎', '🗺️', '✨'], frames: ['🔎 Scanning the area…', '🗺️ A clue appears on the map!', '✨ A hidden cache is glowing!']
    }
  };
  const config = configs[command];
  if (!config) return;

  try {
    const result = tryEarn(message.guild.id, user.id, Date.now(), config.field, config.cooldown, config.min, config.max);
    if (!result.ok) {
      return message.reply({ embeds: [makeEmbed('⏳ Expedition cooldown', `You can **${command}** again in **${waitText(result.wait)}**.\n\nWhile you wait, try **${currentPrefix}work** or **${currentPrefix}daily**.`, user, 0xF0B232)] });
    }
    await animateEarning(message, user, config, result);
  } catch (error) {
    console.error('NxtCoin earning command failed:', error);
    return message.reply({ embeds: [makeEmbed('⚠️ Earning failed', 'Could not award NxtCoin right now. Please try again later.', user, 0xED4245)] }).catch(() => {});
  }
}

const previousLogin = Client.prototype.login;
Client.prototype.login = function loginWithExtraNxtCoinEarnings(token) {
  if (!this.__nxtCoinEarningCommandsAttached) {
    this.on('messageCreate', message => { void handleEarningCommand(message); });
    this.__nxtCoinEarningCommandsAttached = true;
  }
  return previousLogin.call(this, token);
};
