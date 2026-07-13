# Autodarts LED Scoreboard

A physical LED scoreboard + ambient light reactions for play.autodarts.io, driven
from the browser userscript over your LAN.

```
autodarts.io page ─► CORE theme script ─(DOM CustomEvent)─► Scoreboard bridge script
                                                               │ GM_xmlhttpRequest (POST)
                                                               ▼
                                                   ESP32-S3  ── HUB75 64x64 panel (scoreboard)
                                                             └─ 2x WS2812 strips (reactions)
```

## Hardware

| Part | Notes |
|------|-------|
| ESP32-S3-DevKitC-1 **N16R8** (8 MB PSRAM) | seated in the diymore MRD076A screw-terminal adapter |
| 64x64 **P3** HUB75 panel | 1/32 scan, 5 V |
| 2x WS2812B strips | data on IO17 / IO21 |
| COOLM 5 V 15 A PSU | powers panel + strips via WAGO 221 (5-way rails) |

**Power rule:** the ESP32 carries **data only**. All LED power comes from the PSU.
All grounds common. Never use the adapter's `5V` terminal for LED power.

## HUB75 → ESP32-S3 pin map (top row of the adapter)

| HUB75 | GPIO | HUB75 | GPIO |
|---|---|---|---|
| R1 | 4  | A   | 18 |
| G1 | 5  | B   | 8  |
| B1 | 6  | C   | 9  |
| R2 | 7  | D   | 10 |
| G2 | 15 | E   | 11 |
| B2 | 16 | CLK | 12 |
|    |    | LAT | 13 |
|    |    | OE  | 14 |

HUB75 GND wires → GND rail. Strip 1 data → **IO17**, Strip 2 data → **IO21**.
Avoid IO26–37 (octal-PSRAM reserved on N16R8).

## Firmware (`firmware/`)

Custom PlatformIO sketch — HUB75-DMA (GFX scoreboard) + **AnimatedGIF** (bitbank2, animated
sprites) + **LittleFS** (GIF library + config) + FastLED (LED effect engine) + WiFiManager + WebServer.

The sprite library is **a folder of GIFs on the ESP32's flash** (`/gifs/`). You upload GIFs from
Tampermonkey (no reflash), and map each event → GIF + LED effect + text + colour in the config,
which is also pushed from Tampermonkey and persisted on the ESP32.

1. Open `firmware/` in VS Code with the **PlatformIO** extension.
2. **Build**, then **Upload** over the ESP32-S3 UART USB-C port.
3. First boot: connect to the **`DartsScoreboard-Setup`** WiFi hotspot, enter your
   home WiFi. Credentials are saved; it reconnects automatically after that.
4. It advertises `http://darts.local` and its IP appears on the serial monitor.

Set your real `STRIP1_NUM` / `STRIP2_NUM` LED counts at the top of `src/main.cpp`.
If the panel is blank/garbled, uncomment a `cfg.driver = ...` line to match the panel chip.

### HTTP API

