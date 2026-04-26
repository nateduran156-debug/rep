# Discord Ticket Bot

A Discord ticket / verification / Roblox group management bot.

## Run locally

```bash
cd bot
npm install
cp .env.example .env   # then fill in DISCORD_TOKEN
npm start
```

## Deploy to Railway

1. Push this repository to GitHub.
2. Open [railway.app](https://railway.app/) → **New Project** → **Deploy from GitHub repo** → pick your repo.
3. In the project, click **Settings** and set the **Root Directory** to `bot` (since the bot lives in this subfolder).
4. Add environment variables under the **Variables** tab — at minimum:
   - `DISCORD_TOKEN` — your bot token
   - `WHITELIST_MANAGERS` — comma-separated Discord user IDs that can run admin commands (optional)
   - any other variables from `.env.example` you need
5. (Optional but recommended) Add a **Postgres** service to the project — Railway automatically injects `DATABASE_URL` and the bot will use it for storage with JSON files as a fallback.
6. Deploy. Railway will run `npm install` then `node bot.js` on every push.

The included `railway.json` and `nixpacks.toml` pin the build to Node 20 and the start command to `node bot.js`.

## Environment variables

See `.env.example` for the full list and descriptions.

## Storage

The bot writes runtime state to JSON files (`tickets.json`, `verify config.json`, `whitelist.json`, etc.) and mirrors them to Postgres if `DATABASE_URL` is set.

> Railway's filesystem is **ephemeral** — files are wiped on every redeploy. Always set `DATABASE_URL` (attach a Postgres plugin) when running on Railway, otherwise you will lose all ticket / verify / whitelist data on each deploy.
