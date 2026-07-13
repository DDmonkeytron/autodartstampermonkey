# Bring-up checklist

Step-by-step from bare boards to a working, game-driven scoreboard. Do the phases in order.

## Phase 0 — wiring sanity (before any power)

- [ ] All LED **power** comes from the PSU, **not** the ESP32 (only DIN/data + a GND go to the ESP32).
- [ ] **Common ground**: PSU GND, panel GND, both strip GNDs, and the ESP32 GND all tied together (via the GND WAGO).
- [ ] **Polarity**: with a multimeter, confirm the barrel→screw connector reads **+5 V** on the red/`+` terminal (not −5 V).
- [ ] Voltage is **5 V** everywhere (never 12 V).
- [ ] Nothing landed on the adapter's reserved pins (IO26–37) or its `5V` terminal for LED power.
- [ ] HUB75 ribbon: pin-1 (stripe) confirmed against the panel silkscreen.

## Phase 1 — power + flash

1. [ ] Power the ESP32 over **USB-C** (UART port) and PlatformIO → **Build** → **Upload**.
2. [ ] *(optional)* Put GIFs in `firmware/data/gifs/` → PlatformIO **Upload Filesystem Image**.
3. [ ] Power the PSU. Panel should show **`WiFi setup..`** on first boot.
4. [ ] On a phone, join the **`DartsScoreboard-Setup`** WiFi, enter your home WiFi, save.
5. [ ] Panel shows the default scoreboard. Note the IP (serial/`/log`) — try **http://darts.local/**.

## Phase 2 — panel + strips + web UI

6. [ ] Open the **web UI** (`http://darts.local/`). Status + log should update.
7. [ ] **Upload a GIF**, then **Push config** (or edit + Save), then hit a **test event** button.
8. [ ] Confirm: GIF plays centred, event text scrolls, **both strips react**.

Fix-ups if needed:
- Panel blank/garbled → uncomment a `mx.driver = FM6126A/FM6124` line and reflash.
- GIF colours wrong → flip `GIF_PALETTE_RGB565_BE` ↔ `_LE`.
- Strip colours wrong (red/green swapped) → change `GRB` in the `addLeds` lines.
- A strip dead → wrong data GPIO or DIN on the wrong (output) end of the strip.

## Phase 3 — userscript + detection

9. [ ] Install `autodarts-scoreboard.user.js`. HUD pill should show **🟢** (or **Set IP** / **Scan**).
10. [ ] `Scoreboard.event('180')` from the console → celebration fires.
11. [ ] Keep **`DEBUG = true`**, play/observe a real game. Watch the browser console + web-UI `/log`.
12. [ ] Use menu **"Dump match state (copy)"** and confirm the field paths in `readMatch()` / `classifyDart()`.
13. [ ] Once events fire correctly on real throws, set **`DEBUG = false`**.

## Phase 4 — dial it in

- [ ] `maxMilliamps` — set to your PSU headroom so full-white can't brown out.
- [ ] `brightness` / `stripBrightness` — comfortable levels (push config, no reflash).
- [ ] `showThrows` / `showCheckout` / `showAvg` / `showLegs` — pick the layout you like.
- [ ] `idleMs` + `tzOffset` — idle clock behaviour.
- [ ] Map events → GIFs/effects/colours to taste; **Download** the config as a backup.

## Quick troubleshooting

| Symptom | Likely cause |
|---|---|
| Panel blank | `driver` mismatch; power connector; ribbon pin-1 wrong |
| Panel garbled / wrong colours | `driver`; a swapped HUB75 data wire |
| Nothing on strips | wrong data GPIO; DIN on output end; no common ground |
| Strip colours swapped | `GRB` order in `addLeds` |
| GIF wrong colours | `GIF_PALETTE` BE/LE |
| Far end of strip dim/red | voltage drop — inject power at that end |
| HUD 🔴 | wrong IP; not same LAN; `darts.local` not resolving (set IP) |
| Events never fire | schema paths — tune via DEBUG + "Dump match state" |
| Brown-out / resets on celebration | lower `maxMilliamps`/brightness; check PSU + wire gauge |
