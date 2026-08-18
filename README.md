# TBG virtual-XP bot

TBG is a Discord bot for one server, with virtual, non-redeemable XP only. It has no payments, cash-out, crypto, or real-world value exchange. The security boundary is the required `TBG_GUILD_ID`, never a server name.

## Quick start

1. Use Node 22 and PostgreSQL 17. Copy `.env.example` to `.env` and fill every required value.
2. Run `npm ci`, `npm run db:migrate`, `npm run build`, and `npm test`.
3. Run `npm start`, or `docker compose up -d --build`.

The health endpoint binds to loopback only: `curl http://127.0.0.1:3000/healthz`. `/readyz` also checks the database and Discord readiness.

## Discord setup

Create a Discord application and bot, then set `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and the numeric `TBG_GUILD_ID`. Invite with `bot applications.commands`. Minimum permissions are View Channels, Send Messages, Embed Links, Read Message History, Use Application Commands, and Add Reactions if components are enabled. Enable Guilds, Guild Members, Guild Messages/Message Content (for message XP or prefix aliases), Guild Message Reactions, and Guild Voice States intents. Do not grant Administrator.

Only events and interactions bearing the configured guild ID are processed. DMs receive the configured brief reply; external guild events are ignored. At startup, the bot warns if the configured guild's display name is not `TBG`, but this warning does not replace ID checks.

## Configuration and administration

`ADMIN_ROLE_IDS` and `MODERATOR_ROLE_IDS` are comma-separated numeric role IDs. Administrator/Moderate Members permissions are also honored. Administrators can export settings through `/admin-settings-export`; changes must be audited and validated before import. Settings are versioned in `GuildConfig` and include XP rules, progression, games, channels, feature switches, and maintenance mode. Never add tokens, private keys, or production `.env` files to Git.

Default progression is 0–50, with cumulative threshold `50 × level²` XP (level 50 is 125,000 XP). Unlocks: level 0 base games/activity, level 5 `rob`, level 15 `donate`/`coinflip`, level 20 `give`, level 50 `prestige`. Prestige resets XP to its configured baseline, retains lifetime statistics, increments prestige, and writes a ledger record.

Economy entries use serializable database transactions, idempotency keys, immutable ledger records, and non-negative balance checks. Game odds are configuration-backed; randomness comes from Node cryptographic APIs and fairness metadata is retained server-side. Configure realistic caps/cooldowns before enabling each activity.

## Operations

`compose.yml` runs PostgreSQL without host exposure and binds health checks to `127.0.0.1`. Install `deploy/tbg-bot.service` at `/etc/systemd/system/tbg-bot.service`, `systemctl daemon-reload`, then `systemctl enable --now tbg-bot`. Logs: `docker compose logs -f bot`; restart: `systemctl restart tbg-bot`; rollback: deploy the previous Git revision then `systemctl restart tbg-bot`.

Back up with `deploy/backup-postgres.sh` using a root-owned cron/systemd timer, retain at least 14 days, encrypt and copy backups off-droplet. Test restore on an isolated database with `pg_restore -U tbg -d tbg --clean backup.dump`; do not restore over production without a confirmed maintenance window. Firewall policy: expose no database port and no public health port. The provided CI runs schema validation, lint, types, tests, and build; deploy only from a protected `main` branch after a manual secret-configured SSH/CD step.

## Runbook

If Discord is disconnected, check `docker compose logs bot`, token/intents, bot permissions, and `GET /readyz`. If the database is unavailable, confirm `docker compose ps`, disk space, and backup age; the bot should report unready rather than grant XP. Moderators should cancel stuck games and refund escrow only after checking ledger/game IDs. Freeze suspicious accounts with a reason and expiry, preserve audit records, and never edit balances directly in SQL.

## Current command surface

Slash equivalents are registered for ping, progression/leaderboards, blackjack, slots, d100, daily, crash, novelty commands, raffle, quests, bounty, tic-tac-toe, duel, rob, donate, coinflip, give, prestige, and admin export/freeze. Prefix aliases are intentionally not enabled by default; enabling them requires a separately reviewed parser, since Message Content access and anti-spam controls are needed.
