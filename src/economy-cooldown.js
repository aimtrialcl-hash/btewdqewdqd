// Shared 10-second prefix-command throttle and animated server-emoji renderer.
// Discord doesn't accept Google emoji GIFs as message emojis: animated server
// emoji markup is the native way to display animation in Discord messages.
require('dotenv').config();
const { Client, Message, EmbedBuilder } = require('discord.js');
const { db } = require('./database');

const COMMAND_COOLDOWN_MS = 10_000;
const COOLDOWN_NOTICE_MS = 10_000;
const cooldowns = new Map();
const editFrames = new Map();
let emojiCursor = 0;
const getPrefix = db.prepare('SELECT prefix FROM economy_guild_settings WHERE guild_id=?');
const economyCommands = new Set([
  'help','nxthelp','earn','earning','earnhelp','prefix','balance','bal','wallet','daily','work',
  'fish','scavenge','pay','give','coinflip','flip','slots','spin','rich','nxttop'
]);
const emojiPattern = /\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?|\p{Emoji_Modifier}|\uFE0F)*/gu;

function animatedEmojis(guild) {
  return guild?.emojis?.cache?.filter(emoji => emoji.animated && emoji.available !== false)?.map(emoji => emoji.toString()) || [];
}
function animatedMarkup(guild) {
  const emojis = animatedEmojis(guild);
  if (!emojis.length) return '';
  return emojis[emojiCursor++ % emojis.length];
}
function getCommand(message) {
  if (!message.guild || !message.author || message.author.bot || message.system || typeof message.content !== 'string') return null;
  const prefix = getPrefix.get(message.guild.id)?.prefix || '!';
  if (!message.content.startsWith(prefix)) return null;
  const command = message.content.slice(prefix.length).trim().split(/\s+/, 1)[0]?.toLowerCase();
  return economyCommands.has(command) ? { command, prefix } : null;
}

// Convert ordinary Unicode emoji in NxtCoin embeds into animated custom emoji
// from the current server. If no animated server emoji is available, remove the
// static emoji glyphs rather than pretending they animate.
function animateEmbed(embed, guild) {
  const value = typeof embed?.toJSON === 'function' ? embed.toJSON() : { ...embed };
  const isEconomy = value?.footer?.text?.includes('NxtCoin • Community economy');
  if (!isEconomy) return embed;
  const replace = text => typeof text === 'string' ? text.replace(emojiPattern, () => animatedMarkup(guild)) : text;
  if (value.title) value.title = replace(value.title);
  if (value.description) value.description = replace(value.description);
  if (value.author?.name) value.author.name = replace(value.author.name);
  if (value.footer?.text) value.footer.text = replace(value.footer.text);
  if (Array.isArray(value.fields)) value.fields = value.fields.map(field => ({
    ...field, name: replace(field.name), value: replace(field.value)
  }));
  return value;
}
function animatePayload(payload, guild, frameOffset = 0) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.embeds)) return payload;
  emojiCursor += frameOffset;
  return {
    ...payload,
    embeds: payload.embeds.map(embed => animateEmbed(embed, guild))
  };
}

// A single per-member, per-server cooldown applies across all economy prefix
// commands. The blocked-command notice is emitted only once per cooldown window.
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
    const frame = editFrames.get(this) || 0;
    editFrames.set(this, frame + 1);
    return originalEdit.call(this, animatePayload(args[0], this.guild, frame), ...args.slice(1));
  };
}

// Avoid unbounded in-memory growth on long-running bot processes.
setInterval(() => {
  const cutoff = Date.now() - COMMAND_COOLDOWN_MS * 2;
  for (const [key, value] of cooldowns) if (value.at < cutoff) cooldowns.delete(key);
}, COMMAND_COOLDOWN_MS * 10).unref();
