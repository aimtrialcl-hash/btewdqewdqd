// Shared 10-second prefix-command throttle and animated server-emoji renderer.
// Discord message text can't display Google's emoji animations inline. Animated
// server emojis are the supported animated emoji format; GIFs can be embed images.
require('dotenv').config();
const { Client, Message, EmbedBuilder } = require('discord.js');
const { db } = require('./database');

const COMMAND_COOLDOWN_MS = 10_000;
const cooldowns = new Map();
const editFrames = new Map();
let emojiCursor = 0;
const getPrefix = db.prepare('SELECT prefix FROM economy_guild_settings WHERE guild_id=?');
const economyCommands = new Set([
  'help','nxthelp','earn','earning','earnhelp','prefix','balance','bal','wallet','daily','work',
  'fish','scavenge','pay','give','coinflip','flip','slots','spin','rich','nxttop'
]);
const unicodeEmoji = /\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?|\p{Emoji_Modifier}|\uFE0F)*/gu;

function animatedEmojis(guild) {
  return guild?.emojis?.cache?.filter(emoji => emoji.animated && emoji.available !== false)?.map(emoji => emoji.toString()) || [];
}
function animatedMarkup(guild) {
  const emojis = animatedEmojis(guild);
  if (!emojis.length) return '';
  return emojis[emojiCursor++ % emojis.length];
}
function prefixFor(guildId) { return getPrefix.get(guildId)?.prefix || '!'; }
function getCommand(message) {
  if (!message.guild || !message.author || message.author.bot || message.system || typeof message.content !== 'string') return null;
  const prefix = prefixFor(message.guild.id);
  if (!message.content.startsWith(prefix)) return null;
  const command = message.content.slice(prefix.length).trim().split(/\s+/, 1)[0]?.toLowerCase();
  return economyCommands.has(command) ? { command, prefix } : null;
}
function makeAnimatedHelp(guild, prefix) {
  const emoji = () => animatedMarkup(guild);
  const lines = [
    `${emoji()} **${prefix}daily** — claim 100–250 NxtCoin every 24h`,
    `${emoji()} **${prefix}work** — earn 20–100 NxtCoin every 30m`,
    `${emoji()} **${prefix}fish** — catch 15–90 NxtCoin every 15m`,
    `${emoji()} **${prefix}scavenge** — find 40–160 NxtCoin every hour`,
    `${emoji()} **${prefix}balance** [@member] — check a wallet`,
    `${emoji()} **${prefix}pay** @member amount — transfer coins`,
    `${emoji()} **${prefix}coinflip** amount heads|tails — flip for coins`,
    `${emoji()} **${prefix}slots** amount — play the emoji slots`,
    `${emoji()} **${prefix}rich** — see the server's top wallets`,
    `${emoji()} **${prefix}prefix** <new> — change prefix (Manage Server)`
  ].filter(line => !line.startsWith(' **'));
  const animatedAvailable = animatedEmojis(guild).length > 0;
  return new EmbedBuilder()
    .setColor(0x7C5CFC)
    .setTitle(`${animatedMarkup(guild)} NxtCoin • Command guide`)
    .setDescription(`${lines.join('\n')}\n\n${animatedAvailable ? '✨ Animated server emojis are active.' : 'Add animated custom emojis to this server and let the bot use them to show animated icons.'}\n⏱️ Shared command cooldown: **10 seconds**.`)
    .setThumbnail(guild?.iconURL?.({ size: 128 }) || null)
    .setFooter({ text: `NxtCoin • Prefix: ${prefix}` })
    .setTimestamp();
}
function animateEmbed(embed, guild) {
  const value = typeof embed?.toJSON === 'function' ? embed.toJSON() : { ...embed };
  if (!value?.footer?.text?.includes('NxtCoin • Community economy')) return embed;
  const available = animatedEmojis(guild);
  if (!available.length) return embed;
  const replace = text => typeof text === 'string' ? text.replace(unicodeEmoji, () => animatedMarkup(guild)) : text;
  if (value.title) value.title = replace(value.title);
  if (value.description) value.description = replace(value.description);
  if (value.author?.name) value.author.name = replace(value.author.name);
  if (value.footer?.text) value.footer.text = replace(value.footer.text);
  if (Array.isArray(value.fields)) value.fields = value.fields.map(field => ({
    ...field, name: replace(field.name), value: replace(field.value)
  }));
  return value;
}
function animatePayload(payload, guild) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.embeds)) return payload;
  return { ...payload, embeds: payload.embeds.map(embed => animateEmbed(embed, guild)) };
}

// Apply one shared 10-second cooldown per user/server and display a complete,
// current help command once per cooldown window.
const originalEmit = Client.prototype.emit;
Client.prototype.emit = function emitWithEconomyCooldown(event, ...args) {
  if (event === 'messageCreate') {
    const message = args[0];
    const parsed = getCommand(message);
    if (parsed) {
      const now = Date.now();
      const key = `${message.guild.id}:${message.author.id}`;
      const previous = cooldowns.get(key);
      if (previous && now - previous.at < COMMAND_COOLDOWN_MS) {
        if (!previous.notified && typeof message.reply === 'function') {
          previous.notified = true;
          const seconds = Math.max(1, Math.ceil((COMMAND_COOLDOWN_MS - (now - previous.at)) / 1000));
          const emoji = animatedMarkup(message.guild);
          const embed = new EmbedBuilder()
            .setColor(0xF0B232)
            .setTitle(`${emoji ? `${emoji} ` : ''}Command cooldown`)
            .setDescription(`Please wait **${seconds} seconds** before using another NxtCoin command.`)
            .setFooter({ text: 'NxtCoin • Community economy' });
          void message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } }).catch(() => {});
        }
        return true;
      }
      cooldowns.set(key, { at: now, notified: false });
      if (parsed.command === 'help' || parsed.command === 'nxthelp') {
        void message.reply({ embeds: [makeAnimatedHelp(message.guild, parsed.prefix)] }).catch(() => {});
        return true;
      }
    }
  }
  return originalEmit.call(this, event, ...args);
};

if (Message?.prototype?.reply) {
  const originalReply = Message.prototype.reply;
  Message.prototype.reply = function replyWithAnimatedEconomyEmojis(...args) {
    return originalReply.call(this, animatePayload(args[0], this.guild), ...args.slice(1));
  };
}
if (Message?.prototype?.edit) {
  const originalEdit = Message.prototype.edit;
  Message.prototype.edit = function editWithAnimatedEconomyEmojis(...args) {
    editFrames.set(this, (editFrames.get(this) || 0) + 1);
    return originalEdit.call(this, animatePayload(args[0], this.guild), ...args.slice(1));
  };
}
setInterval(() => {
  const cutoff = Date.now() - COMMAND_COOLDOWN_MS * 2;
  for (const [key, value] of cooldowns) if (value.at < cutoff) cooldowns.delete(key);
}, COMMAND_COOLDOWN_MS * 10).unref();
