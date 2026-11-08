// Preload hook for optional per-rank emoji directives stored in the leaderboard intro.
// This keeps rank customization backward-compatible with existing settings databases.
require('dotenv').config();
const { EmbedBuilder } = require('discord.js');
const originalSetDescription = EmbedBuilder.prototype.setDescription;
const directive = /<!--rank-emojis:([A-Za-z0-9_-]+)-->/;

EmbedBuilder.prototype.setDescription = function setDescriptionWithRankEmojis(description) {
  if (typeof description !== 'string' || !description.includes('<!--rank-emojis:')) {
    return originalSetDescription.call(this, description);
  }
  let ranks = [];
  const match = description.match(directive);
  if (match) {
    try {
      const decoded = Buffer.from(match[1], 'base64url').toString('utf8');
      const parsed = JSON.parse(decoded);
      if (Array.isArray(parsed)) ranks = parsed.slice(0, 10);
    } catch (error) {
      console.warn('Ignoring invalid leaderboard rank emoji settings.');
    }
  }
  const clean = description.replace(directive, '').trim();
  const rendered = clean.replace(/\*\*(\d{1,2})\.\*\*/g, (original, rank) => {
    const emoji = ranks[Number(rank) - 1];
    return typeof emoji === 'string' && emoji.length <= 100 ? `${emoji} ` : original;
  });
  return originalSetDescription.call(this, rendered);
};
