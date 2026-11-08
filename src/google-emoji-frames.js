// Google Noto Emoji animation-like embed frames.
// Noto Emoji files are static PNG images; cycling them on embed edits creates
// a frame animation effect. Discord does not support them as inline emoji.
const { Message } = require('discord.js');

const CDN = 'https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@main/png/128';
const cooldowns = new WeakMap();
const framesByMessage = new WeakMap();
const sequences = {
  fish: ['1f3a3', '1f30a', '1f41f', '2728'],
  scavenge: ['1f50e', '1f5fa', '1f4a0', '1f381'],
  daily: ['1f381', '2728', '1f4b0', '1f389'],
  work: ['1f4bc', '2699', '1f4aa', '1f4b0'],
  slot: ['1f3b0', '1f352', '1f514', '1f48e', '2b50'],
  coin: ['1fa99', '1f4b0', '2728', '1f389'],
  default: ['1f381', '2728', '1fa99', '1f4b0']
};

function sequenceFor(embeds) {
  const text = (embeds || []).map(embed => {
    const data = typeof embed?.toJSON === 'function' ? embed.toJSON() : embed;
    return `${data?.title || ''} ${data?.description || ''}`;
  }).join(' ').toLowerCase();
  if (/fish|fishing|catch/.test(text)) return sequences.fish;
  if (/scavenge|treasure|hidden stash/.test(text)) return sequences.scavenge;
  if (/daily|drop/.test(text)) return sequences.daily;
  if (/work|shift/.test(text)) return sequences.work;
  if (/slot|spin|reel/.test(text)) return sequences.slot;
  if (/coin|flip|wallet|balance|nxtcoin/.test(text)) return sequences.coin;
  return sequences.default;
}
function decorate(payload, index, stateMap, message) {
  if (!payload || !Array.isArray(payload.embeds)) return payload;
  const sequence = sequenceFor(payload.embeds);
  const frame = sequence[index % sequence.length];
  const imageURL = `${CDN}/emoji_u${frame}.png`;
  const embeds = payload.embeds.map(embed => {
    const value = typeof embed?.toJSON === 'function' ? embed.toJSON() : embed;
    if (!value || typeof value !== 'object') return embed;
    const author = { ...(value.author || { name: 'NxtCoin • Google Noto Emoji' }), icon_url: imageURL };
    return { ...value, author };
  });
  if (message) stateMap.set(message, index + 1);
  return { ...payload, embeds };
}

if (Message?.prototype?.reply) {
  const originalReply = Message.prototype.reply;
  Message.prototype.reply = function replyWithGoogleNotoFrame(...args) {
    const index = 0;
    args[0] = decorate(args[0], index, framesByMessage, null);
    return originalReply.apply(this, args);
  };
}
if (Message?.prototype?.edit) {
  const originalEdit = Message.prototype.edit;
  Message.prototype.edit = function editWithGoogleNotoFrame(...args) {
    const index = framesByMessage.get(this) || 1;
    args[0] = decorate(args[0], index, framesByMessage, this);
    return originalEdit.apply(this, args);
  };
}
