# Discord Bot

## Deploy on Railway (recommended)

You don't need a `.env` file or any local setup. Just:

1. Push this folder to a GitHub repo (or use Railway's "Deploy from local" option).
2. Create a new Railway service from that repo.
3. In **Variables**, set at minimum:
   - `DISCORD_TOKEN` — your bot token from the Discord developer portal
   - `CLIENT_ID` — the application ID of the bot
4. Optional variables (see "Environment variables" below) for Postgres, Roblox, etc.
5. Railway auto-detects Node and runs `npm start`. The bot logs in on first deploy.

That's it. The bot reads `process.env.DISCORD_TOKEN` directly — no prompt, no interactive setup.

### Run locally (only if you want to)

If you'd rather run it on your own machine instead:

```
npm install
DISCORD_TOKEN=... CLIENT_ID=... npm start
```

Or copy `.env.example` to `.env`, fill it in, then `npm start` (you'll need a tool like `dotenv-cli` if you want auto-loading — Railway handles this for you automatically).

## Hardcoded permission roster

Whitelist manager, temp owners, and whitelist are all locked to a single user:

- `1472482602215538779`

Anything in `wlmanagers.json`, `tempowners.json`, `whitelist.json`, the `WHITELIST_MANAGERS` env var, or `WHITELISTED_USER_IDS` is ignored. Only that one user has full access.

## Antinuke

Off by default per server. Turn it on:

```
.antinuke enable
.antinuke logs #mod-log
.antinuke status
```

`.antinuke` (no args) shows the full subcommand list.

## Environment variables

| Name                  | Required | Purpose                                          |
|-----------------------|----------|--------------------------------------------------|
| `DISCORD_TOKEN`       | yes      | Bot login token                                  |
| `CLIENT_ID`           | yes      | Application ID (used for slash command routes)   |
| `GUILD_ID`            | no       | Scope slash registration to one guild for testing|
| `STARTUP_CHANNEL_ID`  | no       | Channel ID to post a startup notice in           |
| `DATABASE_URL`        | no       | Postgres connection string (mirrors JSON storage)|
| `ROBLOX_COOKIE`       | no       | `.ROBLOSECURITY` value for group integration     |
| `ROBLOX_GROUP_ID`     | no       | Roblox group ID                                  |
| `WHITELIST_MANAGERS`  | no       | Legacy — ignored by the hardcoded roster         |
| `WHITELISTED_USER_IDS`| no       | Legacy — ignored by the hardcoded roster         |
| `ATTEND`              | no       | Attendance webhook flag                          |
| `ATTEND_PORT`         | no       | Attendance webhook port                          |
| `ATTEND_SECRET`       | no       | Attendance webhook secret                        |

On Railway, set these in the service's **Variables** tab. The bot picks them up automatically — no `.env` file required.

## Embed logo

Default embed image is set in `config.json` → `logoUrl`. Edit and redeploy, or use `.id logo <url>` from Discord at runtime.

## Persistent state

The bot writes JSON files next to itself (rollcalls, antinuke config, tickets, warnings, verified accounts, etc.) on first run.

> ⚠️ Railway's filesystem is **ephemeral** — any JSON files written at runtime will be wiped on every redeploy. If you need this state to survive deploys, attach a **Railway Volume** (mount it at the project root) or set `DATABASE_URL` so the bot mirrors writes to Postgres.
