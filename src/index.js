require('dotenv').config();
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const {
  Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits,
  SlashCommandBuilder, ChannelType
} = require('discord.js');
const store = require('./database');

const required = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'BOT_OWNER_ID', 'DASHBOARD_TOKEN'];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}
const ownerId = process.env.BOT_OWNER_ID;
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates] });
const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (_req, res) => res.status(client.isReady() ? 200 : 503).json({ ok: client.isReady() }));

function requireDashboardToken(req, res, next) {
  const received = req.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  const expected = process.env.DASHBOARD_TOKEN;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
function periodRange(period, now = new Date()) {
  const end = now.getTime();
  const start = new Date(now);
  if (period === 'weekly') {
    start.setUTCHours(0, 0, 0, 0);
    const daysSinceMonday = (start.getUTCDay() + 6) % 7;
    start.setUTCDate(start.getUTCDate() - daysSinceMonday);
  } else {
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
  }
  return { start: start.getTime(), end };
}
function leaderboard(guildId, period) {
  const { start, end } = periodRange(period);
  return store.getLeaderboard(guildId, start, end, Date.now()).map(row => {
    const member = client.guilds.cache.get(guildId)?.members.cache.get(row.user_id);
    return { userId: row.user_id, name: member?.displayName || `Member ${row.user_id.slice(-4)}`, milliseconds: row.milliseconds };
  });
}
app.get('/api/leaderboard', (req, res) => {
  const { guildId, period = 'weekly' } = req.query;
  if (typeof guildId !== 'string' || !client.guilds.cache.has(guildId)) return res.status(404).json({ error: 'Unknown server' });
  if (!['weekly', 'monthly'].includes(period)) return res.status(400).json({ error: 'period must be weekly or monthly' });
  res.json({ period, entries: leaderboard(guildId, period) });
});
app.get('/api/guilds', requireDashboardToken, (_req, res) => {
  res.json(client.guilds.cache.map(guild => ({ id: guild.id, name: guild.name })));
});
app.get('/api/settings/:guildId', requireDashboardToken, (req, res) => {
  if (!client.guilds.cache.has(req.params.guildId)) return res.status(404).json({ error: 'Unknown server' });
  res.json(store.settings(req.params.guildId));
});
app.put('/api/settings/:guildId', requireDashboardToken, async (req, res) => {
  const guild = client.guilds.cache.get(req.params.guildId);
  if (!guild) return res.status(404).json({ error: 'Unknown server' });
  const allowed = ['announcement_channel_id', 'grind_role_id', 'vanity_role_id', 'vanity_code'];
  const changes = {};
  for (const key of allowed) {
    if (Object.hasOwn(req.body, key)) {
      const val = req.body[key];
      if (val !== null && (typeof val !== 'string' || val.length > 100)) return res.status(400).json({ error: `Invalid ${key}` });
      changes[key] = val || null;
    }
  }
  res.json(store.saveGuildSettings(guild.id, changes));
});
app.post('/api/embed', requireDashboardToken, async (req, res) => {
  const { guildId, channelId, title, description, color = '#5865F2' } = req.body || {};
  const guild = client.guilds.cache.get(guildId);
  if (!guild || typeof channelId !== 'string' || typeof title !== 'string' || typeof description !== 'string') return res.status(400).json({ error: 'Provide a valid server, channel, title, and description.' });
  if (title.length > 256 || description.length > 4000 || !/^#[0-9a-f]{6}$/i.test(color)) return res.status(400).json({ error: 'Title, description, or color is invalid.' });
  try {
    const channel = await guild.channels.fetch(channelId);
    if (!channel?.isTextBased() || !channel.send) return res.status(400).json({ error: 'That is not a text channel.' });
    await channel.send({ embeds: [new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setTimestamp()] });
    res.json({ ok: true });
  } catch (error) {
    console.error('Dashboard embed failed:', error);
    res.status(500).json({ error: 'Could not send embed. Check the bot channel permissions.' });
  }
});

function utcDuration(ms) {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  return `${hours}h ${minutes}m`;
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
    .addChannelOption(o => o.setName('announcement_channel').setDescription('Channel for vanity notices').addChannelTypes(ChannelType.GuildText))
    .addRoleOption(o => o.setName('grind_role').setDescription('Role members can opt into'))
    .addRoleOption(o => o.setName('vanity_role').setDescription('Reward role for a vanity claim')),
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
  try {
    await client.application.commands.set(commands.map(command => command.toJSON()));
    console.log('Registered global slash commands.');
  } catch (error) { console.error('Could not register slash commands:', error); }
});

client.on('voiceStateUpdate', (oldState, newState) => {
  const guildId = newState.guild.id;
  const userId = newState.id;
  if (!oldState.channelId && newState.channelId && !newState.member?.user.bot) {
    store.recordVoiceJoin(guildId, userId, newState.channelId);
  } else if (oldState.channelId && !newState.channelId) {
    store.recordVoiceLeave(guildId, userId);
  } else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
    store.recordVoiceLeave(guildId, userId);
    if (!newState.member?.user.bot) store.recordVoiceJoin(guildId, userId, newState.channelId);
  }
});

client.on('guildMemberAdd', async member => {
  if (!member.user.bot || !store.isLocked(member.guild.id)) return;
  try {
    const logs = await member.guild.fetchAuditLogs({ type: 28, limit: 6 }); // AuditLogEvent.BotAdd
    const entry = logs.entries.find(item => item.target?.id === member.id && Date.now() - item.createdTimestamp < 60_000);
    const inviterId = entry?.executor?.id;
    const allowed = inviterId === ownerId || inviterId === member.guild.ownerId || (inviterId && store.isWhitelisted(member.guild.id, inviterId));
    if (!allowed && member.guild.members.me?.permissions.has(PermissionFlagsBits.KickMembers)) {
      await member.kick('Bot-add monitoring: inviter is not authorized');
    }
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
      const channel = interaction.options.getChannel('announcement_channel');
      const grindRole = interaction.options.getRole('grind_role');
      const vanityRole = interaction.options.getRole('vanity_role');
      if (channel) changes.announcement_channel_id = channel.id;
      if (grindRole) changes.grind_role_id = grindRole.id;
      if (vanityRole) changes.vanity_role_id = vanityRole.id;
      if (!Object.keys(changes).length) return interaction.reply({ content: 'Choose at least one setting to update.', ephemeral: true });
      store.saveGuildSettings(interaction.guildId, changes);
      return interaction.reply({ content: 'Guild settings updated.', ephemeral: true });
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
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle(`${period === 'weekly' ? 'Weekly' : 'Monthly'} Voice Leaderboard`)
        .setDescription(description).setFooter({ text: 'UTC period • time tracked while the bot is online' }).setTimestamp()], ephemeral: false });
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
        if (channel?.isTextBased() && channel.send) await channel.send({ embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('Vanity supporter')
          .setDescription(`${interaction.user} claimed the vanity reward!`).setTimestamp()] });
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
        return interaction.reply({ content: `Bot-add monitoring ${enabled ? 'enabled' : 'disabled'}. Note: Discord does not let bots prevent app installs; this monitors joins and may remove unauthorized bots after they are added.`, ephemeral: true });
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
