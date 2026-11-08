# Discord community bot and dashboard

Railway Discord bot with dashboard-configurable channels/roles, voice and message leaderboards, reward roles, embed tools, and a NxtCoin prefix-command economy.

## NxtCoin economy
- Default prefix is `!`; a server admin can set a different 1–3 character prefix with `!prefix ?` (then use `?help`). Prefix settings and balances persist in SQLite.
- `!help` — economy command guide.
- `!balance` / `!bal` — check your wallet (or mention another member).
- `!daily` — claim a random 100–250 NxtCoin bonus every 24 hours.
- `!work` — earn 20–100 NxtCoin every 30 minutes.
- `!pay @member amount` — transfer NxtCoin to another member.
- `!coinflip amount heads|tails` and `!slots amount` — animated-in-chat coin flip and slot reels, with NxtCoin wagers.
- `!rich` — server wallet leaderboard.
- The animation is made from timed message edits and emoji/embed effects; Discord embeds themselves are static.

## Dashboard
- Select server channels and roles from menus.
- Embed editor sends new embeds or edits a bot-authored message. It supports title, description, author/footer, color, thumbnail, large image, timestamp and custom server emoji markup.
- Configure leaderboard embed title (supports `{period}` and `{type}`), intro/emoji text, thumbnail URL, and image URL. The bot maintains weekly/monthly voice and message boards and edits them every minute.

## Rewards and tracking
- Weekly/monthly voice and message winner roles can be configured independently. At period reset, the #1 member receives their configured role; the prior bot-awarded role is removed on the next reset.
- Message counts start at deployment and require the Discord Message Content privileged intent enabled in the Developer Portal. The bot counts messages but does not inspect their text.
- Voice time is tracked from Gateway voice events while the bot is online. Weekly/monthly periods use UTC.
- `/grind`, `/vanity`, and `/botaccess` commands remain available.

## Deploy
Enable Server Members Intent and Message Content Intent. Set Railway environment values from `.env.example`, register the `/auth/callback` OAuth redirect, and mount persistent storage at `/data`. Invite with `bot` and `applications.commands` and grant the necessary channel permissions, Manage Roles (above the configured rewards), and View Audit Log if bot-add monitoring is enabled.
