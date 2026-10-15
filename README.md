# Zombies Den online server

One small program that gives the game **Quick Play**, **Browse online games**, and **join with a code**.
It keeps the public game list and passes game traffic between players, so nobody has to open router ports.
It needs no installs: only Node.js (version 18 or newer), which the hosting site provides.

## Put it online (Render.com, free plan)
1. Make a free account at github.com and create a new **public** repository (any name).
2. In the repository, tap **Add file > Upload files** and upload everything in this `server` folder
   (`relay.js`, `package.json`, `render.yaml`). Commit.
3. Make a free account at render.com. **New > Blueprint** (or **New > Web Service**), connect your GitHub,
   pick the repository. If you chose Web Service: Runtime **Node**, Build command `npm install`, Start command `npm start`, plan **Free**.
4. When it says **Live**, open the address Render shows (like `https://zombies-den-xxxx.onrender.com`).
   You should see "Zombies Den server OK".
5. Send that address to Claude (or paste it into `DEFAULT_SERVER` near the top of `scripts/net/net.gd`) and rebuild the game.

Notes:
- The free plan goes to sleep after ~15 minutes with nobody online. The first player after that waits up to a minute while it wakes up
  (the game keeps trying for 65 seconds). A paid plan (about $7/month) stays awake.
- One server handles hundreds of players: each game uses very little.
- Check it works any time: `/stats` on your address shows rooms and players online.

## What it does and does not do
- The public list only shows games that are not full and not started. Hosts can switch a game to code-only.
- Game packets are forwarded untouched, host to players only. The server never looks inside them.
- Limits: 3 games per internet address, 400 games total, flood protection per connection.
- It stores nothing: no accounts, no chat, nothing saved. Restarting it just ends the current games.

## Run it on your own computer for testing
`node relay.js` (port 8080, or set `PORT`). Point a test build at it with the environment variable
`ZDEN_SERVER=http://127.0.0.1:8080`.

## Player accounts (optional)
Set `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_KEY` in Render > Environment and every
player must be signed in; the server then uses the username from their account (see `supabase.sql`
and the game's `docs/ACCOUNTS.md`). Unset, names come from the game as before.
`GET /accounts` tells you which mode is on.
