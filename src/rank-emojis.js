// Preload hook for optional per-rank emoji directives stored in leaderboard descriptions.
// Directives are removed before the embed is sent; only the configured ranking emoji markup remains.
require('dotenv').config();
const { EmbedBuilder } = require('discord.js');
const originalSetDescription = EmbedBuilder.prototype.setDescription;
const directive = /<!--rank-emojis:([A-Za-z0-9_-]+)-->/;
const rankLine = /^\*\*(\d{1,2})\.\*\*\s+(.+?)\s+[—–-]\s+(.+)$/;
const divider = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

EmbedBuilder.prototype.setDescription = function setDescriptionWithRankEmojis(description) {
  if (typeof description !== 'string' || !description.includes('<!--rank-emojis:')) {
    return originalSetDescription.call(this, description);
  }

  let ranks = [];
  const match = description.match(directive);
  if (match) {
    try {
      const parsed = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
      if (Array.isArray(parsed)) ranks = parsed.slice(0, 10);
    } catch {
      console.warn('Ignoring invalid leaderboard rank emoji settings.');
    }
  }

  const clean = description.replace(directive, '').trim();
  const lines = clean.split('\n');
  const ranked = [];
  const retained = [];
  for (const line of lines) {
    const parsed = line.trim().match(rankLine);
    if (!parsed) retained.push(line);
    else ranked.push({ rank: Number(parsed[1]), name: parsed[2], score: parsed[3] });
  }

  if (!ranked.length) return originalSetDescription.call(this, clean);

  // Keep the configured intro and reset/reward text, but present the first-place
  // result prominently and then render all ranked entries in the compact list style.
  const firstRankIndex = lines.findIndex(line => rankLine.test(line.trim()));
  const intro = lines.slice(0, firstRankIndex).join('\n').trim();
  const tail = retained.join('\n').trim();
  const winner = ranked[0];
  const winnerEmoji = ranks[0] || '🏆';
  const winnerLine = `**${winnerEmoji} ${winner.name} (${winner.score})**`;
  const list = ranked.map(({ rank, name, score }) => {
    const emoji = ranks[rank - 1];
    const marker = emoji || `**${rank}.**`;
    return `${marker} ${name} ➜ ${score}`;
  });
  const sections = [];
  if (intro) sections.push(intro);
  sections.push(divider, winnerLine, divider, ...list, divider);
  if (tail) sections.push(tail);

  const rendered = sections.join('\n').slice(0, 4096);
  return originalSetDescription.call(this, rendered);
};
