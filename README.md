# Discord community bot and dashboard

Railway Discord bot with Discord OAuth dashboard, selectable channel/role controls, voice and message leaderboards, and persistent auto-updating leaderboard embeds.

## Dashboard
- Sign in with Discord; only shared servers where your account has Manage Server/Administrator permission are listed.
- Choose channels and roles from dropdowns.
- The embed editor can send new embeds or edit an existing message sent by this bot. For edits, select the channel, choose **Edit existing bot embed**, and provide the message ID (enable Developer Mode in Discord and use **Copy Message ID**). For safety, messages authored by other users cannot be edited.
- The editor has a live preview and a custom server emoji picker.
- The dashboard leaderboard refreshes once per minute while the tab is visible.

## Leaderboards and bot commands
- Choose a posting channel to create weekly/monthly voice and message leaderboard embeds; the bot edits the same posts every 60 seconds.
- Voice time is calculated from voice-state events. Message counts start after deployment and require the Message Content Intent; message contents are not read.
- The weekly/monthly voice #1 receives the configured winner role when each period resets.
- `/grind join` and `/grind leave` manage the opt-in role. `/vanity set`, `/vanity claim`, and `/vanity remove` are self-claimed role commands and do not verify server vanity/tag use.
- `/botaccess` provides best-effort bot-add monitoring; Discord does not let bots block app installations in advance.

## Deploy
1. Enable Server Members Intent and Message Content Intent in the Discord Developer Portal.
2. Add the exact OAuth redirect URI `https://YOUR-RAILWAY-DOMAIN/auth/callback`.
3. Set Railway variables from `.env.example`, including `DATA_DIR=/data`, `DASHBOARD_URL`, and `NODE_ENV=production`; mount a persistent volume at `/data`.
4. Invite the bot with `bot` and `applications.commands` scopes. Grant View Channels, Send Messages, Embed Links, Read Message History, Manage Roles, View Audit Log, and other permissions needed for enabled features.

Never share bot tokens or OAuth secrets. Message and voice history are not retroactive. Railway availability depends on plan and service status.
