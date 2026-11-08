# Discord community bot and dashboard

Railway Discord bot with dashboard-configurable channels/roles, voice and message leaderboards, reward roles, and embed tools.

## Dashboard
- Select server channels and roles from menus.
- Embed editor sends new embeds or edits a bot-authored message. It supports title, description, author/footer, color, thumbnail, large image, timestamp and custom server emoji markup.
- Configure leaderboard embed title (supports `{period}` and `{type}`), intro/emoji text, thumbnail URL, and image URL. The bot maintains weekly/monthly voice and message boards and edits them every minute.

## Rewards and tracking
- Weekly/monthly voice and message winner roles can be configured independently. At period reset, the #1 member receives their configured role; the prior bot-awarded role is removed on the next reset. The announcement includes a mention of the winner and reward role, restricted to those IDs.
- Message counts start at deployment and require the Discord Message Content privileged intent enabled in the Developer Portal. The bot counts messages but does not inspect their text.
- Voice time is tracked from Gateway voice events while the bot is online. Weekly/monthly periods use UTC.
- `/grind`, `/vanity`, and `/botaccess` commands remain available.

## Deploy
Enable Server Members Intent and Message Content Intent. Set Railway environment values from `.env.example`, register the `/auth/callback` OAuth redirect, and mount persistent storage at `/data`. Invite with `bot` and `applications.commands` and grant the necessary channel permissions, Manage Roles (above the configured rewards), and View Audit Log if bot-add monitoring is enabled.
