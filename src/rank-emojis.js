// Preload hook for leaderboard formatting directives stored in the leaderboard description.
// Directives are stripped before Discord receives the embed.
require('dotenv').config();
const { EmbedBuilder } = require('discord.js');
const originalSetDescription = EmbedBuilder.prototype.setDescription;
const originalSetColor = EmbedBuilder.prototype.setColor;
const directive = /<!--rank-emojis:([A-Za-z0-9_-]+)-->/;
const rankLine = /^\*\*(\d{1,2})\.\*\*\s+(.+?)\s+[—–-]\s+(.+)$/;
const divider = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

EmbedBuilder.prototype.setDescription = function setDescriptionWithRankEmojis(description) {
  if (typeof description !== 'string') return originalSetDescription.call(this, description);

  let ranks = [];
  let colors = null;
  const match = description.match(directive);
  if (match) {
    try {
      const decoded = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
      if (Array.isArray(decoded)) ranks = decoded.slice(0, 10); // legacy settings
      else if (decoded && typeof decoded === 'object') {
        ranks = Array.isArray(decoded.ranks) ? decoded.ranks.slice(0, 10) : [];
        colors = decoded.colors && typeof decoded.colors === 'object' ? decoded.colors : null;
      }
    } catch {
      console.warn('Ignoring invalid leaderboard appearance settings.');
    }
  }

  let clean = description.replace(directive, '').trim();
  // An empty board stays posted and ready to fill; do not display a negative
  // “no activity recorded” line in the embed.
  clean = clean.split('\n').filter(line => !/no\s+(?:messages?|voice|activity)\s+activity\s+(?:was\s+)?recorded/i.test(line.trim())
    && !/no activity recorded this period/i.test(line.trim())).join('\n').trim();

  const lines = clean.split('\n');
  const ranked = [];
  const before = [];
  const after = [];
  let foundRank = false;
  for (const line of lines) {
    const parsed = line.trim().match(rankLine);
    if (parsed) {
      foundRank = true;
      ranked.push({ rank: Number(parsed[1]), name: parsed[2], score: parsed[3] });
    } else if (foundRank) after.push(line);
    else before.push(line);
  }

  if (!foundRank || !ranked.length) {
    return originalSetDescription.call(this, clean || '\u200b');
  }

  // Allow the dashboard to specify one embed accent color per period. Discord
  // controls final embed dimensions, but this sets the colored left edge.
  if (colors) {
    const title = String(this.data?.title || '').toLowerCase();
    const periodKey = title.includes('monthly') ? 'monthly' : 'weekly';
    const color = colors[periodKey];
    if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) {
      originalSetColor.call(this, color);
    }
  }

  const intro = before.join('\n').trim();
  const footer = after.join('\n').trim();
  const winner = ranked[0];
  const winnerEmoji = ranks[0] || '🏆';
  const output = [];
  if (intro) output.push(intro);
  output.push(divider, `**${winnerEmoji} ${winner.name} (${winner.score})**`, divider);

  for (const { rank, name, score } of ranked) {
    const emoji = ranks[rank - 1];
    const rankLabel = typeof emoji === 'string' && emoji.length <= 100 ? emoji : `**${rank}.**`;
    output.push(`${rankLabel} ${name} ➜ ${score}`);
  }

  output.push(divider);
  if (footer) output.push(footer);
  return originalSetDescription.call(this, output.join('\n').slice(0, 4096));
};
