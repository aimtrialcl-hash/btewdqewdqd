# Discord community bot + dashboard

Railway-deployable Discord bot with voice-time leaderboards, automatic weekly/monthly winner roles, grind and vanity roles, embed announcements, and a web dashboard.

## Features

- `/leaderboard weekly` and `/leaderboard monthly` show voice time, the reward role, and the next UTC reset.
- At each weekly/monthly reset, the #1 voice-time member is automatically given the configured reward role. The prior winner's bot-awarded role is removed on the next reset. Results and reset processing are persisted in SQLite to avoid duplicate awards after restarts.
- Configure reward roles using `/configure weekly_reward_role:@Role monthly_reward_role:@Role` or in the dashboard. The bot needs **Manage Roles**, and its highest role must be above each reward role.
- `/grind join` / `/grind leave` lets members opt into the configured grind role.
- `/embed` sends a basic embed. The web dashboard has a richer live-preview editor for author, footer, accent color, images, thumbnail, and timestamp.
- `/vanity set`, `/vanity claim`, and `/vanity remove` manage explicit vanity reward claims. Discord does not give bots an event for a member applying a vanity URL.
- `/botaccess lock` and `/botaccess whitelist` provide best-effort bot-add monitoring. Discord does not let a bot block app installs before they happen.

Voice data begins when the bot is online and receives voice-state events. At startup, any open sessions from its previous process lifetime are closed and currently connected members are re-tracked. Use a Railway Volume mounted at `/data` to persist SQLite data across deployments. Railway availability depends on your plan/service; no service can guarantee uninterrupted 24/7 uptime.

## Deploy

1. Create a Discord application/bot in the [Developer Portal](https://discord.com/developers/applications); enable **Server Members Intent**.
2. Invite it with `bot` and `applications.commands` scopes. Grant View Channels, Send Messages, Embed Links, Manage Roles, View Audit Log, and Kick Members as needed. Place the bot's role above all roles it manages.
3. Set `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `BOT_OWNER_ID`, and a long random `DASHBOARD_TOKEN` in Railway. Set `DATA_DIR=/data`; Railway sets `PORT` automatically.
4. Add a persistent Railway Volume mounted at `/data`, deploy, and open the generated public domain.
5. Connect to the dashboard with `DASHBOARD_TOKEN`. Configure the announcement channel and weekly/monthly leaderboard reward role IDs, or use `/configure` in Discord.

Never commit bot tokens or paste them into chat. If a token was exposed, reset it in the Discord Developer Portal immediately.