| Method | Path | Body | Effect |
|---|---|---|---|
| GET  | `/`        | – | **web config UI** (edit config, upload GIFs, test events, OTA, status) |
| GET  | `/ping`    | – | identifies the device (used by the scan feature) |
| GET  | `/status`  | – | heap / RSSI / IP / current GIF / uptime / queue depth |
| GET  | `/config`  | – | returns current config (layout + event map) |
| POST | `/config`  | full config JSON | replace layout + event map, persist, re-render, apply live |
| GET  | `/sprites` | – | list uploaded GIFs |
| POST | `/sprite`  | multipart `file=<gif>` | upload a GIF into `/gifs/` |
| POST | `/delete`  | `?name=x.gif` | delete a GIF |
| POST | `/update`  | multipart `<firmware.bin>` | **OTA firmware update**, then reboots |
| POST | `/score`   | `{ "activePlayer":0, "players":[{"name","score","legs","avg"}], "throws":[60,20,57] }` | update the scoreboard (`throws` = active player's darts this turn) |
| POST | `/event`   | `{ "event":"180" }` | looks up the map → GIF + scrolling text + LED effect (queued if one is playing) |

### Web UI — the config panel

Browse to **`http://darts.local/`** (or the IP) from any device. It's a full **form-based config
panel** — no JSON editing needed:

- **Scoreboard panel** — players, what's shown (throws/checkout/avg/legs), brightness, rotation,
  idle wallpaper, and **per-player score colours** (colour pickers).
- **Celebrations** — one card per event: on/off, **min threshold** (e.g. only T15+), text, duration,
  **GIF picker** (thumbnails from the device), 2D effect, and **per-strip LED controls** — strip 1's
  effect/palette/colour, and strip 2 set to **mirror** (slave/replicate), **custom** (own
  effect/palette/colour), or **off**. Plus ▶ test-fire and ✕ delete per event, and "+ add event".
- **Sprites** — upload/delete GIFs with live thumbnails.
- **Test / OTA / WiFi reset / Status / Log** — as before.
- **Advanced** — the raw JSON textarea is still there for power edits and backup download.

Every change is applied by **Save & apply** — live, no reflash.

### Extra features

- **Scrolling event text** — the event `text` scrolls along the bottom while the GIF plays.
- **Checkout suggestions** — `showCheckout`: the active player ≤170 shows a route (e.g. `T20 T20 D25`).
- **Idle clock** — after `idleMs` of no activity it shows an NTP clock (`tzOffset` sets the zone).
- **Current cap** — `maxMilliamps` limits strip draw so a full-white celebration can't brown out the PSU.
- **2–4 players** — `players`; 3–4 use a compact per-row layout.
- **Event queue** — rapid events chain (treble → 180) instead of clobbering each other.
- **Live tuning** — `brightness` / `stripBrightness` / `rotation` apply on config push (no reflash;
  `panelDriver` needs a reboot).
- **Per-player colours** — optional `layout.playerColors: [[r,g,b], …]` tints each player's score.
- **Session stats** — 180 count + highest turn per player, shown on the idle screen and in `/status`; reset via the web UI.

### Debugging & ease

- **On-device log** — a rolling log (`GET /log`, shown live in the web UI) of events/text/errors, so
  you debug over WiFi with no serial cable. Every received event is logged.
- **GIF previews** — the web UI shows each sprite as a thumbnail (GIFs are served at `/gifs/<name>`).
- **Config backup** — **Download** in the web UI saves `config.json`; the textarea + **Save** restores it.
- **On-page HUD** — the userscript shows a 🟢/🔴 pill on autodarts.io with connection status + last event.
- **Dump match state** — userscript menu **"Dump match state (copy)"** copies the last raw autodarts
  WebSocket JSON to the clipboard — the fast way to confirm/tune the schema.
- **Arbitrary text** — `POST /text {text,ms,effect,color}` (or the web UI box) scrolls any message.
- **Reset WiFi** — web UI button / `POST /wifi/reset` clears credentials and re-opens the setup portal.
- **Starter GIF pack** — drop GIFs in `firmware/data/gifs/` and run PlatformIO **Upload Filesystem
  Image** so the board has sprites on first boot (see `firmware/data/README.md`).

### Zero-config target

The userscript defaults its target to **`darts.local`** (mDNS), so on many networks it connects with
no IP setup at all. Set a fixed IP via the menu if mDNS isn't reliable on your OS.

### Event map (config)

Each event maps to a backdrop (**GIF** or **2D effect**) + **per-strip LED effects** + palette/colour/text.

```json
"events": {
  "180":     { "gif":"/gifs/laugh.gif", "text":"180!", "effect":"flash", "palette":"party", "color":[255,0,0], "ms":5000 },
  "treble":  { "min":15, "text":"TREBLE", "effect":"sparkle", "ms":2000 },
  "gameWon": { "gif":"", "panelFx":"plasma", "text":"GAME SHOT!", "effect":"rainbow", "palette":"party", "ms":6000,
               "fx2": { "effect":"comet", "color":[255,215,0] } }
}
```

Per-event fields:

| Field | Meaning |
|---|---|
| `enabled` | `false` switches the event off without deleting it |
| `min` | **celebration threshold** — only fire when the dart/turn value ≥ min (e.g. `double` min 10 = D10+, `treble` min 15 = T15+; the userscript sends the segment number / turn total as `value`) |
| `effect`/`palette`/`color`/`speed` | **strip 1**'s effect (or both, if no `fx2`) |
| `fx1` | optional explicit strip-1 override object |
| `fx2` | **strip 2**: omit or `"mirror"` = replicate strip 1 exactly (slave); `"off"` = stay dark; or its own `{effect, palette, color, speed}` for an independent look |
| `gif` / `panelFx` / `text` / `ms` | backdrop GIF, 2D effect, scrolling text, duration |

- **Strip effects** (`effect`): `solid · flash · strobe · pulse · rainbow · palette · running · sparkle · twinkle · comet · off`
- **Palettes** (`palette`): `rainbow · party · ocean · forest · lava · fire · cloud`
- **2D panel effects** (`panelFx`, when **no** GIF is set): `plasma · fire · matrix · sparkle`
- A **GIF takes precedence** over `panelFx`. Set `"gif":""` to use a 2D backdrop instead.
- **Idle wallpaper**: `layout.idleFx` (`plasma`/`fire`/`matrix`/`sparkle`) + `layout.idlePalette`.

### Sprites (GIFs)

- Any animated (or static) **GIF** works — emoji, explosions, memes, trophies.
- Keep them **≤ 64×64** (they're centred on the panel); smaller = less flash + faster.
- Upload via Tampermonkey (`Scoreboard.uploadGif(url, 'laugh.gif')`) or the `/sprite` endpoint.
- If colours look wrong, flip `GIF_PALETTE_RGB565_BE` ↔ `_LE` in `gif.begin()`.

## Userscript (`userscript/autodarts-scoreboard.user.js`)

Install as a **separate** Tampermonkey script (it needs `@grant GM_xmlhttpRequest`,
which the `@grant none` CORE script can't have). Then:

- **Set Scoreboard IP** (e.g. `192.168.1.60` or `darts.local`), or **Scan for scoreboard**.
- **Push default config** — sends the event map to the ESP32 (edit `DEFAULT_CONFIG` in the script).
- **List uploaded GIFs** / **Test event (180)** to check the link.

Upload GIFs from the console, e.g.:

```js
Scoreboard.uploadGif('https://example.com/laugh.gif', 'laugh.gif');
Scoreboard.pushConfig();          // push the event map
Scoreboard.event('180');          // fire a test celebration
```

The event map lives in `DEFAULT_CONFIG` at the top of the userscript — edit the GIF names,
effects, colours and durations there, then **Push config**. The GIF filenames must match ones
you've uploaded to `/gifs/`.

**Layout options** (`DEFAULT_CONFIG.layout`):

| Key | Effect |
|---|---|
| `showAvg` / `showLegs` | show the 3-dart average / leg count on each player line |
| `showThrows` | when `true`, the **active** player shows this turn's individual darts (e.g. `60 20 57`) instead of legs/avg — the "P1 score + throw 1,2,3 / P2 score" layout |

### Automatic throw detection

The script hooks the page's WebSocket (`@run-at document-start`) and reads autodarts' live
match state, deriving events automatically:

| Event | Trigger |
|---|---|
| `double` / `treble` / `bull` | per dart |
| `26` | turn total = 26 |
| `100` / `140` / `180` | turn total ≥ 100 / ≥ 140 / = 180 |
| `bust` | busted turn |
| `legWon` | a player's leg count increases |
| `gameWon` | match winner set |

It also pushes live scoreboard state (names / scores / legs / average / active player).

**Tuning (first run):** autodarts' WebSocket schema can drift, so `DEBUG = true` (top of the
script) logs the raw match state to the browser console. Open the console during a game,
confirm the field names, and adjust the paths in `readMatch()` / `classifyDart()` if needed.
Set `DEBUG = false` once it's firing correctly.

> The DOM-event bridge from the CORE script still works as an alternative/override — but with
> WebSocket detection running, the scoreboard is fully self-contained and needs no CORE changes.

### Driving it from the CORE theme script

The CORE script drives the scoreboard by dispatching DOM CustomEvents (these cross the
sandbox boundary because the DOM is shared). Add at your existing score/celebration hooks:

```js
// when a score is thrown / turn changes:
document.dispatchEvent(new CustomEvent('ad-scoreboard-score', { detail: {
  activePlayer: 0,
  players: [
    { name: 'JASON', score: 301, legs: 1, avg: 62.5 },
    { name: 'OPP',   score: 420, legs: 0, avg: 55.1 },
  ],
}}));

// at your 57/60/95/100/140/180 celebration triggers:
document.dispatchEvent(new CustomEvent('ad-scoreboard-event', {
  detail: { event: '180', text: 'ONE HUNDRED AND EIGHTY' }
}));
```

No return value / no coupling — if the scoreboard script isn't installed, the events
are simply ignored.
