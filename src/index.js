require('dotenv').config();
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const {
  Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits,
  SlashCommandBuilder, ChannelType, AuditLogEvent
} = require('discord.js');
const store = require('./database');

const required = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'BOT_OWNER_ID', 'SESSION_SECRET', 'DASHBOARD_URL'];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}
const ownerId = process.env.BOT_OWNER_ID;
const dashboardUrl = process.env.DASHBOARD_URL.replace(/\/$/, '');
const redirectUri = `${dashboardUrl}/auth/callback`;
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates] });
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use(session({
  name: 'community.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (_req, res) => res.status(client.isReady() ? 200 : 503).json({ ok: client.isReady() }));

function periodRange(period, now = new Date()) {
  const end = now.getTime();
  const start = new Date(now);
  if (period === 'weekly') {
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  } else {
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
  }
  return { start: start.getTime(), end };
}
function previousPeriodRange(period, now = new Date()) {
  const { start: end } = periodRange(period, now);
  const startDate = new Date(end);
  if (period === 'weekly') startDate.setUTCDate(startDate.getUTCDate() - 7);
  else startDate.setUTCMonth(startDate.getUTCMonth() - 1);
  return { start: startDate.getTime(), end };
}
function leaderboard(guildId, period) {
  const { start, end } = periodRange(period);
  return store.getLeaderboard(guildId, start, end, Date.now()).map(row => {
    const member = client.guilds.cache.get(guildId)?.members.cache.get(row.user_id);
    return { userId: row.user_id, name: member?.displayName || `Member ${row.user_id.slice(-4)}`, milliseconds: row.milliseconds };
  });
}
function rewardRoleId(settings, period) {
  return period === 'weekly' ? settings.weekly_reward_role_id : settings.monthly_reward_role_id;
}
function getRewardInfo(guild, period) {
  const roleId = rewardRoleId(store.settings(guild.id), period);
  const role = roleId && guild.roles.cache.get(roleId);
  return role ? `Top voice member receives ${role.name}.` : 'No winner role configured yet.';
}
function validOptionalString(value, maxLength) {
  return value == null || (typeof value === 'string' && value.length <= maxLength);
}
function validImageUrl(value) {
  if (!value) return true;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}
function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Please log in with Discord.' });
  next();
}
function canManageGuild(req, guildId) {
  return req.session.user?.id === ownerId || req.session.guildIds?.includes(guildId);
}
function requireGuildManager(req, res, next) {
  if (!canManageGuild(req, req.params.guildId || req.body?.guildId)) return res.status(403).json({ error: 'You need Manage Server permission for this server.' });
  next();
}

app.get('/auth/discord', (req, res) => {
  const state = crypto.randomBytes(24).toString('hex');
  req.session.oauthState = state;
  const authorize = new URL('https://discord.com/oauth2/authorize');
  authorize.searchParams.set('client_id', process.env.DISCORD_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('scope', 'identify guilds');
  authorize.searchParams.set('state', state);
  res.redirect(authorize.toString());
});
app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || typeof code !== 'string' || typeof state !== 'string' || !req.session.oauthState
      || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(req.session.oauthState))) {
    return res.redirect('/?login=failed');
  }
  delete req.session.oauthState;
  try {
    const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri
      })
    });
    if (!tokenResponse.ok) throw new Error(`Discord token exchange failed (${tokenResponse.status})`);
    const tokenData = await tokenResponse.json();
    const headers = { Authorization: `Bearer ${tokenData.access_token}` };
    const [userResponse, guildsResponse] = await Promise.all([
      fetch('https://discord.com/api/v10/users/@me', { headers }),
      fetch('https://discord.com/api/v10/users/@me/guilds', { headers })
    ]);
    if (!userResponse.ok || !guildsResponse.ok) throw new Error('Could not fetch Discord account details.');
    const [user, userGuilds] = await Promise.all([userResponse.json(), guildsResponse.json()]);
    const manageableGuildIds = userGuilds.filter(guild => {
      const permissions = BigInt(guild.permissions || '0');
      const manages = guild.owner || (permissions & 0x8n) !== 0n || (permissions & 0x20n) !== 0n;
      return manages && client.guilds.cache.has(guild.id);
    }).map(guild => guild.id);
    await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
    req.session.user = { id: user.id, username: user.global_name || user.username, avatar: user.avatar };
    req.session.guildIds = manageableGuildIds;
    res.redirect('/');
  } catch (err) {
    console.error('Discord OAuth login failed:', err);
    res.redirect('/?login=failed');
  }
});
app.get('/auth/logout', (req, res, next) => req.session.destroy(error => {
  if (error) return next(error);
  res.clearCookie('community.sid', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' });
  res.redirect('/');
}));
app.get('/api/auth/me', (req, res) => {
  if (!req.session.user) return res.json({ authenticated: false });
  const user = req.session.user;
  const avatar = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${user.avatar.startsWith('a_') ? 'gif' : 'png'}?size=128`
    : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id) >> 22n) % 6}.png`;
  res.json({ authenticated: true, user: { id: user.id, username: user.username, avatar } });
});

app.get('/api/leaderboard', (req, res) => {
  const { guildId, period = 'weekly' } = req.query;
  const guild = typeof guildId === 'string' ? client.guilds.cache.get(guildId) : null;
  if (!guild) return res.status(404).json({ error: 'Unknown server' });
  if (!['weekly', 'monthly'].includes(period)) return res.status(400).json({ error: 'period must be weekly or monthly' });
  res.json({ period, reward: getRewardInfo(guild, period), entries: leaderboard(guild.id, period) });
});
app.get('/api/guilds', requireLogin, (req, res) => {
  const guilds = client.guilds.cache.filter(guild => canManageGuild(req, guild.id));
  res.json(guilds.map(guild => ({ id: guild.id, name: guild.name, icon: guild.iconURL({ size: 64 }) })));
});
app.get('/api/guilds/:guildId/emojis', requireLogin, requireGuildManager, async (req, res) => {
  const guild = client.guilds.cache.get(req.params.guildId);
  if (!guild) return res.status(404).json({ error: 'Unknown server' });
  try {
    await guild.emojis.fetch();
    res.json(guild.emojis.cache.map(emoji => ({
      id: emoji.id, name: emoji.name, animated: emoji.animated,
      markup: `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`,
      image: emoji.imageURL({ extension: emoji.animated ? 'gif' : 'png', size: 64 })
    })));
  } catch (error) {
    console.error('Could not load server emojis:', error);
    res.status(500).json({ error: 'Could not load server emojis.' });
  }
});
app.get('/api/settings/:guildId', requireLogin, requireGuildManager, (req, res) => {
  const guild = client.guilds.cache.get(req.params.guildId);
  if (!guild) return res.status(404).json({ error: 'Unknown server' });
  res.json(store.settings(guild.id));
});
app.put('/api/settings/:guildId', requireLogin, requireGuildManager, (req, res) => {
  const guild = client.guilds.cache.get(req.params.guildId);
  if (!guild) return res.status(404).json({ error: 'Unknown server' });
  const allowed = ['announcement_channel_id', 'grind_role_id', 'vanity_role_id', 'vanity_code', 'weekly_reward_role_id', 'monthly_reward_role_id'];
  const changes = {};
  for (const key of allowed) {
    if (Object.hasOwn(req.body, key)) {
      const value = req.body[key];
      if (!validOptionalString(value, 100)) return res.status(400).json({ error: `Invalid ${key}` });
      changes[key] = value || null;
    }
  }
  res.json(store.saveGuildSettings(guild.id, changes));
});
app.post('/api/embed', requireLogin, requireGuildManager, async (req, res) => {
  const { guildId, channelId, title, description, color = '#5865F2', author, footer, imageUrl, thumbnailUrl, timestamp = false } = req.body || {};
  const guild = client.guilds.cache.get(guildId);
  if (!guild || typeof channelId !== 'string' || typeof title !== 'string' || typeof description !== 'string') {
    return res.status(400).json({ error: 'Provide a valid server, channel, title, and description.' });
  }
  if (title.length > 256 || description.length > 4000 || !/^#[0-9a-f]{6}$/i.test(color)
      || !validOptionalString(author, 256) || !validOptionalString(footer, 2048)
      || !validImageUrl(imageUrl) || !validImageUrl(thumbnailUrl)) {
    return res.status(400).json({ error: 'Embed text, color, or image URL is invalid.' });
  }
  try {
    const channel = await guild.channels.fetch(channelId);
    if (!channel?.isTextBased() || !channel.send) return res.status(400).json({ error: 'That is not a text channel.' });
    const embed = new EmbedBuilder().setColor(color).setTitle(title).setDescription(description);
    if (author) embed.setAuthor({ name: author });
    if (footer) embed.setFooter({ text: footer });
    if (imageUrl) embed.setImage(imageUrl);
    if (thumbnailUrl) embed.setThumbnail(thumbnailUrl);
    if (timestamp) embed.setTimestamp();
    await channel.send({ embeds: [embed] });
    res.json({ ok: true });
  } catch (error) {
    console.error('Dashboard embed failed:', error);
    res.status(500).json({ error: 'Could not send embed. Check the bot channel permissions.' });
  }
});

function utcDuration(ms) {
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}
async function processLeaderboardResets() {
  for (const guild of client.guilds.cache.values()) {
    for (const period of ['weekly', 'monthly']) {
      const { start, end } = previousPeriodRange(period);
      if (store.getAward(guild.id, period, start)) continue;
      const roleId = rewardRoleId(store.settings(guild.id), period);
      if (!roleId) continue;
      const role = await guild.roles.fetch(roleId).catch(() => null);
      if (!role) { console.warn(`Missing ${period} leaderboard reward role in guild ${guild.id}`); continue; }
      const previous = store.latestAward(guild.id, period, start);
      if (previous?.user_id && previous.role_id === role.id) {
        const priorMember = await guild.members.fetch(previous.user_id).catch(() => null);
        if (priorMember?.roles.cache.has(role.id)) await priorMember.roles.remove(role, `${period} leaderboard reward reset`).catch(console.error);
      }
      const winner = store.getLeaderboard(guild.id, start, end, end)[0];
      let winnerMember = null;
      if (winner) {
        winnerMember = await guild.members.fetch(winner.user_id).catch(() => null);
        if (winnerMember) await winnerMember.roles.add(role, `${period} leaderboard winner`).catch(error => { console.error('Could not assign leaderboard reward:', error); winnerMember = null; });
      }
      if (winner && !winnerMember) continue;
      store.recordAward(guild.id, period, start, winnerMember?.id || null, role.id);
      const channelId = store.settings(guild.id).announcement_channel_id;
      const channel = channelId && await guild.channels.fetch(channelId).catch(() => null);
      if (channel?.isTextBased() && channel.send) {
        const description = winnerMember
          ? `${winnerMember} won ${role} with **${utcDuration(winner.milliseconds)}** of voice time. The ${period} leaderboard has reset.`
          : `No voice activity was recorded for the previous ${period} leaderboard. The new ${period} period has started.`;
        await channel.send({ embeds: [new EmbedBuilder().setColor(winnerMember ? 0x57F287 : 0x5865F2)
          .setTitle(`${period === 'weekly' ? 'Weekly' : 'Monthly'} leaderboard reset`).setDescription(description).setTimestamp()] }).catch(console.error);
      }
    }
  }
}
function isGuildManager(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}
function isBotOwner(interaction) {
  return interaction.user.id === ownerId;
}
function canConfigure(interaction) {
  return isBotOwner(interaction) || isGuildManager(interaction);
}
const commands = [
  new SlashCommandBuilder().setName('configure').setDescription('Configure roles and announcement channel')
    .addChannelOption(o => o.setName('announcement_channel').setDescription('Channel for notices').addChannelTypes(ChannelType.GuildText))
    .addRoleOption(o => o.setName('grind_role').setDescription('Role members can opt into'))
    .addRoleOption(o => o.setName('vanity_role').setDescription('Reward role for a vanity claim'))
    .addRoleOption(o => o.setName('weekly_reward_role').setDescription('Role awarded to the weekly voice leaderboard winner'))
    .addRoleOption(o => o.setName('monthly_reward_role').setDescription('Role awarded to the monthly voice leaderboard winner')),
  new SlashCommandBuilder().setName('embed').setDescription('Send an embed to a channel')
    .addChannelOption(o => o.setName('channel').setDescription('Destination').setRequired(true).addChannelTypes(ChannelType.GuildText))
    .addStringOption(o => o.setName('title').setDescription('Embed title').setRequired(true).setMaxLength(256))
    .addStringOption(o => o.setName('description').setDescription('Embed content').setRequired(true).setMaxLength(4000))
    .addStringOption(o => o.setName('color').setDescription('Hex color, e.g. #5865F2').setMaxLength(7)),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Show voice-time leaderboard')
    .addStringOption(o => o.setName('period').setDescription('Leaderboard period').setRequired(true)
      .addChoices({ name: 'Weekly', value: 'weekly' }, { name: 'Monthly', value: 'monthly' })),
  new SlashCommandBuilder().setName('grind').setDescription('Join or leave the grind role')
    .addStringOption(o => o.setName('action').setDescription('Choose an action').setRequired(true)
      .addChoices({ name: 'Join', value: 'join' }, { name: 'Leave', value: 'leave' })),
  new SlashCommandBuilder().setName('vanity').setDescription('Configure or claim the server vanity reward')
    .addSubcommand(s => s.setName('set').setDescription('Set vanity code, announcement channel, and reward role')
      .addStringOption(o => o.setName('code').setDescription('Vanity code members must enter to claim').setRequired(true).setMaxLength(100))
      .addChannelOption(o => o.setName('channel').setDescription('Announcement channel').setRequired(true).addChannelTypes(ChannelType.GuildText))
      .addRoleOption(o => o.setName('role').setDescription('Reward role').setRequired(true)))
    .addSubcommand(s => s.setName('claim').setDescription('Claim the configured vanity reward')
      .addStringOption(o => o.setName('code').setDescription('Configured vanity code').setRequired(true).setMaxLength(100)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove your vanity reward role')),
  new SlashCommandBuilder().setName('botaccess').setDescription('Owner-only bot-add monitoring controls')
    .addSubcommand(s => s.setName('lock').setDescription('Enable or disable bot-add monitoring')
      .addBooleanOption(o => o.setName('enabled').setDescription('Turn monitoring on or off').setRequired(true)))
    .addSubcommand(s => s.setName('whitelist').setDescription('Allow or remove an authorized bot inviter')
      .addStringOption(o => o.setName('action').setDescription('Choose an action').setRequired(true)
        .addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }))
      .addUserOption(o => o.setName('user').setDescription('Authorized inviter').setRequired(true)))
];

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  store.closeOpenVoiceSessions();
  for (const guild of client.guilds.cache.values()) {
    for (const state of guild.voiceStates.cache.values()) {
      if (state.channelId && state.member && !state.member.user.bot) store.recordVoiceJoin(guild.id, state.id, state.channelId);
    }
  }
  try {
    await client.application.commands.set(commands.map(command => command.toJSON()));
    console.log('Registered global slash commands.');
  } catch (error) { console.error('Could not register slash commands:', error); }
  await processLeaderboardResets().catch(error => console.error('Leaderboard reset processing failed:', error));
  setInterval(() => processLeaderboardResets().catch(error => console.error('Leaderboard reset processing failed:', error)), 60_000);
});

