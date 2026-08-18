# TBGBot virtual-XP bot

TBGBot is a prefix-command Discord bot for virtual, non-redeemable XP. It has no payments, cash-out, crypto, or real-world value exchange.

One TBGBot application, one running bot process, and one PostgreSQL database can serve any number of Discord servers. Every guild has an isolated economy and configuration: members, XP, levels, prestige, leaderboards, cooldowns, games and escrow, ledger history, raffles, quests, bounties, voice stats, prefixes, allowed channels, feature toggles, and bot roles never cross guild boundaries.

## Quick start

1. Use Node 22 and PostgreSQL 17. Copy `.env.example` to a private `.env` and supply the required values.
2. Run `npm ci`, `npm run db:migrate`, `npm run build`, and `npm test`.
3. Run `npm start`, or use Docker Compose with `docker compose up -d --build`.

The health endpoint binds to loopback only: `curl http://127.0.0.1:3000/healthz`. `/readyz` also checks PostgreSQL and Discord readiness.

## Discord installation

Create one Discord application and bot, set `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`, then invite that bot to each server with the `bot` scope. Recommended permissions are View Channels, Send Messages, Embed Links, Read Message History, and Add Reactions. Add Use External Emojis if desired by the server.

Enable these Gateway Intents in the Discord Developer Portal:

- Guilds
- Guild Members
- Guild Messages
- Message Content (required for prefix commands)
- Guild Message Reactions
- Guild Voice States

TBGBot does not need Discord's Administrator permission. On joining a server, it automatically creates a fresh default `GuildConfig`; startup also initializes any guilds already connected. It never copies another server's user data or mutable settings. Economy and game commands do not run in DMs; DMs receive a generic installation message instead.

## Per-server setup and administration

The default prefix is `!`. A server owner or member with Discord's Administrator permission can always administer TBGBot. A guild may additionally configure its own TBGBot admin role. Moderator actions accept the server owner, Administrator, Moderate Members permission, the configured admin role, or the configured moderator role. Legacy environment role IDs are considered only for the optional legacy/home guild identified by `TBG_GUILD_ID`; they never authorize users in another server.

After inviting the bot, a server administrator should run:

```text
!setup
!settings show
```

Useful configuration commands:

- `!settings prefix ?` changes this server's prefix. Its future commands use `?`, for example `?level` and `?bj 100`.
- `!settings channel add #bot-commands`, `!settings channel remove #bot-commands`, and `!settings channel all` control command channels.
- `!settings xp <messageaward|messageminlength|messagecooldown|maxperhour|dailyaward|reactionaward|voiceperminute> <value>` configures XP with safe bounds.
- `!settings games <minbet|maxbet|duelreward> <value>` configures game limits and duel rewards.
- `!settings feature <blackjack|slots|gamble|coinflip|crash|robbery|message-xp|reaction-xp|voice-xp> <on|off>` toggles a feature for this guild only.
- `!settings adminrole @role` and `!settings modrole @role` set optional portable bot roles; pass `clear` to remove either role.
- `!settings reset <prefix|channels|xp|games|features|roles>` restores one configuration section to safe defaults.

`!settings` and `!settings show` provide a readable summary rather than raw JSON. Changes are versioned and audit logged. `!givexp @user <amount>` remains an admin-only, guild-scoped ledgered XP award. `!admin-settings-export`, `!admin-settings <on|off>`, and `!admin-freeze @user <minutes> <reason>` remain available for existing operations.

## Commands and economy safety

TBGBot intentionally uses prefix commands; it does not register a slash-command UX. Run `!help` (or the current guild prefix) to see the current server's command surface and progression unlocks.

- `!bj <wager>` starts persisted blackjack with Hit, Stand, and first-decision Double Down. `!crash <wager>` starts persisted Crash with a player-only Cash Out button. Both retain escrow, settlement, expiry refund, and recovery behavior.
- `!gamble <wager>`, `!slots <wager>`, and `!coinflip <wager>` use transactional virtual-XP escrow/settlement.
- `!duel @user`, `!rob @user`, and `!tictactoe @user` remain persisted social games.
- `!daily`, `!level [@user]`, `!levels`, `!lb`, `!vclb`, `!longestcall`, `!autoprestige`, `!give @user <amount>`, and `!prestige` retain their progression/economy behavior.

The schema keys members by `(guildId, userId)` and scopes cooldowns, voice sessions, leaderboards, ledgers, games, raffles, quests, bounties, and audit entries by guild. Every game button loads the persisted game and verifies the interaction guild plus the relevant player(s); a button from one guild cannot modify another guild's game or economy.

Economy operations use serializable transactions, idempotency keys, immutable ledger records, non-negative balance checks, escrow, and duplicate-settlement protections. Do not edit balances directly with SQL.

## Environment

`TBG_GUILD_ID` is optional and now means only “legacy/home guild for legacy role compatibility”; it is not an allowlist. Keep secrets in private environment configuration and never commit `.env` files, tokens, passwords, or production connection strings.

## Testing

`npm test` runs unit tests. `npm run test:integration` starts a disposable PostgreSQL 17 container, deploys migrations to that disposable database, runs `tests/integration`, and removes the fixture afterwards. It never needs or targets a production database.

## Operations

`compose.yml` runs PostgreSQL without host exposure and binds bot health checks to `127.0.0.1`. Back up PostgreSQL with `deploy/backup-postgres.sh` using a root-owned timer or cron job, retain encrypted off-host backups, and test restoration on an isolated database. Never use `docker compose down -v` in production.

For the established Docker Compose deployment at `/root/vamp-giveaway-bot`, after code has been reviewed, committed, and pushed:

```sh
cd /root/vamp-giveaway-bot
git pull --ff-only origin main
docker compose build bot
docker compose run --rm --no-deps --entrypoint npx bot prisma migrate deploy
docker compose up -d --no-deps --force-recreate bot
docker compose ps
curl -s http://127.0.0.1:3000/readyz
echo
docker compose logs --tail=100 bot
```

Skip the `prisma migrate deploy` line only when no unapplied migration exists. Do not run `docker compose config`, since it may expand sensitive environment variables.
