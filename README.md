# Discord community bot and dashboard

Railway Discord bot with dashboard-configurable channels/roles, voice and message leaderboards, reward roles, embed tools, and a NxtCoin prefix-command economy.

## NxtCoin economy
- Default prefix is `!`; a server admin can set a different 1–3 character prefix with `!prefix ?` (then use `?help`). Prefix settings and balances persist in SQLite.
- Economy prefix commands have a shared 10-second cooldown per member and server. Only one cooldown notice is sent during that wait.
- `!help` / `?help` — full command guide with earning methods, games, balance, transfers, and prefix setup.
- `!earn` — list earning methods and their cooldowns.
- `!balance` / `!bal` — check your wallet (or mention another member).
- `!daily` — collect 100–250 NxtCoin every 24 hours.
- `!work` — earn 20–100 NxtCoin every 30 minutes.
- `!fish` — earn 15–90 NxtCoin every 15 minutes, with animated fishing frames.
- `!scavenge` — earn 40–160 NxtCoin every hour, with animated treasure-hunt frames.
- `!pay @member amount` — transfer NxtCoin to another member.
- `!coinflip amount heads|tails` and `!slots amount` — animated-in-chat coin flip and slot reels, with NxtCoin wagers.
- `!rich` — server wallet leaderboard.
- Google emoji animations cannot be inserted as inline Discord message emojis. The help embed and economy commands use animated custom server emojis when the server has them and the bot can access them, with standard emoji as a fallback. Google artwork can be added as a GIF image in an embed, not as inline text.

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
Enable Server Members Intent and Message Content Intent. Set Railway environment values from `.env.example`, register the `/auth/callback` OAuth redirect, and mount persistent storage at `/data`. Prefix commands need Message Content Intent enabled for the bot in the Discord Developer Portal.
