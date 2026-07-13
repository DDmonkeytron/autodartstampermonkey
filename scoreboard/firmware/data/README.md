# Starter GIF pack (LittleFS `data/`)

Files placed in this `data/` folder are baked into the LittleFS image and flashed to the
ESP32, so the scoreboard has GIFs available on **first boot** — no uploading required.

## How to use

1. Drop your GIFs in here under a `gifs/` subfolder, matching the names the default config expects:

   ```
   data/gifs/laugh.gif
   data/gifs/fire.gif
   data/gifs/cry.gif
   data/gifs/trophy.gif
   data/gifs/target.gif
   ```

2. In PlatformIO run **"Upload Filesystem Image"** (Project Tasks → Platform → *Upload Filesystem Image*).
   This writes everything in `data/` to the ESP32's LittleFS, separately from the firmware upload.

## Notes

- Keep GIFs **≤ 64×64** px (they're centred on the panel); smaller = less flash, faster decode.
- After first flash you can add/replace GIFs live via the web UI or Tampermonkey — no reflash.
- Uploading a new filesystem image **overwrites** LittleFS, including `config.json`. Back up your
  config first (web UI → **Download**) if you've customised it.
- These are **your** assets — this repo ships the mechanism, not the GIF files.
