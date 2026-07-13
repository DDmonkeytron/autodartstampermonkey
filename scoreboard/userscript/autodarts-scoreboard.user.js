// ==UserScript==
// @name         Autodarts LED Scoreboard Bridge (ESP32)
// @namespace    autodarts.scoreboard.ddmonkeytron
// @version      0.6.5
// @downloadURL  https://raw.githubusercontent.com/DDmonkeytron/autodartstampermonkey/main/scoreboard/userscript/autodarts-scoreboard.user.js
// @updateURL    https://raw.githubusercontent.com/DDmonkeytron/autodartstampermonkey/main/scoreboard/userscript/autodarts-scoreboard.user.js
// @description  Controls an ESP32 LED scoreboard (HUB75 + WS2812) from play.autodarts.io: live scores, GIF+light celebrations, layout config, GIF uploads, and automatic throw detection (double/treble/ton/140/180/26/bust/legWon/gameWon).
// @match        https://play.autodarts.io/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      *
// ==/UserScript==

(() => {
  "use strict";
  const KEY_IP = "scoreboard_ip";
  let ESP_IP = GM_getValue(KEY_IP, "darts.local");   // mDNS default — works out of the box on many networks
  let lastRaw = "", lastEv = "-", online = false, hud = null, hudOn = GM_getValue("scoreboard_hud", true);
  const log = (...a) => console.log("[scoreboard]", ...a);

  // Turn on to log the raw autodarts match state to the console so you can
  // confirm / tune the field paths in readMatch(). Set false once it works.
  const DEBUG = false;   // schema confirmed live 2026-07-13 (see readMatch paths); flip true to re-tune
  const GAME_SHOT_CALL = true;   // announce "GAME SHOT COMING – <double> TO WIN" when a player steps up on a 1-dart finish

  // ---------- default event map (edit, then "Push config") ----------
  // NOTE: the friendlier way to edit all of this is the ESP32's web UI (http://darts.local/) —
  // it has form controls for everything below and saves straight to the device.
  // effect (strips): solid|flash|strobe|pulse|rainbow|palette|running|sparkle|twinkle|comet|off
  // palette: rainbow|party|ocean|forest|lava|fire|cloud
  // panelFx (2D, used when no gif): plasma|fire|matrix|sparkle
  // Per event you can also set:
  //   enabled: false        → event off without deleting it
  //   min: 15               → only celebrate when the dart/turn value ≥ 15 (e.g. T15+, D10+)
  //   fx1: {...}            → explicit strip-1 override (otherwise flat effect/palette/color = strip 1)
  //   fx2: "mirror"|"off"|{effect,palette,color,speed} → strip 2 replicates strip 1, stays dark, or runs its own look
  const DEFAULT_CONFIG = {
    layout: {
      players: 2, showAvg: true, showLegs: true,
      showThrows: false,      // active player shows this turn's 3 darts
      showCheckout: true,     // active player ≤170 shows a suggested checkout route
      brightness: 120, stripBrightness: 90, rotation: 0,
      maxMilliamps: 8000,     // strip current cap (protects the 5V PSU)
      idleMs: 90000,          // idle screen after this much inactivity (0 = never)
      idleFx: "",             // "" = clock; or plasma|fire|matrix|sparkle 2D wallpaper
      idlePalette: "ocean",
      tzOffset: 0,            // seconds from UTC for the idle clock (e.g. BST = 3600)
      panelDriver: "SHIFTREG", // or "FM6126A" / "FM6124" (needs a reboot to change)
      // playerColors: [[0,200,255],[255,120,0]],  // optional per-player score colour
    },
    events: {
      "180":     { gif: "/gifs/laugh.gif",  text: "180!",       effect: "flash",   palette: "party", color: [255, 0, 0],   ms: 5000 },
      "140":     { gif: "/gifs/fire.gif",   text: "140",        effect: "comet",   palette: "lava",  color: [255, 120, 0], ms: 4000 },
      "100":     { gif: "/gifs/fire.gif",   text: "TON",        effect: "pulse",   palette: "lava",  color: [255, 200, 0], ms: 3500 },
      "26":      { gif: "/gifs/laugh.gif",  text: "26",         effect: "rainbow", palette: "rainbow", color: [0, 0, 0],   ms: 4000 },
      "double":  { min: 10, gif: "/gifs/target.gif", text: "DOUBLE",  effect: "sparkle", palette: "ocean", color: [0, 200, 255], ms: 2000 },
      "treble":  { min: 15, gif: "/gifs/target.gif", text: "TREBLE",  effect: "sparkle", palette: "forest", color: [0, 255, 120], ms: 2000 },
      "bull":    { gif: "/gifs/target.gif", text: "BULL",       effect: "sparkle", palette: "party", color: [255, 60, 60], ms: 2000 },
      "bust":    { gif: "/gifs/cry.gif",    text: "BUST",       effect: "twinkle", palette: "ocean", color: [80, 80, 255], ms: 3000 },
      "legWon":  { gif: "/gifs/trophy.gif", text: "LEG WON",    effect: "running", palette: "party", color: [255, 215, 0], ms: 4000 },
      // gameWon: 2D plasma backdrop; strip 1 rainbows while strip 2 runs its own gold comet:
      "gameWon": { gif: "", panelFx: "plasma", text: "GAME SHOT!", effect: "rainbow", palette: "party", color: [255, 215, 0], ms: 6000,
                   fx2: { effect: "comet", palette: "party", color: [255, 215, 0] } },
    },
  };

  // =================== NETWORKING ===================
  function req(o) {
    return new Promise((res, rej) => {
      if (!ESP_IP) return rej("no IP set");
      GM_xmlhttpRequest({
        url: `http://${ESP_IP}${o.path}`, method: o.method || "GET",
        headers: o.headers, data: o.data, timeout: o.timeout || 3000,
        onload: res, onerror: rej, ontimeout: () => rej("timeout"),
      });
    });
  }
  const postJSON = (path, obj) =>
    req({ path, method: "POST", headers: { "Content-Type": "application/json" }, data: JSON.stringify(obj) })
      .catch((e) => log("POST", path, "failed:", e));

  const postScore  = (state)       => postJSON("/score", state);
  // value = dart number (D16 → 16, T18 → 18) or turn total — the ESP32 checks it
  // against the event's "min" threshold (e.g. treble min 15 = only T15+ celebrates)
  const postEvent  = (event, text, value) => { lastEv = event + (value ? ` (${value})` : ""); updateHud(); log("event →", event, value ?? ""); return postJSON("/event", { event, text, value }); };
  const postText   = (text, opts)  => { lastEv = "call"; updateHud(); log("text →", text); return postJSON("/text", Object.assign({ text }, opts || {})); };
  const pushConfig = (cfg)         => postJSON("/config", cfg).then(() => log("config pushed"));

  async function uploadGifFromUrl(url, filename) {
    const blob = await fetch(url).then((r) => r.blob());
    const form = new FormData();
    form.append("file", blob, filename);
    return req({ path: "/sprite", method: "POST", data: form, timeout: 15000 }).then(() => log("uploaded", filename));
  }
  const listSprites = () => req({ path: "/sprites" }).then((r) => (log("sprites:", r.responseText), r.responseText));

  // =================== DISCOVERY ===================
  const ping = (ip) => new Promise((res) => GM_xmlhttpRequest({
    method: "GET", url: `http://${ip}/ping`, timeout: 400,
    onload: (r) => res(r.responseText.includes("darts-scoreboard") ? ip : null),
    onerror: () => res(null), ontimeout: () => res(null),
  }));
  async function scan() {
    const bases = ["192.168.1", "192.168.0", "10.0.0", "192.168.68"];
    log("scanning…");
    for (const base of bases)
      for (let s = 1; s <= 254; s += 20) {
        const found = (await Promise.all(
          Array.from({ length: Math.min(20, 255 - s) }, (_, k) => ping(`${base}.${s + k}`))
        )).find(Boolean);
        if (found) { ESP_IP = found; GM_setValue(KEY_IP, found); alert(`Scoreboard found: ${found}`); return found; }
      }
    alert("No scoreboard found — set the IP manually.");
  }

  // =================== MENU ===================
  GM_registerMenuCommand("Set Scoreboard IP", () => {
    const v = prompt("ESP32 IP or host:", ESP_IP);
    if (v != null) { ESP_IP = v.trim(); GM_setValue(KEY_IP, ESP_IP); }
  });
  GM_registerMenuCommand("Scan for scoreboard", scan);
  GM_registerMenuCommand("Push default config", () => pushConfig(DEFAULT_CONFIG));
  GM_registerMenuCommand("List uploaded GIFs", listSprites);
  GM_registerMenuCommand("Test event (180)", () => postEvent("180", "ONE HUNDRED AND EIGHTY"));

  // =================== DETECTION (autodarts WebSocket) ===================
  // We wrap the page's WebSocket at document-start and inspect messages for a
  // match-state object, then derive events. autodarts' exact schema can drift,
  // so keep DEBUG on for the first run and confirm the paths in readMatch().

  function hookWebSocket() {
    const scope = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;
    const Orig = scope.WebSocket;
    if (!Orig || Orig.__ad_hooked) return;
    function Hooked(url, protocols) {
      const ws = protocols !== undefined ? new Orig(url, protocols) : new Orig(url);
      try { ws.addEventListener("message", (e) => { try { onWsMessage(e.data); } catch (_) {} }); } catch (_) {}
      return ws;
    }
    Hooked.prototype = Orig.prototype;
    ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach((k) => (Hooked[k] = Orig[k]));
    Hooked.__ad_hooked = true;
    scope.WebSocket = Hooked;
    log("WebSocket hooked");
  }

  function onWsMessage(data) {
    if (typeof data !== "string") return;              // autodarts streams JSON text
    let obj; try { obj = JSON.parse(data); } catch (_) { return; }
    const m = findMatch(obj);
    if (m) { lastRaw = data; onMatchState(m); }
  }

  // Heuristic: find the object that looks like an X01 match state.
  function findMatch(o) {
    const looksMatch = (x) => x && typeof x === "object" &&
      (Array.isArray(x.players)) && (x.turns || x.turn || x.gameScores || x.scores);
    if (looksMatch(o)) return o;
    if (looksMatch(o.data)) return o.data;
    if (o.data && looksMatch(o.data.data)) return o.data.data;
    return null;
  }

  // ---- extraction (CONFIRM against DEBUG logs, tune paths here) ----
  function dartPoints(t) {
    const seg = t.segment || t;
    const n = seg.number ?? seg.num ?? 0;
    const mult = seg.multiplier ?? t.multiplier ?? 1;
    return t.points ?? seg.points ?? n * mult;
  }
  function classifyDart(t) {
    const seg = t.segment || t;
    const bed = String(seg.bed || seg.name || "").toLowerCase();
    const mult = seg.multiplier ?? t.multiplier;
    const num = seg.number ?? seg.num;
    // returns {ev, val}: val = the segment number, used for "min" thresholds on the ESP32
    if (num === 25 || bed.includes("bull") || bed === "25" || bed === "50") return { ev: "bull", val: (mult === 2 || bed === "50") ? 50 : 25 };
    if (mult === 3 || bed.includes("triple")) return { ev: "treble", val: num || 0 };
    if (mult === 2 || bed.includes("double")) return { ev: "double", val: num || 0 };
    return null;
  }
  function classifyTurn(total) {
    if (total === 180) return "180";
    if (total === 26)  return "26";
    if (total >= 140)  return "140";
    if (total >= 100)  return "100";
    return null;
  }
  // "game shot" anticipation: is this remaining score a ONE-DART finish? → the double/bull to win on.
  function oneDartFinish(n) {
    if (n === 50) return "BULL";
    if (n >= 2 && n <= 40 && n % 2 === 0) return "D" + (n / 2);
    return null;
  }
  function readMatch(m) {
    const players = (m.players || []).map((p, i) => ({
      name: String(p.name || p.playerName || `P${i + 1}`).toUpperCase().slice(0, 10),
      score: (m.gameScores && m.gameScores[i]) ?? p.score ?? 0,
      legs:  m.scores?.[i]?.legs ?? p.legs ?? 0,          // autodarts: legs live in scores[i].legs
      avg:   Math.round((m.stats?.[i]?.matchStats?.average ?? p.average ?? p.avg ?? 0) * 10) / 10,
    }));
    const turns  = m.turns || (m.turn ? [m.turn] : []);
    const cur    = turns.length ? turns[turns.length - 1] : (m.turn || {});
    return {
      players,
      active:  m.player ?? m.turn?.player ?? cur.player ?? 0,
      throws:  cur.throws || [],
      busted:  !!(cur.busted || m.turnBusted || m.turn?.busted),
      winner:  (m.winner ?? m.gameWinner ?? -1) >= 0 ? (m.winner ?? m.gameWinner) : null,  // autodarts uses -1 for "no winner"
    };
  }

  // ---- state machine ----
  let curThrows = [], curActive = -1, lastWinner = null, prevLegs = [], scoreSig = "", bustedThisTurn = false, turnCelebrated = false, shotSig = "";

  function finishTurn(throws) {
    if (!throws.length || bustedThisTurn || turnCelebrated) return;
    const total = throws.reduce((a, t) => a + dartPoints(t), 0);
    const ev = classifyTurn(total);
    if (ev) postEvent(ev, undefined, total);
  }

  function onMatchState(m) {
    if (DEBUG) log("match state", m);
    const s = readMatch(m);
    if (!s.players.length) return;

    // push scoreboard (deduped) — include the active turn's individual dart scores
    const throwPoints = s.throws.map(dartPoints);
    const sig = JSON.stringify([s.active, s.players, throwPoints]);
    if (sig !== scoreSig) {
      scoreSig = sig;
      postScore({ activePlayer: s.active, players: s.players, throws: throwPoints });
    }

    // turn boundary → evaluate the turn that just ended (safety net if the
    // immediate 3rd-dart check below didn't fire, e.g. missed updates)
    if (s.active !== curActive || s.throws.length < curThrows.length) {
      finishTurn(curThrows);
      curThrows = []; curActive = s.active; bustedThisTurn = false; turnCelebrated = false; shotSig = "";
    }

    // "game shot coming": whenever the active player is on a ONE-DART finish with a dart still in
    // hand — start of turn OR mid-turn (gameScores[active] is the LIVE remaining, updates per dart).
    // Re-fires if the finish changes (e.g. missed D20 leaves D10); shotSig resets each turn above.
    if (GAME_SHOT_CALL && !s.busted && s.throws.length < 3) {
      const act = s.players[s.active];
      const rem = act ? act.score : -1;
      const fin = oneDartFinish(rem);
      const sig = s.active + ":" + rem;
      if (fin && sig !== shotSig) { shotSig = sig; postText(`GAME SHOT COMING - ${fin} TO WIN`, { effect: "flash", palette: "party", color: [255, 40, 40], ms: 3200 }); }
    }
    // new darts this update → per-dart events (with segment value for thresholds)
    for (let i = curThrows.length; i < s.throws.length; i++) {
      const d = classifyDart(s.throws[i]);
      if (d) postEvent(d.ev, undefined, d.val);
    }
    curThrows = s.throws.slice();

    // bust (once per turn)
    if (s.busted && !bustedThisTurn) { bustedThisTurn = true; postEvent("bust"); }

    // 3rd dart landed → celebrate the turn total NOW (not when the next player steps up)
    if (curThrows.length === 3 && !bustedThisTurn && !turnCelebrated) {
      const total = curThrows.reduce((a, t) => a + dartPoints(t), 0);
      const ev = classifyTurn(total);
      if (ev) { turnCelebrated = true; postEvent(ev, undefined, total); }
    }

    // leg win (legs counter increased)
    s.players.forEach((p, i) => {
      if (prevLegs[i] != null && p.legs > prevLegs[i]) {
        const legStr = s.players.map((q) => q.legs).join("-");        // e.g. "2-1"
        postEvent("legWon", `${p.name} WINS THE LEG  ${legStr}`, p.legs);
      }
    });
    prevLegs = s.players.map((p) => p.legs);

    // game win
    if (s.winner != null && s.winner !== lastWinner) {
      lastWinner = s.winner;
      const w = s.players[s.winner];
      postEvent("gameWon", w ? `${w.name} WINS THE MATCH` : undefined, s.winner);
    }
  }

  hookWebSocket();   // must run at document-start (before the app opens its socket)

  // =================== BRIDGE (optional, from CORE script) ===================
  document.addEventListener("ad-scoreboard-score", (e) => e.detail && postScore(e.detail));
  document.addEventListener("ad-scoreboard-event", (e) => e.detail && postEvent(e.detail.event, e.detail.text));

  // =================== STATUS HUD + DEBUG ===================
  function updateHud() {
    if (!hudOn) { if (hud) { hud.remove(); hud = null; } return; }
    if (!hud) {
      hud = document.createElement("div");
      hud.style.cssText = "position:fixed;bottom:8px;right:8px;z-index:99999;background:#000c;color:#0f0;font:11px/1.4 monospace;padding:4px 8px;border-radius:6px;pointer-events:none;white-space:pre";
      (document.body || document.documentElement).appendChild(hud);
    }
    hud.textContent = `${online ? "🟢" : "🔴"} ${ESP_IP || "no IP"}\nlast: ${lastEv}`;
  }
  GM_registerMenuCommand("Toggle status HUD", () => { hudOn = !hudOn; GM_setValue("scoreboard_hud", hudOn); updateHud(); });
  GM_registerMenuCommand("Dump match state (copy)", () => {
    if (!lastRaw) return alert("No match data captured yet — start/observe a game first.");
    (navigator.clipboard?.writeText(lastRaw) || Promise.reject())
      .then(() => alert("Raw match JSON copied to clipboard."))
      .catch(() => { console.log("[scoreboard] raw match state:", lastRaw); alert("Clipboard blocked — logged to console instead."); });
  });
  setInterval(() => {
    if (!ESP_IP) return;
    GM_xmlhttpRequest({ method: "GET", url: `http://${ESP_IP}/ping`, timeout: 1500,
      onload: () => { online = true; updateHud(); },
      onerror: () => { online = false; updateHud(); },
      ontimeout: () => { online = false; updateHud(); } });
  }, 5000);
  setTimeout(updateHud, 1500);

  // =================== CONSOLE API ===================
  // Must live on unsafeWindow: with @grant sandboxing, window.* stays inside the
  // Tampermonkey sandbox and the devtools console would see Scoreboard as undefined.
  const api = {
    score: postScore, event: postEvent, text: postText, pushConfig: () => pushConfig(DEFAULT_CONFIG),
    uploadGif: uploadGifFromUrl, listGifs: listSprites, scan,
    setIP: (ip) => { ESP_IP = ip; GM_setValue(KEY_IP, ip); },
    config: DEFAULT_CONFIG,
  };
  try { unsafeWindow.Scoreboard = api; } catch (_) { window.Scoreboard = api; }
  log("ready", ESP_IP ? `(target ${ESP_IP})` : "(no IP set)");
})();
