# Darts Scoreboard — remote-access relay (Cloudflare)

Lets you reach a board's web UI from anywhere. Each ESP32 **dials out** to this
Worker over a secure WebSocket (so it works behind home NAT with no port
forwarding). You log into a dashboard (protected by **Cloudflare Access**) and it
**proxies that board's own web UI** back through the tunnel — so layouts, GIF
uploads and config all work remotely with the *same* UI as on the LAN.

```
 ESP32 (any house) ──wss──► this Worker + Durable Object ◄──Access login── you
        holds tunnel open      (1 DO per board)              dashboard → open a board
```

## What's here
- `src/board.ts` — `BoardDO` Durable Object: one per board, holds its WebSocket, relays requests.
- `src/index.ts` — Worker: `/connect` (board dials in, token-auth), `/api/boards`, `/board/:id/*` (proxy), and the dashboard.

## Deploy (one-time)

```bash
cd scoreboard/cloud
npm install
npx wrangler login                     # opens browser, log into your Cloudflare account
```

**1. Set the board tokens** (this is how boards authenticate). Pick a long random
token per board — these get flashed into each board later:

```bash
npx wrangler secret put BOARD_TOKENS
# paste, e.g:  {"garage":"P8s2...long-random...","daves":"9fKq...long-random..."}
```

**2. Deploy:**

```bash
npx wrangler deploy
```

Note the deployed URL, e.g. `https://darts-scoreboard-relay.<you>.workers.dev`.

## Lock the dashboard with Cloudflare Access (important)

Only `/connect` should be public (boards authenticate with their token); the
dashboard and `/board/*` must be behind login.

1. Cloudflare dashboard → **Zero Trust → Access → Applications → Add application → Self-hosted**.
2. **Application domain:** your Worker hostname (`darts-scoreboard-relay.<you>.workers.dev`).
3. Add a **path exclusion / bypass for `/connect`** (create a second app on path
   `/connect` with a **Bypass** policy, *Everyone*) so boards can still dial in.
4. On the main app, add an **Allow** policy limited to **your email** (and your
   friend's, if they should see it) — Access sends a one-time code to log in.

That's it: visiting the Worker URL now prompts for email login; `/connect` stays open for boards.

## Provision a board

Each board needs its **id** + **token** (matching a `BOARD_TOKENS` entry) and the
relay host. These are set on the board's **System → Cloud** page (added by the
firmware WebSocket-client update) — no reflash to change them. Toggle **cloud on**,
and the board appears 🟢 in the dashboard.

## Notes / limits
- Config, layouts, GIF list, test events, and **GIF uploads** proxy fine (small payloads).
- **OTA firmware push** over the tunnel is a follow-up (a ~1 MB image exceeds the
  1 MB WebSocket-message limit and needs chunking). Local OTA still works.
- Durable Object **WebSocket hibernation** keeps idle boards essentially free.
