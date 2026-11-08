# Discord community bot + dashboard

Railway-deployable Discord bot with voice-time leaderboards, automatic weekly/monthly winner roles, grind and vanity roles, embed announcements, and a Discord OAuth dashboard.

## Dashboard

- Sign in with Discord; the dashboard lists only servers shared with the bot where your account is the owner or has Manage Server/Administrator permission.
- The voice leaderboard refreshes automatically every 60 seconds while the dashboard tab is visible.
- Configure server settings and the weekly/monthly #1 voice-time reward roles.
- Build embeds with a live Discord-inspired preview. The editor loads the selected server's custom emojis; click one to insert its Discord emoji markup at the current cursor in the title, description, author, or footer.
- Dashboard sessions use secure, HTTP-only cookies. No shared dashboard bearer token is used.

## Bot features

- `/leaderboard weekly` and `/leaderboard monthly` show voice time, reward role, and next UTC reset.
- At each weekly/monthly reset, the #1 voice-time member gets the configured reward role. The prior winner's bot-awarded role is removed at the following reset. Reset awards are stored in SQLite to avoid duplicates after restarts.
- Configure reward roles using `/configure weekly_reward_role:@Role monthly_reward_role:@Role` or in the dashboard. The bot needs **Manage Roles** and its highest role must be above each role it manages.
- `/grind join` / `/grind leave` lets members opt into the configured grind role.
- `/embed` sends a basic embed; use the web editor for additional formatting and server emoji insertion.
- `/vanity set`, `/vanity claim`, and `/vanity remove` manage explicit vanity reward claims. Discord does not notify bots when a member applies a vanity URL.
- `/botaccess lock` and `/botaccess whitelist` provide best-effort bot-add monitoring. Discord does not let bots block app installations before they happen.

Voice data begins when the bot is online and receives voice-state events. At startup, open sessions from its previous process lifetime are closed and currently connected members are re-tracked. Use a Railway Volume mounted at `/data` to persist SQLite data across deployments.

## Discord OAuth and Railway setup

1. In the Discord Developer Portal, enable **Server Members Intent** for the bot.
2. Under **OAuth2 → General**, add the exact redirect URI `https://YOUR-RAILWAY-DOMAIN/auth/callback` (replace with your actual public domain).
3. Set Railway variables using `.env.example`: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `BOT_OWNER_ID`, `SESSION_SECRET`, `DASHBOARD_URL`, and `DATA_DIR=/data`. Railway supplies `PORT`.
4. Add a persistent Railway Volume mounted at `/data`, deploy, and open the same domain configured as `DASHBOARD_URL`.
5. Invite the bot with `bot` and `applications.commands` scopes. Grant View Channels, Send Messages, Embed Links, Manage Roles, View Audit Log, and Kick Members as needed. Place its role above roles it should assign/remove.

The OAuth dashboard requests only `identify` and `guilds`. Use a strong random `SESSION_SECRET`. Set `NODE_ENV=production` in Railway to enable secure session cookies. Never commit or share bot tokens, OAuth client secrets, or session secrets. Any secret previously exposed should be rotated in its provider dashboard immediately.

Railway availability depends on your plan and service status; uninterrupted 24/7 uptime cannot be guaranteed.
