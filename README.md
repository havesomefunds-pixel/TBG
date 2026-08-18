# TBG virtual-XP bot

TBG is a Discord bot for one server, with virtual, non-redeemable XP only. It has no payments, cash-out, crypto, or real-world value exchange. The security boundary is the required `TBG_GUILD_ID`, never a server name.

## Quick start

1. Use Node 22 and PostgreSQL 17. Copy `.env.example` to `.env` and fill every required value.
2. Run `npm ci`, `npm run db:migrate`, `npm run build`, and `npm test`.
3. Run `npm start`, or `docker compose up -d --build`.

The health endpoint binds to loopback only: `curl http://127.0.0.1:3000/healthz`. `/readyz` also checks the database and Discord readiness.

## Discord setup

Create a Discord application and bot, then set `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and the numeric `TBG_GUILD_ID`. Invite with the `bot` scope. Minimum permissions are View Channels, Send Messages, Embed Links, Read Message History, and Add Reactions if components are enabled. Enable Guilds, Guild Members, Guild Messages/Message Content, Guild Message Reactions, and Guild Voice States intents. Do not grant Administrator.

Only events and interactions bearing the configured guild ID are processed. DMs receive the configured brief reply; external guild events are ignored. At startup, the bot warns if the configured guild's display name is not `TBG`, but this warning does not replace ID checks.

## Configuration and administration

`OWNER_ROLE_IDS`, `ADMIN_ROLE_IDS`, and `MODERATOR_ROLE_IDS` are comma-separated numeric role IDs. The safe defaults retain TBG's configured owner role `1458348294123159683` and admin/moderator role `1458348294123159684`. Administrator/Moderate Members permissions are also honored. Administrators can export settings through `!admin-settings-export` and toggle maintenance through `!admin-settings <on|off>`; changes are versioned and audited. Moderators can use `!admin-freeze @user <minutes> <reason>`, which is also audit logged. Settings include XP rules, progression, games, channels, feature switches, and maintenance mode. Never add tokens, private keys, or production `.env` files to Git.

Default progression is 0–50, with cumulative threshold `50 × level²` XP (level 50 is 125,000 XP). Unlocks: level 0 base games/activity, level 5 `rob`, level 15 `donate`/`coinflip`, level 20 `give`, level 50 `prestige`. Prestige resets XP to its configured baseline, retains lifetime statistics, increments prestige, and writes a ledger record.

Economy entries use serializable database transactions, idempotency keys, immutable ledger records, and non-negative balance checks. Interactive blackjack and crash games debit a game escrow at creation, persist their state, verify button ownership, and settle/refund exactly once. Blackjack uses a shuffled 52-card deck, dealer rules, natural 3:2 payouts, and double-down escrow. Crash derives a retained crash point and lets the player cash out its increasing multiplier. Coinflip is a transactional 1:1 virtual-XP wager. Game recovery resumes unexpired blackjack, resolves crash safely, and refunds every expiry. Configure realistic caps/cooldowns before enabling each activity.

## Operations

`compose.yml` runs PostgreSQL without host exposure and binds health checks to `127.0.0.1`. Install `deploy/tbg-bot.service` at `/etc/systemd/system/tbg-bot.service`, `systemctl daemon-reload`, then `systemctl enable --now tbg-bot`. Logs: `docker compose logs -f bot`; restart: `systemctl restart tbg-bot`; rollback: deploy the previous Git revision then `systemctl restart tbg-bot`.

Back up with `deploy/backup-postgres.sh` using a root-owned cron/systemd timer, retain at least 14 days, encrypt and copy backups off-droplet. Test restore on an isolated database with `pg_restore -U tbg -d tbg --clean backup.dump`; do not restore over production without a confirmed maintenance window. Firewall policy: expose no database port and no public health port. The provided CI runs schema validation, lint, types, tests, and build; deploy only from a protected `main` branch after a manual secret-configured SSH/CD step.

## Runbook

If Discord is disconnected, check `docker compose logs bot`, token/intents, bot permissions, and `GET /readyz`. If the database is unavailable, confirm `docker compose ps`, disk space, and backup age; the bot should report unready rather than grant XP. Moderators should cancel stuck games and refund escrow only after checking ledger/game IDs. Freeze suspicious accounts with a reason and expiry, preserve audit records, and never edit balances directly in SQL.

## Prefix command surface

TBG uses `!` message commands; public slash commands are cleared at startup. Commands never earn message XP. Buttons are used only after a game command starts a persisted game, and only its player(s) can press them.

- `!bj <wager>` starts persisted blackjack with Hit, Stand, and first-decision Double Down; escrow, settlement, expiry refund, recovery, and balance are shown in TBG embeds.
- `!gamble <wager>` rolls one d100 using configured payout bands and shows the roll, required winning roll, stake, XP change, new balance, and payout table. `!slots <wager>` and `!coinflip <wager>` use the transactional virtual-XP escrow/settlement economy.
- `!crash <wager>` starts persisted crash and provides a player-only Cash Out button. `!duel @user` sends a target-only Accept/Decline challenge and awards the configured winner reward exactly once. `!rob @user` applies the configured chance and transfers XP or failure penalty in the serializable robbery transaction.
- `!tictactoe @user` starts a persisted, player-only 3×3 button board with turn, win, draw, expiry, and optimistic-concurrency checks.
- `!daily`, `!level [@user]`, `!levels`, `!lb`, `!vclb`, `!longestcall`, `!autoprestige`, `!give @user <amount>`, and `!prestige` retain progression/economy behavior and unlocks.
- `!8ball <question>`, `!ship @user`, `!vibecheck [@user]` (also `!vibe-check`), `!raffle`, `!quests`, `!bounty [@user]`, and `!donate` provide social/event views without inventing XP movement for inactive events.
- `!ping`, `!admin-settings-export`, `!admin-settings <on|off>`, and `!admin-freeze @user <minutes> <reason>` retain health and role/permission-protected administration.
