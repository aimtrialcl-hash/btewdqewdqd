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
for (const key of required) if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
const ownerId = process.env.BOT_OWNER_ID;
const dashboardUrl = process.env.DASHBOARD_URL.replace(/\/$/, '');
const redirectUri = `${dashboardUrl}/auth/callback`;
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use(session({ name: 'community.sid', secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 } }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (_req, res) => res.status(client.isReady() ? 200 : 503).json({ ok: client.isReady() }));
function periodRange(period, now = new Date()) {
  const end = now.getTime(); const start = new Date(now);
  if (period === 'weekly') { start.setUTCHours(0, 0, 0, 0); start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7)); }
  else { start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0); }
  return { start: start.getTime(), end };
}
function previousPeriodRange(period, now = new Date()) {
  const { start: end } = periodRange(period, now); const startDate = new Date(end);
  if (period === 'weekly') startDate.setUTCDate(startDate.getUTCDate() - 7); else startDate.setUTCMonth(startDate.getUTCMonth() - 1);
  return { start: startDate.getTime(), end };
}
function getLeaderboard(guildId, period, metric = 'voice') {
  const { start, end } = periodRange(period);
  const rows = metric === 'messages' ? store.getMessageLeaderboard(guildId, start, end) : store.getVoiceLeaderboard(guildId, start, end);
  return rows.map(row => {
    const member = client.guilds.cache.get(guildId)?.members.cache.get(row.user_id);
    return { userId: row.user_id, name: member?.displayName || `Member ${row.user_id.slice(-4)}`, score: row.score };
  });
}
function rewardRoleId(settings, period) { return period === 'weekly' ? settings.weekly_reward_role_id : settings.monthly_reward_role_id; }
function getRewardInfo(guild, period) {
  const roleId = rewardRoleId(store.settings(guild.id), period); const role = roleId && guild.roles.cache.get(roleId);
  return role ? `Top voice member receives ${role.name}.` : 'No winner role configured yet.';
}
function validOptionalString(value, maxLength = 100) { return value == null || (typeof value === 'string' && value.length <= maxLength); }
function validImageUrl(value) {
  if (!value) return true;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}
