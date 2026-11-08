// Google Noto Emoji art in Discord embeds. Noto assets are static PNG images;
// rotating the embed author icon across edits creates a simple animation effect.
const { Message } = require('discord.js');

const CDN = 'https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@main/png/128';
const frameByMessage = new WeakMap();
const frameSequences = {
  fish: ['1f3a3', '1f30a', '1f41f', '2728'],
  scavenge: ['1f50e', '1f5fa', '1f4a0', '1f381'],
  daily: ['1f381', '2728', '1f4b0', '1f389'],
  work: ['1f4bc', '2699', '1f4aa', '1f4b0'],
  slots: ['1f3b0', '1f352', '1f514', '1f48e', '2b50'],
  coin: ['1fa99', '1f4b0', '2728', '1f389'],
  default: ['1f381', '2728', '1fa99', '1f4b0']
};

function getFrameSequence(embeds) {
  const text = embeds.map(item => {
    const data = typeof item?.toJSON === 'function' ? item.toJSON() : item;
    return `${data?.title || ''} ${data?.description || ''}`;
  }).join(' ').toLowerCase();
  if (/fish|fishing|catch/.test(text)) return frameSequences.fish;
  if (/scavenge|treasure|hidden stash/.test(text)) return frameSequences.scavenge;
  if (/daily|drop/.test(text)) return frameSequences.daily;
  if (/work|shift/.test(text)) return frameSequences.work;
  if (/slot|spin|reel/.test(text)) return frameSequences.slots;
  if (/coin|flip|wallet|balance|nxtcoin/.test(text)) return frameSequences.coin;
  return frameSequences.default;
}
function decorate(payload, frameIndex, message) {
  if (!payload || !Array.isArray(payload.embeds)) return payload;
  const sequence = getFrameSequence(payload.embeds);
  const image = `${CDN}/emoji_u${sequence[frameIndex % sequence.length]}.png`;
  const embeds = payload.embeds.map(item => {
    const data = typeof item?.toJSON === 'function' ? item.toJSON() : item;
    if (!data || typeof data !== 'object') return item;
    return {
      ...data,
      author: { ...(data.author || { name: 'NxtCoin • Google Noto Emoji' }), icon_url: image }
    };
  });
  if (message) frameByMessage.set(message, frameIndex + 1);
  return { ...payload, embeds };
}

if (Message?.prototype?.reply) {
  const originalReply = Message.prototype.reply;
  Message.prototype.reply = function replyWithGoogleNotoEmoji(...args) {
    args[0] = decorate(args[0], 0, null);
    return originalReply.apply(this, args);
  };
}
if (Message?.prototype?.edit) {
  const originalEdit = Message.prototype.edit;
  Message.prototype.edit = function editWithGoogleNotoEmoji(...args) {
    const index = frameByMessage.get(this) ?? 1;
    args[0] = decorate(args[0], index, this);
    return originalEdit.apply(this, args);
  };
}