client.on('voiceStateUpdate', (oldState, newState) => {
  const guildId = newState.guild.id;
  const userId = newState.id;
  if (!oldState.channelId && newState.channelId && !newState.member?.user.bot) store.recordVoiceJoin(guildId, userId, newState.channelId);
  else if (oldState.channelId && !newState.channelId) store.recordVoiceLeave(guildId, userId);
  else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
    store.recordVoiceLeave(guildId, userId);
    if (!newState.member?.user.bot) store.recordVoiceJoin(guildId, userId, newState.channelId);
  }
});

client.on('guildMemberAdd', async member => {
  if (!member.user.bot || !store.isLocked(member.guild.id)) return;
  try {
    const logs = await member.guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 6 });
    const entry = logs.entries.find(item => item.target?.id === member.id && Date.now() - item.createdTimestamp < 60_000);
    const inviterId = entry?.executor?.id;
    const allowed = inviterId === ownerId || inviterId === member.guild.ownerId || (inviterId && store.isWhitelisted(member.guild.id, inviterId));
    if (!allowed && member.guild.members.me?.permissions.has(PermissionFlagsBits.KickMembers)) await member.kick('Bot-add monitoring: inviter is not authorized');
    const destination = store.settings(member.guild.id).announcement_channel_id;
    const channel = destination && await member.guild.channels.fetch(destination).catch(() => null);
    if (channel?.isTextBased() && channel.send) {
      await channel.send({ embeds: [new EmbedBuilder().setColor(allowed ? 0x57F287 : 0xED4245)
        .setTitle(allowed ? 'Bot added (authorized)' : 'Bot-add security alert')
        .setDescription(`${member.user.tag} (${member.id})${inviterId ? ` added by <@${inviterId}>` : '. Inviter could not be verified.'}${!allowed ? '\nRemoval was attempted if the bot has permission.' : ''}`)
        .setTimestamp()] });
    }
  } catch (error) { console.error('Bot-add monitoring failed:', error); }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;
  try {
    if (interaction.commandName === 'configure') {
      if (!canConfigure(interaction)) return interaction.reply({ content: 'You need Manage Server permission to configure this bot.', ephemeral: true });
      const changes = {};
      const options = [
        ['announcement_channel', 'announcement_channel_id'], ['grind_role', 'grind_role_id'],
        ['vanity_role', 'vanity_role_id'], ['weekly_reward_role', 'weekly_reward_role_id'],
        ['monthly_reward_role', 'monthly_reward_role_id']
      ];
      for (const [option, key] of options) {
        const value = option === 'announcement_channel' ? interaction.options.getChannel(option) : interaction.options.getRole(option);
        if (value) changes[key] = value.id;
      }
      if (!Object.keys(changes).length) return interaction.reply({ content: 'Choose at least one setting to update.', ephemeral: true });
      store.saveGuildSettings(interaction.guildId, changes);
      return interaction.reply({ content: 'Guild settings updated. Weekly/monthly leaderboard reward roles go to the #1 voice-time member at reset.', ephemeral: true });
    }
    if (interaction.commandName === 'embed') {
      if (!canConfigure(interaction)) return interaction.reply({ content: 'You need Manage Server permission to send configured embeds.', ephemeral: true });
      const color = interaction.options.getString('color') || '#5865F2';
      if (!/^#[0-9a-f]{6}$/i.test(color)) return interaction.reply({ content: 'Color must be a hex value like #5865F2.', ephemeral: true });
      const channel = interaction.options.getChannel('channel');
      await channel.send({ embeds: [new EmbedBuilder().setColor(color).setTitle(interaction.options.getString('title'))
        .setDescription(interaction.options.getString('description')).setTimestamp()] });
      return interaction.reply({ content: `Embed sent to ${channel}.`, ephemeral: true });
    }
    if (interaction.commandName === 'leaderboard') {
      const period = interaction.options.getString('period');
      const entries = leaderboard(interaction.guildId, period);
      const description = entries.length ? entries.map((entry, i) => `**${i + 1}.** ${entry.name} — ${utcDuration(entry.milliseconds)}`).join('\n') : 'No voice activity recorded for this period yet.';
      const { start } = periodRange(period);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle(`${period === 'weekly' ? 'Weekly' : 'Monthly'} Voice Leaderboard`)
        .setDescription(`${description}\n\n**Reward:** ${getRewardInfo(interaction.guild, period)}\n**Resets:** <t:${Math.floor(start / 1000)}:R>`)
        .setFooter({ text: 'UTC period • voice time tracked while the bot is online' }).setTimestamp()], ephemeral: false });
    }
    if (interaction.commandName === 'grind') {
      const roleId = store.settings(interaction.guildId).grind_role_id;
      const role = roleId && await interaction.guild.roles.fetch(roleId).catch(() => null);
      if (!role) return interaction.reply({ content: 'No valid grind role is configured. Ask a server manager to use /configure.', ephemeral: true });
      const joining = interaction.options.getString('action') === 'join';
      await interaction.member.roles[joining ? 'add' : 'remove'](role);
      return interaction.reply({ content: joining ? `You joined ${role.name}.` : `You left ${role.name}.`, ephemeral: true });
    }
    if (interaction.commandName === 'vanity') {
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'set') {
        if (!canConfigure(interaction)) return interaction.reply({ content: 'You need Manage Server permission to configure vanity rewards.', ephemeral: true });
        const code = interaction.options.getString('code').trim();
        const channel = interaction.options.getChannel('channel');
        const role = interaction.options.getRole('role');
        store.saveGuildSettings(interaction.guildId, { vanity_code: code, announcement_channel_id: channel.id, vanity_role_id: role.id });
        return interaction.reply({ content: `Vanity claim configured for code “${code}”. Members can use /vanity claim.`, ephemeral: true });
      }
      const config = store.settings(interaction.guildId);
      const role = config.vanity_role_id && await interaction.guild.roles.fetch(config.vanity_role_id).catch(() => null);
      if (!role) return interaction.reply({ content: 'No valid vanity reward role is configured.', ephemeral: true });
      if (subcommand === 'claim') {
        const given = interaction.options.getString('code').trim();
        if (!config.vanity_code || given.toLowerCase() !== config.vanity_code.toLowerCase()) return interaction.reply({ content: 'That does not match the configured vanity code.', ephemeral: true });
        await interaction.member.roles.add(role);
        const channel = config.announcement_channel_id && await interaction.guild.channels.fetch(config.announcement_channel_id).catch(() => null);
        if (channel?.isTextBased() && channel.send) await channel.send({ embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('Vanity supporter').setDescription(`${interaction.user} claimed the vanity reward!`).setTimestamp()] });
        return interaction.reply({ content: `Vanity reward ${role} added. Use /vanity remove to remove it.`, ephemeral: true });
      }
      await interaction.member.roles.remove(role);
      return interaction.reply({ content: `Vanity reward ${role} removed.`, ephemeral: true });
    }
    if (interaction.commandName === 'botaccess') {
      if (!isBotOwner(interaction)) return interaction.reply({ content: 'Only the configured bot owner can change these security settings.', ephemeral: true });
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'lock') {
        const enabled = interaction.options.getBoolean('enabled');
        store.setLocked(interaction.guildId, enabled);
        return interaction.reply({ content: `Bot-add monitoring ${enabled ? 'enabled' : 'disabled'}. Discord does not let bots prevent app installs; this monitors joins and may remove unauthorized bots after they are added.`, ephemeral: true });
      }
      const user = interaction.options.getUser('user');
      const add = interaction.options.getString('action') === 'add';
      store.whitelistUser(interaction.guildId, user.id, add);
      return interaction.reply({ content: `${user.tag} ${add ? 'added to' : 'removed from'} the authorized bot-inviter whitelist.`, ephemeral: true });
    }
  } catch (error) {
    console.error('Command failed:', error);
    const response = { content: 'The command failed. Check bot permissions and role hierarchy.', ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(response).catch(() => {});
    else await interaction.reply(response).catch(() => {});
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, '0.0.0.0', () => console.log(`Dashboard listening on ${port}`));
client.login(process.env.DISCORD_TOKEN);