function requireLogin(req, res, next) { if (!req.session.user) return res.status(401).json({ error: 'Please log in with Discord.' }); next(); }
function canManageGuild(req, guildId) { return req.session.user?.id === ownerId || req.session.guildIds?.includes(guildId); }
function requireGuildManager(req, res, next) {
  if (!canManageGuild(req, req.params.guildId || req.body?.guildId)) return res.status(403).json({ error: 'You need Manage Server permission for this server.' });
  next();
}
app.get('/auth/discord', (req, res) => {
  const state = crypto.randomBytes(24).toString('hex'); req.session.oauthState = state;
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', process.env.DISCORD_CLIENT_ID); url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code'); url.searchParams.set('scope', 'identify guilds'); url.searchParams.set('state', state);
  res.redirect(url.toString());
});
app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || typeof code !== 'string' || typeof state !== 'string' || !req.session.oauthState
    || Buffer.byteLength(state) !== Buffer.byteLength(req.session.oauthState)
    || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(req.session.oauthState))) return res.redirect('/?login=failed');
  delete req.session.oauthState;
  try {
    const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID, client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code', code, redirect_uri: redirectUri }) });
    if (!tokenResponse.ok) throw new Error(`Discord token exchange failed (${tokenResponse.status})`);
    const tokenData = await tokenResponse.json(); const headers = { Authorization: `Bearer ${tokenData.access_token}` };
    const [userResponse, guildsResponse] = await Promise.all([fetch('https://discord.com/api/v10/users/@me', { headers }), fetch('https://discord.com/api/v10/users/@me/guilds', { headers })]);
    if (!userResponse.ok || !guildsResponse.ok) throw new Error('Could not fetch Discord account details.');
    const [user, guilds] = await Promise.all([userResponse.json(), guildsResponse.json()]);
    const manageableGuildIds = guilds.filter(g => {
      const p = BigInt(g.permissions || '0'); return (g.owner || (p & 0x8n) !== 0n || (p & 0x20n) !== 0n) && client.guilds.cache.has(g.id);
    }).map(g => g.id);
    await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
    req.session.user = { id: user.id, username: user.global_name || user.username, avatar: user.avatar };
    req.session.guildIds = manageableGuildIds; res.redirect('/');
  } catch (err) { console.error('Discord OAuth login failed:', err); res.redirect('/?login=failed'); }
});
app.get('/auth/logout', (req, res, next) => req.session.destroy(err => {
  if (err) return next(err);
  res.clearCookie('community.sid', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' }); res.redirect('/');
}));
app.get('/api/auth/me', (req, res) => {
  if (!req.session.user) return res.json({ authenticated: false }); const user = req.session.user;
  const avatar = user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${user.avatar.startsWith('a_') ? 'gif' : 'png'}?size=128`
    : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id) >> 22n) % 6}.png`;
  res.json({ authenticated: true, user: { id: user.id, username: user.username, avatar } });
});
app.get('/api/guilds', requireLogin, (req, res) => res.json(client.guilds.cache.filter(g => canManageGuild(req, g.id)).map(g => ({ id: g.id, name: g.name, icon: g.iconURL({ size: 64 }) }))));
app.get('/api/guilds/:guildId/resources', requireLogin, requireGuildManager, async (req, res) => {
  const guild = client.guilds.cache.get(req.params.guildId); if (!guild) return res.status(404).json({ error: 'Unknown server' });
  try {
    await Promise.all([guild.roles.fetch(), guild.emojis.fetch()]);
    const channels = await guild.channels.fetch();
    res.json({ channels: channels.filter(c => c && [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(c.type)).map(c => ({ id: c.id, name: `#${c.name}` })),
      roles: guild.roles.cache.filter(r => r.id !== guild.id && !r.managed).sort((a,b) => b.position-a.position).map(r => ({ id:r.id, name:r.name })),
      emojis: guild.emojis.cache.map(e => ({ id:e.id, name:e.name, animated:e.animated, markup:`<${e.animated?'a':''}:${e.name}:${e.id}>`, image:e.imageURL({ extension:e.animated?'gif':'png', size:64 }) })) });
  } catch (error) { console.error('Could not load guild resources:', error); res.status(500).json({ error: 'Could not load server channels, roles, or emojis.' }); }
});
app.get('/api/settings/:guildId', requireLogin, requireGuildManager, (req,res) => {
  const guild = client.guilds.cache.get(req.params.guildId); if (!guild) return res.status(404).json({error:'Unknown server'}); res.json(store.settings(guild.id));
});
app.put('/api/settings/:guildId', requireLogin, requireGuildManager, (req,res) => {
  const guild = client.guilds.cache.get(req.params.guildId); if (!guild) return res.status(404).json({error:'Unknown server'});
  const fields = ['announcement_channel_id','grind_role_id','vanity_role_id','vanity_code','weekly_reward_role_id','monthly_reward_role_id','leaderboard_channel_id'];
  const changes = {};
  for (const key of fields) if (Object.hasOwn(req.body,key)) {
    if (!validOptionalString(req.body[key])) return res.status(400).json({error:`Invalid ${key}`}); changes[key] = req.body[key] || null;
  }
  const resources = guild.channels.cache;
  for (const key of ['announcement_channel_id','leaderboard_channel_id']) if (changes[key] && ![ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(resources.get(changes[key])?.type)) return res.status(400).json({error:`Select a valid text channel for ${key}.`});
  for (const key of ['grind_role_id','vanity_role_id','weekly_reward_role_id','monthly_reward_role_id']) if (changes[key] && !guild.roles.cache.has(changes[key])) return res.status(400).json({error:`Select a valid server role for ${key}.`});
  res.json(store.saveGuildSettings(guild.id,changes));
});
app.post('/api/embed', requireLogin, requireGuildManager, async (req,res) => {
  const {guildId,channelId,title,description,color='#5865F2',author,footer,imageUrl,thumbnailUrl,timestamp=false}=req.body||{}; const guild=client.guilds.cache.get(guildId);
  if (!guild || typeof channelId!=='string' || typeof title!=='string' || typeof description!=='string') return res.status(400).json({error:'Provide a valid server, channel, title, and description.'});
  if (title.length>256 || description.length>4000 || !/^#[0-9a-f]{6}$/i.test(color) || !validOptionalString(author,256) || !validOptionalString(footer,2048) || !validImageUrl(imageUrl) || !validImageUrl(thumbnailUrl)) return res.status(400).json({error:'Embed text, color, or image URL is invalid.'});
  try {
    const channel=await guild.channels.fetch(channelId); if (!channel || ![ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(channel.type)) return res.status(400).json({error:'Choose a text channel.'});
    const embed=new EmbedBuilder().setColor(color).setTitle(title).setDescription(description);
    if(author)embed.setAuthor({name:author}); if(footer)embed.setFooter({text:footer}); if(imageUrl)embed.setImage(imageUrl); if(thumbnailUrl)embed.setThumbnail(thumbnailUrl); if(timestamp)embed.setTimestamp();
    await channel.send({embeds:[embed]}); res.json({ok:true});
  } catch(error){console.error('Dashboard embed failed:',error);res.status(500).json({error:'Could not send embed. Check the bot channel permissions.'});}
});
app.get('/api/leaderboard', requireLogin, requireGuildManager, (req,res) => {
  const {guildId,period='weekly',metric='voice'}=req.query; const guild=typeof guildId==='string'&&client.guilds.cache.get(guildId);
  if(!guild)return res.status(404).json({error:'Unknown server'}); if(!['weekly','monthly'].includes(period)||!['voice','messages'].includes(metric))return res.status(400).json({error:'Invalid leaderboard type.'});
  res.json({period,metric,reward:metric==='voice'?getRewardInfo(guild,period):'Message leaderboard; no automatic role reward.',entries:getLeaderboard(guild.id,period,metric)});
});
function utcDuration(ms){return `${Math.floor(ms/3600000)}h ${Math.floor((ms%3600000)/60000)}m`;}
function leaderboardEmbed(guild,metric,period){
  const entries=getLeaderboard(guild.id,period,metric); const {start}=periodRange(period);
  const lines=entries.map((entry,i)=>metric==='voice'?`**${i+1}.** ${entry.name} — ${utcDuration(entry.score)}`:`**${i+1}.** ${entry.name} — ${entry.score.toLocaleString()} messages`);
  const title=`${period==='weekly'?'Weekly':'Monthly'} ${metric==='voice'?'Voice':'Message'} Leaderboard`;
  const description=`${lines.length?lines.join('\n'):'No activity recorded this period.'}${metric==='voice'?`\n\n**Reward:** ${getRewardInfo(guild,period)}`:''}\n\n**Resets:** <t:${Math.floor(start/1000)}:R>`;
  return new EmbedBuilder().setColor(0x5865F2).setTitle(title).setDescription(description).setFooter({text:'Auto-updated every minute • UTC period'}).setTimestamp();
}
async function refreshLeaderboardPosts(){
  for(const guild of client.guilds.cache.values()){
    const channelId=store.settings(guild.id).leaderboard_channel_id; if(!channelId)continue;
    const channel=await guild.channels.fetch(channelId).catch(()=>null); if(!channel||![ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(channel.type))continue;
    for(const metric of ['voice','messages'])for(const period of ['weekly','monthly']){
      const embed=leaderboardEmbed(guild,metric,period); const saved=store.getPost(guild.id,metric,period); let message=null;
      if(saved?.channel_id===channel.id)message=await channel.messages.fetch(saved.message_id).catch(()=>null);
      if(message){await message.edit({embeds:[embed]}).catch(error=>console.error('Leaderboard message edit failed:',error));}
      else{
        const posted=await channel.send({embeds:[embed]}).catch(error=>{console.error('Leaderboard post failed:',error);return null;});
        if(posted)store.savePost(guild.id,metric,period,channel.id,posted.id);
      }
    }
  }
}
async function processLeaderboardResets(){
  for(const guild of client.guilds.cache.values())for(const period of ['weekly','monthly']){
    const {start,end}=previousPeriodRange(period);if(store.getAward(guild.id,period,start))continue;
    const roleId=rewardRoleId(store.settings(guild.id),period);if(!roleId)continue;
    const role=await guild.roles.fetch(roleId).catch(()=>null);if(!role){console.warn(`Missing ${period} reward role in ${guild.id}`);continue;}
    const previous=store.latestAward(guild.id,period,start);
    if(previous?.user_id&&previous.role_id===role.id){const member=await guild.members.fetch(previous.user_id).catch(()=>null);if(member?.roles.cache.has(role.id))await member.roles.remove(role,`${period} leaderboard reward reset`).catch(console.error);}
    const winner=store.getVoiceLeaderboard(guild.id,start,end,end)[0];let member=null;
    if(winner){member=await guild.members.fetch(winner.user_id).catch(()=>null);if(member)await member.roles.add(role,`${period} leaderboard winner`).catch(error=>{console.error('Could not assign reward:',error);member=null;});}
    if(winner&&!member)continue;store.recordAward(guild.id,period,start,member?.id||null,role.id);
    const noticeId=store.settings(guild.id).announcement_channel_id;const notice=noticeId&&await guild.channels.fetch(noticeId).catch(()=>null);
    if(notice&&[ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(notice.type))await notice.send({embeds:[new EmbedBuilder().setColor(member?0x57F287:0x5865F2).setTitle(`${period==='weekly'?'Weekly':'Monthly'} leaderboard reset`).setDescription(member?`${member} won ${role} with **${utcDuration(winner.score)}** of voice time.`:'No voice activity was recorded for the previous period.').setTimestamp()]}).catch(console.error);
  }
}
function canConfigure(interaction){return interaction.user.id===ownerId||interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);}
const commands=[
  new SlashCommandBuilder().setName('configure').setDescription('Configure roles and announcement channel')
    .addChannelOption(o=>o.setName('announcement_channel').setDescription('Channel for notices').addChannelTypes(ChannelType.GuildText))
    .addRoleOption(o=>o.setName('grind_role').setDescription('Role members can opt into'))
    .addRoleOption(o=>o.setName('vanity_role').setDescription('Reward role for a vanity claim'))
    .addRoleOption(o=>o.setName('weekly_reward_role').setDescription('Weekly voice winner role'))
    .addRoleOption(o=>o.setName('monthly_reward_role').setDescription('Monthly voice winner role'))
    .addChannelOption(o=>o.setName('leaderboard_channel').setDescription('Channel for auto-updating message and voice leaderboard embeds').addChannelTypes(ChannelType.GuildText)),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Show voice-time leaderboard').addStringOption(o=>o.setName('period').setDescription('Period').setRequired(true).addChoices({name:'Weekly',value:'weekly'},{name:'Monthly',value:'monthly'})),
  new SlashCommandBuilder().setName('grind').setDescription('Join or leave the grind role').addStringOption(o=>o.setName('action').setDescription('Action').setRequired(true).addChoices({name:'Join',value:'join'},{name:'Leave',value:'leave'})),
  new SlashCommandBuilder().setName('vanity').setDescription('Manage vanity reward claims')
    .addSubcommand(s=>s.setName('set').setDescription('Configure claim').addStringOption(o=>o.setName('code').setDescription('Claim code').setRequired(true).setMaxLength(100)).addChannelOption(o=>o.setName('channel').setDescription('Notice channel').setRequired(true).addChannelTypes(ChannelType.GuildText)).addRoleOption(o=>o.setName('role').setDescription('Reward role').setRequired(true)))
    .addSubcommand(s=>s.setName('claim').setDescription('Claim reward').addStringOption(o=>o.setName('code').setDescription('Claim code').setRequired(true).setMaxLength(100)))
    .addSubcommand(s=>s.setName('remove').setDescription('Remove your vanity role')),
  new SlashCommandBuilder().setName('botaccess').setDescription('Owner-only bot-add monitoring controls')
    .addSubcommand(s=>s.setName('lock').setDescription('Toggle bot-add monitoring').addBooleanOption(o=>o.setName('enabled').setDescription('Enabled').setRequired(true)))
    .addSubcommand(s=>s.setName('whitelist').setDescription('Manage bot inviter whitelist').addStringOption(o=>o.setName('action').setDescription('Action').setRequired(true).addChoices({name:'Add',value:'add'},{name:'Remove',value:'remove'})).addUserOption(o=>o.setName('user').setDescription('Authorized inviter').setRequired(true)))
];
client.once('ready',async()=>{
  console.log(`Logged in as ${client.user.tag}`);store.closeOpenVoiceSessions();
  for(const guild of client.guilds.cache.values())for(const state of guild.voiceStates.cache.values())if(state.channelId&&state.member&&!state.member.user.bot)store.recordVoiceJoin(guild.id,state.id,state.channelId);
  try{await client.application.commands.set(commands.map(c=>c.toJSON()));}catch(error){console.error('Command registration failed:',error);}
  await processLeaderboardResets().catch(console.error);await refreshLeaderboardPosts().catch(console.error);store.cleanupMessageEvents();
  setInterval(()=>{processLeaderboardResets().catch(console.error);refreshLeaderboardPosts().catch(console.error);},60_000);
  setInterval(()=>store.cleanupMessageEvents(),60*60_000);
});
client.on('messageCreate',message=>{if(message.guild&&!message.author.bot&&!message.system)store.recordMessage(message.guild.id,message.author.id,message.createdTimestamp);});
client.on('voiceStateUpdate',(oldState,newState)=>{
  const guildId=newState.guild.id,userId=newState.id;
  if(!oldState.channelId&&newState.channelId&&!newState.member?.user.bot)store.recordVoiceJoin(guildId,userId,newState.channelId);
  else if(oldState.channelId&&!newState.channelId)store.recordVoiceLeave(guildId,userId);
  else if(oldState.channelId&&newState.channelId&&oldState.channelId!==newState.channelId){store.recordVoiceLeave(guildId,userId);if(!newState.member?.user.bot)store.recordVoiceJoin(guildId,userId,newState.channelId);}
});
client.on('guildMemberAdd',async member=>{
  if(!member.user.bot||!store.isLocked(member.guild.id))return;
  try{
    const logs=await member.guild.fetchAuditLogs({type:AuditLogEvent.BotAdd,limit:6});const entry=logs.entries.find(e=>e.target?.id===member.id&&Date.now()-e.createdTimestamp<60_000);
    const inviterId=entry?.executor?.id;const allowed=inviterId===ownerId||inviterId===member.guild.ownerId||(inviterId&&store.isWhitelisted(member.guild.id,inviterId));
    if(!allowed&&member.guild.members.me?.permissions.has(PermissionFlagsBits.KickMembers))await member.kick('Bot-add monitoring: inviter is not authorized');
    const id=store.settings(member.guild.id).announcement_channel_id;const ch=id&&await member.guild.channels.fetch(id).catch(()=>null);
    if(ch&&[ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(ch.type))await ch.send({embeds:[new EmbedBuilder().setColor(allowed?0x57F287:0xED4245).setTitle(allowed?'Bot added (authorized)':'Bot-add security alert').setDescription(`${member.user.tag} (${member.id})${inviterId?` added by <@${inviterId}>`:'. Inviter could not be verified.'}${!allowed?'\nRemoval was attempted if permitted.':''}`).setTimestamp()]});
  }catch(error){console.error('Bot-add monitoring failed:',error);}
});
client.on('interactionCreate',async interaction=>{
  if(!interaction.isChatInputCommand()||!interaction.guild)return;
  try{
    if(interaction.commandName==='configure'){
      if(!canConfigure(interaction))return interaction.reply({content:'You need Manage Server permission.',ephemeral:true});const changes={};
      for(const [option,key] of [['announcement_channel','announcement_channel_id'],['leaderboard_channel','leaderboard_channel_id'],['grind_role','grind_role_id'],['vanity_role','vanity_role_id'],['weekly_reward_role','weekly_reward_role_id'],['monthly_reward_role','monthly_reward_role_id']]){
        const value=option.endsWith('channel')?interaction.options.getChannel(option):interaction.options.getRole(option);if(value)changes[key]=value.id;
      }
      if(!Object.keys(changes).length)return interaction.reply({content:'Choose a setting to update.',ephemeral:true});store.saveGuildSettings(interaction.guildId,changes);
      if(changes.leaderboard_channel_id)await refreshLeaderboardPosts();return interaction.reply({content:'Settings saved. Leaderboard embeds refresh every minute in the selected channel.',ephemeral:true});
    }
    if(interaction.commandName==='leaderboard'){
      const period=interaction.options.getString('period');const entries=getLeaderboard(interaction.guildId,period,'voice');const {start}=periodRange(period);
      const description=entries.length?entries.map((e,i)=>`**${i+1}.** ${e.name} — ${utcDuration(e.score)}`).join('\n'):'No voice activity recorded this period.';
      return interaction.reply({embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle(`${period==='weekly'?'Weekly':'Monthly'} Voice Leaderboard`).setDescription(`${description}\n\n**Reward:** ${getRewardInfo(interaction.guild,period)}\n**Resets:** <t:${Math.floor(start/1000)}:R>`).setFooter({text:'UTC period • tracked while the bot is online'}).setTimestamp()]});
    }
    if(interaction.commandName==='grind'){
      const roleId=store.settings(interaction.guildId).grind_role_id;const role=roleId&&await interaction.guild.roles.fetch(roleId).catch(()=>null);if(!role)return interaction.reply({content:'Configure a grind role first.',ephemeral:true});
      const joining=interaction.options.getString('action')==='join';await interaction.member.roles[joining?'add':'remove'](role);return interaction.reply({content:`${joining?'Joined':'Left'} ${role.name}.`,ephemeral:true});
    }
    if(interaction.commandName==='vanity'){
      const sub=interaction.options.getSubcommand();if(sub==='set'){
        if(!canConfigure(interaction))return interaction.reply({content:'You need Manage Server permission.',ephemeral:true});const code=interaction.options.getString('code').trim(),channel=interaction.options.getChannel('channel'),role=interaction.options.getRole('role');
        store.saveGuildSettings(interaction.guildId,{vanity_code:code,announcement_channel_id:channel.id,vanity_role_id:role.id});return interaction.reply({content:'Vanity claim configured.',ephemeral:true});
      }
      const cfg=store.settings(interaction.guildId),role=cfg.vanity_role_id&&await interaction.guild.roles.fetch(cfg.vanity_role_id).catch(()=>null);if(!role)return interaction.reply({content:'Configure a vanity reward role first.',ephemeral:true});
      if(sub==='claim'){if(interaction.options.getString('code').trim().toLowerCase()!==cfg.vanity_code?.toLowerCase())return interaction.reply({content:'That code does not match.',ephemeral:true});await interaction.member.roles.add(role);return interaction.reply({content:`Vanity role ${role} added.`,ephemeral:true});}
      await interaction.member.roles.remove(role);return interaction.reply({content:`Vanity role ${role} removed.`,ephemeral:true});
    }
    if(interaction.commandName==='botaccess'){
      if(interaction.user.id!==ownerId)return interaction.reply({content:'Only the configured bot owner can change these security settings.',ephemeral:true});const sub=interaction.options.getSubcommand();
      if(sub==='lock'){const enabled=interaction.options.getBoolean('enabled');store.setLocked(interaction.guildId,enabled);return interaction.reply({content:`Bot-add monitoring ${enabled?'enabled':'disabled'}. Discord does not let bots prevent app installs in advance.`,ephemeral:true});}
      const user=interaction.options.getUser('user'),add=interaction.options.getString('action')==='add';store.whitelistUser(interaction.guildId,user.id,add);return interaction.reply({content:`${user.tag} ${add?'added to':'removed from'} whitelist.`,ephemeral:true});
    }
  }catch(error){console.error('Command failed:',error);const response={content:'Command failed. Check bot permissions and role hierarchy.',ephemeral:true};if(interaction.replied||interaction.deferred)await interaction.followUp(response).catch(()=>{});else await interaction.reply(response).catch(()=>{});}
});
const port=Number(process.env.PORT||3000);app.listen(port,'0.0.0.0',()=>console.log(`Dashboard listening on ${port}`));client.login(process.env.DISCORD_TOKEN);
