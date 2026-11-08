# Discord community bot + dashboard

A JavaScript Discord bot with voice-time leaderboards, grind/vanity roles, embed announcements, a small web dashboard, and best-effort bot-add monitoring. It is designed to deploy as one long-running Railway service.

## Features

- `/leaderboard weekly` and `/leaderboard monthly` — voice time, measured in UTC and ranked from voice-state events.
- `/configure` — set the announcement channel and grind/vanity roles.
- `/grind join` / `/grind leave` — let members opt into the configured grind role.
- `/embed` — send a formatted embed to a selected channel.
- `/vanity set` — configure the code, announcement channel, and reward role. `/vanity claim` and `/vanity remove` let a member claim or remove that role. This is an explicit self-claim flow: Discord does not provide bots an event saying that a member “applied” a server vanity URL.
- `/botaccess lock` and `/botaccess whitelist` — best-effort monitoring of bot additions, with an inviter whitelist and removal of unauthorized bots when the bot has the required permissions.
- Dashboard at `/` to view leaderboards and update channel/role settings or send embeds.

## Important Discord limitations

A bot cannot prevent an authorized server member from starting an OAuth install or guarantee that no other bot is added. Discord controls who can authorize app installs. This bot can monitor bot-add audit log entries and attempt to remove unauthorized bots after they join; grant it **View Audit Log** and **Kick Members**. The whitelist is for authorized *inviting users*. Keep the server’s own app-install permissions restricted in Discord settings as well. The bot cannot set or detect individual “vanity applications”; the vanity reward is managed through the explicit `/vanity claim` and `/vanity remove` commands.

Voice data starts accumulating when the bot is online and receives voice-state events; it cannot reconstruct earlier activity. Use a Railway Volume mounted at `/data` so the SQLite database survives deploys. Railway uptime and availability depend on your Railway plan and service status; no application can guarantee 24/7 availability.

## Setup

1. Create a Discord application and bot in the [Developer Portal](https://discord.com/developers/applications). Copy the bot token and application ID.
2. Enable the **Server Members Intent** in the bot's Privileged Gateway Intents. Voice state intent is enabled by the code.
3. Invite it with the `bot` and `applications.commands` scopes. Suggested permissions: View Channels, Send Messages, Embed Links, Manage Roles, View Audit Log, and Kick Members. Put the bot's role above the roles it must assign/remove.
4. Copy `.env.example` to `.env` for local use and set the variables. Use a long random `DASHBOARD_TOKEN`; never commit real secrets.
5. Deploy this repository to Railway. Set the environment variables from `.env.example`, attach a persistent Volume mounted at `/data`, and expose the service's HTTP port. Railway provides `PORT` automatically.
6. In Discord, use `/configure` or open the dashboard and enter your server ID, channel ID, and role IDs. Use `/vanity set` to configure the vanity claim code and reward role.

The first run registers global application commands, which may take a short time to appear. The dashboard's write API requires the `DASHBOARD_TOKEN` as a bearer token. Public leaderboard endpoints expose only aggregate voice time and display names.

## Commands

- `/configure [announcement_channel] [grind_role] [vanity_role]`
- `/embed channel title description [color]`
- `/leaderboard period:weekly|monthly`
- `/grind action:join|leave`
- `/vanity set code channel role`, `/vanity claim code`, `/vanity remove`
- `/botaccess lock enabled:true|false`
- `/botaccess whitelist action:add|remove user`

Only the configured bot owner can change bot-add lock/whitelist settings. Guild configuration and role actions require appropriate guild permissions.
