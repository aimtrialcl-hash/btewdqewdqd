# Discord community bot and dashboard

Railway Discord bot with Discord OAuth dashboard, selectable channel/role controls, voice and message leaderboards, and persistent auto-updating leaderboard embeds.

## Dashboard and leaderboard embeds
- Sign in with Discord. Only servers shared with the bot where the signed-in user owns the server or has Manage Server/Administrator permission are listed.
- Choose channels and roles from dropdowns; no need to copy IDs.
- Choose a leaderboard posting channel and the bot creates four embeds: weekly/monthly voice time and message counts. The same messages are edited every 60 seconds.
- The dashboard leaderboard also refreshes once per minute while the tab is visible.
- The embed editor includes live preview and a server custom-emoji picker.

## Tracking and rewards
- Voice time is calculated from voice state events. It only accumulates while the bot is online and tracking; previously connected users are resumed at startup.
- Message leaderboard counts non-bot guild messages from deployment onward. Enable the **Message Content Intent** in the Discord Developer Portal (the bot does not read message text, only count events).
- At weekly/monthly reset, the #1 voice-time member gets the configured reward role; the prior bot-awarded role is removed on the next reset.
- Bot needs Manage Roles, with its top role above roles it manages. It also needs View Channel, Send Messages, Embed Links and Read Message History for leaderboard posting.
- `/grind join` and `/grind leave` manage the opt-in role. `/vanity set`, `/vanity claim`, `/vanity remove` manage explicit vanity reward claims.
- `/botaccess` offers best-effort bot-add monitoring; Discord does not permit bots to block app installations before they happen.

## Railway and Discord OAuth setup
1. In Discord Developer Portal, enable **Server Members Intent**, **Server Messages Intent/Message Content Intent** as available, and set OAuth2 redirect URI to `https://YOUR-RAILWAY-DOMAIN/auth/callback`.
2. Set Railway variables: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `BOT_OWNER_ID`, `SESSION_SECRET`, `DASHBOARD_URL`, `DATA_DIR=/data`, and `NODE_ENV=production`. Railway supplies `PORT`.
3. Set `DASHBOARD_URL` to the exact public Railway domain (no trailing slash). Add a Railway Volume mounted at `/data` so SQLite data persists.
4. Redeploy, open the dashboard, sign in with Discord, select the server and configure channel/role dropdowns.

Message and voice history is not retroactive. Railway availability depends on service plan/status. Never share bot tokens or OAuth secrets; rotate any secret already exposed.
