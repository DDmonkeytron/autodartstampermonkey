// ==UserScript==
// @name         Autodarts – CORE - Jason
// @namespace    autodarts.core.szala
// @author       Szala/AI
// @version      2.36.0
// @match        https://play.autodarts.io/*
// @run-at       document-start
// @grant        none
// @inject-into  content
// @homepageURL  https://github.com/DDmonkeytron/autodartstampermonkey
// @supportURL   https://github.com/DDmonkeytron/autodartstampermonkey/issues
// @downloadURL  https://raw.githubusercontent.com/DDmonkeytron/autodartstampermonkey/main/autodarts-theme.user.js
// @updateURL    https://raw.githubusercontent.com/DDmonkeytron/autodartstampermonkey/main/autodarts-theme.user.js
// @description  CORE panel with 6 presets (A-F) + HU/EN/DE + SafeMode + Total overlay fix + integrated Floating Clock + optional Back-to-Autodarts button on /boards + integrated Stylebot CSS as toggleable "Skin/Layout" module + theme gallery (GitHub-hosted, with color-swatch previews) + click/drag Layout Editor (Beta) for Player Info with snap-to-grid/alignment guides and one-click 2P<->3-4P layout copy. Includes performance optimizations (dirty flags + scoped observers).
// ==/UserScript==

(() => {
  "use strict";

  const SCRIPT_VERSION = "2.36.0";

  /* ================== STORAGE ================== */
  const STORE_KEY_STATE = "ad_core_state";
  const LEGACY_KEYS = [
  "ad_core_state_v245",
  "ad_core_state_v243",
  "ad_core_state_v242",
  "ad_core_state_v241",
  "ad_core_state_v240",
  "ad_core_state_v233",
  "ad_core_state_v232",
  "ad_core_state_v231",
  "ad_core_state_v230",
  "ad_core_state_v227",
];
  const STATE_SCHEMA_VERSION = 1;
  const LEGACY_CLOCK_KEY = "ad_clock_only_v11";

  const clone = (obj) => (typeof structuredClone === "function")
    ? structuredClone(obj)
    : JSON.parse(JSON.stringify(obj));

  /* ================== EFFECTS MATRIX (tick-box grid: effect x trigger) ================== */
  // Rows = effects, columns = trigger types. Config keys are flat FX_<EFFECT>_<TRIGGER> booleans
  // (generated here, not hand-typed - 10 x 6 = 60 keys) so the settings-panel table and the
  // dispatcher (runMatrixEffects, defined further down near the other launch* effect functions)
  // can iterate them generically instead of hard-coding every combination.
  const FX_EFFECTS = ["SPARK", "GLOW", "CONFETTI", "FIREWORKS", "LIGHTNING", "SMOKE", "CROWD", "EXPLODE", "DINO", "CANNONS"];
  const FX_TRIGGERS = ["TRIPLE", "DOUBLE", "DBLSTREAK", "T1", "T2", "T3"];
  const FX_DEFAULTS = {
    TRIPLE: ["SPARK"],
    DOUBLE: ["SPARK"],
    DBLSTREAK: ["LIGHTNING"],
    T1: ["GLOW", "FIREWORKS"],
    T2: ["GLOW", "LIGHTNING", "CONFETTI", "FIREWORKS"],
    T3: ["GLOW", "LIGHTNING", "SMOKE", "CROWD", "CONFETTI", "FIREWORKS", "EXPLODE"],
  };
  function fxKey(effect, trigger) { return `FX_${effect}_${trigger}`; }
  const FX_MATRIX_KEYS = [];
  const FX_MATRIX_DEFAULT_CFG = { FX_MATRIX_ENABLED: true, FX_SOUND_ENABLED: true };
  for (const trig of FX_TRIGGERS) {
    for (const eff of FX_EFFECTS) {
      const key = fxKey(eff, trig);
      FX_MATRIX_KEYS.push(key);
      FX_MATRIX_DEFAULT_CFG[key] = (FX_DEFAULTS[trig] || []).includes(eff);
    }
  }

  /* ================== DEFAULTS ================== */
  const DEFAULT_CFG = {
    ...FX_MATRIX_DEFAULT_CFG,
    // utilities
    BOARD_MARKER: true,
    BM_BACK_BUTTON: true,

    // NEW: integrated Stylebot CSS as toggleable module
    SKIN_CSS: true,
    SKIN_AUTO_DISABLE_ON_MISMATCH: true,

        // Skin / Layout adjustable
    SKIN_UI_SCALE: 1,
    SKIN_SPACING_PLAYER: 20,
    SKIN_BG_URL: "https://raw.githubusercontent.com/DDmonkeytron/autodartstampermonkey/main/Background.jpg",
    SKIN_BG_OVERLAY_ALPHA: 0.55,
    SKIN_PLAYER_BG_HEX: "#c0c0c0",
    SKIN_PLAYER_BG_OPACITY: 0.10,

    // Throw cards background (and hover)
    THROW_BG_HEX: "#ffffff",
    THROW_BG_OPACITY: 1.0,
    THROW_HOVER_BG_HEX: "#d9822b",
    THROW_HOVER_BG_OPACITY: 1.0,

    // Total card background (overlay)
    TOTAL_BG_HEX: "#cfd3d7",
    TOTAL_BG_OPACITY: 0.05,

    // display
    THROWS_TO_POINTS: true,
    SHOW_ORIG_IN_CORNER: true,
    TOTAL_VIEW: true,
    CHECKOUT_VIEW: true,

    // Player info text sizing (name / total score / averages / throw history)
    PLAYER_INFO: false,
    PI_NAME_FONT_PX: 18,
    PI_SCORE_FONT_PX: 123,
    PI_AVG_FONT_PX: 16,
    PI_HISTORY_FONT_PX: 35,
    // Player info colors (only applied when PI_CUSTOM_COLORS is on)
    PI_CUSTOM_COLORS: false,
    PI_NAME_COLOR_HEX: "#ffffff",
    PI_SCORE_COLOR_HEX: "#ffffff",
    PI_AVG_COLOR_HEX: "#cfd3d7",
    PI_HISTORY_COLOR_HEX: "#ffffff",
    // Player info layout (helps avoid overlap when fonts are enlarged)
    PI_STACK_GAP_PX: 8,        // gap between avatar / score / name / averages
    PI_HISTORY_WIDTH_PX: 0,    // throw-history table width: 0 = auto (fit to font), >0 = fixed px
    PI_HISTORY_HEIGHT_PX: 0,   // throw-history table height: 0 = auto (fit rows), >0 = fixed px
    PI_AVATAR_SCALE: 7,        // profile avatar size (native = 7; lower = smaller)
    PI_CARD_WIDTH_PX: 0,       // whole player card width: 0 = native, >0 = fixed px
    PI_CARD_HEIGHT_PX: 0,      // whole player card height: 0 = native, >0 = fixed px
    // Per-element positioning (translate px; X = left/right, Y = up/down)
    PI_AVATAR_X_PX: 0,  PI_AVATAR_OFFSET_PX: 0,   // avatar X / Y
    PI_SCORE_X_PX: 0,   PI_SCORE_Y_PX: 0,         // total score X / Y
    PI_NAME_X_PX: 0,    PI_NAME_Y_PX: 0,          // name X / Y
    PI_AVG_X_PX: 0,     PI_AVG_Y_PX: 0,           // averages X / Y
    PI_HISTORY_X_PX: 0, PI_HISTORY_OFFSET_PX: 0,  // history X / Y
    // Per-player alignment nudge (shifts avatar+name+averages of a player to line up with the others)
    PI_P1_SHIFT_Y: 0, PI_P2_SHIFT_Y: 0, PI_P3_SHIFT_Y: 0, PI_P4_SHIFT_Y: 0,
    // Per-player horizontal nudge (companion to SHIFT_Y above, same 3 elements)
    PI_P1_SHIFT_X: 0, PI_P2_SHIFT_X: 0, PI_P3_SHIFT_X: 0, PI_P4_SHIFT_X: 0,
    // Whole-card position (Layout Editor card drag): translates the card <div> itself, so the
    // background box, active glow, and EVERYTHING inside (incl. score/history) move together.
    PI_P1_CARD_X_PX: 0, PI_P1_CARD_Y_PX: 0, PI_P2_CARD_X_PX: 0, PI_P2_CARD_Y_PX: 0,
    PI_P3_CARD_X_PX: 0, PI_P3_CARD_Y_PX: 0, PI_P4_CARD_X_PX: 0, PI_P4_CARD_Y_PX: 0,
    // 3-4 player layout fit: when 3+ players, scale player-info to fit the 2x2 grid (avoids overlap).
    // Any PI_G_* key left null is derived from its 2-player counterpart × PI_GRID_SCALE (legacy
    // behavior, fully backward compatible); setting one explicitly tunes the 3-4p layout
    // independently of the 2-player one (0 on a width/height key means "auto", same convention
    // as its 2-player counterpart). The Layout Editor writes these automatically when a
    // 3-4 player match is active.
    PI_GRID_ADJUST: true,
    PI_GRID_SCALE: 0.5,
    PI_G_NAME_FONT_PX: null, PI_G_SCORE_FONT_PX: null, PI_G_AVG_FONT_PX: null, PI_G_HISTORY_FONT_PX: null,
    PI_G_NAME_X_PX: null, PI_G_NAME_Y_PX: null,
    PI_G_SCORE_X_PX: null, PI_G_SCORE_Y_PX: null,
    PI_G_AVG_X_PX: null, PI_G_AVG_Y_PX: null,
    PI_G_HISTORY_X_PX: null, PI_G_HISTORY_OFFSET_PX: null,
    PI_G_HISTORY_WIDTH_PX: null, PI_G_HISTORY_HEIGHT_PX: null,
    PI_G_AVATAR_X_PX: null, PI_G_AVATAR_OFFSET_PX: null, PI_G_AVATAR_SCALE: null,
    PI_G_STACK_GAP_PX: null,
    PI_G_CARD_WIDTH_PX: null, PI_G_CARD_HEIGHT_PX: null,
    PI_G_P1_SHIFT_Y: null, PI_G_P2_SHIFT_Y: null, PI_G_P3_SHIFT_Y: null, PI_G_P4_SHIFT_Y: null,
    // Per-player colours: off = all players share the colours above; on = players 2-4 use their own
    PI_PER_PLAYER_COLORS: false,
    PI_P2_NAME_COLOR_HEX: "#ffffff", PI_P2_SCORE_COLOR_HEX: "#ffffff", PI_P2_AVG_COLOR_HEX: "#cfd3d7", PI_P2_HISTORY_COLOR_HEX: "#ffffff",
    PI_P3_NAME_COLOR_HEX: "#ffffff", PI_P3_SCORE_COLOR_HEX: "#ffffff", PI_P3_AVG_COLOR_HEX: "#cfd3d7", PI_P3_HISTORY_COLOR_HEX: "#ffffff",
    PI_P4_NAME_COLOR_HEX: "#ffffff", PI_P4_SCORE_COLOR_HEX: "#ffffff", PI_P4_AVG_COLOR_HEX: "#cfd3d7", PI_P4_HISTORY_COLOR_HEX: "#ffffff",
    // Player-card text effects (name / score / averages / history). Stackable list;
    // each item = { style:"outline"|"emboss"|"glow"|"shadow", size:1..12, color:"#rrggbb" }
    PI_TEXT_EFFECTS: [],

    // highlight/anim/sound
    ACTIVE_PLAYER_HIGHLIGHT: true,
    TRIPLE_ANIM: true,
    WIN_MUSIC: true,

    ACTIVE_COLOR_HEX: "#ffffff",
    ACTIVE_OUTLINE_PX: 3,
    ACTIVE_GLOW: 0.42,
    ACTIVE_TRAIL: true,
    ACTIVE_TRAIL_SPEED_MS: 2500,
    ACTIVE_TRAIL_COLOR_HEX: "#00cfff",
    // Active highlight per-player: off = both players share the settings above (= Player 1);
    // on = Players 2-4 use their own settings below
    ACTIVE_PER_PLAYER: false,
    ACTIVE_P2_COLOR_HEX: "#ffffff", ACTIVE_P2_OUTLINE_PX: 3, ACTIVE_P2_GLOW: 0.42, ACTIVE_P2_TRAIL: true, ACTIVE_P2_TRAIL_SPEED_MS: 2500, ACTIVE_P2_TRAIL_COLOR_HEX: "#ff7b00",
    ACTIVE_P3_COLOR_HEX: "#ffffff", ACTIVE_P3_OUTLINE_PX: 3, ACTIVE_P3_GLOW: 0.42, ACTIVE_P3_TRAIL: true, ACTIVE_P3_TRAIL_SPEED_MS: 2500, ACTIVE_P3_TRAIL_COLOR_HEX: "#43e0ff",
    ACTIVE_P4_COLOR_HEX: "#ffffff", ACTIVE_P4_OUTLINE_PX: 3, ACTIVE_P4_GLOW: 0.42, ACTIVE_P4_TRAIL: true, ACTIVE_P4_TRAIL_SPEED_MS: 2500, ACTIVE_P4_TRAIL_COLOR_HEX: "#5dff8a",

    THROW_VAL_FONT_PX: 100,
    THROW_VAL_COLOR_HEX: "#222222",
    THROW_VAL_OPACITY: 1.0,

    ORIG_FONT_PX: 30,
    ORIG_COLOR_HEX: "#000000",
    ORIG_OPACITY: 0.45,

    TOTAL_FONT_PX: 100,
    TOTAL_COLOR_HEX: "#ffffff",
    TOTAL_OPACITY: 1.0,

    CHECKOUT_FONT_PX: 100,
    CHECKOUT_COLOR_HEX: "#ffffff",
    CHECKOUT_OPACITY: 0.55,

    TRIPLE_SHIMMER_MS: 2000,
    TRIPLE_SLAM_MS: 350,
    TRIPLE_RATTLE_MS: 500,
    TRIPLE_RATTLE_DELAY_MS: 275,
    TRIPLE_GLOW_HEX: "#ff6600",
    TRIPLE_GLOW: 0.70,
    TRIPLE_FLASH: true,
    TRIPLE_SPIN: false,          // spin the board on each triple
    TRIPLE_SPIN_MS: 1200,
    TRIPLE_SPIN_MIN: 15,         // only triples T>=this value spin the board (1..20)
    TRIPLE_VARIETY: true,        // pick a random animation style each hit instead of always the same one

    DOUBLE_ANIM: true,
    DOUBLE_SHIMMER_MS: 1400,
    DOUBLE_SLAM_MS: 250,
    DOUBLE_RATTLE_MS: 350,
    DOUBLE_RATTLE_DELAY_MS: 150,
    DOUBLE_GLOW_HEX: "#00aaff",
    DOUBLE_GLOW: 0.55,
    DOUBLE_FLASH: false,
    DOUBLE_SPIN: false,          // spin the board on each double
    DOUBLE_SPIN_MS: 1000,
    DOUBLE_SPIN_MIN: 15,         // only doubles D>=this value spin the board (1..20)
    DOUBLE_VARIETY: true,        // pick a random animation style each hit instead of always the same one
    DOUBLE_STREAK_ANIM: true,    // "DOUBLE, DOUBLE!!" banner + flash when 2+ of this turn's 3 darts are doubles

    HIGHSCORE_ANIM: true,
    HIGHSCORE_THRESHOLD: 100,
    HIGHSCORE_SHIMMER_MS: 2000,
    HIGHSCORE_GLOW_HEX: "#ffd700",
    HIGHSCORE_GLOW: 0.80,
    HIGHSCORE_FLASH: true,
    HIGHSCORE_SPIN: true,
    HIGHSCORE_SPIN_MS: 7000,     // board spin duration for a ton (user-set, default 7s)
    HIGHSCORE_BOARD_FLASH: true,
    HIGHSCORE_THROW_FLASH: true,
    // Tier 2 (ton-forty) and tier 3 (180/max) escalate the tier-1 effects above (bigger spin/
    // fireworks) instead of re-configuring them from scratch. Which extra effects fire for each
    // tier (fireworks, confetti, lightning, board explosion, dino, etc.) is governed by the
    // effects matrix (FX_* keys above), not fixed toggles here.
    HIGHSCORE2_ENABLED: true,
    HIGHSCORE2_THRESHOLD: 140,
    HIGHSCORE3_ENABLED: true,
    HIGHSCORE3_THRESHOLD: 180,
    HIGHSCORE3_BANNER: true,     // flashing "ONE HUNDRED AND EIGHTY!" text on a 180

    // "26" fire: a 3-dart turn totalling exactly 26 (the classic 5-20-1 bad-luck score) sets the
    // board ablaze - a real ring-of-fire video (Fireflicker.mp4, hollow ring on black) is played
    // over the board with screen-blend (black drops out) so flames ring the rim and the scoring
    // shows through the empty centre, plus a gentle board grow, over a ~5s burn. Default ON; toggle
    // lives in the High Score module. The video is loaded from the repo via jsDelivr (the script is
    // @grant none, so no GM_getResourceURL), pinned to the commit that added Fireflicker.mp4 so the
    // URL is immutable and CDN-cacheable; bump the pin if you ever replace the clip.
    FIRE26_ENABLED: true,
    FIRE26_VIDEO_URL: "https://cdn.jsdelivr.net/gh/DDmonkeytron/autodartstampermonkey@12e86abd45462ac2ba976fa86c0afec1f8d930c6/Fireflicker.mp4",
    FIRE26_VIDEO_SCALE: 2.05,  // video size vs the board box; tune so the ring's hole hugs the rim

    ACTIVE_POLL_MS: 150,
    WIN_VOLUME: 1.0,

    // Board / Undo / Next repositioning (Layout Editor, Beta). translate/scale compose with the
    // existing spin/flash animations instead of clobbering them (same technique as Player Info).
    BOARD_X_PX: 0, BOARD_Y_PX: 0, BOARD_SCALE: 1,
    UNDO_BTN_X_PX: 0, UNDO_BTN_Y_PX: 0, UNDO_BTN_SCALE: 1,
    NEXT_BTN_X_PX: 0, NEXT_BTN_Y_PX: 0, NEXT_BTN_SCALE: 1,
    // Whole turn bar (the 3 dart-throw cards + total score, moved/scaled as one linked unit)
    TURN_BAR_X_PX: 0, TURN_BAR_Y_PX: 0, TURN_BAR_SCALE: 1,
  };

  const DEFAULT_CLOCK = {
    blL: null, blB: null,         // BL anchor az órához
    enabled: false,
    x: null,
    y: null,
    scale: 1,
    format24: true,
    showSeconds: true,
    bgHex: "#000000",
    bgAlpha: 0.85,
    textHex: "#ffffff",
  };

  const DEFAULT_UI = {
    panelL: null, panelB: null,   // BL anchor a panelhez
    btnL: null,   btnB: null,     // BL anchor a fő gombhoz
    open: false,
    x: null,
    y: null,
    btnX: null,
    btnY: null,
    selectedTab: "general",
    safeMode: true,
    compact: false,
    helpOpen: false,
    lang: "hu",              // hu | en | de
    clock: clone(DEFAULT_CLOCK),
    editSnapEnabled: true,   // Layout Editor: snap-to-grid + alignment guides while dragging
  };

  // ===== Preset A baked default (the user's tuned config) =====
  // Only the keys that differ from DEFAULT_CFG; spread over DEFAULT_CFG so any
  // future keys are filled from defaults.
  const PRESET_A_OVERRIDES = {
    SKIN_UI_SCALE: 0.93, SKIN_SPACING_PLAYER: 38,
    SKIN_BG_URL: "https://raw.githubusercontent.com/DDmonkeytron/autodartstampermonkey/main/NeonBlueBG.png",
    SKIN_BG_OVERLAY_ALPHA: 0.6, SKIN_PLAYER_BG_OPACITY: 0.15,
    THROW_BG_HEX: "#bababa", THROW_HOVER_BG_HEX: "#848edc", THROW_HOVER_BG_OPACITY: 0.95,
    PLAYER_INFO: true,
    PI_NAME_FONT_PX: 80, PI_SCORE_FONT_PX: 220, PI_AVG_FONT_PX: 39, PI_HISTORY_FONT_PX: 58,
    PI_CUSTOM_COLORS: true, PI_NAME_COLOR_HEX: "#f53232", PI_SCORE_COLOR_HEX: "#ec1842", PI_AVG_COLOR_HEX: "#e82626", PI_HISTORY_COLOR_HEX: "#f01919",
    PI_STACK_GAP_PX: 80, PI_HISTORY_HEIGHT_PX: 560, PI_AVATAR_SCALE: 2.5, PI_CARD_WIDTH_PX: 440, PI_CARD_HEIGHT_PX: 810,
    PI_AVATAR_OFFSET_PX: 75, PI_SCORE_Y_PX: -170, PI_NAME_Y_PX: -190, PI_AVG_X_PX: 5, PI_AVG_Y_PX: -180, PI_HISTORY_OFFSET_PX: -95,
    PI_P1_SHIFT_Y: -36, PI_P2_SHIFT_Y: -34, PI_P3_SHIFT_Y: -32, PI_P4_SHIFT_Y: -36,
    PI_PER_PLAYER_COLORS: true,
    PI_P2_NAME_COLOR_HEX: "#e356f5", PI_P2_SCORE_COLOR_HEX: "#ec6ae7", PI_P2_AVG_COLOR_HEX: "#f264be", PI_P2_HISTORY_COLOR_HEX: "#dd46d8",
    PI_P3_NAME_COLOR_HEX: "#1b22ee", PI_P3_SCORE_COLOR_HEX: "#2a27dd",
    PI_P4_NAME_COLOR_HEX: "#6ae704", PI_P4_SCORE_COLOR_HEX: "#5ddf26",
    PI_TEXT_EFFECTS: [{ style: "shadow", size: 4, color: "#000000" }, { style: "outline", size: 2, color: "#000000" }],
    ACTIVE_COLOR_HEX: "#ff0000", ACTIVE_OUTLINE_PX: 1, ACTIVE_GLOW: 0.72, ACTIVE_TRAIL_SPEED_MS: 3000, ACTIVE_TRAIL_COLOR_HEX: "#ffffff",
    ACTIVE_PER_PLAYER: true,
    ACTIVE_P2_COLOR_HEX: "#ff42ef", ACTIVE_P2_TRAIL_SPEED_MS: 3000, ACTIVE_P2_TRAIL_COLOR_HEX: "#ffffff",
    ACTIVE_P3_COLOR_HEX: "#1221f3", ACTIVE_P3_TRAIL_COLOR_HEX: "#ffffff",
    ACTIVE_P4_COLOR_HEX: "#1de234",
    THROW_VAL_FONT_PX: 120, THROW_VAL_COLOR_HEX: "#030303", ORIG_FONT_PX: 34, TOTAL_FONT_PX: 130, TOTAL_OPACITY: 0.95,
    TRIPLE_SHIMMER_MS: 4700, TRIPLE_SLAM_MS: 290, TRIPLE_RATTLE_MS: 1080, TRIPLE_RATTLE_DELAY_MS: 575, TRIPLE_GLOW: 0.8,
    TRIPLE_SPIN: true, TRIPLE_SPIN_MS: 2000, TRIPLE_SPIN_MIN: 10,
    DOUBLE_SLAM_MS: 670, DOUBLE_RATTLE_MS: 1360, DOUBLE_FLASH: true, DOUBLE_SPIN: true, DOUBLE_SPIN_MIN: 10,
    HIGHSCORE_THRESHOLD: 99, HIGHSCORE_SHIMMER_MS: 700, HIGHSCORE_GLOW_HEX: "#ffbb00", HIGHSCORE_SPIN_MS: 7100,
  };
  const presetA = () => ({ ...clone(DEFAULT_CFG), ...clone(PRESET_A_OVERRIDES) });
  // Background shared with presets B & C (image + overlay + player-card tint)
  const sharedBg = () => {
    const a = presetA();
    return {
      SKIN_CSS: a.SKIN_CSS,
      SKIN_BG_URL: a.SKIN_BG_URL,
      SKIN_BG_OVERLAY_ALPHA: a.SKIN_BG_OVERLAY_ALPHA,
      SKIN_PLAYER_BG_HEX: a.SKIN_PLAYER_BG_HEX,
      SKIN_PLAYER_BG_OPACITY: a.SKIN_PLAYER_BG_OPACITY,
    };
  };
  const presetBC = () => ({ ...clone(DEFAULT_CFG), ...sharedBg() });

  // Fixed-cap preset slots (A-F). Slot 0 is the tuned default (presetA); the rest start
  // from a plain DEFAULT_CFG clone (presetBC) - same as the old B/C slots always did.
  const PRESET_COUNT = 6;
  const PRESET_LABELS = ["A", "B", "C", "D", "E", "F"];
  const makeDefaultPresets = () =>
    Array.from({ length: PRESET_COUNT }, (_, i) => (i === 0 ? presetA() : presetBC()));

  const DEFAULT_STATE = {
    schemaVersion: STATE_SCHEMA_VERSION,
    activePreset: 0,
    presets: makeDefaultPresets(),
    ui: clone(DEFAULT_UI),
  };

  /* ================== I18N ================== */
  const I18N = {
    hu: {
      appTitle: "🎯 Autodarts CORE",
      modulesTitle: "Kapcsolók / modulok",
      help: "Súgó",
      close: "Bezár",
      export: "Export",
      import: "Import",
      themesTitle: "Témák",
      themeTarget: "Betöltés ide:",
      themeFromFile: "Téma fájlból",
      themeBrowse: "Témák (GitHub)",
      themeExportPreset: "Preset → téma export",
      themeLoading: "Betöltés…",
      themeEmpty: "Nincs elérhető téma.",
      themeLoadError: "Téma betöltése sikertelen",
      activeRefresh: "Aktív frissítés (ms)",
      activeRefreshHint: "Aktív játékos felismerés polling. 0 = csak DOM figyelés. Ha néha késik, 100–200ms jó.",
      preset: "Preset",
      reset: "Reset",
      resetPreset: "Reset Preset",
      resetAll: "Reset MINDEN",
      resetAllConfirm: "Biztosan mindent alaphelyzetbe állítasz? (Presetek + UI)",
      saved: "Mentve ✓",
      posReset: "Panel pozíció reset",
      btnPosReset: "Fő gomb helye reset",
      safeMode: "Safe Mode (ajánlott)",
      compact: "Kompakt mód",
      hotkeysLine: "Hotkeys: Shift+F panel • Shift+1/2/3 preset • Shift+M Safe • Shift+H help • ESC close",
      hintConfig: "Beállítások →",
      iconConfigTitle: "Állítható (katt a sorra)",
      markerNow: "Marker frissítés most",
      markerInfo: "Board marker: megjelöli a tábla SVG-t (ad-board-svg). Ha a custom tábla skin ezt használja, maradjon ON.",
      bmInfo: "A /boards oldalon betesz egy 'Vissza az Autodartsba' gombot (touch/fullscreenben hasznos).",
      bmBackLabel: "Vissza az Autodartsba",
      skinInfo: "Skin/Layout: Ha használsz Stylebotot ehhez az oldalhoz, kapcsold ki, mert összeakadhat ezzel a userscripttel. (Autodarts frissítésnél a css-xxxxx classnevek változhatnak, ilyenkor frissíteni kell a CSS szelektorokat.)",
      diagCopy: "Debug info másolás",
      diagGenOverrides: "Preset A → default overrides generálása",
      diagSelectors: "Szelektor ellenőrzés",
      diagOk: "OK",
      diagMissing: "HIÁNYZIK",
      diagOptional: "OPCIONÁLIS",
      tab: {
        general:  "Általános",
        skin:     "Skin / Layout",
        board:    "Eszköz – Board marker",
        bmback:   "Eszköz – Vissza gomb (/boards)",
        throws:   "Megjelenítés – Dobáspontok",
        orig:     "Megjelenítés – Sarok jelölés (T20)",
        total:    "Megjelenítés – Összérték",
        checkout: "Megjelenítés – Checkout tipp",
        playerinfo: "Megjelenítés – Játékos infó",
        active:   "Kiemelés – Aktív játékos",
        triple:   "Animáció – Tripla találat",
        double:   "Animáció – Dupla találat",
        highscore: "Animáció – Magas pont",
        fx: "Effektek (mátrix)",
        win:      "Hang – Győzelem",
        clock:    "Widget – Óra",
        diag: "Diagnosztika",
      },
      fxTriggers: { TRIPLE: "3x", DOUBLE: "2x", DBLSTREAK: "2xD", T1: "100+", T2: "140+", T3: "180" },
      fxEffects: {
        SPARK: "Szikra", GLOW: "Izzás", CONFETTI: "Konfetti", FIREWORKS: "Tűzijáték",
        LIGHTNING: "Villám", SMOKE: "Füst", CROWD: "Tömeg", EXPLODE: "Tábla robbanás",
        DINO: "Dínó", CANNONS: "Konfetti ágyú",
      },
      fields: {
        bg: "Háttér",
        bgOpacity: "Háttér áttetszőség",
        hoverBg: "Hover háttér",
        hoverOpacity: "Hover áttetszőség",
        fontSize: "Betűméret",
        color: "Szín",
        opacity: "Áttetszőség",
        outline: "Keret vastagság",
        glow: "Glow erősség",
        trailEnabled: "Forgó fény effekt",
        trailSpeed: "Forgó fény sebesség",
        trailColor: "Fény szín",
        glowColor: "Glow szín",
        flashEnabled: "Villogás",
        spinEnabled: "Tábla pörgés",
        spinDuration: "Pörgés idő",
        boardFlash: "Tábla felvillanás",
        throwFlash: "Dobáskártya felvillanás",
        spinMin: "Pörgés minimum érték",
        varietyEnabled: "Változatos animáció",
        tier2: "2. szint (Ton-forty)",
        tier3: "3. szint (Max/180)",
        bannerEnabled: "\"ONE HUNDRED AND EIGHTY!\" felirat",
        fire26Enabled: "🔥 Tábla lángra kap 26-nál",
        doubleStreak: "\"DOUBLE, DOUBLE!!\" felirat (2+ dupla)",
        fxMatrixInfo: "A tűzijáték, konfetti, villámlás, füst, tömeg stb. részletes beállítása az \"Effektek\" modulban (tábla: melyik effekt melyik találatnál induljon el).",
        fxMasterEnabled: "Effekt mátrix BE",
        fxSoundEnabled: "Effekt hang (szintetizált)",
        perPlayer: "Játékosonként eltérő",
        p1: "1.J",
        p2: "2.J",
        p3: "3.J",
        p4: "4.J",
        threshold: "Pont határ",
        highlightSpeed: "Highlight sebesség",
        numberAnim: "Szám animáció",
        rattleDur: "Rázkódás idő",
        rattleDelay: "Rázkódás késleltetés",
        volume: "Hangerő",
      },
      totalInfo: "Fix: a Total szám overlay, így a beállítások mindig érvényesülnek és a kártya magassága nem változik.",
      piText: {
        name: "Név betűméret",
        score: "Összpontszám betűméret",
        average: "Átlagok betűméret",
        history: "Dobás előzmény betűméret",
        spacing: "Függőleges térköz",
        avatarPos: "Avatar pozíció (fel/le)",
        historyPos: "Előzmény tábla pozíció",
        historyWidth: "Előzmény tábla szélesség (0 = auto)",
        historyHeight: "Előzmény tábla magasság (0 = auto)",
        avatarSize: "Avatar méret",
        cardWidth: "Kártya szélesség (0 = alap)",
        cardHeight: "Kártya magasság (0 = alap)",
        secSizes: "Méretek",
        secPos: "Pozíció (↔ vízszintes / ↕ függőleges)",
        secCard: "Játékos kártya",
        secColors: "Színek",
        secEffect: "Szöveg effekt",
        effectStyle: "Effekt",
        effectSize: "Effekt méret",
        effectColor: "Effekt szín",
        addEffect: "Effekt hozzáadása",
        fxNone: "Nincs", fxOutline: "Körvonal", fxEmboss: "Dombor", fxGlow: "Ragyogás", fxShadow: "Árnyék",
        alignP1: "1. játékos igazítás ↕",
        alignP2: "2. játékos igazítás ↕",
        alignP3: "3. játékos igazítás ↕",
        alignP4: "4. játékos igazítás ↕",
        secGrid: "3-4 játékos illesztés",
        gridAdjust: "3-4 játékosnál méretezés",
        gridScale: "3-4 méretarány",
        gridIndependentInfo: "Tipp: nyisd meg a Layout Editort (Beta) egy 3-4 fős meccs alatt, hogy a 3-4 játékos elrendezését a 2 játékostól teljesen függetlenül, kézzel finomhangold (méret/pozíció). Amíg nem nyúlsz hozzá, a fenti arányból számolódik automatikusan.",
        perPlayerColors: "Játékosonként eltérő színek",
        p1Prefix: "1.J",
        p2Prefix: "2.J",
        p3Prefix: "3.J",
        p4Prefix: "4.J",
        el: { avatar: "Avatar", name: "Név", score: "Pont", average: "Átlag", history: "Előzmény" },
        customColors: "Saját színek",
        nameColor: "Név szín",
        scoreColor: "Összpontszám szín",
        avgColor: "Átlagok szín",
        historyColor: "Előzmény szín",
        info: "Átméretezi/színezi a játékos kártya szövegeit. A 'Játékos infó' kapcsolót be kell kapcsolni. Nagy betűknél a 'Függőleges térköz' és az 'Előzmény tábla pozíció' segít az átfedés ellen. A színekhez kapcsold be a 'Saját színek'-et. (Autodarts frissítésnél a szelektorok változhatnak.)",
        editModeOn: "🖱️ Elrendezés szerkesztő (Beta)",
        editModeOff: "✖ Szerkesztés befejezése",
        editHint: "BETA: Kattints egy elemre a kijelöléshez, húzd az áthelyezéshez, a sárga négyzetet az átméretezéshez. Esc vagy Befejezés a kilépéshez.",
        editNeedMatch: "Nyiss meg egy meccset a szerkesztéshez.",
        editSnapOn: "🧲 Illesztés BE",
        editSnapOff: "🧲 Illesztés KI",
        editCopyToGrid: "2P→3-4P másolás",
        editCopyToFlat: "3-4P→2P másolás",
        editCopyToGridConfirm: "Ez felülírja a 3-4 fős elrendezést a jelenlegi 2 fős elrendezéssel. Folytatod?",
        editCopyToFlatConfirm: "Ez felülírja a 2 fős elrendezést a jelenlegi 3-4 fős elrendezéssel. Folytatod?",
        editCopyDone: "Elrendezés átmásolva ✓",
        editWidth: "Szélesség",
        editHeight: "Magasság",
        editScale: "Méret (scale)",
        editFont: "Betűméret",
        editEnableCustom: "Saját színek bekapcsolása",
        editEnablePerPlayer: "Játékosonkénti színek bekapcsolása",
        editSharedColor: "Szín (közös minden játékosnál)",
        editPlayerColor: "Szín (csak ennél a játékosnál)",
        editReset: "Elem reset",
        editOpacity: "Áttetszőség",
        editGroupScale: "Sarok húzása: minden elem méretezése is (kikapcsolva: csak a doboz). A kártya húzása mindig mindent együtt mozgat.",
        editGlobalLabel: {
          throwVal: "Dobás érték", orig: "Eredeti dobás (sarok)", total: "Összpontszám",
          checkout: "Kiszálló javaslat", board: "Tábla (SVG/kép)", undoBtn: "Vissza gomb", nextBtn: "Következő gomb",
          turnBar: "Dobás sáv (kártyák + összpontszám együtt)",
        },
      },
      skinText: {
        uiScale: "UI méret (scale)",
        spacing: "Játékos távolság (spacing)",
        playerBg: "Player kártya háttér",
        playerBgOpacity: "Player háttér áttetszőség",
        bgUrl: "Háttérkép URL",
        overlay: "Overlay áttetszőség",
        autoDisable: "Auto kikapcsolás, ha frissítés után elcsúszik (ajánlott)",
      },
      clockText: {
        enabled: "Óra engedélyezése",
        scale: "Méret",
        bg: "Háttérszín",
        bgAlpha: "Háttér áttetszőség",
        text: "Szöveg szín",
        format24: "24 órás formátum",
        seconds: "Másodperc mutatása",
        resetLook: "Óra stílus reset",
        resetPos: "Óra pozíció reset",
        hint: "Mozgatás: húzd az órát. Méret: Ctrl+↑ / Ctrl+↓ (vagy Ctrl+görgő). Dupla katt: 24h ki/be. Shift+dupla: másodperc ki/be. Hotkeys: Shift+T óra ki/be, Shift+R reset óra."
      },
      helpHtml: `
        <div style="font-weight:900;margin-bottom:6px">⌨️ Gyorsbillentyűk</div>
        <div><b>Shift+F</b> panel ki/be</div>
        <div><b>ESC</b> bezár</div>
        <div><b>Shift+1/2/3</b> Preset A/B/C</div>
        <div><b>Shift+M</b> Safe Mode ki/be</div>
        <div><b>Shift+H</b> Súgó ki/be</div>
        <div style="margin-top:8px;opacity:.8">Tipp: ahol a név mellett ott a kis “sliders” ikon, ott vannak extra beállítások.</div>
      `,
      alerts: {
        invalidJson: "❌ A fájl nem érvényes JSON",
        invalidPreset: "❌ Hibás preset formátum",
      },
      toasts: {
        preset: (p)=>`Preset ${p} ✓`,
        export: "Export ✓",
        import: "Import ✓",
        themeApplied: "Téma alkalmazva →",
        posSaved: "Panel pozíció mentve ✓",
        btnPosSaved: "Fő gomb helye mentve ✓",
        posReset: "Panel pozíció reset ✓",
        btnPosReset: "Fő gomb helye reset ✓",
        safeOn: "Safe Mode ✓",
        safeOff: "Safe Mode OFF",
        compactOn: "Kompakt ✓",
        compactOff: "Kompakt OFF",
        resetTab: "Reset ✓",
        resetPreset: "Preset reset ✓",
        resetAll: "Reset ✓",
        marker: "Marker ✓",
        clockOn: "Óra ON ✓",
        clockOff: "Óra OFF",
        clockSaved: "Óra mentve ✓",
        skinOn: "Skin ON ✓",
        skinOff: "Skin OFF",
        skinWarn: "Skin: Autodarts frissült? (CSS szelektor eltérés gyanú) – lehet, hogy frissíteni kell a Skin CSS-t.",
        lang: "Nyelv frissítve ✓",
        skinAutoOff: "Skin AUTO-OFF (selector eltérés) ✓",
      }
    },

    en: {
      appTitle: "🎯 Autodarts CORE",
      modulesTitle: "Toggles / modules",
      help: "Help",
      close: "Close",
      export: "Export",
      import: "Import",
      themesTitle: "Themes",
      themeTarget: "Load into:",
      themeFromFile: "Theme from file",
      themeBrowse: "Browse themes (GitHub)",
      themeExportPreset: "Export preset as theme",
      themeLoading: "Loading…",
      themeEmpty: "No themes available.",
      themeLoadError: "Failed to load theme",
      activeRefresh: "Active refresh (ms)",
      activeRefreshHint: "Active-player detection polling. 0 = DOM only. If it lags sometimes, try 100–200ms.",
      preset: "Preset",
      reset: "Reset",
      resetPreset: "Reset Preset",
      resetAll: "RESET ALL",
      resetAllConfirm: "Reset everything to defaults? (Presets + UI)",
      saved: "Saved ✓",
      posReset: "Reset panel position",
      btnPosReset: "Reset main button pos",
      safeMode: "Safe Mode (recommended)",
      compact: "Compact mode",
      hotkeysLine: "Hotkeys: Shift+F panel • Shift+1/2/3 preset • Shift+M Safe • Shift+H help • ESC close",
      hintConfig: "Settings →",
      iconConfigTitle: "Configurable (click row)",
      markerNow: "Refresh marker now",
      markerInfo: "Board marker: marks the board SVG (ad-board-svg). Keep ON if your custom board skin relies on it.",
      bmInfo: "Adds a 'Back to Autodarts' button on /boards (useful in touchscreen/fullscreen).",
      bmBackLabel: "Back to Autodarts",
      skinInfo: "Skin/Layout: If you use Stylebot on this site, turn it off because it can conflict with this userscript. (After Autodarts updates, the css-xxxxx class names may change; then the CSS selectors must be updated.)",
      diagCopy: "Copy debug info",
      diagGenOverrides: "Generate Preset A default overrides",
      diagSelectors: "Selector check",
      diagOk: "OK",
      diagMissing: "MISSING",
      diagOptional: "OPTIONAL",
      tab: {
        general:  "General",
        skin:     "Skin / Layout",
        board:    "Utility – Board Marker",
        bmback:   "Utility – Back Button (/boards)",
        throws:   "Display – Throw Points",
        orig:     "Display – Corner Label (T20)",
        total:    "Display – Total",
        checkout: "Display – Checkout Tip",
        playerinfo: "Display – Player Info",
        active:   "Highlight – Active Player",
        triple:   "Animation – Triple Hit",
        double:   "Animation – Double Hit",
        highscore: "Animation – High Score",
        fx: "Effects (matrix)",
        win:      "Sound – Win",
        clock:    "Widget – Clock",
        diag: "Diagnostics",
      },
      fxTriggers: { TRIPLE: "3x", DOUBLE: "2x", DBLSTREAK: "2xD", T1: "100+", T2: "140+", T3: "180" },
      fxEffects: {
        SPARK: "Spark", GLOW: "Glow", CONFETTI: "Confetti", FIREWORKS: "Fireworks",
        LIGHTNING: "Lightning", SMOKE: "Smoke", CROWD: "Crowd", EXPLODE: "Board explode",
        DINO: "Dino", CANNONS: "Confetti cannons",
      },
      fields: {
        bg: "Background",
        bgOpacity: "Background opacity",
        hoverBg: "Hover background",
        hoverOpacity: "Hover opacity",
        fontSize: "Font size",
        color: "Color",
        opacity: "Opacity",
        outline: "Outline size",
        glow: "Glow strength",
        trailEnabled: "Spinning trail",
        trailSpeed: "Trail speed",
        trailColor: "Trail color",
        glowColor: "Glow color",
        flashEnabled: "Flash",
        spinEnabled: "Board spin",
        spinDuration: "Spin duration",
        boardFlash: "Board flash",
        throwFlash: "Throw card flash",
        spinMin: "Spin from value",
        varietyEnabled: "Varied animation",
        tier2: "Tier 2 (Ton-forty)",
        tier3: "Tier 3 (Max/180)",
        bannerEnabled: "\"ONE HUNDRED AND EIGHTY!\" banner",
        fire26Enabled: "🔥 Board catches fire on 26",
        doubleStreak: "\"DOUBLE, DOUBLE!!\" banner (2+ doubles)",
        fxMatrixInfo: "Fine-grained control over fireworks, confetti, lightning, smoke, crowd etc. lives in the \"Effects\" module - a table of which effect fires on which hit.",
        fxMasterEnabled: "Effects matrix ON",
        fxSoundEnabled: "Effect sound (synthesized)",
        perPlayer: "Per-player",
        p1: "P1",
        p2: "P2",
        p3: "P3",
        p4: "P4",
        threshold: "Score threshold",
        highlightSpeed: "Highlight speed",
        numberAnim: "Number animation",
        rattleDur: "Rattle duration",
        rattleDelay: "Rattle delay",
        volume: "Volume",
      },
      totalInfo: "Fix: Total uses an overlay so settings always apply and card height won’t change.",
      piText: {
        name: "Name font size",
        score: "Total score font size",
        average: "Averages font size",
        history: "Throw history font size",
        spacing: "Vertical spacing",
        avatarPos: "Avatar position (up/down)",
        historyPos: "History table position",
        historyWidth: "History table width (0 = auto)",
        historyHeight: "History table height (0 = auto)",
        avatarSize: "Avatar size",
        cardWidth: "Card width (0 = native)",
        cardHeight: "Card height (0 = native)",
        secSizes: "Sizes",
        secPos: "Positioning (↔ horizontal / ↕ vertical)",
        secCard: "Player card",
        secColors: "Colours",
        secEffect: "Text effect",
        effectStyle: "Effect",
        effectSize: "Effect size",
        effectColor: "Effect colour",
        addEffect: "Add effect",
        fxNone: "None", fxOutline: "Outline", fxEmboss: "Emboss", fxGlow: "Glow", fxShadow: "Shadow",
        alignP1: "Player 1 align ↕",
        alignP2: "Player 2 align ↕",
        alignP3: "Player 3 align ↕",
        alignP4: "Player 4 align ↕",
        secGrid: "3-4 player fit",
        gridAdjust: "Scale for 3-4 players",
        gridScale: "3-4 scale",
        gridIndependentInfo: "Tip: open the Layout Editor (Beta) during a 3-4 player match to tune the 3-4 player layout (size/position) completely independently from the 2-player one. Until you touch it, it's derived from the scale above automatically.",
        perPlayerColors: "Per-player colours",
        p1Prefix: "P1",
        p2Prefix: "P2",
        p3Prefix: "P3",
        p4Prefix: "P4",
        el: { avatar: "Avatar", name: "Name", score: "Score", average: "Average", history: "History" },
        customColors: "Custom colors",
        nameColor: "Name color",
        scoreColor: "Total score color",
        avgColor: "Averages color",
        historyColor: "History color",
        info: "Resizes/colors the player-card texts. Turn the 'Player Info' module ON. For large fonts, 'Vertical spacing' and 'History table position' help avoid overlap. For colors, enable 'Custom colors'. (Selectors may change after an Autodarts update.)",
        editModeOn: "🖱️ Layout Editor (Beta)",
        editModeOff: "✖ Exit Layout Editor",
        editHint: "BETA: Click an element to select it, drag to move, drag the yellow square to resize. Esc or Exit to finish.",
        editNeedMatch: "Open a match to use the layout editor.",
        editSnapOn: "🧲 Snap ON",
        editSnapOff: "🧲 Snap OFF",
        editCopyToGrid: "Copy 2P→3-4P",
        editCopyToFlat: "Copy 3-4P→2P",
        editCopyToGridConfirm: "This overwrites the 3-4 player layout with the current 2 player layout. Continue?",
        editCopyToFlatConfirm: "This overwrites the 2 player layout with the current 3-4 player layout. Continue?",
        editCopyDone: "Layout copied ✓",
        editWidth: "Width",
        editHeight: "Height",
        editScale: "Scale",
        editFont: "Font size",
        editEnableCustom: "Enable custom colors",
        editEnablePerPlayer: "Enable per-player colors",
        editSharedColor: "Color (shared by all players)",
        editPlayerColor: "Color (this player only)",
        editReset: "Reset element",
        editOpacity: "Opacity",
        editGroupScale: "Corner drag also resizes every element (off = box only). Dragging the card body always moves everything together.",
        editGlobalLabel: {
          throwVal: "Throw value", orig: "Original throw (corner)", total: "Total score",
          checkout: "Checkout suggestion", board: "Board (SVG/image)", undoBtn: "Undo button", nextBtn: "Next button",
          turnBar: "Turn bar (cards + total together)",
        },
      },
      skinText: {
        uiScale: "UI scale",
        spacing: "Player spacing",
        playerBg: "Player card background",
        playerBgOpacity: "Player background opacity",
        bgUrl: "Background image URL",
        overlay: "Overlay opacity",
        autoDisable: "Auto-disable if selectors mismatch after update (recommended)",
      },
      clockText: {
        enabled: "Enable clock",
        scale: "Scale",
        bg: "Background",
        bgAlpha: "Background opacity",
        text: "Text color",
        format24: "24-hour format",
        seconds: "Show seconds",
        resetLook: "Reset clock style",
        resetPos: "Reset clock position",
        hint: "Move: drag the clock. Scale: Ctrl+↑ / Ctrl+↓ (or Ctrl+wheel). Double-click: 24h toggle. Shift+double: seconds toggle. Hotkeys: Shift+T clock toggle, Shift+R reset clock."
      },
      helpHtml: `
        <div style="font-weight:900;margin-bottom:6px">⌨️ Hotkeys</div>
        <div><b>Shift+F</b> panel toggle</div>
        <div><b>ESC</b> close</div>
        <div><b>Shift+1/2/3</b> Preset A/B/C</div>
        <div><b>Shift+M</b> Safe Mode toggle</div>
        <div><b>Shift+H</b> Help toggle</div>
        <div style="margin-top:8px;opacity:.8">Tip: modules with the small “sliders” icon next to the name have extra settings.</div>
      `,
      alerts: {
        invalidJson: "❌ File is not valid JSON",
        invalidPreset: "❌ Invalid preset format",
      },
      toasts: {
        preset: (p)=>`Preset ${p} ✓`,
        export: "Export ✓",
        import: "Import ✓",
        themeApplied: "Theme applied →",
        posSaved: "Panel position saved ✓",
        btnPosSaved: "Main button position saved ✓",
        posReset: "Panel position reset ✓",
        btnPosReset: "Main button reset ✓",
        safeOn: "Safe Mode ✓",
        safeOff: "Safe Mode OFF",
        compactOn: "Compact ✓",
        compactOff: "Compact OFF",
        resetTab: "Reset ✓",
        resetPreset: "Preset reset ✓",
        resetAll: "Reset ✓",
        marker: "Marker ✓",
        clockOn: "Clock ON ✓",
        clockOff: "Clock OFF",
        clockSaved: "Clock saved ✓",
        skinOn: "Skin ON ✓",
        skinOff: "Skin OFF",
        skinWarn: "Skin: Autodarts update? (selector mismatch) – the Skin CSS selectors may need an update.",
        lang: "Language updated ✓",
        skinAutoOff: "Skin AUTO-OFF (selector mismatch) ✓",
      }
    },

    de: {
      appTitle: "🎯 Autodarts CORE",
      modulesTitle: "Schalter / Module",
      help: "Hilfe",
      close: "Schließen",
      export: "Export",
      import: "Import",
      themesTitle: "Themen",
      themeTarget: "Laden in:",
      themeFromFile: "Thema aus Datei",
      themeBrowse: "Themen (GitHub)",
      themeExportPreset: "Preset als Thema exportieren",
      themeLoading: "Lädt…",
      themeEmpty: "Keine Themen verfügbar.",
      themeLoadError: "Thema konnte nicht geladen werden",
      activeRefresh: "Aktualisierung aktiv (ms)",
      activeRefreshHint: "Erkennung aktiver Spieler (Polling). 0 = nur DOM. Wenn es verzögert: 100–200ms.",
      preset: "Preset",
      reset: "Reset",
      resetPreset: "Preset zurücksetzen",
      resetAll: "ALLES RESET",
      resetAllConfirm: "Alles auf Standard zurücksetzen? (Presets + UI)",
      saved: "Gespeichert ✓",
      posReset: "Panel-Position reset",
      btnPosReset: "Hauptbutton-Pos reset",
      safeMode: "Safe Mode (empfohlen)",
      compact: "Kompaktmodus",
      hotkeysLine: "Hotkeys: Shift+F Panel • Shift+1/2/3 Preset • Shift+M Safe • Shift+H Hilfe • ESC schließen",
      hintConfig: "Einstellungen →",
      iconConfigTitle: "Einstellbar (Zeile klicken)",
      markerNow: "Marker jetzt aktualisieren",
      markerInfo: "Board Marker: markiert das Board-SVG (ad-board-svg). Anlassen, wenn dein Board-Skin darauf basiert.",
      bmInfo: "Fügt auf /boards einen 'Zurück zu Autodarts' Button hinzu (für Touch/Fullscreen hilfreich).",
      bmBackLabel: "Zurück zu Autodarts",
      skinInfo: "Skin/Layout: Wenn du Stylebot auf dieser Seite verwendest, schalte ihn aus, weil er mit diesem Userscript kollidieren kann. (Nach Autodarts-Updates können sich css-xxxxx Klassennamen ändern; dann müssen die CSS-Selektoren aktualisiert werden.)",
      diagCopy: "Debug-Info kopieren",
      diagGenOverrides: "Preset-A-Standardwerte generieren",
      diagSelectors: "Selektor-Check",
      diagOk: "OK",
      diagMissing: "FEHLT",
      diagOptional: "OPTIONAL",
      tab: {
        general:  "Allgemein",
        skin:     "Skin / Layout",
        board:    "Werkzeug – Board Marker",
        bmback:   "Werkzeug – Zurück-Button (/boards)",
        throws:   "Anzeige – Wurfpunkte",
        orig:     "Anzeige – Eckenlabel (T20)",
        total:    "Anzeige – Gesamtwert",
        checkout: "Anzeige – Checkout-Tipp",
        playerinfo: "Anzeige – Spieler-Info",
        active:   "Hervorhebung – Aktiver Spieler",
        triple:   "Animation – Triple-Treffer",
        double:   "Animation – Doppel-Treffer",
        highscore: "Animation – Hoher Punktwert",
        fx: "Effekte (Matrix)",
        win:      "Sound – Sieg",
        clock:    "Widget – Uhr",
        diag: "Diagnose",
      },
      fxTriggers: { TRIPLE: "3x", DOUBLE: "2x", DBLSTREAK: "2xD", T1: "100+", T2: "140+", T3: "180" },
      fxEffects: {
        SPARK: "Funke", GLOW: "Glühen", CONFETTI: "Konfetti", FIREWORKS: "Feuerwerk",
        LIGHTNING: "Blitz", SMOKE: "Rauch", CROWD: "Menge", EXPLODE: "Board-Explosion",
        DINO: "Dino", CANNONS: "Konfetti-Kanonen",
      },
      fields: {
        bg: "Hintergrund",
        bgOpacity: "Hintergrund-Transparenz",
        hoverBg: "Hover Hintergrund",
        hoverOpacity: "Hover Transparenz",
        fontSize: "Schriftgröße",
        color: "Farbe",
        opacity: "Transparenz",
        outline: "Rahmenstärke",
        glow: "Glow Stärke",
        trailEnabled: "Drehender Leuchtstrahl",
        trailSpeed: "Leuchtstrahl Geschwindigkeit",
        trailColor: "Leuchtstrahl Farbe",
        glowColor: "Glow Farbe",
        flashEnabled: "Blitzen",
        spinEnabled: "Board drehen",
        spinDuration: "Drehdauer",
        boardFlash: "Board-Blitz",
        throwFlash: "Wurfkarten-Blitz",
        spinMin: "Drehen ab Wert",
        varietyEnabled: "Abwechslungsreiche Animation",
        tier2: "Stufe 2 (Ton-Forty)",
        tier3: "Stufe 3 (Max/180)",
        bannerEnabled: "\"ONE HUNDRED AND EIGHTY!\" Banner",
        fire26Enabled: "🔥 Board fängt bei 26 Feuer",
        doubleStreak: "\"DOUBLE, DOUBLE!!\" Banner (2+ Doppel)",
        fxMatrixInfo: "Feineinstellung für Feuerwerk, Konfetti, Blitz, Rauch, Menge usw. im Modul \"Effekte\" - eine Tabelle, welcher Effekt bei welchem Treffer ausgelöst wird.",
        fxMasterEnabled: "Effekt-Matrix AN",
        fxSoundEnabled: "Effekt-Sound (synthetisiert)",
        perPlayer: "Pro Spieler",
        p1: "S1",
        p2: "S2",
        p3: "S3",
        p4: "S4",
        threshold: "Punktschwelle",
        highlightSpeed: "Highlight Speed",
        numberAnim: "Zahlenanimation",
        rattleDur: "Wackeln Dauer",
        rattleDelay: "Wackeln Verzögerung",
        volume: "Lautstärke",
      },
      totalInfo: "Fix: Total nutzt ein Overlay – Einstellungen wirken immer, Kartenhöhe bleibt stabil.",
      piText: {
        name: "Name Schriftgröße",
        score: "Gesamtpunktzahl Schriftgröße",
        average: "Durchschnitte Schriftgröße",
        history: "Wurf-Verlauf Schriftgröße",
        spacing: "Vertikaler Abstand",
        avatarPos: "Avatar Position (hoch/runter)",
        historyPos: "Verlauf-Tabelle Position",
        historyWidth: "Verlauf-Tabelle Breite (0 = auto)",
        historyHeight: "Verlauf-Tabelle Höhe (0 = auto)",
        avatarSize: "Avatar Größe",
        cardWidth: "Karten-Breite (0 = Standard)",
        cardHeight: "Karten-Höhe (0 = Standard)",
        secSizes: "Größen",
        secPos: "Positionierung (↔ horizontal / ↕ vertikal)",
        secCard: "Spielerkarte",
        secColors: "Farben",
        secEffect: "Text-Effekt",
        effectStyle: "Effekt",
        effectSize: "Effekt-Größe",
        effectColor: "Effekt-Farbe",
        addEffect: "Effekt hinzufügen",
        fxNone: "Keiner", fxOutline: "Umriss", fxEmboss: "Relief", fxGlow: "Leuchten", fxShadow: "Schatten",
        alignP1: "Spieler 1 ausrichten ↕",
        alignP2: "Spieler 2 ausrichten ↕",
        alignP3: "Spieler 3 ausrichten ↕",
        alignP4: "Spieler 4 ausrichten ↕",
        secGrid: "3-4 Spieler Anpassung",
        gridAdjust: "Skalieren bei 3-4 Spielern",
        gridScale: "3-4 Skalierung",
        gridIndependentInfo: "Tipp: Öffne den Layout-Editor (Beta) während eines 3-4-Spieler-Matches, um das 3-4-Spieler-Layout (Größe/Position) komplett unabhängig vom 2-Spieler-Layout anzupassen. Solange du nichts änderst, wird es automatisch aus der obigen Skalierung abgeleitet.",
        perPlayerColors: "Farben pro Spieler",
        p1Prefix: "S1",
        p2Prefix: "S2",
        p3Prefix: "S3",
        p4Prefix: "S4",
        el: { avatar: "Avatar", name: "Name", score: "Punkte", average: "Schnitt", history: "Verlauf" },
        customColors: "Eigene Farben",
        nameColor: "Name Farbe",
        scoreColor: "Gesamtpunktzahl Farbe",
        avgColor: "Durchschnitte Farbe",
        historyColor: "Verlauf Farbe",
        info: "Ändert Größe/Farbe der Spielerkarten-Texte. Schalter 'Spieler-Info' aktivieren. Bei großen Schriften helfen 'Vertikaler Abstand' und 'Verlauf-Tabelle Position' gegen Überlappung. Für Farben 'Eigene Farben' aktivieren. (Selektoren können sich nach einem Autodarts-Update ändern.)",
        editModeOn: "🖱️ Layout-Editor (Beta)",
        editModeOff: "✖ Editor beenden",
        editHint: "BETA: Klick auf ein Element zum Auswählen, ziehen zum Verschieben, das gelbe Quadrat zum Ändern der Größe. Esc oder Beenden zum Schließen.",
        editNeedMatch: "Öffne ein Match, um den Layout-Editor zu nutzen.",
        editSnapOn: "🧲 Einrasten AN",
        editSnapOff: "🧲 Einrasten AUS",
        editCopyToGrid: "2P→3-4P kopieren",
        editCopyToFlat: "3-4P→2P kopieren",
        editCopyToGridConfirm: "Dies überschreibt das 3-4-Spieler-Layout mit dem aktuellen 2-Spieler-Layout. Fortfahren?",
        editCopyToFlatConfirm: "Dies überschreibt das 2-Spieler-Layout mit dem aktuellen 3-4-Spieler-Layout. Fortfahren?",
        editCopyDone: "Layout kopiert ✓",
        editWidth: "Breite",
        editHeight: "Höhe",
        editScale: "Größe (scale)",
        editFont: "Schriftgröße",
        editEnableCustom: "Eigene Farben aktivieren",
        editEnablePerPlayer: "Farben je Spieler aktivieren",
        editSharedColor: "Farbe (gemeinsam für alle Spieler)",
        editPlayerColor: "Farbe (nur dieser Spieler)",
        editReset: "Element zurücksetzen",
        editOpacity: "Deckkraft",
        editGroupScale: "Eckenziehen skaliert auch alle Elemente (aus = nur Box). Ziehen der Karte selbst bewegt immer alles zusammen.",
        editGlobalLabel: {
          throwVal: "Wurfwert", orig: "Ursprünglicher Wurf (Ecke)", total: "Gesamtpunktzahl",
          checkout: "Checkout-Vorschlag", board: "Board (SVG/Bild)", undoBtn: "Rückgängig-Button", nextBtn: "Weiter-Button",
          turnBar: "Wurfleiste (Karten + Gesamtpunktzahl zusammen)",
        },
      },
      skinText: {
        uiScale: "UI Skalierung",
        spacing: "Spieler-Abstand",
        playerBg: "Player-Karten Hintergrund",
        playerBgOpacity: "Player-Hintergrund Transparenz",
        bgUrl: "Hintergrundbild URL",
        overlay: "Overlay-Transparenz",
        autoDisable: "Auto-Deaktivieren bei Selektor-Mismatch nach Update (empfohlen)",
      },
      clockText: {
        enabled: "Uhr aktivieren",
        scale: "Größe",
        bg: "Hintergrund",
        bgAlpha: "Hintergrund-Transparenz",
        text: "Textfarbe",
        format24: "24h Format",
        seconds: "Sekunden anzeigen",
        resetLook: "Uhr-Stil Reset",
        resetPos: "Uhr-Position Reset",
        hint: "Bewegen: Uhr ziehen. Größe: Ctrl+↑ / Ctrl+↓ (oder Ctrl+Rad). Doppelklick: 24h Toggle. Shift+Doppelklick: Sekunden Toggle. Hotkeys: Shift+T Uhr Toggle, Shift+R Uhr Reset."
      },
      helpHtml: `
        <div style="font-weight:900;margin-bottom:6px">⌨️ Hotkeys</div>
        <div><b>Shift+F</b> Panel ein/aus</div>
        <div><b>ESC</b> schließen</div>
        <div><b>Shift+1/2/3</b> Preset A/B/C</div>
        <div><b>Shift+M</b> Safe Mode</div>
        <div><b>Shift+H</b> Hilfe</div>
        <div style="margin-top:8px;opacity:.8">Tipp: Module mit dem kleinen “Sliders”-Icon neben dem Namen haben Extra-Einstellungen.</div>
      `,
      alerts: {
        invalidJson: "❌ Datei ist kein gültiges JSON",
        invalidPreset: "❌ Ungültiges Preset-Format",
      },
      toasts: {
        preset: (p)=>`Preset ${p} ✓`,
        export: "Export ✓",
        import: "Import ✓",
        themeApplied: "Thema angewendet →",
        posSaved: "Panel-Position gespeichert ✓",
        btnPosSaved: "Hauptbutton-Pos gespeichert ✓",
        posReset: "Panel-Pos reset ✓",
        btnPosReset: "Button reset ✓",
        safeOn: "Safe Mode ✓",
        safeOff: "Safe Mode OFF",
        compactOn: "Kompakt ✓",
        compactOff: "Kompakt OFF",
        resetTab: "Reset ✓",
        resetPreset: "Preset reset ✓",
        resetAll: "Reset ✓",
        marker: "Marker ✓",
        clockOn: "Uhr AN ✓",
        clockOff: "Uhr AUS",
        clockSaved: "Uhr gespeichert ✓",
        skinOn: "Skin AN ✓",
        skinOff: "Skin AUS",
        skinWarn: "Skin: Autodarts Update? (Selektor passt nicht) – ggf. Skin-CSS-Selektoren aktualisieren.",
        lang: "Sprache aktualisiert ✓",
        skinAutoOff: "Skin AUTO-AUS (Selektor-Mismatch) ✓",
      }
    }
  };

  function lang() {
    const l = state?.ui?.lang;
    return (l === "en" || l === "de") ? l : "hu";
  }
  function T() { return I18N[lang()]; }

  /* ================== CONSTANTS ================== */
  const WIN_URL = "https://github.com/Szala86/autodarts-audio/releases/download/v1/win.mp3";
  // Built-in backgrounds (hosted in this repo) selectable in Skin / Layout
  const BG_REPO = "https://raw.githubusercontent.com/DDmonkeytron/autodartstampermonkey/main/";
  const BG_PRESETS = [
    { name: "Arena Green", url: BG_REPO + "Background.jpg" },
    { name: "Neon Blue",   url: BG_REPO + "NeonBlueBG.png" },
  ];
  // Community/gallery themes (flat config-diff JSON files hosted in this repo's presets/ folder)
  const THEMES_MANIFEST_URL = BG_REPO + "presets/index.json";
  const THEME_FILE_URL = (file) => BG_REPO + "presets/" + file;
  const TRIPLE_VALUES = ["T20","T19","T18","T17","T16","T15","T7","BULL","SBULL","DBULL","25","50"];
  const DOUBLE_VALUES = ["D1","D2","D3","D4","D5","D6","D7","D8","D9","D10","D11","D12","D13","D14","D15","D16","D17","D18","D19","D20","D25","DBULL"];

  const HOTKEY_PANEL = { shift: true, ctrl: false, alt: false, key: "f" };
  const HOTKEY_HELP  = { shift: true, ctrl: false, alt: false, key: "h" };
  const HOTKEY_SAFE  = { shift: true, ctrl: false, alt: false, key: "m" };
  const HOTKEY_PRESET_1 = { shift: true, ctrl: false, alt: false, key: "1" };
  const HOTKEY_PRESET_2 = { shift: true, ctrl: false, alt: false, key: "2" };
  const HOTKEY_PRESET_3 = { shift: true, ctrl: false, alt: false, key: "3" };

  const HOTKEY_CLOCK_TOGGLE = { shift: true, ctrl: false, alt: false, key: "t" };
  const HOTKEY_CLOCK_RESET  = { shift: true, ctrl: false, alt: false, key: "r" };

  const SAFE_LIMITS = { THROW_VAL_FONT_PX: 130, ORIG_FONT_PX: 38, TOTAL_FONT_PX: 130, CHECKOUT_FONT_PX: 130, ACTIVE_OUTLINE_PX: 6, ACTIVE_P2_OUTLINE_PX: 6, ACTIVE_P3_OUTLINE_PX: 6, ACTIVE_P4_OUTLINE_PX: 6,
    PI_NAME_FONT_PX: 80, PI_SCORE_FONT_PX: 220, PI_AVG_FONT_PX: 80, PI_HISTORY_FONT_PX: 90 };
  const EXT_LIMITS  = { THROW_VAL_FONT_PX: 220, ORIG_FONT_PX: 80, TOTAL_FONT_PX: 220, CHECKOUT_FONT_PX: 220, ACTIVE_OUTLINE_PX: 12, ACTIVE_P2_OUTLINE_PX: 12, ACTIVE_P3_OUTLINE_PX: 12, ACTIVE_P4_OUTLINE_PX: 12,
    PI_NAME_FONT_PX: 200, PI_SCORE_FONT_PX: 360, PI_AVG_FONT_PX: 200, PI_HISTORY_FONT_PX: 200 };

  const FONT_LINK_ID = "ad-font-barlow-condensed-core";
  const STYLE_ID = "ad-style-core-v245";
  const UI_STYLE_ID = "ad-core-ui-style-v245";
  const EXTRA_STYLE_ID = "ad-style-core-skin-v245";

  const ACTIVE_CLASS = "ad-active-player";
  const TRIPLE_CLASS = "ad-triple-hit";
  const DOUBLE_CLASS = "ad-double-hit";
  const HIGHSCORE_CLASS = "ad-highscore-hit";
  const HIGHSCORE_SPIN_CLASS = "ad-highscore-spin";
  const HIGHSCORE_BOARD_FLASH_CLASS = "ad-highscore-board-flash";
  const HIGHSCORE_THROW_CLASS = "ad-highscore-throw-flash";
  const HIGHSCORE_GLOW2_CLASS = "ad-goldglow-flash";
  const BOARD_VISUAL_CLASS = "ad-board-visual";
  const BOARD_IMG_CLASS = "ad-board-img";
  const BOARD_HOST_CLASS = "ad-board-host";

  function parseThrowValue(raw) {
    if (!raw) return 0;
    const s = String(raw).trim().toUpperCase();
    if (s === "BULL" || s === "50" || s === "DBULL") return 50;
    if (s === "SBULL" || s === "25") return 25;
    if (s.startsWith("T")) return (parseInt(s.slice(1), 10) || 0) * 3;
    if (s.startsWith("D")) return (parseInt(s.slice(1), 10) || 0) * 2;
    if (s.startsWith("S")) return (parseInt(s.slice(1), 10) || 0);
    return parseInt(s, 10) || 0;
  }

  const SDT_RE = /^([SDT])(\d{1,2})$/i;
  const CHECKOUT_TOKEN_RE = /^(?:[SDT](?:[1-9]|1\d|20)|BULL|SBULL|DBULL|25|50)$/i;

  // ✅ Sticky selection (kijelölt dobáskártya indexe a turn-ön)
  const TURN_SEL_ATTR = "data-ad-sel-throw-idx";

  /* ================== UTILS ================== */
  function clamp(n, min, max) { return Math.min(Math.max(n, min), max); }
  function sanitizeHex(v, fallback) {
    if (typeof v !== "string") return fallback;
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback;
  }
  function hexToRgbString(hex) {
    hex = sanitizeHex(hex, "#ffffff");
    const r = parseInt(hex.slice(1,3),16);
    const g = parseInt(hex.slice(3,5),16);
    const b = parseInt(hex.slice(5,7),16);
    return `${r}, ${g}, ${b}`;
  }
  function hexToRgba(hex, alpha) {
    hex = sanitizeHex(hex, "#000000");
    alpha = clamp(Number(alpha) || 0.85, 0.1, 1);
    const r = parseInt(hex.slice(1,3),16);
    const g = parseInt(hex.slice(3,5),16);
    const b = parseInt(hex.slice(5,7),16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  function ensureHead(cb) {
    if (document.head) return cb();
    const obs = new MutationObserver(() => { if (document.head) { obs.disconnect(); cb(); } });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }
  function ensureBody(cb) {
    if (document.body) return cb();
    const obs = new MutationObserver(() => { if (document.body) { obs.disconnect(); cb(); } });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }
  
  function matchHotkey(e, def) {
    if (!def) return false;
    if (!!def.shift !== e.shiftKey) return false;
    if (!!def.ctrl  !== e.ctrlKey)  return false;
    if (!!def.alt   !== e.altKey)   return false;
    return (e.key || "").toLowerCase() === def.key.toLowerCase();
  }
  function ensureVisible(x, y, w, h, pad = 8) {
    return { x: clamp(x, pad, window.innerWidth - w - pad), y: clamp(y, pad, window.innerHeight - h - pad) };
  }
  function tryParseJSON(raw) { try { return JSON.parse(raw); } catch { return null; } }

    function sanitizeUrl(u, fallback) {
    try{
      const s = String(u || "").trim();
      if (!s) return fallback;
      const U = new URL(s, location.href);
      if (U.protocol !== "http:" && U.protocol !== "https:") return fallback;
      return U.href;
    }catch{
      return fallback;
    }
  }
  function cssUrl(u) {
    // minimál védelem: ne tudjon idézőjelet / sortörést “kiszúrni” a CSS-be
    return String(u || "").replace(/["\\\n\r]/g, "");
  }

    /* ================== SCOPE (cleanup for listeners/timers) ================== */
  function makeScope(){
    const off = [];
    const timers = new Set();
    return {
      on(target, type, handler, options){
        target.addEventListener(type, handler, options);
        off.push(() => {
          try { target.removeEventListener(type, handler, options); } catch {}
        });
      },
      setTimeout(fn, ms){
        const id = window.setTimeout(() => { timers.delete(id); fn(); }, ms);
        timers.add(id);
        return id;
      },
      setInterval(fn, ms){
        const id = window.setInterval(fn, ms);
        timers.add(id);
        return id;
      },
      abort(){
        // remove listeners
        while (off.length) { try { off.pop()(); } catch {} }
        // clear timers
        for (const t of timers) { clearTimeout(t); clearInterval(t); }
        timers.clear();
      }
    };
  }

  let scopeMain = null; // resize/fullscreen stb.
  let scopeWin  = null; // win-music stop hookok

  /* ================== STATE LOAD/MIGRATE ================== */
  function normalizeState(st) {
    const out = clone(DEFAULT_STATE);
    out.activePreset = clamp(Number(st?.activePreset ?? out.activePreset), 0, PRESET_COUNT - 1);

    out.ui = { ...out.ui, ...(st?.ui || {}) };
    out.ui.clock = { ...clone(DEFAULT_CLOCK), ...(st?.ui?.clock || {}) };
    out.ui.lang = (out.ui.lang === "en" || out.ui.lang === "de") ? out.ui.lang : "hu";

    // Old saved states may have exactly 3 preset slots (A/B/C) - keep them and pad the new
    // D/E/F slots with fresh presetBC() clones rather than discarding the user's tuning.
    out.presets = (Array.isArray(st?.presets) && st.presets.length >= 1)
      ? Array.from({ length: PRESET_COUNT }, (_, i) =>
          st.presets[i]
            ? sanitizeTextEffects({ ...clone(DEFAULT_CFG), ...(st.presets[i] || {}) })
            : (i === 0 ? presetA() : presetBC()))
      : makeDefaultPresets();

    out.schemaVersion = STATE_SCHEMA_VERSION;
    return out;
  }

  const FX_STYLES = ["outline", "emboss", "glow", "shadow"];
  function sanitizeTextEffects(cfgObj) {
    let list = Array.isArray(cfgObj.PI_TEXT_EFFECTS) ? cfgObj.PI_TEXT_EFFECTS : [];
    // migrate the old single-effect keys (<= v2.15.0)
    if (!list.length && cfgObj.PI_TEXT_EFFECT && cfgObj.PI_TEXT_EFFECT !== "none") {
      list = [{ style: cfgObj.PI_TEXT_EFFECT, size: cfgObj.PI_TEXT_EFFECT_SIZE, color: cfgObj.PI_TEXT_EFFECT_COLOR_HEX }];
    }
    cfgObj.PI_TEXT_EFFECTS = list
      .filter(e => e && FX_STYLES.includes(e.style))
      .slice(0, 6)
      .map(e => ({
        style: e.style,
        size: clamp(Math.round(Number(e.size) || 2), 1, 12),
        color: sanitizeHex(e.color, "#000000"),
      }));
    delete cfgObj.PI_TEXT_EFFECT;
    delete cfgObj.PI_TEXT_EFFECT_SIZE;
    delete cfgObj.PI_TEXT_EFFECT_COLOR_HEX;
    return cfgObj;
  }

  function migrateToState(obj) {
    if (obj && obj.state) return migrateToState(obj.state);
    if (obj && typeof obj === "object" && Array.isArray(obj.presets) && obj.presets.length >= 1 && obj.ui) return normalizeState(obj);
    if (obj && typeof obj === "object" && !obj.presets) {
      const base = { ...clone(DEFAULT_CFG), ...obj };
      const st = clone(DEFAULT_STATE);
      st.presets = Array.from({ length: PRESET_COUNT }, () => clone(base));
      return normalizeState(st);
    }
    return clone(DEFAULT_STATE);
  }

  function loadState() {
    const raw = localStorage.getItem(STORE_KEY_STATE);
    if (raw) return migrateToState(tryParseJSON(raw));
    for (const k of LEGACY_KEYS) {
      const r = localStorage.getItem(k);
      if (!r) continue;
      const st = migrateToState(tryParseJSON(r));
      try { localStorage.setItem(STORE_KEY_STATE, JSON.stringify(st)); } catch {}
      return st;
    }
    return clone(DEFAULT_STATE);
  }

  let state = loadState();
  state.schemaVersion = STATE_SCHEMA_VERSION;
  const cfg = () => state.presets[state.activePreset];

  function saveStateNow(){ 
    try { 
      state.schemaVersion = STATE_SCHEMA_VERSION;
      localStorage.setItem(STORE_KEY_STATE, JSON.stringify(state)); 
    } catch {} 
  }
  let saveTimer = null;
  function saveStateDebounced() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveStateNow(); saveTimer = null; }, 250);
  }

  // import legacy clock settings once
  (function importLegacyClockOnce(){
    try{
      const raw = localStorage.getItem(LEGACY_CLOCK_KEY);
      if(!raw) return;
      const legacy = tryParseJSON(raw);
      if(!legacy || typeof legacy !== "object") return;

      const c = state.ui.clock || (state.ui.clock = clone(DEFAULT_CLOCK));
      const looksDefault = (c.x == null && c.y == null && c.scale === 1 && c.bgHex === DEFAULT_CLOCK.bgHex && c.textHex === DEFAULT_CLOCK.textHex);
      if(!looksDefault) return;

      c.enabled     = !!legacy.enabled;
      c.x           = (typeof legacy.x === "number") ? legacy.x : null;
      c.y           = (typeof legacy.y === "number") ? legacy.y : null;
      c.scale       = clamp(Number(legacy.scale ?? 1), 0.6, 2.0);
      c.format24    = (legacy.format24 !== undefined) ? !!legacy.format24 : true;
      c.showSeconds = (legacy.showSeconds !== undefined) ? !!legacy.showSeconds : true;
      c.bgHex       = sanitizeHex(legacy.bgHex, c.bgHex);
      c.bgAlpha     = clamp(Number(legacy.bgAlpha ?? c.bgAlpha), 0.1, 1);
      c.textHex     = sanitizeHex(legacy.textHex, c.textHex);

      saveStateNow();
    }catch{}
  })();

  /* ================== DEFAULT-OVERRIDES DIFF (dev helper) ================== */
  // Diffs a preset's live config against DEFAULT_CFG. Used both by the "generate
  // PRESET_A_OVERRIDES source" debug tool (re-baking the default no longer needs
  // a manual key-by-key diff) and by the theme export/gallery feature below,
  // where a theme file is just this diff serialized as JSON.
  function formatOverrideValue(v) {
    return JSON.stringify(v);
  }
  function diffPresetVsDefault(presetIdx) {
    const live = state.presets[presetIdx] || {};
    const out = {};
    for (const key of Object.keys(DEFAULT_CFG)) {
      const a = live[key];
      const b = DEFAULT_CFG[key];
      if (JSON.stringify(a) !== JSON.stringify(b)) out[key] = a;
    }
    return out;
  }
  function computePresetAOverrides() {
    return diffPresetVsDefault(0);
  }
  function formatPresetAOverridesSource() {
    const diff = computePresetAOverrides();
    const keys = Object.keys(diff);
    if (!keys.length) return "const PRESET_A_OVERRIDES = {};";
    const lines = keys.map(k => `    ${k}: ${formatOverrideValue(diff[k])},`);
    return `const PRESET_A_OVERRIDES = {\n${lines.join("\n")}\n  };`;
  }

  /* ================== THEMES (gallery / file import-export) ================== */
  // A "theme" is just a flat config-diff object (same shape diffPresetVsDefault
  // produces): only the keys that differ from DEFAULT_CFG. Applying one merges
  // it over DEFAULT_CFG and writes the result into a specific preset slot
  // (chosen by the user), leaving the other two presets and UI settings alone.
  function applyThemeDiffToPreset(diffObj, presetIdx) {
    const merged = sanitizeTextEffects({ ...clone(DEFAULT_CFG), ...clone(diffObj || {}) });
    state.presets[presetIdx] = merged;
    if (presetIdx === state.activePreset) {
      applySafeClampsToCfg();
      dirtyTurn(); dirtyPlayers(); dirtyBoard(); dirtyBm(); dirtySkin();
      scheduleUpdate();
    }
    saveStateDebounced();
    renderPanel();
  }

  /* ================== SAFE MODE HELPERS ================== */
  function getMaxFor(key) {
    const safeMax = SAFE_LIMITS[key];
    const extMax = EXT_LIMITS[key];
    if (safeMax == null || extMax == null) return null;
    return state.ui.safeMode ? safeMax : extMax;
  }
  function clampIfSafe(key, value) {
    const safeMax = SAFE_LIMITS[key];
    if (safeMax == null) return value;
    if (!state.ui.safeMode) return value;
    return Math.min(value, safeMax);
  }
  function pillLevel(key, value) {
    const safeMax = SAFE_LIMITS[key];
    if (safeMax == null) return "ok";
    if (value <= safeMax) return "ok";
    if (value <= safeMax * 1.15) return "warn";
    return "danger";
  }
  function applySafeClampsToCfg() {
    if (!state.ui.safeMode) return;
    const c = cfg();
    c.THROW_VAL_FONT_PX = clampIfSafe("THROW_VAL_FONT_PX", c.THROW_VAL_FONT_PX);
    c.ORIG_FONT_PX = clampIfSafe("ORIG_FONT_PX", c.ORIG_FONT_PX);
    c.TOTAL_FONT_PX = clampIfSafe("TOTAL_FONT_PX", c.TOTAL_FONT_PX);
    c.CHECKOUT_FONT_PX = clampIfSafe("CHECKOUT_FONT_PX", c.CHECKOUT_FONT_PX);
    c.ACTIVE_OUTLINE_PX = clampIfSafe("ACTIVE_OUTLINE_PX", c.ACTIVE_OUTLINE_PX);
    c.ACTIVE_P2_OUTLINE_PX = clampIfSafe("ACTIVE_P2_OUTLINE_PX", c.ACTIVE_P2_OUTLINE_PX);
    c.ACTIVE_P3_OUTLINE_PX = clampIfSafe("ACTIVE_P3_OUTLINE_PX", c.ACTIVE_P3_OUTLINE_PX);
    c.ACTIVE_P4_OUTLINE_PX = clampIfSafe("ACTIVE_P4_OUTLINE_PX", c.ACTIVE_P4_OUTLINE_PX);
    c.PI_NAME_FONT_PX = clampIfSafe("PI_NAME_FONT_PX", c.PI_NAME_FONT_PX);
    c.PI_SCORE_FONT_PX = clampIfSafe("PI_SCORE_FONT_PX", c.PI_SCORE_FONT_PX);
    c.PI_AVG_FONT_PX = clampIfSafe("PI_AVG_FONT_PX", c.PI_AVG_FONT_PX);
    c.PI_HISTORY_FONT_PX = clampIfSafe("PI_HISTORY_FONT_PX", c.PI_HISTORY_FONT_PX);
  }

  /* ================== UI INDICATOR (sliders) ================== */
  function slidersTinySvg(size = 14) {
    return `
      <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
           xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M4 7h9" stroke="white" stroke-width="2" stroke-linecap="round"/>
        <path d="M17 7h3" stroke="white" stroke-width="2" stroke-linecap="round"/>
        <circle cx="15" cy="7" r="2" stroke="white" stroke-width="2"/>
        <path d="M4 17h3" stroke="white" stroke-width="2" stroke-linecap="round"/>
        <path d="M11 17h9" stroke="white" stroke-width="2" stroke-linecap="round"/>
        <circle cx="9" cy="17" r="2" stroke="white" stroke-width="2"/>
      </svg>
    `;
  }

  function ensureUIStyle() {
    ensureHead(() => {
      if (document.getElementById(UI_STYLE_ID)) return;
      const st = document.createElement("style");
      st.id = UI_STYLE_ID;
      st.textContent = `
        #ad-core-panel .ad-mod-row{
          transition: transform .16s ease, background .16s ease, box-shadow .16s ease, border-color .16s ease;
        }
        #ad-core-panel .ad-mod-row:hover{ border-color: rgba(255,255,255,0.18) !important; }
        #ad-core-panel .ad-mod-row.is-config:hover{
          transform: translateX(2px);
          background: rgba(255,255,255,0.10) !important;
          box-shadow: 0 10px 26px rgba(0,0,0,0.35);
        }
        #ad-core-panel .ad-mod-icon{
          opacity:.65;
          transform: translateY(1px);
          transition: opacity .16s ease, transform .16s ease, filter .16s ease;
          display:inline-flex;
          align-items:center;
        }
        #ad-core-panel .ad-mod-row.is-config:hover .ad-mod-icon{
          opacity:1;
          transform: translateY(1px) rotate(-6deg) scale(1.05);
          filter: drop-shadow(0 0 10px rgba(255,255,255,0.15));
        }
        #ad-core-panel .ad-mod-hint{
          opacity:0; transform: translateX(-4px);
          transition: opacity .16s ease, transform .16s ease;
          font-size:11px; font-weight:800; padding:4px 8px;
          border-radius:999px; border:1px solid rgba(255,255,255,.14);
          background: rgba(0,0,0,.35); color:#fff; white-space:nowrap;
        }
        #ad-core-panel .ad-mod-row.is-config:hover .ad-mod-hint{ opacity:.85; transform: translateX(0); }
      `;
      document.head.appendChild(st);
    });
  }

  /* ================== CORE CSS ================== */
  function ensureFontLink() {
    const c = cfg();
    const needsFont = c.THROWS_TO_POINTS || c.TOTAL_VIEW || c.CHECKOUT_VIEW;
    if (!needsFont) return;
    if (!document.getElementById(FONT_LINK_ID)) {
      const link = document.createElement("link");
      link.id = FONT_LINK_ID;
      link.rel = "stylesheet";
      link.href = "https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800;900&display=swap";
      document.head.appendChild(link);
    }
  }

  function renderCss() {
    ensureHead(() => {
      ensureFontLink();
      const c = cfg();

      let style = document.getElementById(STYLE_ID);
      if (!style) {
        style = document.createElement("style");
        style.id = STYLE_ID;
        document.head.appendChild(style);
      }

      const activeRGB = hexToRgbString(c.ACTIVE_COLOR_HEX);
      const trailRGB  = hexToRgbString(c.ACTIVE_TRAIL_COLOR_HEX || c.ACTIVE_COLOR_HEX);
      const throwRGB  = hexToRgbString(c.THROW_VAL_COLOR_HEX);
      const origRGB   = hexToRgbString(c.ORIG_COLOR_HEX);
      const totalRGB  = hexToRgbString(c.TOTAL_COLOR_HEX);
      const chkRGB    = hexToRgbString(c.CHECKOUT_COLOR_HEX);
      const throwBgRGB      = hexToRgbString(c.THROW_BG_HEX);
      const throwHoverBgRGB = hexToRgbString(c.THROW_HOVER_BG_HEX);
      const totalBgRGB      = hexToRgbString(c.TOTAL_BG_HEX);
      const tripleGlowRGB   = hexToRgbString(sanitizeHex(c.TRIPLE_GLOW_HEX, "#ff6600"));
      const doubleGlowRGB   = hexToRgbString(sanitizeHex(c.DOUBLE_GLOW_HEX, "#00aaff"));
      const highscoreRGB    = hexToRgbString(sanitizeHex(c.HIGHSCORE_GLOW_HEX, "#ffd700"));
      const css = [];

      css.push(`
:root{
  --ad-active-rgb: ${activeRGB};
  --ad-active-trail-rgb: ${trailRGB};
  --ad-active-outline: ${clamp(+c.ACTIVE_OUTLINE_PX || 3, 0, 12)}px;
  --ad-active-glow: ${clamp(+c.ACTIVE_GLOW || 0.42, 0, 1)};
  --ad-active-trail-speed: ${clamp(+c.ACTIVE_TRAIL_SPEED_MS || 2500, 500, 10000)}ms;
  --ad-active-trail-width: calc(var(--ad-active-outline) + 4px);

  --ad-throw-font: ${clamp(+c.THROW_VAL_FONT_PX || 100, 20, 220)}px;
  --ad-throw-rgb: ${throwRGB};
  --ad-throw-op: ${clamp(+c.THROW_VAL_OPACITY ?? 1, 0, 1)};

  --ad-throw-bg-rgb: ${throwBgRGB};
  --ad-throw-bg-op: ${clamp(+c.THROW_BG_OPACITY ?? 1, 0, 1)};
  --ad-throw-hover-bg-rgb: ${throwHoverBgRGB};
  --ad-throw-hover-bg-op: ${clamp(+c.THROW_HOVER_BG_OPACITY ?? 1, 0, 1)};

  --ad-total-bg-rgb: ${totalBgRGB};
  --ad-total-bg-op: ${clamp(+c.TOTAL_BG_OPACITY ?? 0, 0, 1)};

  --ad-orig-font: ${clamp(+c.ORIG_FONT_PX || 30, 10, 80)}px;
  --ad-orig-rgb: ${origRGB};
  --ad-orig-op: ${clamp(+c.ORIG_OPACITY ?? 0.45, 0, 1)};

  --ad-total-font: ${clamp(+c.TOTAL_FONT_PX || 100, 20, 220)}px;
  --ad-total-rgb: ${totalRGB};
  --ad-total-op: ${clamp(+c.TOTAL_OPACITY ?? 1, 0, 1)};

  --ad-checkout-font: ${clamp(+c.CHECKOUT_FONT_PX || 100, 20, 220)}px;
  --ad-checkout-rgb: ${chkRGB};
  --ad-checkout-op: ${clamp(+c.CHECKOUT_OPACITY ?? 0.55, 0, 1)};

  --ad-triple-shimmer-ms: ${clamp(+c.TRIPLE_SHIMMER_MS || 2000, 400, 6000)}ms;
  --ad-triple-slam-ms: ${clamp(+c.TRIPLE_SLAM_MS || 350, 80, 1200)}ms;
  --ad-triple-rattle-ms: ${clamp(+c.TRIPLE_RATTLE_MS || 500, 80, 2000)}ms;
  --ad-triple-rattle-delay-ms: ${clamp(+c.TRIPLE_RATTLE_DELAY_MS || 0, 0, 2500)}ms;
  --ad-triple-glow-rgb: ${tripleGlowRGB};
  --ad-triple-glow: ${clamp(+c.TRIPLE_GLOW ?? 0.70, 0, 1)};

  --ad-double-shimmer-ms: ${clamp(+c.DOUBLE_SHIMMER_MS || 1400, 400, 6000)}ms;
  --ad-double-slam-ms: ${clamp(+c.DOUBLE_SLAM_MS || 250, 80, 1200)}ms;
  --ad-double-rattle-ms: ${clamp(+c.DOUBLE_RATTLE_MS || 350, 80, 2000)}ms;
  --ad-double-rattle-delay-ms: ${clamp(+c.DOUBLE_RATTLE_DELAY_MS || 0, 0, 2500)}ms;
  --ad-double-glow-rgb: ${doubleGlowRGB};
  --ad-double-glow: ${clamp(+c.DOUBLE_GLOW ?? 0.55, 0, 1)};

  --ad-highscore-shimmer-ms: ${clamp(+c.HIGHSCORE_SHIMMER_MS || 2000, 400, 6000)}ms;
  --ad-highscore-spin-ms: ${clamp(+c.HIGHSCORE_SPIN_MS || 1400, 400, 4000)}ms;
  --ad-highscore-rgb: ${highscoreRGB};
  --ad-highscore-glow: ${clamp(+c.HIGHSCORE_GLOW ?? 0.80, 0, 1)};

  --ad-pi-name-font: ${clamp(+c.PI_NAME_FONT_PX || 18, 8, 200)}px;
  --ad-pi-score-font: ${clamp(+c.PI_SCORE_FONT_PX || 123, 20, 360)}px;
  --ad-pi-avg-font: ${clamp(+c.PI_AVG_FONT_PX || 16, 8, 200)}px;
  --ad-pi-history-font: ${clamp(+c.PI_HISTORY_FONT_PX || 35, 12, 200)}px;
  --ad-pi-name-color: ${sanitizeHex(c.PI_NAME_COLOR_HEX, "#ffffff")};
  --ad-pi-score-color: ${sanitizeHex(c.PI_SCORE_COLOR_HEX, "#ffffff")};
  --ad-pi-avg-color: ${sanitizeHex(c.PI_AVG_COLOR_HEX, "#cfd3d7")};
  --ad-pi-history-color: ${sanitizeHex(c.PI_HISTORY_COLOR_HEX, "#ffffff")};
  --ad-pi-p2-name-color: ${sanitizeHex(c.PI_P2_NAME_COLOR_HEX, "#ffffff")};
  --ad-pi-p2-score-color: ${sanitizeHex(c.PI_P2_SCORE_COLOR_HEX, "#ffffff")};
  --ad-pi-p2-avg-color: ${sanitizeHex(c.PI_P2_AVG_COLOR_HEX, "#cfd3d7")};
  --ad-pi-p2-history-color: ${sanitizeHex(c.PI_P2_HISTORY_COLOR_HEX, "#ffffff")};
  --ad-pi-p3-name-color: ${sanitizeHex(c.PI_P3_NAME_COLOR_HEX, "#ffffff")};
  --ad-pi-p3-score-color: ${sanitizeHex(c.PI_P3_SCORE_COLOR_HEX, "#ffffff")};
  --ad-pi-p3-avg-color: ${sanitizeHex(c.PI_P3_AVG_COLOR_HEX, "#cfd3d7")};
  --ad-pi-p3-history-color: ${sanitizeHex(c.PI_P3_HISTORY_COLOR_HEX, "#ffffff")};
  --ad-pi-p4-name-color: ${sanitizeHex(c.PI_P4_NAME_COLOR_HEX, "#ffffff")};
  --ad-pi-p4-score-color: ${sanitizeHex(c.PI_P4_SCORE_COLOR_HEX, "#ffffff")};
  --ad-pi-p4-avg-color: ${sanitizeHex(c.PI_P4_AVG_COLOR_HEX, "#cfd3d7")};
  --ad-pi-p4-history-color: ${sanitizeHex(c.PI_P4_HISTORY_COLOR_HEX, "#ffffff")};
  --ad-pi-gap: ${clamp(Number.isFinite(+c.PI_STACK_GAP_PX) ? +c.PI_STACK_GAP_PX : 8, 0, 160)}px;
  --ad-pi-avatar-scale: ${clamp(Number.isFinite(+c.PI_AVATAR_SCALE) ? +c.PI_AVATAR_SCALE : 7, 1, 12)};
  --ad-pi-avatar-x: ${clamp(Number.isFinite(+c.PI_AVATAR_X_PX) ? +c.PI_AVATAR_X_PX : 0, -300, 300)}px;
  --ad-pi-avatar-offset: ${clamp(Number.isFinite(+c.PI_AVATAR_OFFSET_PX) ? +c.PI_AVATAR_OFFSET_PX : 0, -300, 300)}px;
  --ad-pi-score-x: ${clamp(Number.isFinite(+c.PI_SCORE_X_PX) ? +c.PI_SCORE_X_PX : 0, -300, 300)}px;
  --ad-pi-score-y: ${clamp(Number.isFinite(+c.PI_SCORE_Y_PX) ? +c.PI_SCORE_Y_PX : 0, -300, 300)}px;
  --ad-pi-name-x: ${clamp(Number.isFinite(+c.PI_NAME_X_PX) ? +c.PI_NAME_X_PX : 0, -300, 300)}px;
  --ad-pi-name-y: ${clamp(Number.isFinite(+c.PI_NAME_Y_PX) ? +c.PI_NAME_Y_PX : 0, -300, 300)}px;
  --ad-pi-avg-x: ${clamp(Number.isFinite(+c.PI_AVG_X_PX) ? +c.PI_AVG_X_PX : 0, -300, 300)}px;
  --ad-pi-avg-y: ${clamp(Number.isFinite(+c.PI_AVG_Y_PX) ? +c.PI_AVG_Y_PX : 0, -300, 300)}px;
  --ad-pi-history-x: ${clamp(Number.isFinite(+c.PI_HISTORY_X_PX) ? +c.PI_HISTORY_X_PX : 0, -300, 300)}px;
  --ad-pi-history-offset: ${clamp(Number.isFinite(+c.PI_HISTORY_OFFSET_PX) ? +c.PI_HISTORY_OFFSET_PX : 0, -200, 500)}px;
  --ad-pi-history-height: ${(+c.PI_HISTORY_HEIGHT_PX > 0) ? clamp(+c.PI_HISTORY_HEIGHT_PX, 80, 900) + "px" : "auto"};
  --ad-pi-card-w: ${(+c.PI_CARD_WIDTH_PX > 0) ? clamp(+c.PI_CARD_WIDTH_PX, 200, 900) + "px" : "auto"};
  --ad-pi-card-h: ${(+c.PI_CARD_HEIGHT_PX > 0) ? clamp(+c.PI_CARD_HEIGHT_PX, 200, 1400) + "px" : "auto"};
}

/* Total overlay: settings apply + card height unchanged */
.ad-total-cell{
  position: relative !important;
  overflow: hidden !important;
  background-color: rgba(var(--ad-total-bg-rgb), var(--ad-total-bg-op)) !important;
  border-radius: 16px !important;

  /* keret le */
  border: none !important;
  outline: none !important;
  box-shadow: none !important;
}

/* overlay csak a szám, ne a háttér */
.ad-total-overlay{
  background: transparent !important;
  border-radius: inherit !important;
  position:absolute !important;
  inset:0 !important;
  display:flex !important;
  align-items:center !important;
  justify-content:center !important;
  width:100% !important;
  height:100% !important;
  pointer-events:none !important;
}
`);

      if (c.ACTIVE_PLAYER_HIGHLIGHT) {
        css.push(`
#ad-ext-player-display > div{ transition: box-shadow .18s ease, outline-color .18s ease, filter .18s ease; }
#ad-ext-player-display > div.${ACTIVE_CLASS}{
  outline: var(--ad-active-outline) solid rgba(var(--ad-active-rgb), .85) !important;
  outline-offset: calc(-1 * var(--ad-active-outline)) !important;
  overflow: visible !important;
  box-shadow:
    0 0 0 1px rgba(255,255,255,.16) inset,
    0 0 36px rgba(var(--ad-active-rgb), calc(var(--ad-active-glow) * 1.0)),
    0 0 110px rgba(var(--ad-active-rgb), calc(var(--ad-active-glow) * 0.66)),
    0 18px 42px rgba(0,0,0,.55) !important;
  filter: brightness(1.05) saturate(1.06) !important;
}
`);
        const activePP = !!c.ACTIVE_PER_PLAYER;
        if (activePP) {
          for (const n of [2, 3, 4]) {
            const rgb = hexToRgbString(sanitizeHex(c[`ACTIVE_P${n}_COLOR_HEX`], "#ffffff"));
            const trailrgb = hexToRgbString(sanitizeHex(c[`ACTIVE_P${n}_TRAIL_COLOR_HEX`] || c[`ACTIVE_P${n}_COLOR_HEX`], "#ffffff"));
            css.push(`
/* Player ${n} active-highlight overrides (Player 1 uses the base values above) */
#ad-ext-player-display > div:nth-child(${n}){
  --ad-active-rgb: ${rgb};
  --ad-active-trail-rgb: ${trailrgb};
  --ad-active-outline: ${clamp(+c[`ACTIVE_P${n}_OUTLINE_PX`] || 3, 0, 12)}px;
  --ad-active-glow: ${clamp(+c[`ACTIVE_P${n}_GLOW`] || 0.42, 0, 1)};
  --ad-active-trail-speed: ${clamp(+c[`ACTIVE_P${n}_TRAIL_SPEED_MS`] || 2500, 500, 10000)}ms;
  --ad-active-trail-width: calc(var(--ad-active-outline) + 4px);
}
`);
            if (!c[`ACTIVE_P${n}_TRAIL`]) css.push(`#ad-ext-player-display > div:nth-child(${n}).${ACTIVE_CLASS}::before{ display:none !important; }`);
          }
          if (!c.ACTIVE_TRAIL) css.push(`#ad-ext-player-display > div:nth-child(1).${ACTIVE_CLASS}::before{ display:none !important; }`);
        }
        const trailOn = activePP ? (c.ACTIVE_TRAIL || c.ACTIVE_P2_TRAIL || c.ACTIVE_P3_TRAIL || c.ACTIVE_P4_TRAIL) : c.ACTIVE_TRAIL;
        if (trailOn) {
          css.push(`
@property --ad-trail-from {
  syntax: '<angle>';
  inherits: false;
  initial-value: 0deg;
}
@keyframes ad-trail-spin {
  from { --ad-trail-from: 0deg; }
  to   { --ad-trail-from: 360deg; }
}
#ad-ext-player-display > div.${ACTIVE_CLASS}::before {
  content: '' !important;
  position: absolute !important;
  inset: calc(-1 * var(--ad-active-trail-width)) !important;
  border-radius: inherit !important;
  padding: var(--ad-active-trail-width) !important;
  background: conic-gradient(
    from var(--ad-trail-from),
    transparent 0deg,
    transparent 210deg,
    rgba(var(--ad-active-trail-rgb), 0.05) 245deg,
    rgba(var(--ad-active-trail-rgb), 0.30) 285deg,
    rgba(var(--ad-active-trail-rgb), 0.80) 335deg,
    rgba(var(--ad-active-trail-rgb), 1.0)  352deg,
    transparent 360deg
  ) !important;
  -webkit-mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0) !important;
  -webkit-mask-composite: destination-out !important;
  mask-composite: exclude !important;
  animation: ad-trail-spin var(--ad-active-trail-speed) linear infinite !important;
  pointer-events: none !important;
  z-index: 20 !important;
  box-sizing: border-box !important;
  filter: drop-shadow(0 0 calc(var(--ad-active-glow) * 12px + 3px) rgba(var(--ad-active-trail-rgb), 0.9)) !important;
}
`);
        }
      }

      if (c.THROWS_TO_POINTS) {
        css.push(`
.ad-ext-turn-throw{ position: relative !important; }
#ad-ext-turn .ad-ext-turn-throw.ad-has-throw,
#ad-ext-turn .ad-ext-turn-throw:has(p[data-adval]){
  background-color: rgba(var(--ad-throw-bg-rgb), var(--ad-throw-bg-op)) !important;
  background-image: none !important;
  border: 1px solid rgba(0,0,0,.25) !important;
}

/* Hover + kattintás + selected állapot: ne szürküljön */
#ad-ext-turn .ad-ext-turn-throw.ad-has-throw:hover,
#ad-ext-turn .ad-ext-turn-throw:has(p[data-adval]):hover,

#ad-ext-turn .ad-ext-turn-throw.ad-has-throw:active,
#ad-ext-turn .ad-ext-turn-throw:has(p[data-adval]):active,

#ad-ext-turn .ad-ext-turn-throw.ad-has-throw:focus,
#ad-ext-turn .ad-ext-turn-throw:has(p[data-adval]):focus,

#ad-ext-turn .ad-ext-turn-throw.ad-has-throw[aria-selected="true"],
#ad-ext-turn .ad-ext-turn-throw:has(p[data-adval])[aria-selected="true"],

#ad-ext-turn .ad-ext-turn-throw.ad-has-throw[aria-current="true"],
#ad-ext-turn .ad-ext-turn-throw:has(p[data-adval])[aria-current="true"],

#ad-ext-turn .ad-ext-turn-throw.ad-has-throw[aria-pressed="true"],
#ad-ext-turn .ad-ext-turn-throw:has(p[data-adval])[aria-pressed="true"],

#ad-ext-turn .ad-ext-turn-throw.ad-has-throw[data-selected="true"],
#ad-ext-turn .ad-ext-turn-throw:has(p[data-adval])[data-selected="true"],

#ad-ext-turn .ad-ext-turn-throw.ad-has-throw[data-active="true"],
#ad-ext-turn .ad-ext-turn-throw:has(p[data-adval])[data-active="true"]{
  background-color: rgba(var(--ad-throw-hover-bg-rgb), var(--ad-throw-hover-bg-op)) !important;
  background-image: none !important;
}
#ad-ext-turn .ad-ext-turn-throw.ad-has-throw,
#ad-ext-turn .ad-ext-turn-throw.ad-has-throw *{ color:#000 !important; }

/* Sticky selected (userscript) – kattintva is maradjon narancs */
#ad-ext-turn .ad-ext-turn-throw.ad-click-selected,
#ad-ext-turn .ad-ext-turn-throw.ad-click-selected:hover{
  background-color: rgba(var(--ad-throw-hover-bg-rgb), var(--ad-throw-hover-bg-op)) !important;
  background-image: none !important;
}

#ad-ext-turn .ad-ext-turn-throw.css-1tv7rud.ad-has-throw,
#ad-ext-turn .ad-ext-turn-throw.css-1tv7rud:has(p[data-adval]){
  background-color: rgba(var(--ad-throw-hover-bg-rgb), var(--ad-throw-hover-bg-op)) !important;
  background-image: none !important;
  border: 1px solid rgba(0,0,0,.25) !important;
}

.ad-ext-turn-throw p{
  position:relative !important;
  display:flex !important;
  align-items:center !important;
  justify-content:center !important;
  width:100% !important;
  height:100% !important;
  padding:10px 12px !important;
  box-sizing:border-box !important;
  font-size:0 !important;
  line-height:1 !important;
}
.ad-ext-turn-throw p::after{
  content: attr(data-adval);
  font-family:'Barlow Condensed', system-ui, sans-serif !important;
  font-weight:800 !important;
  font-size:var(--ad-throw-font) !important;
  line-height:1 !important;
  letter-spacing:1px !important;
  color: rgba(var(--ad-throw-rgb), var(--ad-throw-op)) !important;
}
.ad-ext-turn-throw p:not([data-adval])::after{ content:"" !important; }
`);
        if (c.SHOW_ORIG_IN_CORNER) {
          css.push(`
.ad-ext-turn-throw p::before{
  content: attr(data-adorig);
  position:absolute !important;
  right:10px !important;
  bottom:8px !important;
  font-family:'Barlow Condensed', system-ui, sans-serif !important;
  font-weight:700 !important;
  font-size:var(--ad-orig-font) !important;
  line-height:1 !important;
  letter-spacing:.5px !important;
  color: rgba(var(--ad-orig-rgb), var(--ad-orig-op)) !important;
  pointer-events:none !important;
}
.ad-ext-turn-throw p:not([data-adorig])::before{ content:"" !important; }
`);
        } else {
          css.push(`.ad-ext-turn-throw p::before{ content:"" !important; }`);
        }
      }

      if (c.TOTAL_VIEW) {
        css.push(`
.ad-ext-turn-total-value,
.ad-ext-turn-total-value *{
  font-family:'Barlow Condensed', system-ui, sans-serif !important;
  font-weight:800 !important;
  font-size:var(--ad-total-font) !important;
  line-height:1 !important;
  letter-spacing:1px !important;
  color: rgba(var(--ad-total-rgb), var(--ad-total-op)) !important;
  filter:none !important;
  text-shadow:none !important;
}
`);
      }

      if (c.CHECKOUT_VIEW) {
        css.push(`
.ad-ext-turn-checkout-value,
.ad-ext-turn-checkout-value *{
  font-family:'Barlow Condensed', system-ui, sans-serif !important;
  font-weight:800 !important;
  font-size:var(--ad-checkout-font) !important;
  line-height:1 !important;
  letter-spacing:1px !important;
  color: rgba(var(--ad-checkout-rgb), var(--ad-checkout-op)) !important;
  text-shadow:none !important;
}
`);
      }

      // Board / Undo / Next repositioning (Layout Editor, Beta). translate/scale are independent
      // CSS properties, so they compose with the spin/flash keyframe animations (which animate
      // `transform`) instead of clobbering them - same technique as the Player Info elements.
      // Autodarts renders the board's ambient glow as a box-shadow on the SVG's own parent
      // wrapper (chakra class, unstable - e.g. "css-13u3cwk"), not on the board itself, so the
      // wrapper is the ONLY thing that gets translated (verified live: .ad-board-host, when
      // present, IS that same wrapper - both are structurally "the div directly containing the
      // board svg/img" - so putting translate on both it AND the svg double-applied the shift
      // for the svg specifically, since CSS transforms compound down the DOM chain).
      css.push(`
svg.ad-board-svg, img.ad-board-img{
  translate: none !important;
  scale: 1 !important;
}
*:has(> svg.ad-board-svg), *:has(> img.ad-board-img){
  translate: ${clamp(Number.isFinite(+c.BOARD_X_PX) ? +c.BOARD_X_PX : 0, -1000, 1000)}px ${clamp(Number.isFinite(+c.BOARD_Y_PX) ? +c.BOARD_Y_PX : 0, -1000, 1000)}px !important;
  scale: ${clamp(Number.isFinite(+c.BOARD_SCALE) ? +c.BOARD_SCALE : 1, 0.3, 3)} !important;
}
.ad-core-btn-undo{
  translate: ${clamp(Number.isFinite(+c.UNDO_BTN_X_PX) ? +c.UNDO_BTN_X_PX : 0, -1000, 1000)}px ${clamp(Number.isFinite(+c.UNDO_BTN_Y_PX) ? +c.UNDO_BTN_Y_PX : 0, -1000, 1000)}px !important;
  scale: ${clamp(Number.isFinite(+c.UNDO_BTN_SCALE) ? +c.UNDO_BTN_SCALE : 1, 0.3, 3)} !important;
}
.ad-core-btn-next{
  translate: ${clamp(Number.isFinite(+c.NEXT_BTN_X_PX) ? +c.NEXT_BTN_X_PX : 0, -1000, 1000)}px ${clamp(Number.isFinite(+c.NEXT_BTN_Y_PX) ? +c.NEXT_BTN_Y_PX : 0, -1000, 1000)}px !important;
  scale: ${clamp(Number.isFinite(+c.NEXT_BTN_SCALE) ? +c.NEXT_BTN_SCALE : 1, 0.3, 3)} !important;
}
#ad-ext-turn{
  translate: ${clamp(Number.isFinite(+c.TURN_BAR_X_PX) ? +c.TURN_BAR_X_PX : 0, -1000, 1000)}px ${clamp(Number.isFinite(+c.TURN_BAR_Y_PX) ? +c.TURN_BAR_Y_PX : 0, -1000, 1000)}px !important;
  scale: ${clamp(Number.isFinite(+c.TURN_BAR_SCALE) ? +c.TURN_BAR_SCALE : 1, 0.3, 3)} !important;
}
`);

      if (c.TRIPLE_ANIM) {
        css.push(`
.${TRIPLE_CLASS}{
  position: relative !important;
  overflow: hidden !important;
  outline: 2px solid rgba(var(--ad-triple-glow-rgb), 0.9) !important;
  outline-offset: 1px !important;
  box-shadow:
    0 0 25px rgba(var(--ad-triple-glow-rgb), var(--ad-triple-glow)),
    0 0 80px rgba(var(--ad-triple-glow-rgb), calc(var(--ad-triple-glow) * 0.5)),
    inset 0 0 20px rgba(var(--ad-triple-glow-rgb), 0.25) !important;
}
.${TRIPLE_CLASS}.ad-anim-classic{
  animation:
    adRattle var(--ad-triple-rattle-ms) ease-out var(--ad-triple-rattle-delay-ms) 1,
    adTriplePulse var(--ad-triple-shimmer-ms) ease-in-out infinite${c.TRIPLE_FLASH ? ",\n    adTripleFlash 0.4s ease-out 0ms 4" : ""};
}
.${TRIPLE_CLASS}.ad-anim-punch{
  animation:
    adTriplePulse var(--ad-triple-shimmer-ms) ease-in-out infinite,
    adTripleFlash 0.25s ease-out 0ms 6;
}
.${TRIPLE_CLASS}.ad-anim-wild{
  animation:
    adRattle var(--ad-triple-rattle-ms) ease-out var(--ad-triple-rattle-delay-ms) 1,
    adTriplePulse var(--ad-triple-shimmer-ms) ease-in-out infinite,
    adTripleFlash 0.3s ease-out 0ms 5;
}
.${TRIPLE_CLASS}::after{
  content:'';
  position:absolute;
  inset:0;
  background:linear-gradient(105deg, transparent 30%, rgba(255,255,255,0.55) 50%, transparent 70%);
  transform:translateX(-100%);
  animation: adShimmerSlide var(--ad-triple-shimmer-ms) linear infinite;
  pointer-events:none;
  border-radius:inherit;
  z-index:2;
}
.${TRIPLE_CLASS} p{
  animation: adSlam var(--ad-triple-slam-ms) ease-in 1;
  font-weight:900 !important;
  position:relative;
  z-index:3;
}
.${TRIPLE_CLASS}.ad-anim-punch p{
  animation: adSlamBig var(--ad-triple-slam-ms) ease-in 1;
}
.${TRIPLE_CLASS}.ad-anim-wild p{
  animation: adSlam var(--ad-triple-slam-ms) ease-in 1, adBigPop 0.5s ease-in-out infinite;
}
@keyframes adBigPop{
  0%,100%{ filter: brightness(1) saturate(1); }
  50%{ filter: brightness(1.7) saturate(1.9); }
}
@keyframes adSlamBig{
  0%   { transform: scale(14,14) rotate(8deg); opacity:0; }
  50%  { opacity:0; }
  75%  { transform: scale(0.9,0.9) rotate(-3deg); opacity:1; }
  100% { transform: scale(1,1) rotate(0deg); opacity:1; }
}
@keyframes adTriplePulse{
  0%,100%{
    outline-color: rgba(var(--ad-triple-glow-rgb),0.9);
    box-shadow: 0 0 25px rgba(var(--ad-triple-glow-rgb),var(--ad-triple-glow)), 0 0 80px rgba(var(--ad-triple-glow-rgb),calc(var(--ad-triple-glow)*0.5)), inset 0 0 20px rgba(var(--ad-triple-glow-rgb),0.25);
  }
  50%{
    outline-color: rgba(255,255,255,0.95);
    box-shadow: 0 0 55px rgba(var(--ad-triple-glow-rgb),calc(var(--ad-triple-glow)*1.5)), 0 0 130px rgba(var(--ad-triple-glow-rgb),var(--ad-triple-glow)), inset 0 0 35px rgba(var(--ad-triple-glow-rgb),0.55);
  }
}
@keyframes adTripleFlash{
  0%,100%{ background-color: rgba(var(--ad-throw-bg-rgb),var(--ad-throw-bg-op)); outline-color: rgba(var(--ad-triple-glow-rgb),0.9); }
  25%,75%{ background-color: rgba(var(--ad-triple-glow-rgb),0.7); outline-color: rgba(255,255,255,1); }
  50%    { background-color: rgba(var(--ad-throw-bg-rgb),var(--ad-throw-bg-op)); outline-color: rgba(var(--ad-triple-glow-rgb),0.7); }
}
@keyframes adShimmerSlide{ 0%{transform:translateX(-100%)} 100%{transform:translateX(200%)} }
@keyframes adSlam{
  0%   { transform: scale(10,10); opacity:0; }
  40%  { opacity:0; }
  100% { transform: scale(1,1); opacity:1; }
}
@keyframes adRattle{
  0%  { transform: translate(0,0); }
  10% { transform: translate(-7px,-4px); }
  20% { transform: translate(7px,3px); }
  30% { transform: translate(-6px,5px); }
  40% { transform: translate(5px,-3px); }
  50% { transform: translate(-4px,2px); }
  60% { transform: translate(4px,-4px); }
  70% { transform: translate(-3px,3px); }
  80% { transform: translate(3px,-2px); }
  90% { transform: translate(-2px,1px); }
  100%{ transform: translate(0,0); }
}
`);
      }

      if (c.DOUBLE_ANIM) {
        css.push(`
.${DOUBLE_CLASS}{
  position: relative !important;
  overflow: hidden !important;
  outline: 2px solid rgba(var(--ad-double-glow-rgb), 0.8) !important;
  outline-offset: 1px !important;
  box-shadow:
    0 0 18px rgba(var(--ad-double-glow-rgb), var(--ad-double-glow)),
    0 0 55px rgba(var(--ad-double-glow-rgb), calc(var(--ad-double-glow) * 0.45)),
    inset 0 0 14px rgba(var(--ad-double-glow-rgb), 0.18) !important;
}
.${DOUBLE_CLASS}.ad-anim-classic{
  animation:
    adRattle var(--ad-double-rattle-ms) ease-out var(--ad-double-rattle-delay-ms) 1,
    adDoublePulse var(--ad-double-shimmer-ms) ease-in-out infinite${c.DOUBLE_FLASH ? ",\n    adDoubleFlash 0.4s ease-out 0ms 3" : ""};
}
.${DOUBLE_CLASS}.ad-anim-punch{
  animation:
    adDoublePulse var(--ad-double-shimmer-ms) ease-in-out infinite,
    adDoubleFlash 0.25s ease-out 0ms 5;
}
.${DOUBLE_CLASS}.ad-anim-wild{
  animation:
    adRattle var(--ad-double-rattle-ms) ease-out var(--ad-double-rattle-delay-ms) 1,
    adDoublePulse var(--ad-double-shimmer-ms) ease-in-out infinite,
    adDoubleFlash 0.3s ease-out 0ms 4;
}
.${DOUBLE_CLASS}::after{
  content:'';
  position:absolute;
  inset:0;
  background:linear-gradient(105deg, transparent 30%, rgba(255,255,255,0.4) 50%, transparent 70%);
  transform:translateX(-100%);
  animation: adShimmerSlide var(--ad-double-shimmer-ms) linear infinite;
  pointer-events:none;
  border-radius:inherit;
  z-index:2;
}
.${DOUBLE_CLASS} p{
  animation: adSlam var(--ad-double-slam-ms) ease-in 1;
  font-weight:900 !important;
  position:relative;
  z-index:3;
}
.${DOUBLE_CLASS}.ad-anim-punch p{
  animation: adSlamBig var(--ad-double-slam-ms) ease-in 1;
}
.${DOUBLE_CLASS}.ad-anim-wild p{
  animation: adSlam var(--ad-double-slam-ms) ease-in 1, adBigPop 0.5s ease-in-out infinite;
}
@keyframes adDoublePulse{
  0%,100%{
    outline-color: rgba(var(--ad-double-glow-rgb),0.8);
    box-shadow: 0 0 18px rgba(var(--ad-double-glow-rgb),var(--ad-double-glow)), 0 0 55px rgba(var(--ad-double-glow-rgb),calc(var(--ad-double-glow)*0.45)), inset 0 0 14px rgba(var(--ad-double-glow-rgb),0.18);
  }
  50%{
    outline-color: rgba(255,255,255,0.85);
    box-shadow: 0 0 35px rgba(var(--ad-double-glow-rgb),calc(var(--ad-double-glow)*1.4)), 0 0 90px rgba(var(--ad-double-glow-rgb),var(--ad-double-glow)), inset 0 0 25px rgba(var(--ad-double-glow-rgb),0.4);
  }
}
@keyframes adDoubleFlash{
  0%,100%{ background-color: rgba(var(--ad-throw-bg-rgb),var(--ad-throw-bg-op)); outline-color: rgba(var(--ad-double-glow-rgb),0.8); }
  25%,75%{ background-color: rgba(var(--ad-double-glow-rgb),0.55); outline-color: rgba(255,255,255,0.9); }
  50%    { background-color: rgba(var(--ad-throw-bg-rgb),var(--ad-throw-bg-op)); outline-color: rgba(var(--ad-double-glow-rgb),0.5); }
}
@keyframes adBigPop{
  0%,100%{ filter: brightness(1) saturate(1); }
  50%{ filter: brightness(1.7) saturate(1.9); }
}
@keyframes adSlamBig{
  0%   { transform: scale(14,14) rotate(8deg); opacity:0; }
  50%  { opacity:0; }
  75%  { transform: scale(0.9,0.9) rotate(-3deg); opacity:1; }
  100% { transform: scale(1,1) rotate(0deg); opacity:1; }
}
@keyframes adShimmerSlide{ 0%{transform:translateX(-100%)} 100%{transform:translateX(200%)} }
@keyframes adSlam{
  0%   { transform: scale(10,10); opacity:0; }
  40%  { opacity:0; }
  100% { transform: scale(1,1); opacity:1; }
}
@keyframes adRattle{
  0%  { transform: translate(0,0); }
  10% { transform: translate(-7px,-4px); }
  20% { transform: translate(7px,3px); }
  30% { transform: translate(-6px,5px); }
  40% { transform: translate(5px,-3px); }
  50% { transform: translate(-4px,2px); }
  60% { transform: translate(4px,-4px); }
  70% { transform: translate(-3px,3px); }
  80% { transform: translate(3px,-2px); }
  90% { transform: translate(-2px,1px); }
  100%{ transform: translate(0,0); }
}
`);
      }

      if (c.HIGHSCORE_ANIM) {
        css.push(`
.${HIGHSCORE_CLASS}{
  animation: adHighscoreFlash var(--ad-highscore-shimmer-ms) ease-out 1 !important;
  overflow: visible !important;
}
@keyframes adHighscoreFlash{
  0%   { outline: 4px solid rgba(var(--ad-highscore-rgb),0); box-shadow: none; }
  20%  { outline: 4px solid rgba(var(--ad-highscore-rgb),1); box-shadow: 0 0 60px rgba(var(--ad-highscore-rgb),var(--ad-highscore-glow)), 0 0 120px rgba(var(--ad-highscore-rgb),calc(var(--ad-highscore-glow)*0.5)); }
  40%  { outline: 4px solid rgba(var(--ad-highscore-rgb),0.15); box-shadow: 0 0 15px rgba(var(--ad-highscore-rgb),0.15); }
  60%  { outline: 4px solid rgba(var(--ad-highscore-rgb),0.85); box-shadow: 0 0 50px rgba(var(--ad-highscore-rgb),calc(var(--ad-highscore-glow)*0.85)); }
  80%  { outline: 4px solid rgba(var(--ad-highscore-rgb),0.1); box-shadow: 0 0 8px rgba(var(--ad-highscore-rgb),0.1); }
  100% { outline: 4px solid rgba(var(--ad-highscore-rgb),0); box-shadow: none; }
}
.${HIGHSCORE_THROW_CLASS}{
  animation: adHighscoreThrowFlash 0.4s ease-out 0ms 4 !important;
  outline: 2px solid rgba(var(--ad-highscore-rgb), 0.9) !important;
}
@keyframes adHighscoreThrowFlash{
  0%,100%{ background-color: rgba(var(--ad-throw-bg-rgb),var(--ad-throw-bg-op)); outline-color: rgba(var(--ad-highscore-rgb),0.9); box-shadow: none; }
  25%,75%{ background-color: rgba(var(--ad-highscore-rgb),0.5); outline-color: rgba(255,255,255,1); box-shadow: 0 0 35px rgba(var(--ad-highscore-rgb),0.8); }
  50%    { background-color: rgba(var(--ad-throw-bg-rgb),var(--ad-throw-bg-op)); outline-color: rgba(var(--ad-highscore-rgb),0.5); box-shadow: 0 0 15px rgba(var(--ad-highscore-rgb),0.4); }
}
`);
      }

      // Unified board celebration: spin / flash (triple, double, high score) + fireworks.
      // Matches the marked board (ad-board-host/-visual) AND the raw fallback (svg.ad-board-svg),
      // so the spin works even when the Board Marker module is OFF. Duration is per-trigger via --ad-spin-dur.
      if (c.TRIPLE_SPIN || c.DOUBLE_SPIN || (c.HIGHSCORE_ANIM && (c.HIGHSCORE_SPIN || c.HIGHSCORE_BOARD_FLASH))) {
        css.push(`
.${BOARD_HOST_CLASS}.ad-spin, .${BOARD_VISUAL_CLASS}.ad-spin, svg.ad-board-svg.ad-spin,
.${BOARD_HOST_CLASS}.ad-spin-flash, .${BOARD_VISUAL_CLASS}.ad-spin-flash, svg.ad-board-svg.ad-spin-flash{
  animation: adBoardSpin var(--ad-spin-dur, 1400ms) cubic-bezier(.35,0,.25,1) 1 !important;
  transform-origin: center center !important;
}
.${BOARD_HOST_CLASS}.ad-spin-flash, .${BOARD_VISUAL_CLASS}.ad-spin-flash, svg.ad-board-svg.ad-spin-flash,
.${BOARD_HOST_CLASS}.ad-flash-only, .${BOARD_VISUAL_CLASS}.ad-flash-only, svg.ad-board-svg.ad-flash-only{
  animation: adBoardSpin var(--ad-spin-dur, 1400ms) cubic-bezier(.35,0,.25,1) 1,
             adBoardFlash 0.4s ease-in-out 0ms infinite !important;
  transform-origin: center center !important;
}
.${BOARD_HOST_CLASS}.ad-flash-only, .${BOARD_VISUAL_CLASS}.ad-flash-only, svg.ad-board-svg.ad-flash-only{
  animation: adBoardFlash 0.4s ease-in-out 0ms infinite !important;
}
@keyframes adBoardSpin{
  0%   { transform: rotate(0deg)   scale(1);    }
  15%  { transform: rotate(180deg) scale(1.06); }
  85%  { transform: rotate(1260deg) scale(1.06); }
  100% { transform: rotate(1440deg) scale(1);   }
}
@keyframes adBoardFlash{
  0%,100%{ filter: none; }
  50%    { filter: brightness(2) saturate(2.5) drop-shadow(0 0 22px rgba(var(--ad-highscore-rgb),1)); }
}
`);
      }

      // Effects matrix CSS (SPARK/GLOW/CONFETTI/FIREWORKS/LIGHTNING/SMOKE/CROWD/EXPLODE/DINO/
      // CANNONS): one combined block behind the matrix's master switch, since any of these can
      // now be wired to any trigger (triple/double/double-streak/T1/T2/T3) via runMatrixEffects.
      if (c.FX_MATRIX_ENABLED) {
        css.push(`
#ad-fireworks{ position:fixed; inset:0; pointer-events:none; z-index:2147483600; overflow:hidden; }
.ad-fw-burst{ position:absolute; width:0; height:0; }
.ad-fw-burst i{
  position:absolute; left:0; top:0; width:8px; height:8px; border-radius:50%;
  background: currentColor; box-shadow: 0 0 10px 1px currentColor;
  animation: adFwParticle 1.25s cubic-bezier(.15,.6,.3,1) forwards;
}
@keyframes adFwParticle{
  0%   { transform: translate(0,0) scale(1.2); opacity:1; }
  70%  { opacity:1; }
  100% { transform: translate(var(--tx), calc(var(--ty) + 40px)) scale(0.25); opacity:0; }
}
#ad-spark{ position:fixed; inset:0; pointer-events:none; z-index:2147483597; overflow:hidden; }
.ad-spark-piece{
  position:absolute; width:4px; height:4px; border-radius:50%;
  background: currentColor; box-shadow: 0 0 6px 1px currentColor;
  animation: adSparkBurst 0.22s ease-out forwards;
}
@keyframes adSparkBurst{
  0%   { transform: translate(0,0) scale(1); opacity:1; }
  100% { transform: translate(var(--tx), var(--ty)) scale(0.3); opacity:0; }
}
.${BOARD_HOST_CLASS}.ad-board-implode, .${BOARD_VISUAL_CLASS}.ad-board-implode, svg.ad-board-svg.ad-board-implode{
  animation: adBoardImplode var(--ad-implode-dur, 2000ms) cubic-bezier(.5,0,.4,1) 1 !important;
  transform-origin: center center !important;
}
@keyframes adBoardImplode{
  0%   { transform: scale(1) rotate(0deg);      opacity:1; }
  40%  { transform: scale(0.04) rotate(-18deg); opacity:1; }
  52%  { transform: scale(0.04) rotate(-18deg); opacity:0; }
  58%  { transform: scale(1.4) rotate(6deg);    opacity:1; }
  75%  { transform: scale(1.4) rotate(6deg);    opacity:1; }
  100% { transform: scale(1) rotate(0deg);      opacity:1; }
}
#ad-confetti{ position:fixed; inset:0; pointer-events:none; z-index:2147483600; overflow:hidden; }
.ad-confetti-piece{
  position:absolute; border-radius:2px;
  animation: adConfettiFall 1.8s cubic-bezier(.25,.6,.35,1) forwards;
}
@keyframes adConfettiFall{
  0%   { transform: translate(0,0) rotate(0deg); opacity:1; }
  100% { transform: translate(var(--tx), calc(var(--ty) + 260px)) rotate(var(--rot)); opacity:0; }
}
#ad-dino{
  position:fixed; left:-20vw; bottom:4vh; z-index:2147483601; pointer-events:none;
  animation: adDinoWalk var(--ad-dino-dur, 3200ms) ease-in-out forwards;
}
.ad-dino-body{
  display:inline-block; font-size:22vh; line-height:1;
  animation: adDinoBob 0.32s ease-in-out infinite;
}
#ad-dino.ad-dino-bite .ad-dino-body{
  animation: adDinoBob 0.32s ease-in-out infinite, adDinoBite 0.35s ease-in-out 2;
}
@keyframes adDinoWalk{
  0%   { transform: translateX(0); }
  100% { transform: translateX(var(--ad-dino-end-x, 85vw)); }
}
@keyframes adDinoBob{
  0%,100%{ transform: translateY(0) scaleY(1); }
  50%    { transform: translateY(-1.5vh) scaleY(0.96); }
}
@keyframes adDinoBite{
  0%,100%{ transform: scaleX(1) scaleY(1); }
  50%    { transform: scaleX(1.35) scaleY(0.8); }
}
`);
      }

      // Big flashing banner text - "DOUBLE, DOUBLE!!" (double streak) and/or "ONE HUNDRED AND
      // EIGHTY!" (180) share this CSS, so it needs to exist whenever either could fire.
      if ((c.DOUBLE_ANIM && c.DOUBLE_STREAK_ANIM) || (c.HIGHSCORE_ANIM && c.HIGHSCORE3_ENABLED && c.HIGHSCORE3_BANNER)) {
        css.push(`
#ad-banner{
  position:fixed; left:50%; top:38%; transform:translate(-50%,-50%);
  z-index:2147483610; pointer-events:none; text-align:center;
  font-family: Arial, system-ui, sans-serif; font-weight:900;
  font-size: clamp(28px, 6vw, 96px);
  color:#fff; letter-spacing:1px;
  -webkit-text-stroke: 2px rgba(0,0,0,.6);
  text-shadow: 0 0 18px var(--ad-banner-color,#ffd700), 0 0 46px var(--ad-banner-color,#ffd700), 0 6px 10px rgba(0,0,0,.6);
  animation: adBannerPop var(--ad-banner-hold, 1400ms) cubic-bezier(.2,.9,.25,1) forwards;
}
@keyframes adBannerPop{
  0%   { transform: translate(-50%,-50%) scale(0.2); opacity:0; }
  15%  { transform: translate(-50%,-50%) scale(1.15); opacity:1; }
  25%  { transform: translate(-50%,-50%) scale(1);    opacity:1; }
  85%  { transform: translate(-50%,-50%) scale(1);    opacity:1; }
  100% { transform: translate(-50%,-50%) scale(0.9);  opacity:0; }
}
#ad-banner-flash{
  position:fixed; inset:0; z-index:2147483605; pointer-events:none;
  background: rgba(255,255,255,.85);
  animation: adBannerFlash 0.5s ease-out forwards;
}
@keyframes adBannerFlash{
  0%   { opacity:1; }
  100% { opacity:0; }
}
`);
      }

      // "26" board fire (FIRE26_ENABLED). Unlike the fixed-overlay effects, launchFire26 appends
      // #ad-fire26 as a CHILD of the board host (the div that actually holds the game's board
      // img+svg), so the fire is anchored to the real board and rides its translate/scale/grow
      // instead of being a floating re-render. The ring of fire is a real video (Fireflicker.mp4:
      // a hollow flame ring on solid black) played with mix-blend-mode:screen, so the black drops
      // out, flames ring the rim and the scoring reads through the empty centre. The host gets
      // .ad-board-fire-mount for the gentle grow (transform-based, so it composes with the
      // individual translate/scale positioning like the spin does).
      if (c.FIRE26_ENABLED) {
        css.push(`
#ad-fire26{
  position:absolute; inset:0; pointer-events:none; z-index:9999; overflow:visible;
}
/* Real ring-of-fire footage (Fireflicker.mp4: hollow flame ring on solid black). screen-blend
   turns the black to transparent, so only the flames show and the scoring reads through the empty
   centre. Scaled > board (var --ad-fire26-scale) so the ring's hole lands on the rim and flames
   lick outward past the edge. Fades in/out over the burn. */
.ad-fire26-video{
  position:absolute; left:50%; top:50%;
  width:var(--ad-fire26-scale,230%); height:var(--ad-fire26-scale,230%);
  transform:translate(-50%,-50%);
  object-fit:fill; pointer-events:none;
  mix-blend-mode:screen;
  animation: adFire26Fade 5000ms ease-out forwards;
}
@keyframes adFire26Fade{
  0%   { opacity:0; }
  5%   { opacity:1; }
  88%  { opacity:1; }
  100% { opacity:0; }
}
/* Gentle board grow + warm bloom on the host. transform-based so it composes with the board's
   translate/scale positioning instead of clobbering it (same technique as the spin/implode). */
.ad-board-fire-mount{
  animation: adBoardFireGrow 5000ms ease-in-out 1 !important;
  transform-origin:center center !important;
  will-change: transform, filter;
}
@keyframes adBoardFireGrow{
  0%   { transform: scale(1);    filter:none; }
  14%  { transform: scale(1.05); filter: brightness(1.12) saturate(1.15) drop-shadow(0 0 22px rgba(255,120,20,0.9)); }
  50%  { transform: scale(1.06); filter: brightness(1.18) saturate(1.3) drop-shadow(0 0 40px rgba(255,80,10,0.95)); }
  86%  { transform: scale(1.035);filter: brightness(1.1) saturate(1.15) drop-shadow(0 0 24px rgba(255,120,20,0.8)); }
  100% { transform: scale(1);    filter:none; }
}
`);
      }

      // Effects matrix, part 2: gold/red score glow, lightning (+ big full-flash variant for the
      // double-double streak), smoke cannons, cheering crowd.
      if (c.FX_MATRIX_ENABLED) {
        css.push(`
.${HIGHSCORE_GLOW2_CLASS}{
  animation: adGoldGlowFlash 1.1s ease-in-out 2 !important;
}
@keyframes adGoldGlowFlash{
  0%,100%{ outline-color: rgba(255,90,40,0); box-shadow:none; }
  50%    { outline: 3px solid rgba(255,215,0,.95); box-shadow: 0 0 40px rgba(255,120,20,.85), 0 0 90px rgba(255,215,0,.6); }
}
#ad-lightning{ position:fixed; inset:0; pointer-events:none; z-index:2147483602; overflow:hidden; }
#ad-lightning.ad-flash{ animation: adLightningScreenFlash 0.35s ease-out; }
@keyframes adLightningScreenFlash{ 0%{ background:rgba(220,235,255,.75);} 100%{ background:rgba(220,235,255,0);} }
#ad-lightning.ad-flash-big{ animation: adLightningBigFlash 0.5s ease-out; }
@keyframes adLightningBigFlash{ 0%{ background:rgba(255,255,255,.95);} 100%{ background:rgba(255,255,255,0);} }
.ad-bolt{ position:absolute; opacity:0; filter: drop-shadow(0 0 10px #cfe8ff); animation: adLightningFlicker 0.5s ease-out forwards; }
.ad-bolt.ad-bolt-big{ filter: drop-shadow(0 0 18px #eaf6ff) drop-shadow(0 0 34px #b9dcff); }
@keyframes adLightningFlicker{
  0%   { opacity:0; }
  8%   { opacity:1; }
  16%  { opacity:0.2; }
  24%  { opacity:1; }
  40%  { opacity:0; }
  100% { opacity:0; }
}
#ad-smoke{ position:fixed; inset:0; pointer-events:none; z-index:2147483599; overflow:hidden; }
.ad-smoke-puff{
  position:absolute; border-radius:50%; background: radial-gradient(circle, rgba(210,210,215,.85), rgba(210,210,215,0) 70%);
  filter: blur(2px);
  animation: adSmokeRise 2.4s ease-out forwards;
}
@keyframes adSmokeRise{
  0%   { transform: translate(0,0) scale(0.4); opacity:.85; }
  100% { transform: translate(var(--tx), var(--ty)) scale(1.8); opacity:0; }
}
#ad-crowd{ position:fixed; left:0; right:0; bottom:0; height:9vh; z-index:2147483598; pointer-events:none; display:flex; align-items:flex-end; justify-content:space-evenly; }
.ad-crowd-fig{ font-size:6vh; line-height:1; animation: adCrowdBounce 0.5s ease-in-out infinite; }
@keyframes adCrowdBounce{
  0%,100%{ transform: translateY(0); }
  50%    { transform: translateY(-2.4vh); }
}
`);
      }

      // Player info text sizing / colors / layout (name / score / averages / history)
      if (c.PLAYER_INFO) {
        const piColor = !!c.PI_CUSTOM_COLORS;
        // 3-4 player grid scale (used to derive PI_G_* values that are left null)
        const gs = clamp(Number(c.PI_GRID_SCALE) || 0.5, 0.2, 1);

        // text effects (stackable): outline -> text-stroke; emboss/glow/shadow -> text-shadow
        const fxList = Array.isArray(c.PI_TEXT_EFFECTS) ? c.PI_TEXT_EFFECTS : [];
        const fxShadows = [];
        let fxStroke = null;
        for (const e of fxList) {
          if (!e || !FX_STYLES.includes(e.style)) continue;
          const sz = clamp(Number(e.size) || 2, 1, 12);
          const col = sanitizeHex(e.color, "#000000");
          if (e.style === "outline") {
            if (!fxStroke || sz > fxStroke.sz) fxStroke = { sz, col }; // only one stroke possible; keep the largest
          } else if (e.style === "emboss") {
            fxShadows.push(`${sz}px ${sz}px ${sz}px rgba(0,0,0,.55)`, `-${sz}px -${sz}px ${sz}px rgba(255,255,255,.35)`);
          } else if (e.style === "glow") {
            fxShadows.push(`0 0 ${sz*3}px ${col}`, `0 0 ${sz*6}px ${col}`);
          } else if (e.style === "shadow") {
            fxShadows.push(`${sz}px ${sz}px ${Math.round(sz*1.5)}px rgba(0,0,0,.7)`);
          }
        }
        let fxDecl = "";
        if (fxStroke) fxDecl += `-webkit-text-stroke: ${fxStroke.sz}px ${fxStroke.col} !important; paint-order: stroke fill !important;`;
        if (fxShadows.length) fxDecl += `text-shadow: ${fxShadows.join(", ")} !important;`;
        if (fxDecl) {
          css.push(`
#ad-ext-player-display .ad-ext-player-name,
#ad-ext-player-display .ad-ext-player-score,
#ad-ext-player-display .ad-core-pi-avg,
#ad-ext-player-display p.css-1j0bqop,
#ad-ext-player-display .css-1u90hiz td,
#ad-ext-player-display .css-1u90hiz th{
  ${fxDecl}
}
`);
        }

        css.push(`
#ad-ext-player-display .ad-ext-player-name{
  font-size: var(--ad-pi-name-font) !important;
  line-height: 1.05 !important;
  white-space: normal !important;
  word-break: break-word !important;
  max-width: 100% !important;
  ${piColor ? "color: var(--ad-pi-name-color) !important;" : ""}
}
/* Name "block": move the whole identity row together (series badge + avatar +
   name + 35+ badge + the translucent backing pill), not just the name text */
#ad-ext-player-display .css-37hv00{
  translate: calc(var(--ad-pi-name-x) + var(--pp-shift-x, 0px)) calc(var(--ad-pi-name-y) + var(--pp-shift-y, 0px)) !important;
}
#ad-ext-player-display .ad-ext-player-score{
  font-size: var(--ad-pi-score-font) !important;
  line-height: 1.0 !important;
  translate: var(--ad-pi-score-x) var(--ad-pi-score-y) !important;
  ${piColor ? "color: var(--ad-pi-score-color) !important;" : ""}
}
/* averages / stats line (JS-tagged; chakra class kept as fallback) */
#ad-ext-player-display .ad-core-pi-avg,
#ad-ext-player-display p.css-1j0bqop{
  font-size: var(--ad-pi-avg-font) !important;
  line-height: 1.15 !important;
  translate: calc(var(--ad-pi-avg-x) + var(--pp-shift-x, 0px)) calc(var(--ad-pi-avg-y) + var(--pp-shift-y, 0px)) !important;
  ${piColor ? "color: var(--ad-pi-avg-color) !important;" : ""}
}
/* recent throw history (chalkboard table) */
#ad-ext-player-display .css-1u90hiz td,
#ad-ext-player-display .css-1u90hiz th{
  font-size: var(--ad-pi-history-font) !important;
  ${piColor ? "color: var(--ad-pi-history-color) !important;" : ""}
}
/* layout: gap in the avatar/score/name stack */
#ad-ext-player-display .ad-ext-player .css-y3hfdd{
  gap: var(--ad-pi-gap) !important;
}
/* history table: span the card + center the table so width grows symmetrically */
#ad-ext-player-display .css-1u90hiz{
  left: 0 !important;
  right: 0 !important;
  width: auto !important;
  max-width: none !important;
  height: var(--ad-pi-history-height) !important;
  display: flex !important;
  justify-content: center !important;
  transform: none !important;
  translate: var(--ad-pi-history-x) var(--ad-pi-history-offset) !important;
}
${(+c.PI_HISTORY_WIDTH_PX > 0) ? `
#ad-ext-player-display .css-1u90hiz table{
  width: var(--ad-pi-history-width) !important;
}` : ""}
/* avatar: position (X/Y via translate) + size (scale); doubled id beats skin specificity */
#ad-ext-player-display#ad-ext-player-display .css-1psdi5l{
  translate: calc(var(--ad-pi-avatar-x) + var(--pp-shift-x, 0px)) calc(var(--ad-pi-avatar-offset) + var(--pp-shift-y, 0px)) !important;
  ${(+c.PI_AVATAR_SCALE !== 7) ? "scale: var(--ad-pi-avatar-scale) !important;" : ""}
}
${(+c.PI_CARD_WIDTH_PX > 0 || +c.PI_CARD_HEIGHT_PX > 0) ? `
/* whole player card resize (doubled id beats skin's per-layout sizing) */
#ad-ext-player-display#ad-ext-player-display > div{
  ${(+c.PI_CARD_WIDTH_PX > 0) ? "width: var(--ad-pi-card-w) !important;" : ""}
  ${(+c.PI_CARD_HEIGHT_PX > 0) ? "height: var(--ad-pi-card-h) !important;" : ""}
}` : ""}
/* per-player alignment nudge (shifts avatar+name+averages of each player; X is for the Layout
   Editor's "move whole card" group-drag, isolated to one player at a time) */
${[1, 2, 3, 4].map((n) => `
#ad-ext-player-display > div:nth-child(${n}){
  --pp-shift-y: ${clamp(Number.isFinite(+c[`PI_P${n}_SHIFT_Y`]) ? +c[`PI_P${n}_SHIFT_Y`] : 0, -200, 200)}px;
  --pp-shift-x: ${clamp(Number.isFinite(+c[`PI_P${n}_SHIFT_X`]) ? +c[`PI_P${n}_SHIFT_X`] : 0, -400, 400)}px;
  /* whole-card position (Layout Editor drag): moves the card box + all contents together */
  translate: ${clamp(Number.isFinite(+c[`PI_P${n}_CARD_X_PX`]) ? +c[`PI_P${n}_CARD_X_PX`] : 0, -1500, 1500)}px ${clamp(Number.isFinite(+c[`PI_P${n}_CARD_Y_PX`]) ? +c[`PI_P${n}_CARD_Y_PX`] : 0, -1500, 1500)}px !important;
}`).join("\n")}
${(piColor && c.PI_PER_PLAYER_COLORS) ? [2,3,4].map(n => `
/* per-player colours: player ${n} overrides (player 1 uses the base colours above) */
#ad-ext-player-display > div:nth-child(${n}) .ad-ext-player-name{ color: var(--ad-pi-p${n}-name-color) !important; }
#ad-ext-player-display > div:nth-child(${n}) .ad-ext-player-score{ color: var(--ad-pi-p${n}-score-color) !important; }
#ad-ext-player-display > div:nth-child(${n}) .ad-core-pi-avg,
#ad-ext-player-display > div:nth-child(${n}) p.css-1j0bqop{ color: var(--ad-pi-p${n}-avg-color) !important; }
#ad-ext-player-display > div:nth-child(${n}) .css-1u90hiz td,
#ad-ext-player-display > div:nth-child(${n}) .css-1u90hiz th{ color: var(--ad-pi-p${n}-history-color) !important; }`).join("\n") : ""}
${(c.PI_GRID_ADJUST) ? (() => {
  // Each PI_G_* key is either an explicit override (independent 3-4p tuning) or, when left
  // null, derived from its 2-player counterpart × PI_GRID_SCALE (legacy/back-compat behavior).
  const isNil = (v) => v === null || v === undefined || v === "";
  const gv = (gKey, base2p) => isNil(c[gKey]) ? (Number(base2p) || 0) * gs : (Number(c[gKey]) || 0);

  const nameFontPx  = clamp(gv("PI_G_NAME_FONT_PX", c.PI_NAME_FONT_PX || 18), 8, 200);
  const scoreFontPx = clamp(gv("PI_G_SCORE_FONT_PX", c.PI_SCORE_FONT_PX || 123), 20, 360);
  const avgFontPx   = clamp(gv("PI_G_AVG_FONT_PX", c.PI_AVG_FONT_PX || 16), 8, 200);
  const histFontPx  = clamp(gv("PI_G_HISTORY_FONT_PX", c.PI_HISTORY_FONT_PX || 35), 12, 200);

  const nameX  = clamp(gv("PI_G_NAME_X_PX", c.PI_NAME_X_PX), -900, 900);
  const nameY  = clamp(gv("PI_G_NAME_Y_PX", c.PI_NAME_Y_PX), -900, 900);
  const scoreX = clamp(gv("PI_G_SCORE_X_PX", c.PI_SCORE_X_PX), -900, 900);
  const scoreY = clamp(gv("PI_G_SCORE_Y_PX", c.PI_SCORE_Y_PX), -900, 900);
  const avgX   = clamp(gv("PI_G_AVG_X_PX", c.PI_AVG_X_PX), -900, 900);
  const avgY   = clamp(gv("PI_G_AVG_Y_PX", c.PI_AVG_Y_PX), -900, 900);
  const histX      = clamp(gv("PI_G_HISTORY_X_PX", c.PI_HISTORY_X_PX), -900, 900);
  const histOffset = clamp(gv("PI_G_HISTORY_OFFSET_PX", c.PI_HISTORY_OFFSET_PX), -600, 900);
  const avatarX      = clamp(gv("PI_G_AVATAR_X_PX", c.PI_AVATAR_X_PX), -900, 900);
  const avatarOffset = clamp(gv("PI_G_AVATAR_OFFSET_PX", c.PI_AVATAR_OFFSET_PX), -900, 900);
  const gap          = clamp(gv("PI_G_STACK_GAP_PX", c.PI_STACK_GAP_PX), 0, 160);
  const avatarScale  = clamp(gv("PI_G_AVATAR_SCALE", Number.isFinite(+c.PI_AVATAR_SCALE) ? +c.PI_AVATAR_SCALE : 7), 0.3, 12);

  // Card box: null keeps the original hardcoded 2x2-grid fit; an explicit value overrides it;
  // an explicit 0 means "auto" (no forced size), same convention as the 2-player card fields.
  const gW = c.PI_G_CARD_WIDTH_PX, gH = c.PI_G_CARD_HEIGHT_PX;
  const cardWidthCss  = isNil(gW) ? "411px" : ((+gW > 0) ? clamp(+gW, 150, 900) + "px" : "auto");
  const cardHeightCss = isNil(gH) ? "calc((100vh - 176px) / 2 - 16px)" : ((+gH > 0) ? clamp(+gH, 120, 1400) + "px" : "auto");

  // History table box: null derives from the 2-player width/height (scaled) when one is set,
  // otherwise stays auto; an explicit value (incl. 0 = auto) always wins.
  const histWidthCss = (() => {
    const v = c.PI_G_HISTORY_WIDTH_PX;
    if (isNil(v)) return (+c.PI_HISTORY_WIDTH_PX > 0) ? clamp(+c.PI_HISTORY_WIDTH_PX * gs, 40, 900) + "px" : null;
    return (+v > 0) ? clamp(+v, 40, 900) + "px" : "auto";
  })();
  const histHeightCss = (() => {
    const v = c.PI_G_HISTORY_HEIGHT_PX;
    if (isNil(v)) return (+c.PI_HISTORY_HEIGHT_PX > 0) ? clamp(+c.PI_HISTORY_HEIGHT_PX * gs, 40, 900) + "px" : null;
    return (+v > 0) ? clamp(+v, 40, 900) + "px" : "auto";
  })();

  const shiftFor = (n) => clamp(gv(`PI_G_P${n}_SHIFT_Y`, c[`PI_P${n}_SHIFT_Y`]), -400, 400);
  // No PI_G_*_SHIFT_X override exists (new key, kept simple) - just scale the 2-player value.
  const shiftXFor = (n) => clamp((Number(c[`PI_P${n}_SHIFT_X`]) || 0) * gs, -400, 400);

  return `
/* 3-4 player layout fit: independent sizing when PI_G_* keys are set, otherwise derived from
   the 2-player values × PI_GRID_SCALE (avoids overlap either way) */
#ad-ext-player-display#ad-ext-player-display#ad-ext-player-display:has(> div:nth-child(3)) > div{
  height: ${cardHeightCss} !important;
  width: ${cardWidthCss} !important;
}
#ad-ext-player-display:has(> div:nth-child(3)){
  --ad-pi-name-font: ${nameFontPx}px;
  --ad-pi-score-font: ${scoreFontPx}px;
  --ad-pi-avg-font: ${avgFontPx}px;
  --ad-pi-history-font: ${histFontPx}px;
  --ad-pi-name-x: ${nameX}px; --ad-pi-name-y: ${nameY}px;
  --ad-pi-score-x: ${scoreX}px; --ad-pi-score-y: ${scoreY}px;
  --ad-pi-avg-x: ${avgX}px; --ad-pi-avg-y: ${avgY}px;
  --ad-pi-history-x: ${histX}px; --ad-pi-history-offset: ${histOffset}px;
  --ad-pi-avatar-x: ${avatarX}px; --ad-pi-avatar-offset: ${avatarOffset}px;
  --ad-pi-gap: ${gap}px;
  --ad-pi-avatar-scale: ${avatarScale.toFixed(2)};
  ${histHeightCss ? `--ad-pi-history-height: ${histHeightCss};` : ""}
}
${histWidthCss ? `#ad-ext-player-display:has(> div:nth-child(3)) .css-1u90hiz table{ width: ${histWidthCss} !important; }` : ""}
/* per-player vertical alignment nudge, independent from the 2-player nudge above (higher
   specificity via :has() wins when 3+ players are present) */
#ad-ext-player-display:has(> div:nth-child(3)) > div:nth-child(1){ --pp-shift-y: ${shiftFor(1)}px; --pp-shift-x: ${shiftXFor(1)}px; }
#ad-ext-player-display:has(> div:nth-child(3)) > div:nth-child(2){ --pp-shift-y: ${shiftFor(2)}px; --pp-shift-x: ${shiftXFor(2)}px; }
#ad-ext-player-display:has(> div:nth-child(3)) > div:nth-child(3){ --pp-shift-y: ${shiftFor(3)}px; --pp-shift-x: ${shiftXFor(3)}px; }
#ad-ext-player-display:has(> div:nth-child(3)) > div:nth-child(4){ --pp-shift-y: ${shiftFor(4)}px; --pp-shift-x: ${shiftXFor(4)}px; }
`;
})() : ""}
`);
      }

      style.textContent = css.join("\n");
    });
  }

  /* ================== SKIN / STYLEBOT CSS (INTEGRATED) ================== */
  // ✅ ide került 1:1-ben a Stylebot CSS-ed
  const EXTRA_CSS = String.raw`
:root{
  --ad-ui-scale: 1;
}

:root:has(#ad-ext-turn){
  overflow: hidden !important;
}

:root:has(#ad-ext-turn) body{
  overflow: hidden !important;
}

:root:has(#ad-ext-turn) #root{
  width:  calc(100vw / var(--ad-ui-scale)) !important;
  height: calc(100vh / var(--ad-ui-scale)) !important;

  transform: scale(var(--ad-ui-scale)) !important;
  transform-origin: top left !important;
  will-change: transform;
}

:root {
  --spacing-player: 20px;
}

/* =========================================================
   1–2 játékos:
   ========================================================= */

:root:not(:has(.css-rc3vw3)) #ad-ext-player-display > div:nth-child(1):only-child {
  top: 95px;
  left: 60px;
  height: calc(100% - 100px);
}

:root:not(:has(.css-rc3vw3)) #ad-ext-player-display > div:nth-child(1):nth-last-child(2) {
  top: 95px;
  left: 60px;
  height: calc(100% - 100px);
}

:root:not(:has(.css-rc3vw3)) #ad-ext-player-display > div:nth-child(2):nth-last-child(1) {
  top: 95px;
  right: 60px;
  height: calc(100% - 100px);
}

/* Név pozíció 1–2 játékosnál */
:root:not(:has(.css-rc3vw3)) #ad-ext-player-display:has(> div:nth-child(2):nth-last-child(1)) .css-y3hfdd,
:root:not(:has(.css-rc3vw3)) #ad-ext-player-display:has(> div:only-child) .css-y3hfdd {
  position: absolute;
  top: 14em; /* szabadon állítható */
}

/* =========================================================
   3–4 játékos:
   ========================================================= */

/* 1 (fent bal) */
:root:not(:has(.css-rc3vw3)) #ad-ext-player-display > div:nth-child(1):nth-last-child(3),
:root:not(:has(.css-rc3vw3)) #ad-ext-player-display > div:nth-child(1):nth-last-child(4) {
  top: 95px;
  left: 60px;
  height: calc((105% - 180px) / 2 - var(--spacing-player));
}

/* 2 (fent jobb) */
:root:not(:has(.css-rc3vw3)) #ad-ext-player-display > div:nth-child(2):nth-last-child(2),
:root:not(:has(.css-rc3vw3)) #ad-ext-player-display > div:nth-child(2):nth-last-child(3) {
  top: 95px;
  right: 60px;
  height: calc((105% - 180px) / 2 - var(--spacing-player));
}

/* 3 (lent bal) */
:root:not(:has(.css-rc3vw3)) #ad-ext-player-display > div:nth-child(3):nth-last-child(1),
:root:not(:has(.css-rc3vw3)) #ad-ext-player-display > div:nth-child(3):nth-last-child(2) {
  top: calc(95px + ((100% - 180px) / 2) + var(--spacing-player));
  left: 60px;
  height: calc((105% - 180px) / 2 - var(--spacing-player));
}

/* 4 (lent jobb) */
:root:not(:has(.css-rc3vw3)) #ad-ext-player-display > div:nth-child(4):last-child {
  top: calc(95px + ((100% - 180px) / 2) + var(--spacing-player));
  right: 60px;
  height: calc((105% - 180px) / 2 - var(--spacing-player));
}

/* Név pozíció 3–4 játékosnál */
:root:not(:has(.css-rc3vw3)) #ad-ext-player-display:has(> div:nth-child(3):nth-last-child(2)) .css-y3hfdd,
:root:not(:has(.css-rc3vw3)) #ad-ext-player-display:has(> div:nth-child(4):last-child) .css-y3hfdd {
  position: absolute;
  top: 7em; /* szabadon állítható */
}

/* =========================================================
   5–6 játékos:
   ========================================================= */

:root {
  --row-height-3: calc((108% - 180px) / 3 - var(--spacing-player));
}

/* 1 (fent bal) */
:root:not(:has(.css-rc3vw3)) #ad-ext-player-display > div:nth-child(1):nth-last-child(5),
:root:not(:has(.css-rc3vw3)) #ad-ext-player-display > div:nth-child(1):nth-last-child(6) {
  top: 95px;
  left: 60px;
  height: var(--row-height-3);
}

/* 2 (fent jobb) */
:root:not(:has(.css-rc3vw3)) #ad-ext-player-display > div:nth-child(2):nth-last-child(4),
:root:not(:has(.css-rc3vw3)) #ad-ext-player-display > div:nth-child(2):nth-last-child(5) {
  top: 95px;
  right: 60px;
  height: var(--row-height-3);
}

/* 3 (közép bal) */
:root:not(:has(.css-rc3vw3)) #ad-ext-player-display > div:nth-child(3):nth-last-child(3),
:root:not(:has(.css-rc3vw3)) #ad-ext-player-display > div:nth-child(3):nth-last-child(4) {
  top: calc(95px + ((100% - 180px) / 3) + var(--spacing-player));
  left: 60px;
  height: var(--row-height-3);
}

/* 4 (közép jobb) */
:root:not(:has(.css-rc3vw3)) #ad-ext-player-display > div:nth-child(4):nth-last-child(2),
:root:not(:has(.css-rc3vw3)) #ad-ext-player-display > div:nth-child(4):nth-last-child(3) {
  top: calc(95px + ((100% - 180px) / 3) + var(--spacing-player));
  right: 60px;
  height: var(--row-height-3);
}

/* 5 (lent bal) */
:root:not(:has(.css-rc3vw3)) #ad-ext-player-display > div:nth-child(5):nth-last-child(1),
:root:not(:has(.css-rc3vw3)) #ad-ext-player-display > div:nth-child(5):nth-last-child(2) {
  top: calc(95px + 2 * ((100% - 180px) / 3) + 2 * var(--spacing-player));
  left: 60px;
  height: var(--row-height-3);
}

/* 6 (lent jobb) */
:root:not(:has(.css-rc3vw3)) #ad-ext-player-display > div:nth-child(6):last-child {
  top: calc(95px + 2 * ((100% - 180px) / 3) + 2 * var(--spacing-player));
  right: 60px;
  height: var(--row-height-3);
}

/* Név pozíció 5–6 játékosnál */
:root:not(:has(.css-rc3vw3)) #ad-ext-player-display:has(> div:nth-child(5):nth-last-child(1)) .css-y3hfdd,
:root:not(:has(.css-rc3vw3)) #ad-ext-player-display:has(> div:nth-child(6):last-child) .css-y3hfdd {
  position: absolute;
  top: 2em; /* szabadon állítható */
}

/* =========================================================
   Hover / kattintás vizuál.
   ========================================================= */

:root:not(:has(.css-rc3vw3)) #ad-ext-turn .ad-ext-turn-throw:hover {
  box-shadow: var(--color-shadow-strong);
  transform: scale(1.03);
  cursor: pointer;
}

/* =========================================================
   Konténerek / méretek
   ========================================================= */

:root:not(:has(.css-rc3vw3)) .css-tkevr6 {
  position: relative;
  width: 100%;
  height: 95%;
  box-sizing: border-box;
}

/* Player box szélesség */
:root:not(:has(.css-rc3vw3)) #ad-ext-player-display > div {
  position: absolute;
  width: 411px;
}

/* Scoring + Bullout teljes szélesség */
:root:not(:has(.css-rc3vw3)) .css-1omnor5,
:root:not(:has(.css-rc3vw3)) .css-ul22ge {
  width: 900px;
}

/* Scoring elemek magasság */
:root:not(:has(.css-rc3vw3)) .css-1dkgpmk,
:root:not(:has(.css-rc3vw3)) .css-1wlduvp,
:root:not(:has(.css-rc3vw3)) .css-sm8wdq,
:root:not(:has(.css-rc3vw3)) .css-881tme,
:root:not(:has(.css-rc3vw3)) #ad-ext-turn .css-rrf7rv,
:root:not(:has(.css-rc3vw3)) #ad-ext-turn .score.css-156dsds,
:root:not(:has(.css-rc3vw3)) #ad-ext-turn .ad-ext-turn-throw.css-1p5spmi {
  height: 110px;
}

/* Menüsáv teljes szélesség */
:root:not(:has(.css-rc3vw3)) .css-19lo6pj {
  width: 150%;
}

/* =========================================================
   Chalkboard (1v1)
   ========================================================= */

:root:has(.css-1u90hiz) .css-1u90hiz {
  position: absolute;
  right: 6.2em;
  height: 350px;
  width: 50%;
  top: 500px;
}

:root:has(.css-1u90hiz) tbody tr td {
  font-size: 35px;
  width: 52%;
}

/* =========================================================
   Scoring + board pozíció
   ========================================================= */

:root:not(:has(.css-rc3vw3)):root:not(:has(.css-7lnr9n)):root:not(:has(.css-15suq9)) .css-1emway5,
:root:not(:has(.css-rc3vw3)):root:not(:has(.css-15suq9)) .css-jbngkd,
:root:not(:has(.css-rc3vw3)) .css-1cdcn26 {
  position: relative;
  top: 1em;
}

/* =========================================================
   Avatar: méret + pozíció (1v1)
   ========================================================= */

:root:not(:has(.css-rc3vw3)):root:has(.css-1cdcn26):root:not(:has(#ad-ext-player-display > div:nth-child(3))) div.chakra-stack.css-1psdi5l {
  position: absolute;
  top: -180px;
  left: 50%;
  transform: translate(-3%, -50%);
  scale: 7;
}

:root:not(:has(.css-rc3vw3)):root:has(.css-1cdcn26):root:not(:has(#ad-ext-player-display > div:nth-child(3))) img.chakra-image.css-6t0bzd {
  scale: 0.5;
}

/* =========================================================
   BOARD – Winmau/BladeX look + szürke keret
   ========================================================= */

:root{
  --bladex-black:  #1b1b1b;
  --bladex-cream:  #e9e3d9;
  --bladex-red:    #cf2a2a;
  --bladex-green:  #1f8f3a;
  --bladex-ring:   #2a2f34;
  --bladex-number: #bfc5cb;
}

svg.ad-board-svg{
  filter: none !important;
  opacity: 1 !important;
  border-radius: 50% !important;
  box-shadow:
    0 0 0 6px rgba(207,211,215,.9),
    0 0 0 12px rgba(0,0,0,.35) !important;
}

svg.ad-board-svg [fill="#212121"],
svg.ad-board-svg [fill="#1a1a1a"],
svg.ad-board-svg [fill="#000"],
svg.ad-board-svg [fill="#000000"]{
  fill: var(--bladex-black) !important;
}

svg.ad-board-svg [fill="#f5f5f5"],
svg.ad-board-svg [fill="#ffffff"],
svg.ad-board-svg [fill="#fff"],
svg.ad-board-svg [fill="#F5F5F5"],
svg.ad-board-svg [fill="#FFFFFF"]{
  fill: var(--bladex-cream) !important;
}

svg.ad-board-svg [fill="#e53935"],
svg.ad-board-svg [fill="#ef5350"],
svg.ad-board-svg [fill="#f44336"]{
  fill: var(--bladex-red) !important;
}

svg.ad-board-svg [fill="#43a047"],
svg.ad-board-svg [fill="#66bb6a"],
svg.ad-board-svg [fill="#4caf50"]{
  fill: var(--bladex-green) !important;
}

svg.ad-board-svg [fill="#2b2b2b"],
svg.ad-board-svg [fill="#303030"],
svg.ad-board-svg [fill="#333333"]{
  fill: var(--bladex-ring) !important;
}

svg.ad-board-svg text{
  fill: var(--bladex-number) !important;
}

/* =========================================================
   Háttér – teljes kitöltés (COVER)
   ========================================================= */

:root:has(.css-1cdcn26) body,
:root:has(.css-1cdcn26) #root,
:root:has(.css-1cdcn26) .css-z42oq0,
:root:has(.css-1cdcn26) .css-nfhdnc,
:root:not(:has(.css-1cdcn26)) body,
:root:not(:has(.css-1cdcn26)) #root,
:root:not(:has(.css-1cdcn26)) .css-z42oq0,
:root:not(:has(.css-1cdcn26)) .css-nfhdnc {
  background-color: #081a28 !important;

  background-image:
    linear-gradient(rgba(8,26,40,.55), rgba(8,26,40,.55)),
    url("https://raw.githubusercontent.com/DDmonkeytron/autodartstampermonkey/main/Background.jpg") !important;

  background-repeat: no-repeat !important;
  background-position: center bottom !important;
  background-size: cover !important;
  background-attachment: fixed !important;
}
`;

    // ================== SKIN – selector health-check ==================
  const SKIN_HEALTH_SSKEY = () => `ad_core_skin_sel_warned_${SCRIPT_VERSION}`;
  let skinHealthTimer = 0;
  let skinHealthAttempts = 0;

  function runSkinHealthCheck() {
    const c = cfg();
    if (!c || !c.SKIN_CSS) return;
    if (!location.pathname.startsWith("/matches/")) return;

    const turn = document.querySelector("#ad-ext-turn");
    const players = document.querySelector("#ad-ext-player-display");

    // ha még nem töltött be a meccs UI, próbáljuk újra párszor
    if (!turn || !players) {
      if (skinHealthAttempts++ < 15) scheduleSkinHealthCheck();
      return;
    }

    // Ha egyik ismert Chakra selector sincs, gyanús: Autodarts update / selector drift
    const anyKnown = document.querySelector(
      ".css-tkevr6, .css-19lo6pj, .css-1omnor5, .css-ul22ge, .css-1dkgpmk, .css-1wlduvp, .css-sm8wdq, .css-881tme, .css-rrf7rv, .css-1cdcn26, .css-jbngkd, .css-1emway5"
    );
    if (anyKnown) return;

    // toast csak egyszer / session / verzió
    try {
      if (sessionStorage.getItem(SKIN_HEALTH_SSKEY()) === "1") return;
      sessionStorage.setItem(SKIN_HEALTH_SSKEY(), "1");
    } catch {}

    console.warn("[AD-CORE] Skin health-check: likely selector mismatch after update.");
    const L = T();
    const msg = (L && L.toasts && L.toasts.skinWarn) ? L.toasts.skinWarn : "Skin: selector mismatch";
    if (typeof showToast === "function") showToast(msg);

    // optional auto-disable
    if (c.SKIN_AUTO_DISABLE_ON_MISMATCH) {
      c.SKIN_CSS = false;
      dirtySkin();
      saveStateDebounced();
      scheduleUpdate();

      const L2 = T();
      if (typeof showToast === "function") {
        showToast(L2?.toasts?.skinAutoOff || "Skin AUTO-OFF");
      }
    }
  }

  function scheduleSkinHealthCheck() {
    if (skinHealthTimer) return;
    skinHealthTimer = window.setTimeout(() => {
      skinHealthTimer = 0;
      runSkinHealthCheck();
    }, 1500);
  }

  function ensureSkinCss() {
    ensureHead(() => {
      const c = cfg();
      const on = !!c.SKIN_CSS;

      let st = document.getElementById(EXTRA_STYLE_ID);
      if (!on) {
        if (st) st.remove();
        return;
      }

      if (!st) {
        st = document.createElement("style");
        st.id = EXTRA_STYLE_ID;
      }

      const scale = clamp(Number(c.SKIN_UI_SCALE ?? 1), 0.85, 1.15);
      const spacing = clamp(Number(c.SKIN_SPACING_PLAYER ?? 20), 0, 80);
      const alpha = clamp(Number(c.SKIN_BG_OVERLAY_ALPHA ?? 0.55), 0, 1);
      const url = sanitizeUrl(c.SKIN_BG_URL, DEFAULT_CFG.SKIN_BG_URL);
      const pbgRGB = hexToRgbString(sanitizeHex(c.SKIN_PLAYER_BG_HEX, DEFAULT_CFG.SKIN_PLAYER_BG_HEX));
      const pbgOp  = clamp(Number(c.SKIN_PLAYER_BG_OPACITY ?? DEFAULT_CFG.SKIN_PLAYER_BG_OPACITY), 0, 1);
      const dyn = String.raw`
:root{
  --ad-ui-scale: ${scale};
  --spacing-player: ${spacing}px;
  --ad-bg-overlay-alpha: ${alpha};
  --ad-bg-url: url("${cssUrl(url)}");
  --ad-player-bg-rgb: ${pbgRGB};
  --ad-player-bg-op: ${pbgOp};
}

/* override background-image to use the editable URL + overlay alpha */
:root:has(.css-1cdcn26) body,
:root:has(.css-1cdcn26) #root,
:root:has(.css-1cdcn26) .css-z42oq0,
:root:has(.css-1cdcn26) .css-nfhdnc,
:root:not(:has(.css-1cdcn26)) body,
:root:not(:has(.css-1cdcn26)) #root,
:root:not(:has(.css-1cdcn26)) .css-z42oq0,
:root:not(:has(.css-1cdcn26)) .css-nfhdnc {
  background-image:
    linear-gradient(rgba(8,26,40,var(--ad-bg-overlay-alpha)), rgba(8,26,40,var(--ad-bg-overlay-alpha))),
    var(--ad-bg-url) !important;
}

/* IMPORTANT: keep CORE adjustable card backgrounds even when Skin CSS is ON */
#ad-ext-turn .ad-ext-turn-throw.ad-has-throw{
  background-color: rgba(var(--ad-throw-bg-rgb), var(--ad-throw-bg-op)) !important;
  background-image: none !important;
}
#ad-ext-turn .ad-ext-turn-throw.ad-has-throw:hover{
  background-color: rgba(var(--ad-throw-hover-bg-rgb), var(--ad-throw-hover-bg-op)) !important;
  background-image: none !important;
}

/* ✅ STICKY SELECT: Skin CSS mellett is maradjon hover szín */
#ad-ext-turn .ad-ext-turn-throw.ad-click-selected,
#ad-ext-turn .ad-ext-turn-throw.ad-click-selected:hover{
  background-color: rgba(var(--ad-throw-hover-bg-rgb), var(--ad-throw-hover-bg-op)) !important;
  background-image: none !important;
}

/* Player panelek háttér (Skin/Layout) */
#ad-ext-player-display > div{
  background-color: rgba(var(--ad-player-bg-rgb), var(--ad-player-bg-op)) !important;
}
`;

      st.textContent = EXTRA_CSS + "\n" + dyn;

      const core = document.getElementById(STYLE_ID);
      if (core && core.parentNode) {
        if (!st.parentNode) core.parentNode.appendChild(st);
        if (core.nextSibling !== st) core.after(st);
      } else if (!st.parentNode) {
        document.head.appendChild(st);
        }
        skinHealthAttempts = 0;
        scheduleSkinHealthCheck();
    });
  }

  /* ================== BOARD MARKER ================== */
  function isBoardSvg(svg) {
    if (!svg) return false;
    const pathCount = svg.querySelectorAll("path").length;
    if (pathCount < 40) return false;

    const has20Text = Array.from(svg.querySelectorAll("text")).some(t => (t.textContent || "").trim() === "20");
    const vb = (svg.getAttribute("viewBox") || "").split(/\s+/).map(Number);
    const looksSquareVB = vb.length === 4 && Math.abs((vb[2] || 0) - (vb[3] || 0)) < 5 && (vb[2] || 0) > 300;

    return has20Text || (looksSquareVB && pathCount > 120);
  }

  function isBoardImage(img) {
    if (!img || img.tagName !== "IMG") return false;
    const src = String(img.getAttribute("src") || "").toLowerCase();
    if (!src) return false;

    const w = img.naturalWidth || img.width || img.clientWidth || 0;
    const h = img.naturalHeight || img.height || img.clientHeight || 0;
    const looksSquare = w > 220 && h > 220 && Math.abs(w - h) <= Math.max(24, Math.round(Math.min(w, h) * 0.1));

    const looksBoardSource = src.includes("/api/c") || src.startsWith("blob:");
    const parent = img.parentElement;
    const hasBoardOverlay = !!parent?.querySelector?.("svg[viewBox='0 0 1000 1000']");

    return looksBoardSource && looksSquare && hasBoardOverlay;
  }

  function isBoardHost(el) {
    if (!el || el.tagName !== "DIV") return false;
    const img = el.querySelector(":scope > img");
    const svg = el.querySelector(":scope > svg[viewBox='0 0 1000 1000']");
    if (!img || !svg) return false;

    const r = el.getBoundingClientRect();
    const looksSquare = r.width > 220 && r.height > 220 && Math.abs(r.width - r.height) <= Math.max(24, Math.round(Math.min(r.width, r.height) * 0.12));
    return looksSquare;
  }

  function getBoardVisualTargets() {
    const hosts = Array.from(document.querySelectorAll("." + BOARD_HOST_CLASS));
    if (hosts.length) return hosts;

    const marked = Array.from(document.querySelectorAll("." + BOARD_VISUAL_CLASS));
    if (marked.length) return marked;

    const fallback = [];
    const svg = document.querySelector("svg.ad-board-svg");
    if (svg) fallback.push(svg);

    const imgs = Array.from(document.querySelectorAll("img"));
    for (const img of imgs) {
      if (isBoardImage(img)) fallback.push(img);
    }
    return fallback;
  }

  const SPIN_CLASSES = ["ad-spin", "ad-spin-flash", "ad-flash-only"];
  function clearBoardSpin() {
    for (const cls of SPIN_CLASSES) {
      document.querySelectorAll("." + cls).forEach(el => {
        el.classList.remove(cls);
        if (el.__adSpinT) { clearTimeout(el.__adSpinT); el.__adSpinT = null; }
      });
    }
  }
  // Unified board spin/flash. mode: "spin" | "spin-flash" | "flash". Duration in ms.
  function spinBoard(durationMs, mode = "spin") {
    const dur = clamp(Number(durationMs) || 1400, 300, 15000);
    const cls = mode === "spin-flash" ? "ad-spin-flash" : (mode === "flash" ? "ad-flash-only" : "ad-spin");
    const boards = getBoardVisualTargets();
    for (const board of boards) {
      board.classList.remove("ad-spin", "ad-spin-flash", "ad-flash-only");
      board.style.setProperty("--ad-spin-dur", dur + "ms");
      void board.offsetWidth; // restart animation
      board.classList.add(cls);
      if (board.__adSpinT) clearTimeout(board.__adSpinT);
      board.__adSpinT = setTimeout(() => {
        board.classList.remove(cls);
        board.__adSpinT = null;
      }, dur + 150);
    }
  }

  /* ================== FIREWORKS (CSS particle burst) ================== */
  const FIREWORK_COLORS = ["#ffd700", "#ff4d4d", "#43e0ff", "#5dff8a", "#ff6bff", "#ffffff", "#ff9f1c"];
  // Spawns one radiating particle burst at an explicit screen point (px). Shared by the random-
  // position fireworks loop below and by anything that wants a burst at a specific spot (board
  // explosion, dinosaur chomp) instead of a random one.
  function spawnFireworkBurstAt(overlay, cx, cy, timers, big) {
    const burst = document.createElement("div");
    burst.className = "ad-fw-burst";
    burst.style.left = cx + "px";
    burst.style.top = cy + "px";
    const color = FIREWORK_COLORS[(Math.random() * FIREWORK_COLORS.length) | 0];
    const n = (big ? 36 : 24) + ((Math.random() * (big ? 14 : 10)) | 0);
    for (let i = 0; i < n; i++) {
      const p = document.createElement("i");
      const ang = (i / n) * Math.PI * 2 + Math.random() * 0.25;
      const dist = (big ? 100 : 70) + Math.random() * (big ? 150 : 110);
      p.style.setProperty("--tx", (Math.cos(ang) * dist).toFixed(1) + "px");
      p.style.setProperty("--ty", (Math.sin(ang) * dist).toFixed(1) + "px");
      p.style.color = (Math.random() < 0.25) ? FIREWORK_COLORS[(Math.random() * FIREWORK_COLORS.length) | 0] : color;
      const s = ((big ? 7 : 5) + Math.random() * (big ? 8 : 6)).toFixed(1);
      p.style.width = s + "px"; p.style.height = s + "px";
      burst.appendChild(p);
    }
    overlay.appendChild(burst);
    timers.push(setTimeout(() => burst.remove(), 1400));
  }

  let fireworksTimers = [];
  function stopFireworks() {
    fireworksTimers.forEach(t => clearTimeout(t) || clearInterval(t));
    fireworksTimers = [];
    const ov = document.getElementById("ad-fireworks");
    if (ov) ov.remove();
  }
  function launchFireworks(durationMs, big) {
    const dur = clamp(Number(durationMs) || 7000, 800, 30000);
    stopFireworks();
    const overlay = document.createElement("div");
    overlay.id = "ad-fireworks";
    (document.body || document.documentElement).appendChild(overlay);

    const spawn = () => {
      const cx = (8 + Math.random() * 84) / 100 * innerWidth;
      const cy = (10 + Math.random() * 55) / 100 * innerHeight;
      spawnFireworkBurstAt(overlay, cx, cy, fireworksTimers, big);
    };

    spawn();
    fireworksTimers.push(setTimeout(spawn, 180));
    const iv = setInterval(spawn, big ? 330 : 430);
    fireworksTimers.push(iv);
    fireworksTimers.push(setTimeout(() => clearInterval(iv), Math.max(300, dur - 250)));
    fireworksTimers.push(setTimeout(stopFireworks, dur + 1500));

    if (cfg().FX_SOUND_ENABLED) playBoomSound(big);
  }

  /* ================== BIG BANNER (shared: DOUBLE-DOUBLE / 180!) ================== */
  let bannerTimers = [];
  function stopBanner() {
    bannerTimers.forEach(t => clearTimeout(t) || clearInterval(t));
    bannerTimers = [];
    const el = document.getElementById("ad-banner");
    if (el) el.remove();
    const fl = document.getElementById("ad-banner-flash");
    if (fl) fl.remove();
  }
  function showBigBanner(text, colorHex, holdMs, withFlash) {
    stopBanner();
    const hold = clamp(Number(holdMs) || 1400, 400, 5000);
    const banner = document.createElement("div");
    banner.id = "ad-banner";
    banner.textContent = text;
    banner.style.setProperty("--ad-banner-color", sanitizeHex(colorHex, "#ffd700"));
    banner.style.setProperty("--ad-banner-hold", hold + "ms");
    (document.body || document.documentElement).appendChild(banner);
    bannerTimers.push(setTimeout(stopBanner, hold + 200));

    if (withFlash) {
      const flash = document.createElement("div");
      flash.id = "ad-banner-flash";
      (document.body || document.documentElement).appendChild(flash);
      bannerTimers.push(setTimeout(() => flash.remove(), 500));
    }
  }

  /* ================== WILDCARD (180 only): confetti board explosion / dinosaur run ========== */
  const CONFETTI_COLORS = ["#ffd700", "#ff4d4d", "#43e0ff", "#5dff8a", "#ff6bff", "#ffffff", "#ff9f1c", "#b16bff"];
  let confettiTimers = [];
  function stopConfetti() {
    confettiTimers.forEach(t => clearTimeout(t) || clearInterval(t));
    confettiTimers = [];
    const ov = document.getElementById("ad-confetti");
    if (ov) ov.remove();
    for (const board of getBoardVisualTargets()) board.classList.remove("ad-board-implode");
  }
  function spawnConfettiBurst(cx, cy, count = 70) {
    let overlay = document.getElementById("ad-confetti");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "ad-confetti";
      (document.body || document.documentElement).appendChild(overlay);
    }
    for (let i = 0; i < count; i++) {
      const p = document.createElement("i");
      p.className = "ad-confetti-piece";
      const ang = Math.random() * Math.PI * 2;
      const dist = 60 + Math.random() * 220;
      p.style.setProperty("--tx", (Math.cos(ang) * dist).toFixed(1) + "px");
      p.style.setProperty("--ty", (Math.sin(ang) * dist * 0.6).toFixed(1) + "px");
      p.style.setProperty("--rot", (360 + Math.random() * 720).toFixed(0) + "deg");
      p.style.left = cx + "px";
      p.style.top = cy + "px";
      p.style.background = CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0];
      const w = (5 + Math.random() * 5).toFixed(1), h = (8 + Math.random() * 8).toFixed(1);
      p.style.width = w + "px"; p.style.height = h + "px";
      overlay.appendChild(p);
      confettiTimers.push(setTimeout(() => p.remove(), 1900));
    }
    confettiTimers.push(setTimeout(() => { const ov = document.getElementById("ad-confetti"); if (ov && !ov.children.length) ov.remove(); }, 2100));
  }
  // Shrinks the board away, hides it briefly, then pops back OVERSHOOT-large (adBoardImplode)
  // right as a combined confetti + colorful firework burst fires from its center - "shrink then
  // enlarge and explode into fireworks." Shared by the confetti-explosion wildcard AND the
  // dinosaur chomp below (both actually explode the board, not just a burst at their own spot).
  function implodeBoards(dur) {
    const boards = getBoardVisualTargets();
    for (const board of boards) {
      board.style.setProperty("--ad-implode-dur", dur + "ms");
      board.classList.remove("ad-board-implode");
      void board.offsetWidth;
      board.classList.add("ad-board-implode");
      confettiTimers.push(setTimeout(() => board.classList.remove("ad-board-implode"), dur + 150));
    }
    return boards;
  }
  function explodeBoardAt(dur, boards) {
    confettiTimers.push(setTimeout(() => {
      const target = boards[0];
      const r = target ? target.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      spawnConfettiBurst(cx, cy, 80);
      let overlay = document.getElementById("ad-confetti");
      if (overlay) spawnFireworkBurstAt(overlay, cx, cy, confettiTimers);
    }, dur * 0.55));
  }
  function launchConfettiExplosion(durationMs) {
    stopConfetti();
    const dur = clamp(Number(durationMs) || 2000, 900, 6000);
    explodeBoardAt(dur, implodeBoards(dur));
  }

  // Fires 3 confetti bursts from bottom-left/center/right in quick succession - "triple confetti
  // cannons," reusing the same particle system as the board explosion above.
  function launchConfettiCannons(durationMs) {
    stopConfetti();
    const positions = [0.10, 0.5, 0.90];
    positions.forEach((frac, i) => {
      confettiTimers.push(setTimeout(() => {
        spawnConfettiBurst(frac * innerWidth, 0.95 * innerHeight, 60);
      }, i * 90));
    });
  }

  let dinoTimers = [];
  function stopDinosaur() {
    dinoTimers.forEach(t => clearTimeout(t) || clearInterval(t));
    dinoTimers = [];
    const el = document.getElementById("ad-dino");
    if (el) el.remove();
  }
  // Large emoji sprite walks to the board, "bites" it (quick squash/stretch), then the board
  // itself implodes and explodes (implodeBoards/explodeBoardAt above) - "chomp board and explode
  // the SVG board." One of the three board-exclusive effects in the matrix (DINO/EXPLODE/
  // CANNONS) - runMatrixEffects picks at most one of these per trigger to avoid overlap.
  function launchDinosaurRun(durationMs) {
    stopDinosaur();
    stopConfetti();
    const dur = clamp(Number(durationMs) || 3200, 1500, 8000);
    const dino = document.createElement("div");
    dino.id = "ad-dino";
    dino.style.setProperty("--ad-dino-dur", dur + "ms");
    const body = document.createElement("span");
    body.className = "ad-dino-body";
    body.textContent = Math.random() < 0.5 ? "🦖" : "🦕";
    dino.appendChild(body);
    (document.body || document.documentElement).appendChild(dino);

    const boards = getBoardVisualTargets();
    const target = boards[0];
    if (target) {
      const r = target.getBoundingClientRect();
      const dinoStartX = -0.2 * innerWidth; // matches #ad-dino's left:-20vw
      dino.style.setProperty("--ad-dino-end-x", ((r.left + r.width / 2) - dinoStartX) + "px");
    }

    dinoTimers.push(setTimeout(() => dino.classList.add("ad-dino-bite"), dur * 0.72));
    dinoTimers.push(setTimeout(() => {
      dino.remove();
      const implodeDur = clamp(dur * 0.5, 900, 6000);
      explodeBoardAt(implodeDur, implodeBoards(implodeDur));
    }, dur * 0.82));
  }

  /* ================== FLAIR EFFECTS: glow / lightning / smoke / crowd / spark =============== */
  // Resolves the same "active or first player panel" triggerHighscore's flash effect targets,
  // reused here so the gold/red glow lands on the same element.
  function getActiveOrFirstPanel() {
    const host = document.querySelector("#ad-ext-player-display");
    if (!host) return null;
    return Array.from(host.children).find(p => p.classList && p.classList.contains(ACTIVE_CLASS))
      || host.children[0] || null;
  }

  let flairTimers = [];
  function stopFlair() {
    flairTimers.forEach(t => clearTimeout(t) || clearInterval(t));
    flairTimers = [];
    document.querySelectorAll("." + HIGHSCORE_GLOW2_CLASS).forEach(el => el.classList.remove(HIGHSCORE_GLOW2_CLASS));
    const l = document.getElementById("ad-lightning"); if (l) l.remove();
    const s = document.getElementById("ad-smoke"); if (s) s.remove();
    const cw = document.getElementById("ad-crowd"); if (cw) cw.remove();
  }

  function launchGoldGlow() {
    const panel = getActiveOrFirstPanel();
    if (!panel) return;
    panel.classList.remove(HIGHSCORE_GLOW2_CLASS);
    void panel.offsetWidth;
    panel.classList.add(HIGHSCORE_GLOW2_CLASS);
    flairTimers.push(setTimeout(() => panel.classList.remove(HIGHSCORE_GLOW2_CLASS), 2400));
  }

  // big = double-double streak's "big lightning" ask: more bolts, brighter glow, and a full
  // white screen flash instead of the regular pale-blue tint.
  function launchLightning(big) {
    const overlay = document.createElement("div");
    overlay.id = "ad-lightning";
    (document.body || document.documentElement).appendChild(overlay);
    const svgNS = "http://www.w3.org/2000/svg";
    const boltCount = (big ? 5 : 2) + ((Math.random() * (big ? 2 : 2)) | 0);
    for (let b = 0; b < boltCount; b++) {
      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("class", "ad-bolt" + (big ? " ad-bolt-big" : ""));
      const x0 = 10 + Math.random() * 80;
      let d = `M${x0},0 `;
      let x = x0, y = 0;
      while (y < 100) {
        y += 12 + Math.random() * 14;
        x += (Math.random() - 0.5) * 22;
        d += `L${x},${y} `;
      }
      svg.setAttribute("viewBox", "0 0 100 100");
      svg.setAttribute("preserveAspectRatio", "none");
      svg.style.left = (x0 - 15) + "vw"; svg.style.top = "0"; svg.style.width = "30vw"; svg.style.height = "100vh";
      svg.style.animationDelay = (b * 90) + "ms";
      const path = document.createElementNS(svgNS, "polyline");
      path.setAttribute("points", d.replace(/[ML]/g, "").trim());
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "#eaf6ff");
      path.setAttribute("stroke-width", big ? "2.2" : "1.4");
      svg.appendChild(path);
      overlay.appendChild(svg);
    }
    overlay.classList.add(big ? "ad-flash-big" : "ad-flash");
    flairTimers.push(setTimeout(() => { const el = document.getElementById("ad-lightning"); if (el) el.remove(); }, big ? 1200 : 900));
  }

  // Bigger, bottom-center puffs ("smoke cannons") instead of two thin corner wisps.
  function launchSmoke() {
    const overlay = document.createElement("div");
    overlay.id = "ad-smoke";
    (document.body || document.documentElement).appendChild(overlay);
    const origins = [[0.40, 1], [0.5, 1], [0.60, 1]];
    for (const [fx, fy] of origins) {
      for (let i = 0; i < 14; i++) {
        const puff = document.createElement("i");
        puff.className = "ad-smoke-puff";
        const cx = fx * innerWidth, cy = fy * innerHeight;
        puff.style.left = (cx + (Math.random() - 0.5) * 90) + "px";
        puff.style.top = (cy - Math.random() * 40) + "px";
        const size = 70 + Math.random() * 90;
        puff.style.width = size + "px"; puff.style.height = size + "px";
        puff.style.setProperty("--tx", ((Math.random() - 0.5) * 260).toFixed(0) + "px");
        puff.style.setProperty("--ty", (-(320 + Math.random() * 240)).toFixed(0) + "px");
        puff.style.animationDelay = (Math.random() * 500) + "ms";
        overlay.appendChild(puff);
      }
    }
    flairTimers.push(setTimeout(() => { const el = document.getElementById("ad-smoke"); if (el) el.remove(); }, 3400));
  }

  const CROWD_EMOJI = ["🙌", "🎉", "👏", "🥳"];
  function launchCrowd(durationMs) {
    const dur = clamp(Number(durationMs) || 2200, 800, 6000);
    const bar = document.createElement("div");
    bar.id = "ad-crowd";
    for (let i = 0; i < 14; i++) {
      const fig = document.createElement("span");
      fig.className = "ad-crowd-fig";
      fig.textContent = CROWD_EMOJI[(Math.random() * CROWD_EMOJI.length) | 0];
      fig.style.animationDelay = (Math.random() * 0.4) + "s";
      bar.appendChild(fig);
    }
    (document.body || document.documentElement).appendChild(bar);
    flairTimers.push(setTimeout(() => { const el = document.getElementById("ad-crowd"); if (el) el.remove(); }, dur));
  }

  // Small, cheap, frequent-safe burst for single triple/double hits - a quick radial spark at
  // the hit card's own position, distinct from the bigger high-score effects above.
  let sparkTimers = [];
  function stopSpark() {
    sparkTimers.forEach(t => clearTimeout(t) || clearInterval(t));
    sparkTimers = [];
    const el = document.getElementById("ad-spark");
    if (el) el.remove();
  }
  function launchSpark(cx, cy) {
    let overlay = document.getElementById("ad-spark");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "ad-spark";
      (document.body || document.documentElement).appendChild(overlay);
    }
    const colors = ["#fff5c2", "#ffd700", "#ffffff"];
    const n = 10;
    for (let i = 0; i < n; i++) {
      const p = document.createElement("i");
      p.className = "ad-spark-piece";
      const ang = (i / n) * Math.PI * 2 + Math.random() * 0.3;
      const dist = 24 + Math.random() * 30;
      p.style.setProperty("--tx", (Math.cos(ang) * dist).toFixed(1) + "px");
      p.style.setProperty("--ty", (Math.sin(ang) * dist).toFixed(1) + "px");
      p.style.left = cx + "px"; p.style.top = cy + "px";
      p.style.color = colors[(Math.random() * colors.length) | 0];
      overlay.appendChild(p);
      sparkTimers.push(setTimeout(() => p.remove(), 260));
    }
    sparkTimers.push(setTimeout(() => { const ov = document.getElementById("ad-spark"); if (ov && !ov.children.length) ov.remove(); }, 300));
  }

  /* ================== "26" BOARD FIRE ================== */
  // Sets the real in-game board ablaze for ~5s when a turn totals exactly 26. A ring-of-fire video
  // (Fireflicker.mp4: hollow flame ring on black) is appended INSIDE the board host (the div holding
  // the board img + scoring svg) and screen-blended, so black drops out, flames ring the rim, the
  // scoring shows through the empty centre, and the whole thing rides the board's translate/scale/
  // grow rather than being a floating re-render.
  const FIRE26_DUR_MS = 5000;
  let fire26Timers = [];
  let fire26Mount = null;               // host we appended flames into (for cleanup)
  let fire26MountPrev = null;           // inline styles we temporarily overrode on that host

  // The board host is the element that carries the board's translate/scale positioning and whose
  // box matches the board. Prefer a marked host; else climb from the board svg/img to the div that
  // directly contains it (that same wrapper). Falls back to the raw visual target if nothing else.
  function getBoardFireMount() {
    const host = document.querySelector("." + BOARD_HOST_CLASS);
    if (host) return host;
    const svg = document.querySelector("svg.ad-board-svg, ." + BOARD_VISUAL_CLASS);
    if (svg) return svg.parentElement || svg;
    const img = Array.from(document.querySelectorAll("img")).find(isBoardImage);
    if (img) return img.parentElement || img;
    return getBoardVisualTargets()[0] || null;
  }

  function stopFire26() {
    fire26Timers.forEach(t => clearTimeout(t));
    fire26Timers = [];
    const ov = document.getElementById("ad-fire26");
    if (ov) ov.remove();
    if (fire26Mount) {
      fire26Mount.classList.remove("ad-board-fire-mount");
      if (fire26MountPrev) {
        fire26Mount.style.position = fire26MountPrev.position;
        fire26Mount.style.overflow = fire26MountPrev.overflow;
      }
    }
    fire26Mount = null;
    fire26MountPrev = null;
  }

  function launchFire26() {
    stopFire26();
    const c = cfg();

    const mount = getBoardFireMount();
    if (!mount) return;

    // The video layer is position:absolute and scaled past the board box, so the host must be a
    // positioning context and must not clip the flames. Override only if needed; restore on cleanup.
    const cs = getComputedStyle(mount);
    fire26MountPrev = { position: mount.style.position, overflow: mount.style.overflow };
    if (cs.position === "static") mount.style.position = "relative";
    if (cs.overflow !== "visible") mount.style.overflow = "visible";

    const overlay = document.createElement("div");
    overlay.id = "ad-fire26";

    const scale = clamp(Number(c.FIRE26_VIDEO_SCALE) || 2.3, 1, 5);
    const video = document.createElement("video");
    video.className = "ad-fire26-video";
    video.style.setProperty("--ad-fire26-scale", (scale * 100).toFixed(0) + "%");
    video.src = String(c.FIRE26_VIDEO_URL || DEFAULT_CFG.FIRE26_VIDEO_URL);
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.loop = false;
    video.preload = "auto";
    // Play with the clip's own fire crackle when FX sound is on; fall back to muted if the browser
    // blocks autoplay-with-audio. If the video can't load at all (CSP/network), just clean up.
    video.muted = !c.FX_SOUND_ENABLED;
    video.defaultMuted = video.muted;
    video.onerror = () => stopFire26();
    overlay.appendChild(video);

    mount.appendChild(overlay);
    fire26Mount = mount;

    mount.classList.remove("ad-board-fire-mount");
    void mount.offsetWidth; // restart the grow animation
    mount.classList.add("ad-board-fire-mount");

    try { video.currentTime = 0; } catch {}
    const p = video.play();
    if (p && p.catch) p.catch(() => { video.muted = true; video.play().catch(() => {}); });

    fire26Timers.push(setTimeout(stopFire26, FIRE26_DUR_MS + 200));
  }

  /* ================== EFFECTS MATRIX DISPATCHER ================== */
  // Maps each FX_EFFECTS row to its actual effect function. ctx carries whatever a given call
  // site has handy: durationMs (scales fireworks/dino/etc.), point {x,y} (where to center
  // spark/confetti - e.g. the hit card for a triple/double, the board for T3), and trigger (the
  // FX_TRIGGERS key that fired, used to decide "big" variants like DBLSTREAK's lightning).
  const FX_RUNNERS = {
    SPARK: (ctx) => { if (ctx.point) launchSpark(ctx.point.x, ctx.point.y); },
    GLOW: () => launchGoldGlow(),
    CONFETTI: (ctx) => {
      const p = ctx.point || { x: innerWidth / 2, y: innerHeight / 2 };
      spawnConfettiBurst(p.x, p.y, ctx.trigger === "TRIPLE" || ctx.trigger === "DOUBLE" ? 30 : 70);
    },
    // Always "big" - the ask was bigger fireworks starting at the 100+ threshold, not just 180.
    FIREWORKS: (ctx) => launchFireworks(ctx.durationMs, true),
    LIGHTNING: (ctx) => launchLightning(ctx.trigger === "DBLSTREAK"),
    SMOKE: () => launchSmoke(),
    CROWD: (ctx) => launchCrowd(ctx.durationMs),
    EXPLODE: (ctx) => launchConfettiExplosion(ctx.durationMs),
    DINO: (ctx) => launchDinosaurRun(ctx.durationMs),
    CANNONS: (ctx) => launchConfettiCannons(ctx.durationMs),
  };
  // EXPLODE/DINO/CANNONS all animate the board itself - firing more than one at once for the
  // same trigger would just have them stomp on each other, so if multiple are enabled for the
  // same trigger, pick one of the enabled ones at random instead of running them all.
  const FX_BOARD_EXCLUSIVE = ["EXPLODE", "DINO", "CANNONS"];
  function runMatrixEffects(triggerKey, ctx) {
    const c = cfg();
    if (!c.FX_MATRIX_ENABLED) return;
    const enabledBoardFx = FX_BOARD_EXCLUSIVE.filter(eff => c[fxKey(eff, triggerKey)]);
    const chosenBoardFx = enabledBoardFx.length ? enabledBoardFx[(Math.random() * enabledBoardFx.length) | 0] : null;
    for (const eff of FX_EFFECTS) {
      if (FX_BOARD_EXCLUSIVE.includes(eff)) {
        if (eff === chosenBoardFx) FX_RUNNERS[eff]({ ...ctx, trigger: triggerKey });
        continue;
      }
      if (c[fxKey(eff, triggerKey)]) FX_RUNNERS[eff]({ ...ctx, trigger: triggerKey });
    }
  }

  function applyBoardMarkerNow() {
    const c = cfg();

    const hosts = document.querySelectorAll("div");
    for (const host of hosts) {
      const isHost = isBoardHost(host);
      const hasHost = host.classList.contains(BOARD_HOST_CLASS);
      const hasVisual = host.classList.contains(BOARD_VISUAL_CLASS);
      if (c.BOARD_MARKER) {
        if (isHost && !hasHost) host.classList.add(BOARD_HOST_CLASS);
        if (isHost && !hasVisual) host.classList.add(BOARD_VISUAL_CLASS);
        if (!isHost && hasHost) host.classList.remove(BOARD_HOST_CLASS);
        if (!isHost && hasVisual) host.classList.remove(BOARD_VISUAL_CLASS);
      } else {
        if (hasHost) host.classList.remove(BOARD_HOST_CLASS);
        if (hasVisual) host.classList.remove(BOARD_VISUAL_CLASS);
      }
    }

    const svgs = document.querySelectorAll("svg");
    for (const svg of svgs) {
      const isBoard = isBoardSvg(svg);
      const has = svg.classList.contains("ad-board-svg");
      const hasVisual = svg.classList.contains(BOARD_VISUAL_CLASS);
      const insideHost = !!svg.closest("." + BOARD_HOST_CLASS);
      if (c.BOARD_MARKER) {
        if (isBoard && !has) svg.classList.add("ad-board-svg");
        if (isBoard && !insideHost && !hasVisual) svg.classList.add(BOARD_VISUAL_CLASS);
      } else {
        if (has) svg.classList.remove("ad-board-svg");
        if (hasVisual) svg.classList.remove(BOARD_VISUAL_CLASS);
      }
    }

    const imgs = document.querySelectorAll("img");
    for (const img of imgs) {
      const isBoard = isBoardImage(img);
      const hasBoardImg = img.classList.contains(BOARD_IMG_CLASS);
      const hasVisual = img.classList.contains(BOARD_VISUAL_CLASS);
      const insideHost = !!img.closest("." + BOARD_HOST_CLASS);
      if (c.BOARD_MARKER) {
        if (isBoard && !hasBoardImg) img.classList.add(BOARD_IMG_CLASS);
        if (isBoard && !insideHost && !hasVisual) img.classList.add(BOARD_VISUAL_CLASS);
        if (!isBoard && hasBoardImg) img.classList.remove(BOARD_IMG_CLASS);
        if (!isBoard && hasVisual) img.classList.remove(BOARD_VISUAL_CLASS);
      } else {
        if (hasBoardImg) img.classList.remove(BOARD_IMG_CLASS);
        if (hasVisual) img.classList.remove(BOARD_VISUAL_CLASS);
      }
    }
  }

  let boardMarkScheduled = false;
  function scheduleBoardMark() {
    if (boardMarkScheduled) return;
    boardMarkScheduled = true;
    requestAnimationFrame(() => {
      boardMarkScheduled = false;
      applyBoardMarkerNow();
    });
  }

  let boardMarkerBurstTimer = null;
  function runBoardMarkerBurst() {
    if (boardMarkerBurstTimer) {
      clearTimeout(boardMarkerBurstTimer);
      boardMarkerBurstTimer = null;
    }

    let tries = 0;
    const kick = () => {
      applyBoardMarkerNow();
      tries++;
      if (tries >= 8) return;
      boardMarkerBurstTimer = setTimeout(kick, 300);
    };
    kick();
  }

  /* ================== BOARD MANAGER BACK BUTTON ================== */
  const BM_BTN_ID = "ad-bm-back-btn";
  function isBoardsPage() { return location.pathname.startsWith("/boards"); }

  function removeBmBackButton() {
    const el = document.getElementById(BM_BTN_ID);
    if (el) el.remove();
  }

  function ensureBmBackButton() {
    const c = cfg();
    if (!isBoardsPage()) { removeBmBackButton(); return; }
    if (!c.BM_BACK_BUTTON) { removeBmBackButton(); return; }

    const label = T().bmBackLabel;

    const existing = document.getElementById(BM_BTN_ID);
    if (existing) {
      const span = existing.querySelector("span");
      if (span && span.textContent !== label) span.textContent = label; // ✅ nyelvváltásnál is frissül
      return;
    }

    const candidates = Array.from(document.querySelectorAll("a.chakra-button, button.chakra-button"));
    if (!candidates.length) return;

    const anchor = candidates.reverse().find(el => el && el.offsetParent !== null);
    if (!anchor) return;

    const a = document.createElement("a");
    a.id = BM_BTN_ID;
    a.href = "https://play.autodarts.io/";
    a.target = "_self";
    a.rel = "noopener";
    Object.assign(a.style, {
      display: "inline-flex",
      alignItems: "center",
      gap: "8px",
      padding: "8px 12px",
      borderRadius: "10px",
      border: "1px solid rgba(255,255,255,0.16)",
      background: "rgba(255,255,255,0.08)",
      color: "#fff",
      textDecoration: "none",
      fontWeight: "800",
      whiteSpace: "nowrap",
    });

    a.addEventListener("mouseenter", () => a.style.filter = "brightness(1.12)");
    a.addEventListener("mouseleave", () => a.style.filter = "none");

    a.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"
           viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round">
        <path d="M10 3H6a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h4"/>
        <path d="M16 17l5-5-5-5"/>
        <path d="M19.8 12H9"/>
      </svg>
      <span>${label}</span>
    `;

    anchor.insertAdjacentElement("afterend", a);
  }

  /* ================== THROWS -> POINTS ================== */
  function parseThrow(raw) {
    const t = (raw || "").trim().toUpperCase();
    const mm = t.match(/^M(\d{1,2})$/i);
    if (mm) return { points: 0, orig: null, missLabel: true };
    if (t === "MISS" || t === "0") return { points: 0, orig: null, missLabel: true };
    if (t === "BULL" || t === "DBULL" || t === "50") return { points: 50, orig: raw };
    if (t === "SBULL" || t === "25") return { points: 25, orig: raw };

    const m = t.match(SDT_RE);
    if (m) {
      const ch = m[1];
      const num = parseInt(m[2], 10);
      const mult = ch === "S" ? 1 : (ch === "D" ? 2 : 3);
      return { points: num * mult, orig: raw };
    }
    return { points: null, orig: raw };
  }

  function isPlaceholderRaw(raw) {
    const t = (raw || "").trim();
    return (t === "" || t === "..." || t.includes("•") || t === "…" || t.toLowerCase() === "null");
  }

  let __adStickyInit = false;

  function initStickyThrowSelectOnce(){
  if (__adStickyInit) return;
  __adStickyInit = true;

  document.addEventListener("pointerdown", (e) => {
    if (e.button != null && e.button !== 0) return;

    // 1) keressük meg a kártyát a composedPath-ban (stabilabb)
    let card = null;
    const path = (typeof e.composedPath === "function") ? e.composedPath() : null;
    if (path) {
      for (const n of path) {
        if (n && n.classList && n.classList.contains("ad-ext-turn-throw")) { card = n; break; }
      }
    }
    // 2) fallback: closest
    if (!card) card = e.target?.closest?.(".ad-ext-turn-throw");
    if (!card) return;

    const turn = card.closest("#ad-ext-turn") || document.querySelector("#ad-ext-turn");
    if (!turn) return;

    const cards = Array.from(turn.querySelectorAll(".ad-ext-turn-throw"));
    const idx = cards.indexOf(card);
    if (idx < 0) return;

    // fontos: itt MOST NEM szűrünk ad-has-throw / data-adval alapján,
    // mert pont ez szokott “nem kész lenni” kattintáskor.
    // Csak a teljesen üres/placeholdert dobjuk ki:
    const p = card.querySelector("p");
    const raw = (p?.textContent || "").trim();
    if (isPlaceholderRaw(raw)) return;

    const curRaw = turn.getAttribute(TURN_SEL_ATTR);
    const cur = (curRaw == null) ? -1 : (parseInt(curRaw, 10) | 0);
    const next = (cur === idx) ? -1 : idx;

    if (next < 0) turn.removeAttribute(TURN_SEL_ATTR);
    else turn.setAttribute(TURN_SEL_ATTR, String(next));

    applyStickyThrowSelection(turn);

    dirtyTurn();
    scheduleUpdate();

    if (toastEl) showToast(next < 0 ? "Select OFF" : `Select ${next + 1}`);
  }, true);
}

  function updateThrowGroup(parent) {
    const c = cfg();
    const throwDivs = Array.from(parent.children).filter((el) => el.classList?.contains("ad-ext-turn-throw"));
    if (!throwDivs.length) return;

    const ps = throwDivs.map((d) => d.querySelector("p")).filter(Boolean);
    if (!ps.length) return;

    const raws = ps.map((p) => (p.textContent || "").trim());
    const parsed = raws.map((raw) => isPlaceholderRaw(raw) ? { _placeholder: true } : parseThrow(raw));

    parsed.forEach((it, i) => {
      const p = ps[i];
      const card = p.closest(".ad-ext-turn-throw");

      if (it._placeholder) {
        if (card) {
          card.classList.remove("ad-has-throw");
          card.classList.remove("ad-click-selected");
        }
        if ("adval" in p.dataset) delete p.dataset.adval;
        if ("adorig" in p.dataset) delete p.dataset.adorig;
        return;
      }

      if (card) card.classList.add("ad-has-throw");

      const shown = it.missLabel ? "MISS" : (typeof it.points === "number" ? String(it.points) : raws[i]);
      const orig  = it.missLabel ? null : (it.orig ?? raws[i]);

      p.dataset.adval = shown;

      if (c.SHOW_ORIG_IN_CORNER) {
        if (orig) p.dataset.adorig = orig;
        else if ("adorig" in p.dataset) delete p.dataset.adorig;
      } else {
        if ("adorig" in p.dataset) delete p.dataset.adorig;
      }
    });
  }

  function updateAllThrowGroups(turn) {
    const throwEls = turn.querySelectorAll(".ad-ext-turn-throw");
    const parents = new Set();
    for (const t of throwEls) if (t.parentElement) parents.add(t.parentElement);
    for (const p of parents) updateThrowGroup(p);
  }

function applyStickyThrowSelection(turn){
  if (!turn) return;

  const rawAttr = turn.getAttribute(TURN_SEL_ATTR);
  let idx = (rawAttr == null) ? -1 : (parseInt(rawAttr, 10) | 0);

  const cards = Array.from(turn.querySelectorAll(".ad-ext-turn-throw"));
  if (!cards.length) return;

  // ha rossz index (pl. kevesebb kártya lett), töröljük az attribútumot
  if (idx < 0 || idx >= cards.length) {
    if (rawAttr != null) turn.removeAttribute(TURN_SEL_ATTR);
    cards.forEach(c => c.classList.remove("ad-click-selected"));
    return;
  }

  // ha a kiválasztott kártya placeholder lett -> töröljük a kijelölést
  const p = cards[idx].querySelector("p");
  const txt = (p?.textContent || "").trim();
  if (isPlaceholderRaw(txt)) {
    turn.removeAttribute(TURN_SEL_ATTR);
    idx = -1;
  }

  cards.forEach((c, i) => c.classList.toggle("ad-click-selected", idx >= 0 && i === idx));
}

  /* ================== TOTAL OVERLAY FIX ================== */
  function restoreTotalOverlays(root = document) {
    root.querySelectorAll(".ad-total-overlay").forEach(el => el.remove());
    root.querySelectorAll("[data-ad-total-hidden='1']").forEach(el => {
      el.removeAttribute("data-ad-total-hidden");
      el.style.position = "";
      el.style.left = "";
      el.style.top = "";
      el.style.width = "";
      el.style.height = "";
      el.style.overflow = "";
      el.style.opacity = "";
      el.style.pointerEvents = "";
    });
    root.querySelectorAll(".ad-total-cell").forEach(el => el.classList.remove("ad-total-cell"));
  }

  function findNumericLeaf(container) {
    if (!container) return null;
    const all = [container, ...container.querySelectorAll("*")];
    for (const el of all) {
      const txt = (el.textContent || "").trim();
      if (!/^\d{1,4}$/.test(txt)) continue;
      if (el.children && el.children.length > 0) continue;
      return el;
    }
    return null;
  }

  function forceCenterTotalOverlay(turn) {
    if (!turn) return;

    const leaf = (() => {
      const candidates = Array.from(turn.querySelectorAll("p.ad-ext-turn-points, .ad-ext-turn-points"));
      for (const el of candidates) {
        const txt = (el.textContent || "").trim();
        if (/^\d{1,4}$/.test(txt) && !el.closest(".ad-ext-turn-throw")) return el;
      }
      const f = findNumericLeaf(turn);
      if (f && !f.closest(".ad-ext-turn-throw")) return f;
      return null;
    })();
    if (!leaf) return;

    const value = (leaf.textContent || "").trim();
    if (!/^\d{1,4}$/.test(value)) return;

    let cell = leaf;
    while (cell && cell.parentElement && cell.parentElement !== turn) cell = cell.parentElement;
    if (!cell || cell === turn) return;

    cell.classList.add("ad-total-cell");

    let overlay = cell.querySelector(".ad-total-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "ad-total-overlay ad-ext-turn-total-value";
      cell.appendChild(overlay);
    }
    if (overlay.textContent !== value) overlay.textContent = value;
      overlay.classList.remove("ad-ext-turn-checkout-value");
      overlay.classList.add("ad-ext-turn-total-value");

    if (leaf.dataset.adTotalHidden !== "1") {
      leaf.dataset.adTotalHidden = "1";
      leaf.style.position = "absolute";
      leaf.style.left = "-9999px";
      leaf.style.top = "-9999px";
      leaf.style.width = "1px";
      leaf.style.height = "1px";
      leaf.style.overflow = "hidden";
      leaf.style.opacity = "0";
      leaf.style.pointerEvents = "none";
    }
  }

  /* ================== CHECKOUT MARK ================== */
  function isInButton(el) { return !!el.closest?.("button"); }
function markCheckoutInTurnBar(turn) {
  if (!turn) return;

  // ✅ Biztonság: a Total környékén soha ne legyen checkout class
  turn.querySelectorAll(".ad-total-cell .ad-ext-turn-checkout-value, .ad-total-overlay.ad-ext-turn-checkout-value")
      .forEach(el => el.classList.remove("ad-ext-turn-checkout-value"));

  const nodes = turn.querySelectorAll(".chakra-text, p, span, div");

  for (const el of nodes) {
    if (el.closest(".ad-ext-turn-throw")) continue;    // dobáskártyákon ne
    if (el.closest(".ad-total-cell")) continue;        // total cellen belül ne
    if (el.closest(".ad-total-overlay")) continue;     // total overlayen ne
    if (isInButton(el)) continue;                      // gombokon ne

    // ✅ KRITIKUS: csak LEAF elemet jelöljünk (különben a * selector mindent elvisz)
    if (el.children && el.children.length > 0) continue;

    const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!txt || txt.length > 10) continue;

    if (CHECKOUT_TOKEN_RE.test(txt)) el.classList.add("ad-ext-turn-checkout-value");
  }
}

  /* ================== ACTIVE PLAYER DETECT ================== */
  function parseRGBA(str) {
    const m = String(str || "").match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\s*\)/i);
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: (m[4] == null ? 1 : +m[4]) };
  }
  function brightness01(rgba) { return (rgba.r + rgba.g + rgba.b) / 3 / 255; }
  function bestWhiteFromShadow(shadowStr) {
    const s = String(shadowStr || "");
    let best = 0;
    const re = /rgba?\([^)]+\)/ig;
    let m;
    while ((m = re.exec(s)) !== null) {
      const rgba = parseRGBA(m[0]);
      if (!rgba) continue;
      const b = brightness01(rgba);
      if (b < 0.78 || rgba.a < 0.12) continue;
      best = Math.max(best, b * rgba.a);
    }
    if (best > 0 && s.toLowerCase().includes("inset")) best *= 1.25;
    return best;
  }
  function styleFrameScore(cs) {
    if (!cs) return 0;
    let best = 0;
    const sides = ["top","right","bottom","left"];
    for (const side of sides) {
      const w = parseFloat(cs.getPropertyValue(`border-${side}-width`)) || 0;
      const st = cs.getPropertyValue(`border-${side}-style`) || "none";
      if (w < 0.6 || st === "none") continue;
      const col = cs.getPropertyValue(`border-${side}-color`);
      const rgba = parseRGBA(col);
      if (!rgba) continue;
      const b = brightness01(rgba);
      if (b < 0.78 || rgba.a < 0.12) continue;
      best = Math.max(best, w * b * rgba.a);
    }
    best = Math.max(best, bestWhiteFromShadow(cs.getPropertyValue("box-shadow")) * 1.5);
    return best;
  }
  function elementFrameScore(el) { return styleFrameScore(getComputedStyle(el)); }
  function panelWhiteFrameScore(panel) {
    let best = elementFrameScore(panel);
    const kids = panel.querySelectorAll("*");
    const limit = Math.min(kids.length, 24);
    for (let i = 0; i < limit; i++) {
      const el = kids[i];
      const tn = el.tagName;
      if (tn !== "DIV" && tn !== "SPAN") continue;
      best = Math.max(best, elementFrameScore(el));
    }
    return best;
  }
  function clearActiveClasses() {
    const host = document.querySelector("#ad-ext-player-display");
    if (!host) return;
    Array.from(host.children).forEach(p => p.classList?.remove(ACTIVE_CLASS));
  }
  function updateActivePlayerHighlight() {
    const c = cfg();
    if (!c.ACTIVE_PLAYER_HIGHLIGHT) return;
    const host = document.querySelector("#ad-ext-player-display");
    if (!host) return;

    const panels = Array.from(host.children).filter((n) => n && n.nodeType === 1);
    if (!panels.length) return;

    let bestPanel = null, bestScore = 0;
    for (const p of panels) {
      const s = panelWhiteFrameScore(p);
      if (s > bestScore) { bestScore = s; bestPanel = p; }
    }
    const hasActive = bestPanel && bestScore > 0.02;
    for (const p of panels) p.classList.toggle(ACTIVE_CLASS, hasActive && p === bestPanel);
  }

  /* ================== PLAYER INFO ================== */
  // The averages/stats line uses an unstable chakra class, so we tag it by its
  // content marker (∅) with a stable class the CSS can target.
  function tagPlayerInfo() {
    if (!cfg().PLAYER_INFO) return;
    const host = document.querySelector("#ad-ext-player-display");
    if (!host) return;
    const cards = host.querySelectorAll(".ad-ext-player");
    for (const card of cards) {
      const ps = card.querySelectorAll("p");
      for (const p of ps) {
        if ((p.textContent || "").includes("∅")) p.classList.add("ad-core-pi-avg");
      }
    }
  }

  /* ================== LAYOUT EDITOR (click/drag Player Info elements live) ================== */
  // Photoshop-style direct manipulation for the same PI_* config keys the
  // Player Info sliders already control. Body-drag = move (translate X/Y or,
  // for name/avg/avatar, that player's PI_P{n}_SHIFT_Y nudge, since those are
  // the only per-player position keys that exist). Corner-handle drag = resize:
  // font-size for text elements, PI_AVATAR_SCALE for the avatar, width/height
  // for the two elements that actually have box dimensions (history, card).
  const EDIT_ELEMENT_SELECTORS = {
    name: ".ad-ext-player-name",
    score: ".ad-ext-player-score",
    avg: ".ad-core-pi-avg",
    history: ".css-1u90hiz",
    avatar: ".css-1psdi5l",
  };
  const PI_EL_KEY = { name: "name", score: "score", avg: "average", history: "history", avatar: "avatar" };
  // gXKey/gYKey/gFontKey/gScaleKey/gWidthKey/gHeightKey mirror the base keys for the independent
  // 3-4 player layout (see PI_G_* in DEFAULT_CFG). getModeKeys() swaps them in automatically.
  const EDIT_KIND_MAP = {
    name:    { xKey: "PI_NAME_X_PX",    yKey: "PI_NAME_Y_PX",    fontKey: "PI_NAME_FONT_PX",    colorKey: "PI_NAME_COLOR_HEX",    perPlayerShift: true,  perPlayerColorPrefix: "PI_P{n}_NAME_COLOR_HEX",
               gXKey: "PI_G_NAME_X_PX", gYKey: "PI_G_NAME_Y_PX", gFontKey: "PI_G_NAME_FONT_PX" },
    score:   { xKey: "PI_SCORE_X_PX",   yKey: "PI_SCORE_Y_PX",   fontKey: "PI_SCORE_FONT_PX",   colorKey: "PI_SCORE_COLOR_HEX",   perPlayerShift: false, perPlayerColorPrefix: "PI_P{n}_SCORE_COLOR_HEX",
               gXKey: "PI_G_SCORE_X_PX", gYKey: "PI_G_SCORE_Y_PX", gFontKey: "PI_G_SCORE_FONT_PX" },
    avg:     { xKey: "PI_AVG_X_PX",     yKey: "PI_AVG_Y_PX",     fontKey: "PI_AVG_FONT_PX",     colorKey: "PI_AVG_COLOR_HEX",     perPlayerShift: true,  perPlayerColorPrefix: "PI_P{n}_AVG_COLOR_HEX",
               gXKey: "PI_G_AVG_X_PX", gYKey: "PI_G_AVG_Y_PX", gFontKey: "PI_G_AVG_FONT_PX" },
    history: { xKey: "PI_HISTORY_X_PX", yKey: "PI_HISTORY_OFFSET_PX", fontKey: "PI_HISTORY_FONT_PX", colorKey: "PI_HISTORY_COLOR_HEX", perPlayerShift: false, perPlayerColorPrefix: "PI_P{n}_HISTORY_COLOR_HEX",
               widthKey: "PI_HISTORY_WIDTH_PX", heightKey: "PI_HISTORY_HEIGHT_PX", resizeMode: "box",
               gXKey: "PI_G_HISTORY_X_PX", gYKey: "PI_G_HISTORY_OFFSET_PX", gFontKey: "PI_G_HISTORY_FONT_PX", gWidthKey: "PI_G_HISTORY_WIDTH_PX", gHeightKey: "PI_G_HISTORY_HEIGHT_PX" },
    avatar:  { xKey: "PI_AVATAR_X_PX",  yKey: "PI_AVATAR_OFFSET_PX", perPlayerShift: true, scaleKey: "PI_AVATAR_SCALE", resizeMode: "scale",
               gXKey: "PI_G_AVATAR_X_PX", gYKey: "PI_G_AVATAR_OFFSET_PX", gScaleKey: "PI_G_AVATAR_SCALE" },
    card:    { widthKey: "PI_CARD_WIDTH_PX", heightKey: "PI_CARD_HEIGHT_PX", resizeMode: "box", groupMove: true,
               gWidthKey: "PI_G_CARD_WIDTH_PX", gHeightKey: "PI_G_CARD_HEIGHT_PX" },
  };

  // Global (not per-player) targets: exist once on the page, not once per card. throwVal/orig/
  // total/checkout style-only (font/color/opacity, no position - Autodarts positions them
  // natively); board/undoBtn/nextBtn are move+scale only (Beta - board/button detection has no
  // stable id/class to key off, see BOARD_VISUAL_CLASS / tagActionButtons()).
  const GLOBAL_EDIT_MAP = {
    throwVal: { fontKey: "THROW_VAL_FONT_PX", colorKey: "THROW_VAL_COLOR_HEX", opacityKey: "THROW_VAL_OPACITY", global: true },
    orig:     { fontKey: "ORIG_FONT_PX",      colorKey: "ORIG_COLOR_HEX",      opacityKey: "ORIG_OPACITY",      global: true },
    total:    { fontKey: "TOTAL_FONT_PX",     colorKey: "TOTAL_COLOR_HEX",     opacityKey: "TOTAL_OPACITY",     global: true },
    checkout: { fontKey: "CHECKOUT_FONT_PX",  colorKey: "CHECKOUT_COLOR_HEX",  opacityKey: "CHECKOUT_OPACITY",  global: true },
    board:    { xKey: "BOARD_X_PX",        yKey: "BOARD_Y_PX",        scaleKey: "BOARD_SCALE",        resizeMode: "scale", global: true },
    undoBtn:  { xKey: "UNDO_BTN_X_PX",     yKey: "UNDO_BTN_Y_PX",     scaleKey: "UNDO_BTN_SCALE",      resizeMode: "scale", global: true },
    nextBtn:  { xKey: "NEXT_BTN_X_PX",     yKey: "NEXT_BTN_Y_PX",     scaleKey: "NEXT_BTN_SCALE",      resizeMode: "scale", global: true },
    turnBar:  { xKey: "TURN_BAR_X_PX",     yKey: "TURN_BAR_Y_PX",     scaleKey: "TURN_BAR_SCALE",      resizeMode: "scale", global: true },
  };
  // Order matters: more specific targets first, #ad-ext-turn (the shared container) last as a
  // fallback for empty background clicks - otherwise it would shadow total/checkout/throw clicks.
  const GLOBAL_EDIT_SELECTORS = {
    total: ".ad-ext-turn-total-value",
    checkout: ".ad-ext-turn-checkout-value",
    board: "." + BOARD_HOST_CLASS + ", ." + BOARD_VISUAL_CLASS + ", svg.ad-board-svg, img.ad-board-img",
    undoBtn: ".ad-core-btn-undo",
    nextBtn: ".ad-core-btn-next",
    turnBar: "#ad-ext-turn",
  };
  // throwVal and orig share the same <p> (the big value renders via ::after, the small corner
  // origin label via ::before - both pseudo-elements, so the real hit target is the <p> itself).
  // Disambiguate by click position: bottom-right ~35% of the card is "orig" (it's CSS-anchored
  // there via right/bottom), everything else is "throwVal".
  function classifyThrowClick(el, clientX, clientY) {
    const r = el.getBoundingClientRect();
    const fx = (clientX - r.left) / (r.width || 1);
    const fy = (clientY - r.top) / (r.height || 1);
    return (fx > 0.65 && fy > 0.65) ? "orig" : "throwVal";
  }

  function isGridMode() {
    const host = document.querySelector("#ad-ext-player-display");
    if (!host) return false;
    if (!cfg().PI_GRID_ADJUST) return false;
    return host.children.length >= 3;
  }
  function gridScaleFactor() {
    return clamp(Number(cfg().PI_GRID_SCALE) || 0.5, 0.2, 1);
  }
  function gridDerive(explicit, base, scale) {
    if (explicit === null || explicit === undefined || explicit === "") return (Number(base) || 0) * scale;
    return Number(explicit) || 0;
  }
  // Resolves which literal config keys the editor should read/write for a kind, given whether
  // a 3-4 player match is currently active. Falls back to the 2-player keys when not in grid mode
  // (or when a kind has no grid counterpart, e.g. color keys stay shared between both layouts).
  function getModeKeys(kind) {
    const base = EDIT_KIND_MAP[kind] || GLOBAL_EDIT_MAP[kind];
    if (!base || base.global || !isGridMode()) return base;
    return {
      ...base,
      xKey: base.gXKey || base.xKey,
      yKey: base.gYKey || base.yKey,
      fontKey: base.gFontKey || base.fontKey,
      scaleKey: base.gScaleKey || base.scaleKey,
      widthKey: base.gWidthKey || base.widthKey,
      heightKey: base.gHeightKey || base.heightKey,
      _gridMode: true,
      _base: base,
    };
  }
  // Reads the "effective" current value of a scalar (x/y/font/scale) key, deriving it from the
  // 2-player counterpart × grid scale when the resolved (possibly grid-mode) key is still null.
  function effVal(map, keyName) {
    const c = cfg();
    if (!keyName) return 0;
    const raw = c[keyName];
    if (raw !== null && raw !== undefined && raw !== "") return Number(raw) || 0;
    if (map && map._gridMode && map._base) {
      // keyName is a grid key (e.g. PI_G_NAME_X_PX) resolved via getModeKeys; find its
      // 2-player counterpart by matching which g*Key field points at it ("gXKey" -> "xKey").
      const gField = Object.keys(map._base).find((k) => k.startsWith("g") && map._base[k] === keyName);
      if (gField) {
        const baseField = gField[1].toLowerCase() + gField.slice(2);
        const baseKey = map._base[baseField];
        return gridDerive(null, c[baseKey], gridScaleFactor());
      }
    }
    return 0;
  }
  function shiftKeyForPlayer(player) {
    return isGridMode() ? `PI_G_P${player}_SHIFT_Y` : `PI_P${player}_SHIFT_Y`;
  }
  function effShiftValue(player) {
    const c = cfg();
    const key = shiftKeyForPlayer(player);
    const raw = c[key];
    if (raw !== null && raw !== undefined && raw !== "") return Number(raw) || 0;
    if (isGridMode()) return gridDerive(null, c[`PI_P${player}_SHIFT_Y`], gridScaleFactor());
    return 0;
  }
  // X has no grid-specific override key (kept simple) - same key in both modes, the CSS just
  // scales it by PI_GRID_SCALE when 3+ players are present.
  function shiftXKeyForPlayer(player) {
    return `PI_P${player}_SHIFT_X`;
  }
  function effShiftXValue(player) {
    const c = cfg();
    const raw = c[shiftXKeyForPlayer(player)];
    const v = raw !== null && raw !== undefined && raw !== "" ? Number(raw) || 0 : 0;
    return isGridMode() ? v * gridScaleFactor() : v;
  }
  // Whole-card position: translates the card <div> itself (background box + active glow +
  // everything inside, incl. score/history). Same keys in both 2p and 3-4p modes.
  function cardPosKeys(player) {
    return { x: `PI_P${player}_CARD_X_PX`, y: `PI_P${player}_CARD_Y_PX` };
  }

  // "Scale all elements proportionally with the card" (card popover checkbox, ON by default -
  // uncheck to resize just the box). Each pair is [2-player key, grid key]; groupScaleActiveKey()
  // picks whichever is live right now, groupScaleEffValue() derives its current effective number
  // (same null-handling as effVal, just against explicit key pairs instead of an EDIT_KIND_MAP
  // entry). Dragging the card BODY (not the resize handle) always moves this same set as a group -
  // there's no other sensible meaning for "move the card", since it has no X/Y key of its own.
  let groupResizeEnabled = true;
  const GROUP_SCALE_PAIRS = [
    ["PI_NAME_FONT_PX", "PI_G_NAME_FONT_PX"], ["PI_SCORE_FONT_PX", "PI_G_SCORE_FONT_PX"],
    ["PI_AVG_FONT_PX", "PI_G_AVG_FONT_PX"], ["PI_HISTORY_FONT_PX", "PI_G_HISTORY_FONT_PX"],
    ["PI_AVATAR_SCALE", "PI_G_AVATAR_SCALE"], ["PI_STACK_GAP_PX", "PI_G_STACK_GAP_PX"],
    ["PI_NAME_X_PX", "PI_G_NAME_X_PX"], ["PI_NAME_Y_PX", "PI_G_NAME_Y_PX"],
    ["PI_SCORE_X_PX", "PI_G_SCORE_X_PX"], ["PI_SCORE_Y_PX", "PI_G_SCORE_Y_PX"],
    ["PI_AVG_X_PX", "PI_G_AVG_X_PX"], ["PI_AVG_Y_PX", "PI_G_AVG_Y_PX"],
    ["PI_HISTORY_X_PX", "PI_G_HISTORY_X_PX"], ["PI_HISTORY_OFFSET_PX", "PI_G_HISTORY_OFFSET_PX"],
    ["PI_AVATAR_X_PX", "PI_G_AVATAR_X_PX"], ["PI_AVATAR_OFFSET_PX", "PI_G_AVATAR_OFFSET_PX"],
    ["PI_P1_SHIFT_Y", "PI_G_P1_SHIFT_Y"], ["PI_P2_SHIFT_Y", "PI_G_P2_SHIFT_Y"],
    ["PI_P3_SHIFT_Y", "PI_G_P3_SHIFT_Y"], ["PI_P4_SHIFT_Y", "PI_G_P4_SHIFT_Y"],
  ];
  const GROUP_SCALE_BOX_PAIRS = [
    ["PI_HISTORY_WIDTH_PX", "PI_G_HISTORY_WIDTH_PX"], ["PI_HISTORY_HEIGHT_PX", "PI_G_HISTORY_HEIGHT_PX"],
  ];
  function groupScaleActiveKey(pair) {
    return isGridMode() ? pair[1] : pair[0];
  }
  function groupScaleEffValue(pair) {
    const c = cfg();
    const key = groupScaleActiveKey(pair);
    const raw = c[key];
    if (raw !== null && raw !== undefined && raw !== "") return Number(raw) || 0;
    if (isGridMode()) return gridDerive(null, c[pair[0]], gridScaleFactor());
    return Number(DEFAULT_CFG[key]) || 0;
  }

  let editModeOn = false;
  let editHoverTarget = null;
  let editSelected = null;
  let editDragState = null;
  let editRafHandle = null;
  let editHoverBox = null, editSelectBox = null, editHandleEl = null, editPopoverEl = null, editHintEl = null, editHintTextEl = null, editExitBtn = null;
  let editGuideV = null, editGuideH = null, editSnapBtn = null, editCopyToGridBtn = null, editCopyToFlatBtn = null;
  let __adEditInit = false;

  function getEditTargets() {
    const out = [];
    const host = document.querySelector("#ad-ext-player-display");
    if (host) {
      Array.from(host.children).forEach((cardEl, i) => {
        const player = i + 1;
        if (player > 4) return;
        for (const [kind, sel] of Object.entries(EDIT_ELEMENT_SELECTORS)) {
          const el = cardEl.querySelector(sel);
          if (el) out.push({ el, kind, player, card: cardEl });
        }
        out.push({ el: cardEl, kind: "card", player, card: cardEl });
      });
    }
    const throwP = document.querySelector(".ad-ext-turn-throw p");
    if (throwP) {
      out.push({ el: throwP, kind: "throwVal", player: 0, card: null });
      out.push({ el: throwP, kind: "orig", player: 0, card: null });
    }
    for (const [kind, sel] of Object.entries(GLOBAL_EDIT_SELECTORS)) {
      const el = document.querySelector(sel);
      if (el) out.push({ el, kind, player: 0, card: null });
    }
    return out;
  }

  function hitTestEditTarget(rawTarget, clientX, clientY) {
    if (!rawTarget || !rawTarget.closest) return null;

    const host = document.querySelector("#ad-ext-player-display");
    if (host && host.contains(rawTarget)) {
      const cards = Array.from(host.children);
      for (const [kind, sel] of Object.entries(EDIT_ELEMENT_SELECTORS)) {
        const el = rawTarget.closest(sel);
        if (el && host.contains(el)) {
          const card = cards.find((c) => c.contains(el));
          const player = card ? cards.indexOf(card) + 1 : 0;
          if (player >= 1 && player <= 4) return { el, kind, player, card };
        }
      }
      const card = cards.find((c) => c.contains(rawTarget));
      if (card) {
        const player = cards.indexOf(card) + 1;
        if (player >= 1 && player <= 4) return { el: card, kind: "card", player, card };
      }
      return null;
    }

    // throwVal/orig share the same <p> (both render via ::before/::after pseudo-content)
    const throwEl = rawTarget.closest(".ad-ext-turn-throw p");
    if (throwEl) {
      const kind = classifyThrowClick(throwEl, clientX, clientY);
      return { el: throwEl, kind, player: 0, card: null };
    }

    for (const [kind, sel] of Object.entries(GLOBAL_EDIT_SELECTORS)) {
      const el = rawTarget.closest(sel);
      if (el) return { el, kind, player: 0, card: null };
    }
    return null;
  }

  function reresolveSelection() {
    if (!editSelected) return;
    if (editSelected.el && editSelected.el.isConnected) return;
    const match = getEditTargets().find((t) => t.kind === editSelected.kind && t.player === editSelected.player);
    editSelected = match || null;
    if (!editSelected) renderEditPopoverContent();
  }

  function ensureEditOverlayEls() {
    if (editHoverBox) return;

    editHoverBox = document.createElement("div");
    Object.assign(editHoverBox.style, {
      position: "fixed", pointerEvents: "none", zIndex: 2147483000,
      border: "2px dashed rgba(120,200,255,.9)", borderRadius: "6px",
      display: "none", boxSizing: "border-box",
    });
    document.body.appendChild(editHoverBox);

    editSelectBox = document.createElement("div");
    Object.assign(editSelectBox.style, {
      position: "fixed", pointerEvents: "none", zIndex: 2147483001,
      border: "2px solid rgba(255,210,60,.95)", borderRadius: "6px",
      display: "none", boxSizing: "border-box",
    });
    document.body.appendChild(editSelectBox);

    // Alignment guide lines (card-drag only) - thin full-viewport lines shown when the dragged
    // card's center/edge lines up with another card's, snapping the drag into place.
    editGuideV = document.createElement("div");
    Object.assign(editGuideV.style, {
      position: "fixed", pointerEvents: "none", zIndex: 2147483005,
      top: "0", height: "100vh", width: "1px", background: "rgba(255,80,220,.9)", display: "none",
    });
    document.body.appendChild(editGuideV);

    editGuideH = document.createElement("div");
    Object.assign(editGuideH.style, {
      position: "fixed", pointerEvents: "none", zIndex: 2147483005,
      left: "0", width: "100vw", height: "1px", background: "rgba(255,80,220,.9)", display: "none",
    });
    document.body.appendChild(editGuideH);

    editHandleEl = document.createElement("div");
    editHandleEl.id = "ad-edit-handle";
    Object.assign(editHandleEl.style, {
      position: "fixed", width: "14px", height: "14px", marginLeft: "-7px", marginTop: "-7px",
      background: "rgba(255,210,60,.95)", border: "2px solid #000", borderRadius: "3px",
      cursor: "nwse-resize", zIndex: 2147483002, display: "none", pointerEvents: "auto",
    });
    document.body.appendChild(editHandleEl);
    editHandleEl.addEventListener("pointerdown", (e) => {
      if (!editSelected) return;
      if (e.button != null && e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      beginDrag(editSelected, e, "resize");
    });

    editHintEl = document.createElement("div");
    editHintEl.id = "ad-edit-hint";
    Object.assign(editHintEl.style, {
      position: "fixed", left: "50%", top: "12px", transform: "translateX(-50%)",
      display: "none", alignItems: "center", gap: "10px", flexWrap: "wrap",
      padding: "8px 10px 8px 14px", background: "rgba(0,0,0,.85)", color: "#fff",
      fontFamily: "Arial, system-ui, sans-serif", fontWeight: "800", fontSize: "12.5px",
      borderRadius: "10px", zIndex: 2147483003, border: "1px solid rgba(255,255,255,.18)",
      maxWidth: "820px", textAlign: "left",
    });
    editHintTextEl = document.createElement("span");
    editHintEl.appendChild(editHintTextEl);

    const smallBtn = (id) => {
      const b = document.createElement("button");
      b.id = id;
      Object.assign(b.style, {
        flex: "0 0 auto", padding: "4px 10px", borderRadius: "8px", border: "1px solid rgba(255,255,255,.3)",
        background: "rgba(255,255,255,.12)", color: "#fff", fontWeight: "900", cursor: "pointer",
        fontSize: "12px",
      });
      return b;
    };

    const snapBtn = smallBtn("ad-edit-snap");
    snapBtn.addEventListener("click", () => {
      state.ui.editSnapEnabled = !state.ui.editSnapEnabled;
      saveStateDebounced();
      updateEditSnapBtn();
    });
    editHintEl.appendChild(snapBtn);
    editSnapBtn = snapBtn;

    const copyToGridBtn = smallBtn("ad-edit-copy-to-grid");
    copyToGridBtn.addEventListener("click", () => {
      if (!confirm(T().piText.editCopyToGridConfirm)) return;
      copyLayoutBetweenModes("toGrid");
    });
    editHintEl.appendChild(copyToGridBtn);
    editCopyToGridBtn = copyToGridBtn;

    const copyToFlatBtn = smallBtn("ad-edit-copy-to-flat");
    copyToFlatBtn.addEventListener("click", () => {
      if (!confirm(T().piText.editCopyToFlatConfirm)) return;
      copyLayoutBetweenModes("toFlat");
    });
    editHintEl.appendChild(copyToFlatBtn);
    editCopyToFlatBtn = copyToFlatBtn;

    const exitBtn = document.createElement("button");
    exitBtn.id = "ad-edit-exit";
    exitBtn.textContent = "✖";
    Object.assign(exitBtn.style, {
      flex: "0 0 auto", padding: "4px 10px", borderRadius: "8px", border: "1px solid rgba(255,255,255,.3)",
      background: "rgba(255,255,255,.12)", color: "#fff", fontWeight: "900", cursor: "pointer",
    });
    exitBtn.addEventListener("click", () => exitEditModeAndReopenPanel());
    editHintEl.appendChild(exitBtn);
    document.body.appendChild(editHintEl);
    editExitBtn = exitBtn;
  }

  function updateEditSnapBtn() {
    if (!editSnapBtn) return;
    const on = !!state.ui.editSnapEnabled;
    editSnapBtn.textContent = on ? T().piText.editSnapOn : T().piText.editSnapOff;
    editSnapBtn.style.background = on ? "rgba(120,200,255,.30)" : "rgba(255,255,255,.12)";
    editSnapBtn.style.borderColor = on ? "rgba(120,200,255,.65)" : "rgba(255,255,255,.3)";
  }

  function ensureEditPopover() {
    if (editPopoverEl) return;
    editPopoverEl = document.createElement("div");
    editPopoverEl.id = "ad-edit-popover";
    Object.assign(editPopoverEl.style, {
      position: "fixed", zIndex: 2147483004, minWidth: "230px",
      background: "rgba(10,10,14,.94)", color: "#fff", border: "1px solid rgba(255,255,255,.18)",
      borderRadius: "12px", padding: "10px 12px", boxShadow: "0 10px 30px rgba(0,0,0,.5)",
      fontFamily: "Arial, system-ui, sans-serif", display: "none",
    });
    document.body.appendChild(editPopoverEl);
  }

  function numRow(labelText, value, step, onChange) {
    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", marginBottom: "6px" });
    const lab = document.createElement("div");
    lab.textContent = labelText;
    Object.assign(lab.style, { opacity: "0.85", fontSize: "12px" });
    const inp = document.createElement("input");
    inp.type = "number";
    inp.step = String(step);
    inp.value = String(value);
    Object.assign(inp.style, {
      width: "90px", borderRadius: "8px", border: "1px solid rgba(255,255,255,.18)",
      background: "rgba(255,255,255,.08)", color: "#fff", padding: "4px 6px", fontWeight: "800", fontSize: "12px",
    });
    inp.addEventListener("change", () => onChange(Number(inp.value) || 0));
    row.appendChild(lab); row.appendChild(inp);
    return { row, input: inp };
  }

  function applyEditChange() {
    saveStateDebounced();
    renderCss();
    dirtyPlayers(); dirtyTurn();
    scheduleUpdate();
  }

  // Copies the *effective* current value of every 2-player <-> 3-4-player ("grid") layout key
  // pair literally into the other mode's keys, so a hand-tuned 2P layout can become the starting
  // point for the grid layout (or vice versa) in one click instead of re-tuning from scratch.
  // Reuses GROUP_SCALE_PAIRS/GROUP_SCALE_BOX_PAIRS (the same [flat, grid] key pairs "scale card
  // proportionally" already resizes together) since together with the card width/height pair
  // below they cover every PI_G_* key that exists.
  function copyLayoutBetweenModes(direction) {
    const c = cfg();
    const toGrid = direction === "toGrid";
    const scale = gridScaleFactor();
    const readFlat = (key) => Number(c[key]) || 0;
    const readGrid = (gridKey, flatKey) => {
      const raw = c[gridKey];
      return (raw !== null && raw !== undefined && raw !== "") ? (Number(raw) || 0) : readFlat(flatKey) * scale;
    };
    const copyPair = (flatKey, gridKey) => {
      if (!flatKey || !gridKey) return;
      if (toGrid) c[gridKey] = readFlat(flatKey);
      else c[flatKey] = readGrid(gridKey, flatKey);
    };

    for (const [flatKey, gridKey] of GROUP_SCALE_PAIRS) copyPair(flatKey, gridKey);
    for (const [flatKey, gridKey] of GROUP_SCALE_BOX_PAIRS) copyPair(flatKey, gridKey);
    copyPair("PI_CARD_WIDTH_PX", "PI_G_CARD_WIDTH_PX");
    copyPair("PI_CARD_HEIGHT_PX", "PI_G_CARD_HEIGHT_PX");

    applySafeClampsToCfg();
    applyEditChange();
    renderPanelIfOpen();
    showToast(T().piText.editCopyDone);
  }

  function renderEditPopoverContent() {
    if (!editPopoverEl) return;
    if (!editSelected) { editPopoverEl.style.display = "none"; return; }
    const c = cfg();
    const L = T();
    const pi = L.piText;
    const map = getModeKeys(editSelected.kind);
    const gridMode = !!map._gridMode;
    const player = editSelected.player;
    const prefixes = [pi.p1Prefix, pi.p2Prefix, pi.p3Prefix, pi.p4Prefix];
    const elLabel = editSelected.kind === "card" ? pi.secCard
      : (map.global ? (pi.editGlobalLabel[editSelected.kind] || editSelected.kind)
      : (pi.el[PI_EL_KEY[editSelected.kind]] || editSelected.kind));

    editPopoverEl.textContent = "";
    editPopoverEl._fields = {};
    const fields = editPopoverEl._fields;

    const head = document.createElement("div");
    Object.assign(head.style, { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" });
    const title = document.createElement("div");
    title.textContent = map.global ? elLabel : `${elLabel} — ${prefixes[player - 1] || ("P" + player)}${gridMode ? " · 3-4P" : ""}`;
    Object.assign(title.style, { fontWeight: "900", fontSize: "13px" });
    const closeX = document.createElement("div");
    closeX.textContent = "✕";
    Object.assign(closeX.style, { cursor: "pointer", opacity: "0.7", fontWeight: "900", padding: "0 4px" });
    closeX.addEventListener("click", () => selectEditTarget(null));
    head.appendChild(title); head.appendChild(closeX);
    editPopoverEl.appendChild(head);

    if (map.fontKey) {
      const v = effVal(map, map.fontKey) || DEFAULT_CFG[(map._base || map).fontKey];
      const { row, input } = numRow(pi.editFont, v, 1, (nv) => {
        let vv = clamp(Math.round(nv), 4, 400);
        vv = clampIfSafe((map._base || map).fontKey, vv);
        c[map.fontKey] = vv;
        input.value = String(vv);
        applyEditChange();
      });
      editPopoverEl.appendChild(row);
      fields.font = input;
    }

    if (map.scaleKey) {
      const v = effVal(map, map.scaleKey) || DEFAULT_CFG[(map._base || map).scaleKey];
      const { row, input } = numRow(pi.editScale, v, 0.1, (nv) => {
        const vv = clamp(+nv.toFixed(2), 0.2, 12);
        c[map.scaleKey] = vv;
        input.value = String(vv);
        applyEditChange();
      });
      editPopoverEl.appendChild(row);
      fields.scale = input;
    }

    if (map.xKey) {
      const v = effVal(map, map.xKey);
      const { row, input } = numRow(`${elLabel} ↔`, v, 1, (nv) => {
        c[map.xKey] = clamp(Math.round(nv), -1500, 1500);
        input.value = String(c[map.xKey]);
        applyEditChange();
      });
      editPopoverEl.appendChild(row);
      fields.x = input;
    }

    if (map.perPlayerShift) {
      const shiftKey = shiftKeyForPlayer(player);
      const v = effShiftValue(player);
      const { row, input } = numRow(`${elLabel} ↕`, v, 1, (nv) => {
        c[shiftKey] = clamp(Math.round(nv), -400, 400);
        input.value = String(c[shiftKey]);
        applyEditChange();
      });
      editPopoverEl.appendChild(row);
      fields.y = input;
    } else if (map.yKey) {
      const v = effVal(map, map.yKey);
      const { row, input } = numRow(`${elLabel} ↕`, v, 1, (nv) => {
        c[map.yKey] = clamp(Math.round(nv), -1500, 1500);
        input.value = String(c[map.yKey]);
        applyEditChange();
      });
      editPopoverEl.appendChild(row);
      fields.y = input;
    }

    if (map.widthKey) {
      const v = Number(c[map.widthKey]) || 0;
      const { row, input } = numRow(pi.editWidth, v, 10, (nv) => {
        c[map.widthKey] = clamp(Math.round(nv), 0, 2000);
        input.value = String(c[map.widthKey]);
        applyEditChange();
      });
      editPopoverEl.appendChild(row);
      fields.w = input;
    }
    if (map.heightKey) {
      const v = Number(c[map.heightKey]) || 0;
      const { row, input } = numRow(pi.editHeight, v, 10, (nv) => {
        c[map.heightKey] = clamp(Math.round(nv), 0, 2000);
        input.value = String(c[map.heightKey]);
        applyEditChange();
      });
      editPopoverEl.appendChild(row);
      fields.h = input;
    }

    if (editSelected.kind === "card") {
      const keys = cardPosKeys(player);
      {
        const v = Number(c[keys.x]) || 0;
        const { row, input } = numRow(`${elLabel} ↔`, v, 1, (nv) => {
          c[keys.x] = clamp(Math.round(nv), -1500, 1500);
          input.value = String(c[keys.x]);
          applyEditChange();
        });
        editPopoverEl.appendChild(row);
        fields.cardX = input;
      }
      {
        const v = Number(c[keys.y]) || 0;
        const { row, input } = numRow(`${elLabel} ↕`, v, 1, (nv) => {
          c[keys.y] = clamp(Math.round(nv), -1500, 1500);
          input.value = String(c[keys.y]);
          applyEditChange();
        });
        editPopoverEl.appendChild(row);
        fields.cardY = input;
      }
      const chkRow = document.createElement("label");
      Object.assign(chkRow.style, { display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", opacity: "0.85", cursor: "pointer", margin: "2px 0 6px" });
      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.checked = groupResizeEnabled;
      chk.addEventListener("change", () => { groupResizeEnabled = chk.checked; });
      chkRow.appendChild(chk);
      chkRow.appendChild(document.createTextNode(pi.editGroupScale));
      editPopoverEl.appendChild(chkRow);
    }

    if (map.opacityKey) {
      const v = Number(c[map.opacityKey]);
      const { row, input } = numRow(pi.editOpacity, Number.isFinite(v) ? v : 1, 0.05, (nv) => {
        const vv = clamp(+nv.toFixed(2), 0, 1);
        c[map.opacityKey] = vv;
        input.value = String(vv);
        applyEditChange();
      });
      editPopoverEl.appendChild(row);
      fields.opacity = input;
    }

    if (map.global && map.colorKey) {
      const sep = document.createElement("div");
      Object.assign(sep.style, { height: "1px", background: "rgba(255,255,255,.12)", margin: "8px 0" });
      editPopoverEl.appendChild(sep);

      const row = document.createElement("div");
      Object.assign(row.style, { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" });
      const lab = document.createElement("div");
      lab.textContent = pi.editSharedColor;
      Object.assign(lab.style, { opacity: "0.85", fontSize: "12px" });
      const inp = document.createElement("input");
      inp.type = "color";
      inp.value = sanitizeHex(c[map.colorKey], "#ffffff");
      Object.assign(inp.style, { width: "36px", height: "26px", border: "none", background: "none", cursor: "pointer" });
      inp.addEventListener("input", () => { c[map.colorKey] = inp.value; applyEditChange(); });
      row.appendChild(lab); row.appendChild(inp);
      editPopoverEl.appendChild(row);
    } else if (map.colorKey) {
      const sep = document.createElement("div");
      Object.assign(sep.style, { height: "1px", background: "rgba(255,255,255,.12)", margin: "8px 0" });
      editPopoverEl.appendChild(sep);

      if (!c.PI_CUSTOM_COLORS) {
        const btn = document.createElement("button");
        btn.textContent = pi.editEnableCustom;
        Object.assign(btn.style, {
          width: "100%", padding: "6px 8px", borderRadius: "8px", border: "1px solid rgba(255,255,255,.2)",
          background: "rgba(255,255,255,.08)", color: "#fff", fontWeight: "800", cursor: "pointer", fontSize: "12px",
        });
        btn.addEventListener("click", () => { c.PI_CUSTOM_COLORS = true; renderEditPopoverContent(); applyEditChange(); });
        editPopoverEl.appendChild(btn);
      } else {
        const usePerPlayer = player >= 2 && !!c.PI_PER_PLAYER_COLORS;
        const perKey = map.perPlayerColorPrefix.replace("{n}", player);
        const activeKey = usePerPlayer ? perKey : map.colorKey;
        const label = usePerPlayer ? pi.editPlayerColor : pi.editSharedColor;

        const row = document.createElement("div");
        Object.assign(row.style, { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", marginBottom: "6px" });
        const lab = document.createElement("div");
        lab.textContent = label;
        Object.assign(lab.style, { opacity: "0.85", fontSize: "12px" });
        const inp = document.createElement("input");
        inp.type = "color";
        inp.value = sanitizeHex(c[activeKey], "#ffffff");
        Object.assign(inp.style, { width: "36px", height: "26px", border: "none", background: "none", cursor: "pointer" });
        inp.addEventListener("input", () => { c[activeKey] = inp.value; applyEditChange(); });
        row.appendChild(lab); row.appendChild(inp);
        editPopoverEl.appendChild(row);

        if (player >= 2) {
          const chkRow = document.createElement("label");
          Object.assign(chkRow.style, { display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", opacity: "0.85", cursor: "pointer", marginTop: "4px" });
          const chk = document.createElement("input");
          chk.type = "checkbox";
          chk.checked = !!c.PI_PER_PLAYER_COLORS;
          chk.addEventListener("change", () => { c.PI_PER_PLAYER_COLORS = chk.checked; renderEditPopoverContent(); applyEditChange(); });
          chkRow.appendChild(chk);
          chkRow.appendChild(document.createTextNode(pi.editEnablePerPlayer));
          editPopoverEl.appendChild(chkRow);
        }
      }
    }

    const btnRow = document.createElement("div");
    Object.assign(btnRow.style, { display: "flex", gap: "8px", marginTop: "10px" });
    const resetBtn = document.createElement("button");
    resetBtn.textContent = pi.editReset;
    Object.assign(resetBtn.style, {
      flex: "1", padding: "6px 8px", borderRadius: "8px", border: "1px solid rgba(255,255,255,.2)",
      background: "rgba(255,255,255,.08)", color: "#fff", fontWeight: "800", cursor: "pointer", fontSize: "12px",
    });
    resetBtn.addEventListener("click", () => resetEditTarget());
    btnRow.appendChild(resetBtn);
    editPopoverEl.appendChild(btnRow);

    editPopoverEl.style.display = "block";
  }

  function updateEditPopoverFields() {
    if (!editPopoverEl || !editSelected || !editPopoverEl._fields) return;
    const c = cfg();
    const map = getModeKeys(editSelected.kind);
    const f = editPopoverEl._fields;
    if (f.font && map.fontKey) f.font.value = String(c[map.fontKey]);
    if (f.scale && map.scaleKey) f.scale.value = String(c[map.scaleKey]);
    if (f.x && map.xKey) f.x.value = String(c[map.xKey]);
    if (f.y) {
      if (map.perPlayerShift) f.y.value = String(c[shiftKeyForPlayer(editSelected.player)]);
      else if (map.yKey) f.y.value = String(c[map.yKey]);
    }
    if (f.w && map.widthKey) f.w.value = String(c[map.widthKey]);
    if (f.h && map.heightKey) f.h.value = String(c[map.heightKey]);
    if (f.cardX || f.cardY) {
      const keys = cardPosKeys(editSelected.player);
      if (f.cardX) f.cardX.value = String(Number(c[keys.x]) || 0);
      if (f.cardY) f.cardY.value = String(Number(c[keys.y]) || 0);
    }
  }

  // Resets whichever layer (2-player or, during a 3-4 player match, the independent 3-4p
  // layer) is currently being edited back to its default - for grid keys that means reverting
  // to "auto" (null), i.e. back to deriving from the 2-player value × grid scale.
  function resetEditTarget() {
    if (!editSelected) return;
    const c = cfg();
    const map = getModeKeys(editSelected.kind);
    const player = editSelected.player;
    if (map.xKey) c[map.xKey] = DEFAULT_CFG[map.xKey];
    if (map.yKey) c[map.yKey] = DEFAULT_CFG[map.yKey];
    if (map.perPlayerShift) {
      const shiftKey = shiftKeyForPlayer(player);
      c[shiftKey] = DEFAULT_CFG[shiftKey];
    }
    if (map.groupMove) {
      const keys = cardPosKeys(player);
      c[keys.x] = DEFAULT_CFG[keys.x];
      c[keys.y] = DEFAULT_CFG[keys.y];
      // also clear this player's element nudges (older editor versions wrote these on card drag)
      c[shiftKeyForPlayer(player)] = DEFAULT_CFG[shiftKeyForPlayer(player)];
      c[shiftXKeyForPlayer(player)] = DEFAULT_CFG[shiftXKeyForPlayer(player)];
    }
    if (map.fontKey) c[map.fontKey] = DEFAULT_CFG[map.fontKey];
    if (map.scaleKey) c[map.scaleKey] = DEFAULT_CFG[map.scaleKey];
    if (map.widthKey) c[map.widthKey] = DEFAULT_CFG[map.widthKey];
    if (map.heightKey) c[map.heightKey] = DEFAULT_CFG[map.heightKey];
    if (map.opacityKey) c[map.opacityKey] = DEFAULT_CFG[map.opacityKey];
    if (map.colorKey) {
      c[map.colorKey] = DEFAULT_CFG[map.colorKey];
      if (map.perPlayerColorPrefix && player >= 2) {
        const perKey = map.perPlayerColorPrefix.replace("{n}", player);
        c[perKey] = DEFAULT_CFG[perKey];
      }
    }
    renderEditPopoverContent();
    applyEditChange();
    showToast(T().saved);
  }

  function selectEditTarget(hit) {
    editSelected = hit;
    editHoverTarget = null;
    renderEditPopoverContent();
    positionEditBoxes();
  }

  function setHoverTarget(hit) {
    if (editDragState) return;
    editHoverTarget = hit;
    document.body.style.cursor = hit ? (hit.kind === "card" ? "default" : "move") : "";
  }

  function beginDrag(target, e, mode) {
    const map = getModeKeys(target.kind);
    if (!map) return;
    if (mode === "move" && map.moveDisabled) return;
    const c = cfg();
    const rect = target.el.getBoundingClientRect();
    editDragState = {
      mode, target, map,
      startClientX: e.clientX, startClientY: e.clientY,
      startX: map.xKey ? effVal(map, map.xKey) : 0,
      startY: map.perPlayerShift ? effShiftValue(target.player) : (map.yKey ? effVal(map, map.yKey) : 0),
      startFont: map.fontKey ? (effVal(map, map.fontKey) || DEFAULT_CFG[(map._base || map).fontKey]) : 0,
      startScale: map.scaleKey ? (effVal(map, map.scaleKey) || DEFAULT_CFG[(map._base || map).scaleKey]) : 0,
      startW: map.widthKey ? (Number(c[map.widthKey]) || Math.round(rect.width)) : 0,
      startH: map.heightKey ? (Number(c[map.heightKey]) || Math.round(rect.height)) : 0,
      groupSnapshot: (target.kind === "card" && mode === "resize" && groupResizeEnabled)
        ? GROUP_SCALE_PAIRS.map((pair) => ({ key: groupScaleActiveKey(pair), value: groupScaleEffValue(pair) }))
        : null,
      groupBoxSnapshot: (target.kind === "card" && mode === "resize" && groupResizeEnabled)
        ? GROUP_SCALE_BOX_PAIRS.map((pair) => ({ key: groupScaleActiveKey(pair), value: groupScaleEffValue(pair) }))
        : null,
      // Moving the card drags the card <div> itself via this player's own CARD_X/Y translate -
      // box, glow, and all contents (incl. score/history) move as one; other players untouched.
      cardMoveStart: (mode === "move" && map.groupMove)
        ? (() => {
            const keys = cardPosKeys(target.player);
            return { startX: Number(c[keys.x]) || 0, startY: Number(c[keys.y]) || 0 };
          })()
        : null,
      // Alignment-guide snapping (card move only): snapshot this card's start rect and the
      // other players' rects (they don't move during this drag) so onEditDragMove can compare
      // the dragged card's projected position against them each frame.
      startRect: (mode === "move" && target.kind === "card") ? rect : null,
      otherRects: (mode === "move" && target.kind === "card")
        ? Array.from(document.querySelectorAll("#ad-ext-player-display")[0]?.children || [])
            .filter((el) => el !== target.el)
            .map((el) => {
              const r2 = el.getBoundingClientRect();
              return { left: r2.left, right: r2.right, top: r2.top, bottom: r2.bottom,
                       centerX: r2.left + r2.width / 2, centerY: r2.top + r2.height / 2 };
            })
        : null,
    };
    document.body.style.userSelect = "none";
  }

  // Rounds a position value to the nearest 10px grid line (Layout Editor snap toggle).
  function snapVal(v) { return Math.round(v / 10) * 10; }

  const EDIT_ALIGN_THRESHOLD_PX = 6;
  // Compares the dragged card's projected rect (start rect + raw dx/dy) against the other
  // cards' rects; if a center/edge lines up within EDIT_ALIGN_THRESHOLD_PX on an axis, nudges
  // that axis's delta to align exactly and reports the matched screen coordinate for the guide
  // line. Independent per axis.
  function computeCardAlignment(st, dx, dy) {
    const r = st.startRect;
    const proposed = {
      left: r.left + dx, right: r.right + dx, centerX: r.left + r.width / 2 + dx,
      top: r.top + dy, bottom: r.bottom + dy, centerY: r.top + r.height / 2 + dy,
    };
    let bestDx = null, guideX = null, bestDy = null, guideY = null;
    for (const o of st.otherRects) {
      for (const key of ["centerX", "left", "right"]) {
        const delta = o[key] - proposed[key];
        if (Math.abs(delta) <= EDIT_ALIGN_THRESHOLD_PX && (bestDx === null || Math.abs(delta) < Math.abs(bestDx))) {
          bestDx = delta; guideX = o[key];
        }
      }
      for (const key of ["centerY", "top", "bottom"]) {
        const delta = o[key] - proposed[key];
        if (Math.abs(delta) <= EDIT_ALIGN_THRESHOLD_PX && (bestDy === null || Math.abs(delta) < Math.abs(bestDy))) {
          bestDy = delta; guideY = o[key];
        }
      }
    }
    return {
      dx: bestDx !== null ? dx + bestDx : dx,
      dy: bestDy !== null ? dy + bestDy : dy,
      guideX, guideY,
    };
  }

  function onEditDragMove(e) {
    const st = editDragState;
    if (!st) return;
    const map = st.map || getModeKeys(st.target.kind);
    const c = cfg();
    const dx = e.clientX - st.startClientX;
    const dy = e.clientY - st.startClientY;

    if (st.mode === "move") {
      const snapOn = !!state.ui.editSnapEnabled;
      let adjDx = dx, adjDy = dy, guideX = null, guideY = null;
      if (snapOn && st.target.kind === "card" && st.otherRects && st.otherRects.length) {
        const aligned = computeCardAlignment(st, dx, dy);
        adjDx = aligned.dx; adjDy = aligned.dy; guideX = aligned.guideX; guideY = aligned.guideY;
      }
      // Guide-aligned axes are already pixel-exact; grid-snap only kicks in on axes that
      // didn't align to another card (or when there's no card to align to at all).
      const finalX = (v) => snapOn ? (guideX !== null ? Math.round(v) : snapVal(v)) : Math.round(v);
      const finalY = (v) => snapOn ? (guideY !== null ? Math.round(v) : snapVal(v)) : Math.round(v);

      if (map.xKey) c[map.xKey] = clamp(finalX(st.startX + adjDx), -1500, 1500);
      if (map.perPlayerShift) c[shiftKeyForPlayer(st.target.player)] = clamp(finalY(st.startY + adjDy), -400, 400);
      else if (map.yKey) c[map.yKey] = clamp(finalY(st.startY + adjDy), -1500, 1500);
      if (st.cardMoveStart) {
        const keys = cardPosKeys(st.target.player);
        c[keys.x] = clamp(finalX(st.cardMoveStart.startX + adjDx), -1500, 1500);
        c[keys.y] = clamp(finalY(st.cardMoveStart.startY + adjDy), -1500, 1500);
      }

      if (editGuideV) { editGuideV.style.display = guideX !== null ? "block" : "none"; if (guideX !== null) editGuideV.style.left = guideX + "px"; }
      if (editGuideH) { editGuideH.style.display = guideY !== null ? "block" : "none"; if (guideY !== null) editGuideH.style.top = guideY + "px"; }
    } else if (st.mode === "resize") {
      if (editGuideV) editGuideV.style.display = "none";
      if (editGuideH) editGuideH.style.display = "none";
      if (map.resizeMode === "box") {
        if (map.widthKey) c[map.widthKey] = clamp(Math.round(st.startW + dx), 40, 2000);
        if (map.heightKey) c[map.heightKey] = clamp(Math.round(st.startH + dy), 20, 2000);
        if (st.groupSnapshot) {
          const ratio = clamp((st.startW + dx) / (st.startW || 1), 0.4, 3);
          for (const { key, value } of st.groupSnapshot) {
            c[key] = /_FONT_PX$|_SCALE$|_GAP_PX$/.test(key)
              ? clamp(+(value * ratio).toFixed(2), 0.2, 400)
              : Math.round(value * ratio);
          }
          for (const { key, value } of st.groupBoxSnapshot) {
            if (value > 0) c[key] = clamp(Math.round(value * ratio), 20, 2000);
          }
        }
      } else if (map.resizeMode === "scale") {
        c[map.scaleKey] = clamp(+(st.startScale + dx / 80).toFixed(2), 0.2, 12);
      } else if (map.fontKey) {
        let v = clamp(Math.round(st.startFont + dx), 4, 400);
        v = clampIfSafe((map._base || map).fontKey, v);
        c[map.fontKey] = v;
      }
    }

    applyEditChange();
    updateEditPopoverFields();
  }

  function endDrag() {
    if (!editDragState) return;
    editDragState = null;
    document.body.style.userSelect = "";
    if (editGuideV) editGuideV.style.display = "none";
    if (editGuideH) editGuideH.style.display = "none";
    showToast(T().saved);
  }

  function positionPopover(rect) {
    if (!editPopoverEl || editPopoverEl.style.display === "none") return;
    const margin = 10;
    let left = rect.right + margin;
    let top = rect.top;
    const pw = editPopoverEl.offsetWidth || 240;
    const ph = editPopoverEl.offsetHeight || 200;
    if (left + pw > window.innerWidth - margin) left = rect.left - pw - margin;
    if (left < margin) left = margin;
    if (top + ph > window.innerHeight - margin) top = window.innerHeight - ph - margin;
    if (top < margin) top = margin;
    Object.assign(editPopoverEl.style, { left: left + "px", top: top + "px" });
  }

  function positionEditBoxes() {
    if (!document.querySelector("#ad-ext-player-display")) { setEditMode(false); return; }

    if (editHoverTarget && (!editSelected || editHoverTarget.el !== editSelected.el)) {
      const r = editHoverTarget.el.getBoundingClientRect();
      Object.assign(editHoverBox.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    } else {
      editHoverBox.style.display = "none";
    }

    if (editSelected) reresolveSelection();

    if (editSelected && editSelected.el && editSelected.el.isConnected) {
      const r = editSelected.el.getBoundingClientRect();
      Object.assign(editSelectBox.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
      Object.assign(editHandleEl.style, { display: "block", left: r.right + "px", top: r.bottom + "px" });
      positionPopover(r);
    } else {
      editSelectBox.style.display = "none";
      editHandleEl.style.display = "none";
      if (editPopoverEl) editPopoverEl.style.display = "none";
    }
  }

  function startEditRafLoop() {
    if (editRafHandle) return;
    const tick = () => {
      if (!editModeOn) { editRafHandle = null; return; }
      positionEditBoxes();
      editRafHandle = requestAnimationFrame(tick);
    };
    editRafHandle = requestAnimationFrame(tick);
  }

  function initLayoutEditorOnce() {
    if (__adEditInit) return;
    __adEditInit = true;

    document.addEventListener("pointerdown", (e) => {
      if (!editModeOn) return;
      if (e.button != null && e.button !== 0) return;
      if (e.target.closest && e.target.closest("#ad-edit-popover, #ad-edit-handle, #ad-edit-hint")) return;

      // Only intercept the click if it actually hit something we know how to edit, so anything
      // else on the page (settings gear, Undo/Next when they DON'T resolve to a known target,
      // etc.) keeps working normally while editing.
      const hit = hitTestEditTarget(e.target, e.clientX, e.clientY);
      if (!hit) { selectEditTarget(null); return; }

      e.preventDefault(); e.stopImmediatePropagation();
      selectEditTarget(hit);
      const map = EDIT_KIND_MAP[hit.kind] || GLOBAL_EDIT_MAP[hit.kind];
      if (!map.moveDisabled) beginDrag(hit, e, "move");
    }, true);

    document.addEventListener("pointermove", (e) => {
      if (!editModeOn) return;
      if (editDragState) { onEditDragMove(e); return; }
      const hit = hitTestEditTarget(e.target, e.clientX, e.clientY);
      setHoverTarget(hit);
    }, true);

    window.addEventListener("pointerup", () => { if (editDragState) endDrag(); });

    window.addEventListener("keydown", (e) => {
      if (!editModeOn) return;
      if (e.key === "Escape") exitEditModeAndReopenPanel();
    });
  }

  function exitEditModeAndReopenPanel() {
    setEditMode(false);
    state.ui.selectedTab = "playerinfo";
    setUIOpen(true);
    renderPanel();
  }

  function setEditMode(on) {
    if (on) {
      const host = document.querySelector("#ad-ext-player-display");
      if (!host) { showToast(T().piText.editNeedMatch); return; }
      editModeOn = true;
      ensureEditOverlayEls();
      ensureEditPopover();
      initLayoutEditorOnce();
      setUIOpen(false);
      editHintTextEl.textContent = T().piText.editHint;
      if (editExitBtn) editExitBtn.title = T().piText.editModeOff;
      if (editCopyToGridBtn) editCopyToGridBtn.textContent = T().piText.editCopyToGrid;
      if (editCopyToFlatBtn) editCopyToFlatBtn.textContent = T().piText.editCopyToFlat;
      updateEditSnapBtn();
      editHintEl.style.display = "flex";
      startEditRafLoop();
    } else {
      editModeOn = false;
      editSelected = null;
      editHoverTarget = null;
      editDragState = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (editHintEl) editHintEl.style.display = "none";
      if (editHoverBox) editHoverBox.style.display = "none";
      if (editSelectBox) editSelectBox.style.display = "none";
      if (editHandleEl) editHandleEl.style.display = "none";
      if (editPopoverEl) editPopoverEl.style.display = "none";
      if (editGuideV) editGuideV.style.display = "none";
      if (editGuideH) editGuideH.style.display = "none";
    }
  }

  /* ================== TRIPLE ================== */
  // Random-variety animation classes for triple/double hits (Layout Editor-adjacent CSS at
  // ~1804/1902 defines the "classic"/"punch"/"wild" looks each maps to). Picking one at random
  // per hit keeps a long session from feeling like the same three darts over and over.
  const ANIM_VARIANT_CLASSES = ["ad-anim-classic", "ad-anim-punch", "ad-anim-wild"];
  function pickAnimVariant(varietyOn) {
    return varietyOn ? ANIM_VARIANT_CLASSES[(Math.random() * ANIM_VARIANT_CLASSES.length) | 0] : ANIM_VARIANT_CLASSES[0];
  }
  // Triple and double share the same variant class names, so a card only loses its variant
  // class when it's actually losing markerClass too - otherwise processing an unrelated card
  // in the OTHER handler's loop (e.g. a double card while updateTripleHighlight walks the
  // turn's 3 cards) would strip the wrong hit's animation out from under it.
  function stripAnimMarker(card, markerClass) {
    if (!card.classList.contains(markerClass)) return;
    card.classList.remove(markerClass, ...ANIM_VARIANT_CLASSES);
  }

  function clearTripleClasses() {
    document.querySelectorAll(".ad-ext-turn-throw").forEach(card => {
      stripAnimMarker(card, TRIPLE_CLASS);
      if (card.dataset) delete card.dataset.adTripleToken;
    });
    stopSpark();
  }
  function restartTriple(card, varietyOn) {
    card.classList.remove(TRIPLE_CLASS, ...ANIM_VARIANT_CLASSES);
    void card.offsetWidth;
    card.classList.add(TRIPLE_CLASS, pickAnimVariant(varietyOn));
    const r = card.getBoundingClientRect();
    runMatrixEffects("TRIPLE", { point: { x: r.left + r.width / 2, y: r.top + r.height / 2 } });
  }
  function updateTripleHighlight(turn) {
    const c = cfg();
    if (!c.TRIPLE_ANIM || !turn) return;

    const allow = new Set(TRIPLE_VALUES.map(v => String(v).toUpperCase().trim()));
    const spinMin = clamp(Math.round(Number(c.TRIPLE_SPIN_MIN) || 15), 1, 20);
    const cards = turn.querySelectorAll(".ad-ext-turn-throw");

    for (const card of cards) {
      const p = card.querySelector("p");
      const raw = (p?.textContent || "").trim().toUpperCase();
      const placeholder = (!raw || raw === "..." || raw === "…" || raw.includes("•"));

      // Board spin on qualifying triples (T>=min) — independent of the glow list,
      // so it works for every triple value the user opts into.
      if (placeholder) {
        if (card.dataset && card.dataset.adTripleSpinTok) delete card.dataset.adTripleSpinTok;
      } else {
        const tm = raw.match(/^T(\d{1,2})$/);
        const tnum = tm ? parseInt(tm[1], 10) : 0;
        const spinPrev = (card.dataset && card.dataset.adTripleSpinTok) ? card.dataset.adTripleSpinTok : "";
        if (c.TRIPLE_SPIN && tnum >= spinMin && tnum <= 20 && spinPrev !== raw) {
          if (card.dataset) card.dataset.adTripleSpinTok = raw;
          spinBoard(c.TRIPLE_SPIN_MS, "spin");
        } else if ((tnum < spinMin || !c.TRIPLE_SPIN) && spinPrev) {
          if (card.dataset) delete card.dataset.adTripleSpinTok;
        }
      }

      if (placeholder) {
        stripAnimMarker(card, TRIPLE_CLASS);
        if (card.dataset) delete card.dataset.adTripleToken;
        continue;
      }

      const isTriple = allow.has(raw);
      const prev = (card.dataset && card.dataset.adTripleToken) ? card.dataset.adTripleToken : "";

      if (!isTriple) {
        stripAnimMarker(card, TRIPLE_CLASS);
        if (card.dataset) delete card.dataset.adTripleToken;
        continue;
      }

      if (prev !== raw) {
        if (card.dataset) card.dataset.adTripleToken = raw;
        restartTriple(card, c.TRIPLE_VARIETY);
      } else if (!card.classList.contains(TRIPLE_CLASS) || !ANIM_VARIANT_CLASSES.some(v => card.classList.contains(v))) {
        restartTriple(card, c.TRIPLE_VARIETY);
      }
    }
  }

  /* ================== DOUBLE ================== */
  function clearDoubleClasses() {
    document.querySelectorAll(".ad-ext-turn-throw").forEach(card => {
      stripAnimMarker(card, DOUBLE_CLASS);
      if (card.dataset) delete card.dataset.adDoubleToken;
    });
    stopBanner();
    stopSpark();
    stopFlair();
  }
  function restartDouble(card, varietyOn) {
    card.classList.remove(DOUBLE_CLASS, ...ANIM_VARIANT_CLASSES);
    void card.offsetWidth;
    card.classList.add(DOUBLE_CLASS, pickAnimVariant(varietyOn));
    const r = card.getBoundingClientRect();
    runMatrixEffects("DOUBLE", { point: { x: r.left + r.width / 2, y: r.top + r.height / 2 } });
  }
  function updateDoubleHighlight(turn) {
    const c = cfg();
    if (!c.DOUBLE_ANIM || !turn) return;

    const allow = new Set(DOUBLE_VALUES.map(v => String(v).toUpperCase().trim()));
    const spinMin = clamp(Math.round(Number(c.DOUBLE_SPIN_MIN) || 15), 1, 20);
    const cards = turn.querySelectorAll(".ad-ext-turn-throw");

    let doubleCount = 0, thrownCount = 0;
    for (const card of cards) {
      const p = card.querySelector("p");
      const raw = (p?.textContent || "").trim().toUpperCase();
      const placeholder = (!raw || raw === "..." || raw === "…" || raw.includes("•"));

      // Board spin on qualifying doubles (D>=min), independent of the glow list.
      if (placeholder) {
        if (card.dataset && card.dataset.adDoubleSpinTok) delete card.dataset.adDoubleSpinTok;
      } else {
        const dm = raw.match(/^D(\d{1,2})$/);
        const dnum = dm ? parseInt(dm[1], 10) : 0;
        const spinPrev = (card.dataset && card.dataset.adDoubleSpinTok) ? card.dataset.adDoubleSpinTok : "";
        if (c.DOUBLE_SPIN && dnum >= spinMin && dnum <= 20 && spinPrev !== raw) {
          if (card.dataset) card.dataset.adDoubleSpinTok = raw;
          spinBoard(c.DOUBLE_SPIN_MS, "spin");
        } else if ((dnum < spinMin || !c.DOUBLE_SPIN) && spinPrev) {
          if (card.dataset) delete card.dataset.adDoubleSpinTok;
        }
      }

      if (placeholder) {
        stripAnimMarker(card, DOUBLE_CLASS);
        if (card.dataset) delete card.dataset.adDoubleToken;
        continue;
      }
      thrownCount++;

      const isDouble = allow.has(raw);
      const prev = (card.dataset && card.dataset.adDoubleToken) ? card.dataset.adDoubleToken : "";

      if (!isDouble) {
        stripAnimMarker(card, DOUBLE_CLASS);
        if (card.dataset) delete card.dataset.adDoubleToken;
        continue;
      }
      doubleCount++;

      if (prev !== raw) {
        if (card.dataset) card.dataset.adDoubleToken = raw;
        restartDouble(card, c.DOUBLE_VARIETY);
      } else if (!card.classList.contains(DOUBLE_CLASS) || !ANIM_VARIANT_CLASSES.some(v => card.classList.contains(v))) {
        restartDouble(card, c.DOUBLE_VARIETY);
      }
    }

    // "DOUBLE, DOUBLE!!" - 2+ of this turn's darts are doubles. Fire once per visit (reset when
    // the visit clears, same pattern as the high-score tier tracking below).
    if (c.DOUBLE_STREAK_ANIM && turn.dataset) {
      if (thrownCount === 0) {
        turn.dataset.adDblStreak = "";
      } else if (doubleCount >= 2 && turn.dataset.adDblStreak !== "1") {
        turn.dataset.adDblStreak = "1";
        showBigBanner("DOUBLE, DOUBLE!!", c.DOUBLE_GLOW_HEX, 1300, true);
        runMatrixEffects("DBLSTREAK", { durationMs: 1600 });
      }
    }
  }

  /* ================== HIGH SCORE ================== */
  function clearHighscoreClasses() {
    document.querySelectorAll("." + HIGHSCORE_CLASS).forEach(el => el.classList.remove(HIGHSCORE_CLASS));
    document.querySelectorAll("." + HIGHSCORE_THROW_CLASS).forEach(el => el.classList.remove(HIGHSCORE_THROW_CLASS));
    clearBoardSpin();
    stopFireworks();
    stopConfetti();
    stopDinosaur();
    stopBanner();
    stopFlair();
    stopSpark();
  }
  // tier: 1 = ton (>=100), 2 = ton-forty (>=140+, escalates tier 1's effects), 3 = max/180
  // (escalates further). Effects for all three tiers are driven by runMatrixEffects (the
  // FX_* matrix) rather than fixed per-tier logic.
  // Escalation reuses the same effects at longer durations rather than needing separate settings
  // per tier - a longer spin/fireworks window naturally reads as "bigger" without new CSS.
  function triggerHighscore(tier) {
    const c = cfg();
    const intensity = tier >= 3 ? 1.6 : tier >= 2 ? 1.35 : 1;
    const dur = clamp((Number(c.HIGHSCORE_SHIMMER_MS) || 2000) * intensity, 400, 9000);
    const spinMs = clamp((Number(c.HIGHSCORE_SPIN_MS) || 7000) * intensity, 300, 20000);

    if (c.HIGHSCORE_FLASH) {
      const host = document.querySelector("#ad-ext-player-display");
      if (host) {
        const activePanel = Array.from(host.children).find(p => p.classList && p.classList.contains(ACTIVE_CLASS))
          || Array.from(host.children)[0];
        if (activePanel) {
          activePanel.classList.remove(HIGHSCORE_CLASS);
          void activePanel.offsetWidth;
          activePanel.classList.add(HIGHSCORE_CLASS);
          setTimeout(() => activePanel.classList.remove(HIGHSCORE_CLASS), dur + 200);
        }
      }
    }

    if (c.HIGHSCORE_THROW_FLASH) {
      document.querySelectorAll("#ad-ext-turn .ad-ext-turn-throw.ad-has-throw").forEach(card => {
        if (card.classList.contains(TRIPLE_CLASS) || card.classList.contains(DOUBLE_CLASS)) return;
        card.classList.remove(HIGHSCORE_THROW_CLASS);
        void card.offsetWidth;
        card.classList.add(HIGHSCORE_THROW_CLASS);
        setTimeout(() => card.classList.remove(HIGHSCORE_THROW_CLASS), 1800);
      });
    }

    if (c.HIGHSCORE_SPIN) {
      spinBoard(spinMs, c.HIGHSCORE_BOARD_FLASH ? "spin-flash" : "spin");
    } else if (c.HIGHSCORE_BOARD_FLASH) {
      spinBoard(spinMs, "flash");
    }

    if (tier >= 3 && c.HIGHSCORE3_BANNER) showBigBanner("ONE HUNDRED AND EIGHTY!", c.HIGHSCORE_GLOW_HEX, 1800, true);

    const board = getBoardVisualTargets()[0];
    const point = board ? (() => { const r = board.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })() : null;
    runMatrixEffects(tier >= 3 ? "T3" : tier >= 2 ? "T2" : "T1", { durationMs: spinMs, point });
  }
  function updateHighscoreHighlight(turn) {
    const c = cfg();
    if (!c.HIGHSCORE_ANIM || !turn) return;

    const t1 = Math.max(1, Math.round(Number(c.HIGHSCORE_THRESHOLD) || 100));
    const t2 = Math.max(1, Math.round(Number(c.HIGHSCORE2_THRESHOLD) || 140));
    const t3 = Math.max(1, Math.round(Number(c.HIGHSCORE3_THRESHOLD) || 180));
    const cards = Array.from(turn.querySelectorAll(".ad-ext-turn-throw"));

    let total = 0, count = 0;
    for (const card of cards) {
      const p = card.querySelector("p");
      const raw = (p?.textContent || "").trim().toUpperCase();
      if (!raw || raw === "..." || raw === "…" || raw.includes("•")) continue;
      total += parseThrowValue(raw);
      count++;
    }

    // Track the highest tier already fired this visit, so a turn that jumps straight past 100
    // to 180 in one dart gets the tier-3 celebration (not tier-1), and a turn that escalates
    // across darts (100 -> 140 -> 180) re-fires with the bigger effect each time it crosses a
    // new tier. Reset on a new visit.
    if (count === 0) {
      if (turn.dataset) turn.dataset.adHsTier = "0";
      return;
    }

    const tier = (c.HIGHSCORE3_ENABLED && total >= t3) ? 3
      : (c.HIGHSCORE2_ENABLED && total >= t2) ? 2
      : (total >= t1) ? 1 : 0;
    const firedTier = (turn.dataset && Number(turn.dataset.adHsTier)) || 0;

    if (tier > firedTier) {
      if (turn.dataset) turn.dataset.adHsTier = String(tier);
      triggerHighscore(tier);
    } else if (tier === 0 && turn.dataset) {
      turn.dataset.adHsTier = "0";
    }
  }

  /* ================== "26" FIRE DETECTION ================== */
  // Fires the board-fire effect when a completed 3-dart turn totals exactly 26 (the classic
  // 5-20-1 "bag of nuts"). Requires all three darts so a partial 20+6 doesn't trip early, and
  // dedupes per turn element (adFire26 flag) so the 5s burn only launches once per visit.
  function updateFire26(turn) {
    if (!turn) return;
    const cards = Array.from(turn.querySelectorAll(".ad-ext-turn-throw"));

    let total = 0, count = 0;
    for (const card of cards) {
      const p = card.querySelector("p");
      const raw = (p?.textContent || "").trim().toUpperCase();
      if (!raw || raw === "..." || raw === "…" || raw.includes("•")) continue;
      total += parseThrowValue(raw);
      count++;
    }

    if (count === 0) {
      if (turn.dataset) delete turn.dataset.adFire26;
      return;
    }

    const isTwentySix = count === 3 && total === 26;
    const alreadyFired = turn.dataset && turn.dataset.adFire26 === "1";
    if (isTwentySix && !alreadyFired) {
      if (turn.dataset) turn.dataset.adFire26 = "1";
      launchFire26();
    } else if (!isTwentySix && count < 3 && turn.dataset) {
      // Mid-turn (darts still being retracted/re-thrown): clear so a fresh 26 can re-arm.
      delete turn.dataset.adFire26;
    }
  }

  /* ================== SYNTH SOUND (fireworks boom - no audio asset needed) ============= */
  // Lazily creates a shared AudioContext, unlocked on the page's first pointerdown (same trick
  // the win-audio player below uses) so playback complies with browser autoplay policy.
  let sfxCtx = null;
  function ensureSfxCtx() {
    if (sfxCtx) return sfxCtx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    sfxCtx = new Ctx();
    const unlock = () => { if (sfxCtx && sfxCtx.state === "suspended") sfxCtx.resume().catch(() => {}); };
    document.addEventListener("pointerdown", unlock, { passive: true });
    return sfxCtx;
  }
  function playBoomSound(big) {
    const ctx = ensureSfxCtx();
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      const master = ctx.createGain();
      master.gain.value = big ? 0.5 : 0.35;
      master.connect(ctx.destination);

      // Low sine "thump"
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(big ? 140 : 110, now);
      osc.frequency.exponentialRampToValueAtTime(35, now + (big ? 0.5 : 0.35));
      const oscGain = ctx.createGain();
      oscGain.gain.setValueAtTime(1, now);
      oscGain.gain.exponentialRampToValueAtTime(0.001, now + (big ? 0.55 : 0.4));
      osc.connect(oscGain).connect(master);
      osc.start(now);
      osc.stop(now + (big ? 0.6 : 0.45));

      // Short filtered noise burst (the "crackle")
      const dur = big ? 0.5 : 0.35;
      const buffer = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
      const noise = ctx.createBufferSource();
      noise.buffer = buffer;
      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = "highpass";
      noiseFilter.frequency.value = big ? 1800 : 2400;
      const noiseGain = ctx.createGain();
      noiseGain.gain.value = big ? 0.4 : 0.25;
      noise.connect(noiseFilter).connect(noiseGain).connect(master);
      noise.start(now);
    } catch {}
  }

  /* ================== WIN MUSIC ================== */
let winAudio = null;
let winUnlocked = false;
let winArmed = true;
let winLastPlay = 0;
let winPrevFinishPresent = false;

// ✅ ha a win UI eltűnik (next leg/set vagy auto progress), ennyi ideig várunk, hogy ne villogásra álljon le
let winUiAbsentSince = 0;
const WIN_STOP_ABSENT_MS = 450;

const WIN_PLAY_COOLDOWN_MS = 2500;
const RE_FINISH = /(finish|befejez|beenden)/i;

// ✅ ezekre a gombokra azonnal álljon le
const RE_STOP_BTN = /(finish|befejez|beenden|next\s*leg|következő\s*leg|nächste\s*leg|naechste\s*leg|next\s*set|következő\s*set|nächste\s*set|naechste\s*set)/i;

// Layout Editor (Beta): best-effort text-based detection for the Undo/Next buttons, since Autodarts
// gives them no stable id/class. Matched on trimmed textContent + aria-label, HU/EN/DE only - if
// your Autodarts UI language differs, or these labels change, the buttons just won't tag (no error).
const RE_UNDO_BTN = /^(undo|vissza|rückgängig|rueckgaengig)$/i;
const RE_NEXT_BTN = /^(next|következő|kovetkezo|weiter)$/i;
function tagActionButtons() {
  const btns = document.querySelectorAll("button");
  for (const b of btns) {
    const txt = ((b.textContent || "").trim());
    if (RE_UNDO_BTN.test(txt)) b.classList.add("ad-core-btn-undo");
    else if (RE_NEXT_BTN.test(txt)) b.classList.add("ad-core-btn-next");
  }
}

function safe(fn) { try { return fn(); } catch {} }

function stopWinAudio() {
  if (!winAudio) return;
  safe(() => { winAudio.pause(); winAudio.currentTime = 0; });
}

function installWinStopHooks() {
  if (scopeWin) scopeWin.abort();
  scopeWin = makeScope();

  // ✅ Stop gombokra
  scopeWin.on(document, "click", (e) => {
    const btn = e.target?.closest?.("button, a");
    if (!btn) return;
    const txt = ((btn.textContent || "") + " " + (btn.getAttribute("aria-label") || "")).trim();
    if (RE_STOP_BTN.test(txt)) stopWinAudio();
  }, true); // capture

  // ✅ Navigáció / oldalváltás esetén is álljon le
  const onNav = () => stopWinAudio();
  scopeWin.on(window, "popstate", onNav, true);
  scopeWin.on(window, "hashchange", onNav, true);

  // SPA route váltás (history patch) – ezt nem lehet “unpatch”-elni, ezért csak egyszer
  if (!installWinStopHooks._patched) {
    installWinStopHooks._patched = true;

    const _ps = history.pushState;
    history.pushState = function () {
      const r = _ps.apply(this, arguments);
      onNav();
      return r;
    };
    const _rs = history.replaceState;
    history.replaceState = function () {
      const r = _rs.apply(this, arguments);
      onNav();
      return r;
    };
  }
}

function initWinMusicOnce() {
  if (winAudio) return;

  winAudio = new Audio(WIN_URL);
  winAudio.preload = "auto";
  winAudio.volume = clamp(Number(cfg().WIN_VOLUME ?? 1.0), 0, 1);

  installWinStopHooks();

  const unlock = () => {
    if (winUnlocked || !winAudio) return;
    winUnlocked = true;

    const oldVol = winAudio.volume;
    winAudio.volume = 0;
    safe(() => { winAudio.pause(); winAudio.currentTime = 0; });

    const p = winAudio.play();
    if (p && typeof p.then === "function") {
      p.then(() => {
        safe(() => winAudio.pause());
        safe(() => (winAudio.currentTime = 0));
        winAudio.volume = oldVol;
      }).catch(() => { winAudio.volume = oldVol; winUnlocked = false; });
    } else {
      winAudio.volume = oldVol;
    }
  };

  document.addEventListener("pointerdown", unlock, true);
  document.addEventListener("keydown", unlock, true);
  document.addEventListener("click", unlock, true);
}

function hadThrowInThisTurn() {
  const turn = document.querySelector("#ad-ext-turn");
  const t = (turn?.innerText || "").toUpperCase();
  return /\b[SDT](?:[1-9]|1\d|20)\b/.test(t) || /\bSBULL\b|\bDBULL\b|\bBULL\b|\b25\b|\b50\b/.test(t);
}

function findFinishButton() {
  const btns = Array.from(document.querySelectorAll("button"));
  for (const b of btns) {
    const txt = ((b.textContent || "") + " " + (b.getAttribute("aria-label") || "")).trim();
    if (RE_FINISH.test(txt)) return b;
  }
  return null;
}

function findStopButtonPresent() {
  const btns = Array.from(document.querySelectorAll("button"));
  for (const b of btns) {
    const txt = ((b.textContent || "") + " " + (b.getAttribute("aria-label") || "")).trim();
    if (RE_STOP_BTN.test(txt)) return true;
  }
  return false;
}

function scanWinMusic() {
  const c = cfg();
  if (!c.WIN_MUSIC) return;

  if (!winAudio) initWinMusicOnce();
  if (winAudio) winAudio.volume = clamp(Number(c.WIN_VOLUME ?? 1.0), 0, 1);

  const finishPresent = !!findFinishButton();
  const stopUiPresent = finishPresent || findStopButtonPresent();

  // ha még nem volt dobás ebben a turnben, újra “élesítjük”
  if (!hadThrowInThisTurn()) winArmed = true;

  // ✅ START: finish megjelent ÉS volt dobás
  if (finishPresent && !winPrevFinishPresent && hadThrowInThisTurn()) {
    const t = Date.now();
    if (winArmed && winUnlocked && t - winLastPlay > WIN_PLAY_COOLDOWN_MS) {
      winArmed = false;
      winLastPlay = t;
      winUiAbsentSince = 0;

      safe(() => { winAudio.pause(); winAudio.currentTime = 0; });
      const pr = winAudio.play();
      if (pr && typeof pr.catch === "function") pr.catch(() => {});
    }
  }

  // ✅ STOP: csak akkor álljon meg, ha a win UI eltűnt (auto new leg/set, auto exit, stb.)
  // (nem időre, nem gif hosszra)
  if (winAudio && !winAudio.paused) {
    if (stopUiPresent) {
      winUiAbsentSince = 0;
    } else {
      if (!winUiAbsentSince) winUiAbsentSince = Date.now();
      else if (Date.now() - winUiAbsentSince >= WIN_STOP_ABSENT_MS) {
        stopWinAudio();
        winUiAbsentSince = 0;
      }
    }
  }

  winPrevFinishPresent = finishPresent;
}

  /* ================== FLOATING CLOCK ================== */
  let clockEl = null;
  let clockTimeEl = null;
  let clockDrag = null;
  let clockTicker = null;

  const CLOCK_SCALE_MIN = 0.6;
  const CLOCK_SCALE_MAX = 2.0;
  const CLOCK_SCALE_STEP = 0.05;

  function buildClockIfNeeded() {
    if (clockEl) return;

    clockEl = document.createElement("div");
    clockEl.id = "ad-core-floating-clock";
    Object.assign(clockEl.style, {
      position: "fixed",
      zIndex: 2147483647,
      left: "0px",
      top: "0px",
      padding: "10px 12px",
      borderRadius: "12px",
      boxShadow: "0 6px 18px rgba(0,0,0,.55)",
      userSelect: "none",
      pointerEvents: "auto",
      transformOrigin: "top left",
      display: "flex",
      alignItems: "center",
      gap: "10px",
      cursor: "move"
    });

    clockTimeEl = document.createElement("span");
    Object.assign(clockTimeEl.style, {
      fontSize: "22px",
      fontWeight: "800",
      fontFamily: "Arial, sans-serif",
      letterSpacing: "0.3px",
      whiteSpace: "nowrap"
    });

    clockEl.appendChild(clockTimeEl);
    document.body.appendChild(clockEl);

    clockEl.addEventListener("pointerdown", (e) => {
      const cs = state.ui.clock;
      if (!cs.enabled) return;
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      clockEl.setPointerCapture?.(e.pointerId);
      clockDrag = { dx: e.clientX - clockEl.offsetLeft, dy: e.clientY - clockEl.offsetTop };
      clockEl.style.opacity = "0.95";
    });

    window.addEventListener("pointermove", (e) => {
      if (!clockDrag || !clockEl) return;
      const cs = state.ui.clock;
      const r = clockEl.getBoundingClientRect();
      const nx = e.clientX - clockDrag.dx;
      const ny = e.clientY - clockDrag.dy;
      const safe = ensureVisible(nx, ny, r.width, r.height);
      cs.x = Math.round(safe.x);
      cs.y = Math.round(safe.y);
      cs.blL = cs.x;
      cs.blB = Math.round(window.innerHeight - (cs.y + r.height));
      applyClockPosition();
    }, { passive: true });

    window.addEventListener("pointerup", () => {
      if (!clockDrag) return;
      clockDrag = null;
      clockEl.style.opacity = "1";
      saveStateDebounced();
      showToast(T().toasts.clockSaved);
    });

    clockEl.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const dir = e.deltaY > 0 ? -1 : 1;
      const cs = state.ui.clock;
      cs.scale = clamp(Math.round((cs.scale + dir * CLOCK_SCALE_STEP) * 100) / 100, CLOCK_SCALE_MIN, CLOCK_SCALE_MAX);
      applyClockScale();
      applyClockPosition();
      saveStateDebounced();
      renderPanelIfOpen();
    }, { passive: false });

    clockEl.addEventListener("dblclick", (e) => {
      e.preventDefault();
      const cs = state.ui.clock;
      if (e.shiftKey) cs.showSeconds = !cs.showSeconds;
      else cs.format24 = !cs.format24;
      saveStateDebounced();
      renderClockTime();
      renderPanelIfOpen();
    });

    if (!clockTicker) {
      clockTicker = setInterval(() => {
        if (!clockEl) return;
        if (!state.ui.clock.enabled) return;
        renderClockTime();
      }, 250);
    }

    applyClockStyle();
    applyClockScale();
    applyClockPosition();
    applyClockEnabled();
    renderClockTime();
  }

  function applyClockEnabled() {
    if (!clockEl) return;
    clockEl.style.display = state.ui.clock.enabled ? "flex" : "none";
  }
  function applyClockScale() {
    if (!clockEl) return;
    clockEl.style.transform = `scale(${state.ui.clock.scale || 1})`;
  }
  function applyClockStyle() {
    if (!clockEl) return;
    const cs = state.ui.clock;
    clockEl.style.background = hexToRgba(cs.bgHex, cs.bgAlpha);
    clockEl.style.color = sanitizeHex(cs.textHex, "#ffffff");
  }

  function applyClockPosition() {
    if (!clockEl) return;
    const cs = state.ui.clock;

    const r = clockEl.getBoundingClientRect();
    if (typeof cs.blL === "number" && typeof cs.blB === "number") {
     cs.x = Math.round(cs.blL);
     cs.y = Math.round(window.innerHeight - cs.blB - r.height);
    }
    let x = cs.x;
    let y = cs.y;

    // default: jobb felül
    if (typeof x !== "number") x = Math.round(window.innerWidth - r.width - 16);
    if (typeof y !== "number") y = 16;

    const safe = ensureVisible(x, y, r.width, r.height, 8);

    clockEl.style.left = Math.round(safe.x) + "px";
    clockEl.style.top  = Math.round(safe.y) + "px";
  }

  // ✅ locale követi a nyelvet (hu-HU / en-US / de-DE)
  function renderClockTime() {
    if (!clockTimeEl) return;
    const cs = state.ui.clock;

    const opts = {
      hour: "2-digit",
      minute: "2-digit",
      second: cs.showSeconds ? "2-digit" : undefined,
      hour12: !cs.format24
    };
    if (!cs.showSeconds) delete opts.second;

    const loc = (state.ui.lang === "en") ? "en-US" : (state.ui.lang === "de" ? "de-DE" : "hu-HU");
    clockTimeEl.textContent = new Date().toLocaleTimeString(loc, opts);
  }

  function resetClockLook() {
    state.ui.clock = { ...clone(DEFAULT_CLOCK), enabled: state.ui.clock.enabled, x: state.ui.clock.x, y: state.ui.clock.y };
    applyClockStyle(); applyClockScale(); applyClockPosition(); renderClockTime();
    saveStateDebounced();
  }
  function resetClockPosition() {
    state.ui.clock.x = null;
    state.ui.clock.y = null;
    state.ui.clock.blL = null;
    state.ui.clock.blB = null;
    applyClockPosition();
    saveStateDebounced();
  }

  /* ================== PERF: DIRTY FLAGS ================== */
  const DIRTY = {
    turn: true,
    players: true,
    board: true,
    bm: true,
    skin: true,
  };
  function dirtyTurn(){ DIRTY.turn = true; }
  function dirtyPlayers(){ DIRTY.players = true; }
  function dirtyBoard(){ DIRTY.board = true; }
  function dirtyBm(){ DIRTY.bm = true; }
  function dirtySkin(){ DIRTY.skin = true; }

  /* ================== UPDATE SCHEDULING ================== */
  let scheduled = false;
  let wasGameActive = false;
  function scheduleUpdate() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;

      renderCss();

      // Skin only if dirty
      if (DIRTY.skin) {
        DIRTY.skin = false;
        ensureSkinCss();
      }

      if (DIRTY.board) {
        DIRTY.board = false;
        scheduleBoardMark();
      }

      if (DIRTY.bm) {
        DIRTY.bm = false;
        ensureBmBackButton();
      }

      const c = cfg();

      if (c.ACTIVE_PLAYER_HIGHLIGHT && DIRTY.players) {
        DIRTY.players = false;
        updateActivePlayerHighlight();
      }

      if (c.PLAYER_INFO) tagPlayerInfo();
      tagActionButtons();

      const turn = document.querySelector("#ad-ext-turn");
      const gameActive = !!turn;
      if (gameActive && !wasGameActive && c.BOARD_MARKER) {
        // Equivalent to pressing "Marker now" when a game view appears.
        runBoardMarkerBurst();
      }
      wasGameActive = gameActive;

      if (turn && DIRTY.turn) {
        DIRTY.turn = false;

        if (c.TOTAL_VIEW) forceCenterTotalOverlay(turn);
        else restoreTotalOverlays(turn);

        if (c.THROWS_TO_POINTS) updateAllThrowGroups(turn);
        // ✅ mindig visszarakjuk a kijelölt kártyára
        applyStickyThrowSelection(turn);
        if (c.CHECKOUT_VIEW) markCheckoutInTurnBar(turn);
        if (c.TRIPLE_ANIM) updateTripleHighlight(turn);
        if (c.DOUBLE_ANIM) updateDoubleHighlight(turn);
        if (c.HIGHSCORE_ANIM) updateHighscoreHighlight(turn);
        if (c.FIRE26_ENABLED) updateFire26(turn);

        if (c.WIN_MUSIC) scanWinMusic();
      } else {
        // ✅ ha nem volt turn-dirty, akkor is tartsuk életben
        if (turn) applyStickyThrowSelection(turn);
        if (c.WIN_MUSIC) scanWinMusic();
      }

      if (clockEl) {
        applyClockStyle();
        applyClockScale();
        applyClockPosition();
        applyClockEnabled();
      }
    });
  }

  /* ================== ACTIVE POLL TIMER ================== */
  let activePollTimer = null;
  function configureActivePolling() {
    if (activePollTimer) { clearInterval(activePollTimer); activePollTimer = null; }
    const c = cfg();
    if (c.ACTIVE_PLAYER_HIGHLIGHT && (c.ACTIVE_POLL_MS | 0) > 0) {
      activePollTimer = setInterval(updateActivePlayerHighlight, c.ACTIVE_POLL_MS | 0);
    }
  }

  function applyToggleSideEffects() {
    const c = cfg();
    if (!c.ACTIVE_PLAYER_HIGHLIGHT) clearActiveClasses();
    if (!c.TRIPLE_ANIM) clearTripleClasses();
    if (!c.DOUBLE_ANIM) clearDoubleClasses();
    if (!c.HIGHSCORE_ANIM) clearHighscoreClasses();
    if (!cfg().WIN_MUSIC) stopWinAudio();
    if (!cfg().WIN_MUSIC && scopeWin) { scopeWin.abort(); scopeWin = null; }
    configureActivePolling();

    // toggles can affect everything
    dirtyTurn();
    dirtyPlayers();
    dirtyBoard();
    dirtyBm();
    dirtySkin();

    scheduleUpdate();
  }

  /* ================== UI ================== */
  let uiBtn = null;
  let panel = null;
  let toastEl = null;
  let fileInput = null;
  let themeFileInput = null;
  let themeTargetPreset = null;  // which preset slot (0/1/2) a loaded theme is written into; defaults to the active one
  let themeGalleryCache = null;  // manifest fetched from GitHub, cached for the session

  function gearIconSvg() {
    return `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
           xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0
                 .276 1.134 1.56 1.69 2.573 1.066
                 1.543-.94 3.31.826 2.37 2.37
                 -.624 1.012-.068 2.297 1.066 2.573
                 1.756.426 1.756 2.924 0 3.35
                 -1.134.276-1.69 1.56-1.066 2.573
                 .94 1.543-.826 3.31-2.37 2.37
                 -1.012-.624-2.297-.068-2.573 1.066
                 -.426 1.756-2.924 1.756-3.35 0
                 -.276-1.134-1.56-1.69-2.573-1.066
                 -1.543.94-3.31-.826-2.37-2.37
                 .624-1.012.068-2.297-1.066-2.573
                 -1.756-.426-1.756-2.924 0-3.35
                 1.134-.276 1.69-1.56 1.066-2.573
                 -.94-1.543.826-3.31 2.37-2.37
                 1.012.624 2.297.068 2.573-1.066Z"
              stroke="white" stroke-width="2" stroke-linejoin="round"/>
        <path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0-6 0"
              stroke="white" stroke-width="2" stroke-linecap="round"/>
      </svg>
    `;
  }

  function styleBtn(el) {
    Object.assign(el.style, {
      border: "1px solid rgba(255,255,255,0.18)",
      background: "rgba(0,0,0,0.55)",
      color: "#fff",
      borderRadius: "12px",
      cursor: "pointer",
      fontWeight: "800",
      backdropFilter: "blur(6px)",
      boxShadow: "0 10px 24px rgba(0,0,0,0.45)"
    });
    el.addEventListener("mouseenter", () => el.style.filter = "brightness(1.12)");
    el.addEventListener("mouseleave", () => el.style.filter = "none");
  }

  function showToast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg || T().saved;
    toastEl.style.opacity = "1";
    toastEl.style.transform = "translateX(-50%) translateY(0)";
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      toastEl.style.opacity = "0";
      toastEl.style.transform = "translateX(-50%) translateY(6px)";
    }, 1100);
  }

  function renderPanelIfOpen(){ if (panel && state.ui.open) renderPanel(); }

  function setUIOpen(open) {
    state.ui.open = open;
    if (panel) panel.style.display = open ? "flex" : "none";
    saveStateDebounced();
  }

  let __migratedPanelBL = false;

function ensurePanelPosition() {
  if (!panel) return;
  const r = panel.getBoundingClientRect();

  // hagyjunk helyet alul a 44px-es fő gombnak + padding
  const RESERVED_BOTTOM = 44 + 16 + 12;

  // 1) Egyszeri migráció régi x/y-ból BL-be (ha volt mentett pozíciód)
  if (!__migratedPanelBL) {
    if (typeof state.ui.panelL !== "number" && typeof state.ui.x === "number") state.ui.panelL = state.ui.x;
    if (typeof state.ui.panelB !== "number" && typeof state.ui.y === "number") state.ui.panelB = Math.round(window.innerHeight - (state.ui.y + r.height));
    __migratedPanelBL = true;
    saveStateDebounced();
  }

  const wantL = (typeof state.ui.panelL === "number") ? state.ui.panelL : 16;
  const wantB = (typeof state.ui.panelB === "number") ? state.ui.panelB : RESERVED_BOTTOM;

  const wantX = Math.round(wantL);
  const wantY = Math.round(window.innerHeight - wantB - r.height);

  const safe = ensureVisible(wantX, wantY, r.width, r.height, 8);

  panel.style.left = Math.round(safe.x) + "px";
  panel.style.top  = Math.round(safe.y) + "px";

  // csak akkor írjuk át a mentést, ha ténylegesen clamping történt
  if (Math.round(safe.x) !== wantX || Math.round(safe.y) !== wantY) {
    state.ui.panelL = Math.round(safe.x);
    state.ui.panelB = Math.round(window.innerHeight - (safe.y + r.height));
    state.ui.x = Math.round(safe.x);
    state.ui.y = Math.round(safe.y);
    saveStateDebounced();
  }
}

  let __migratedBtnBL = false;

function ensureMainButtonPosition() {
  if (!uiBtn) return;
  const size = 44;

  if (!__migratedBtnBL) {
    if (typeof state.ui.btnL !== "number" && typeof state.ui.btnX === "number") state.ui.btnL = state.ui.btnX;
    if (typeof state.ui.btnB !== "number" && typeof state.ui.btnY === "number") state.ui.btnB = Math.round(window.innerHeight - (state.ui.btnY + size));
    __migratedBtnBL = true;
    saveStateDebounced();
  }

  const wantL = (typeof state.ui.btnL === "number") ? state.ui.btnL : 16;
  const wantB = (typeof state.ui.btnB === "number") ? state.ui.btnB : 16;

  const wantX = Math.round(wantL);
  const wantY = Math.round(window.innerHeight - wantB - size);

  const safe = ensureVisible(wantX, wantY, size, size, 8);

  uiBtn.style.left = Math.round(safe.x) + "px";
  uiBtn.style.top  = Math.round(safe.y) + "px";
  uiBtn.style.bottom = "auto";
  uiBtn.style.right  = "auto";

  if (Math.round(safe.x) !== wantX || Math.round(safe.y) !== wantY) {
    state.ui.btnL = Math.round(safe.x);
    state.ui.btnB = Math.round(window.innerHeight - (safe.y + size));
    state.ui.btnX = Math.round(safe.x);
    state.ui.btnY = Math.round(safe.y);
    saveStateDebounced();
  }
}

  function presetLabel(i) { return PRESET_LABELS[i] || String(i); }

  function setActivePreset(i) {
    state.activePreset = clamp(i, 0, PRESET_COUNT - 1);
    applySafeClampsToCfg();
    saveStateDebounced();
    renderCss();
    applyToggleSideEffects();
    renderPanelIfOpen();
    showToast(T().toasts.preset(presetLabel(state.activePreset)));
  }

  // ✅ Teljes nyelvfrissítés: panel + tooltip + /boards gomb + óra locale + toast
  function setLang(newLang) {
    state.ui.lang = (newLang === "en" || newLang === "de") ? newLang : "hu";
    saveStateDebounced();

    if (uiBtn) uiBtn.title = `${T().appTitle} (Shift+F)`;
    if (panel && state.ui.open) renderPanel();

    dirtyBm();
    scheduleUpdate();

    if (clockEl && state.ui.clock.enabled) renderClockTime();
    showToast(T().toasts.lang);
  }

  function pillStyle(level) {
    if (level === "danger") return ["rgba(255,60,60,.18)", "rgba(255,60,60,.65)"];
    if (level === "warn")   return ["rgba(255,190,60,.16)", "rgba(255,190,60,.65)"];
    return ["rgba(60,255,120,.12)", "rgba(60,255,120,.55)"];
  }

  function makePill(text, level = "ok") {
    const [bg, br] = pillStyle(level);
    const s = document.createElement("span");
    s.textContent = text;
    Object.assign(s.style, {
      minWidth: "66px",
      textAlign: "center",
      padding: "6px 8px",
      borderRadius: "999px",
      border: `1px solid ${br}`,
      background: bg,
      fontWeight: "900",
      fontSize: "12px",
      opacity: "0.95",
      userSelect: "none",
    });
    return s;
  }

  function mkRow(labelText, rightEl, compact) {
    const row = document.createElement("div");
    Object.assign(row.style, { display:"flex", alignItems:"center", justifyContent:"space-between", gap: compact ? "10px" : "12px" });
    const left = document.createElement("div");
    left.textContent = labelText;
    left.style.opacity = "0.9";
    left.style.fontSize = compact ? "12px" : "13px";
    row.appendChild(left);
    row.appendChild(rightEl);
    return row;
  }

  function mkSliderRow(labelText, slider, pillText, level, compact) {
    slider.style.width = compact ? "190px" : "220px";
    const wrap = document.createElement("div");
    Object.assign(wrap.style, { display:"flex", alignItems:"center", gap: compact ? "8px" : "10px" });
    const pill = makePill(pillText, level);
    wrap.appendChild(slider);
    wrap.appendChild(pill);
    return {
      row: mkRow(labelText, wrap, compact),
      setPill: (t, lvl="ok") => {
        pill.textContent = t;
        const [bg, br] = pillStyle(lvl);
        pill.style.background = bg;
        pill.style.border = `1px solid ${br}`;
      }
    };
  }

  function mkButton(text, onClick, variant="ghost", compact=false) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;

    Object.assign(b.style, {
      padding: compact ? "8px 10px" : "10px 12px",
      borderRadius: "12px",
      border: "1px solid rgba(255,255,255,.18)",
      cursor: "pointer",
      fontWeight: "900",
      color: "#fff",
      background: "rgba(255,255,255,.08)",
      fontSize: compact ? "12px" : "13px",
    });

    if (variant === "primary") {
      b.style.background = "rgba(60,255,120,.16)";
      b.style.border = "1px solid rgba(60,255,120,.55)";
    }

    b.addEventListener("mouseenter", () => b.style.filter = "brightness(1.12)");
    b.addEventListener("mouseleave", () => b.style.filter = "none");
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onClick?.(); });

    return b;
  }

  function tabTitle(tab) { return T().tab[tab] || tab; }

  function resetTab(tab) {
    const c = cfg();
    const d = DEFAULT_CFG;

    const map = {
      throws: ["THROW_VAL_FONT_PX","THROW_VAL_COLOR_HEX","THROW_VAL_OPACITY","THROW_BG_HEX","THROW_BG_OPACITY","THROW_HOVER_BG_HEX","THROW_HOVER_BG_OPACITY"],
      orig: ["ORIG_FONT_PX","ORIG_COLOR_HEX","ORIG_OPACITY"],
      total: ["TOTAL_FONT_PX","TOTAL_COLOR_HEX","TOTAL_OPACITY","TOTAL_BG_HEX","TOTAL_BG_OPACITY"],
      checkout: ["CHECKOUT_FONT_PX","CHECKOUT_COLOR_HEX","CHECKOUT_OPACITY"],
      playerinfo: ["PI_NAME_FONT_PX","PI_SCORE_FONT_PX","PI_AVG_FONT_PX","PI_HISTORY_FONT_PX","PI_AVATAR_SCALE",
                   "PI_CUSTOM_COLORS","PI_NAME_COLOR_HEX","PI_SCORE_COLOR_HEX","PI_AVG_COLOR_HEX","PI_HISTORY_COLOR_HEX",
                   "PI_STACK_GAP_PX","PI_HISTORY_WIDTH_PX","PI_HISTORY_HEIGHT_PX","PI_CARD_WIDTH_PX","PI_CARD_HEIGHT_PX",
                   "PI_AVATAR_X_PX","PI_AVATAR_OFFSET_PX","PI_SCORE_X_PX","PI_SCORE_Y_PX",
                   "PI_NAME_X_PX","PI_NAME_Y_PX","PI_AVG_X_PX","PI_AVG_Y_PX","PI_HISTORY_X_PX","PI_HISTORY_OFFSET_PX",
                   "PI_P1_SHIFT_Y","PI_P2_SHIFT_Y","PI_P3_SHIFT_Y","PI_P4_SHIFT_Y","PI_GRID_ADJUST","PI_GRID_SCALE","PI_PER_PLAYER_COLORS",
                   "PI_P2_NAME_COLOR_HEX","PI_P2_SCORE_COLOR_HEX","PI_P2_AVG_COLOR_HEX","PI_P2_HISTORY_COLOR_HEX",
                   "PI_P3_NAME_COLOR_HEX","PI_P3_SCORE_COLOR_HEX","PI_P3_AVG_COLOR_HEX","PI_P3_HISTORY_COLOR_HEX",
                   "PI_P4_NAME_COLOR_HEX","PI_P4_SCORE_COLOR_HEX","PI_P4_AVG_COLOR_HEX","PI_P4_HISTORY_COLOR_HEX",
                   "PI_TEXT_EFFECTS"],
      active: ["ACTIVE_COLOR_HEX","ACTIVE_OUTLINE_PX","ACTIVE_GLOW","ACTIVE_TRAIL","ACTIVE_TRAIL_SPEED_MS","ACTIVE_TRAIL_COLOR_HEX","ACTIVE_PER_PLAYER",
               "ACTIVE_P2_COLOR_HEX","ACTIVE_P2_OUTLINE_PX","ACTIVE_P2_GLOW","ACTIVE_P2_TRAIL","ACTIVE_P2_TRAIL_SPEED_MS","ACTIVE_P2_TRAIL_COLOR_HEX",
               "ACTIVE_P3_COLOR_HEX","ACTIVE_P3_OUTLINE_PX","ACTIVE_P3_GLOW","ACTIVE_P3_TRAIL","ACTIVE_P3_TRAIL_SPEED_MS","ACTIVE_P3_TRAIL_COLOR_HEX",
               "ACTIVE_P4_COLOR_HEX","ACTIVE_P4_OUTLINE_PX","ACTIVE_P4_GLOW","ACTIVE_P4_TRAIL","ACTIVE_P4_TRAIL_SPEED_MS","ACTIVE_P4_TRAIL_COLOR_HEX"],
      triple: ["TRIPLE_SHIMMER_MS","TRIPLE_SLAM_MS","TRIPLE_RATTLE_MS","TRIPLE_RATTLE_DELAY_MS","TRIPLE_GLOW_HEX","TRIPLE_GLOW","TRIPLE_FLASH","TRIPLE_SPIN","TRIPLE_SPIN_MS","TRIPLE_SPIN_MIN","TRIPLE_VARIETY"],
      double: ["DOUBLE_SHIMMER_MS","DOUBLE_SLAM_MS","DOUBLE_RATTLE_MS","DOUBLE_RATTLE_DELAY_MS","DOUBLE_GLOW_HEX","DOUBLE_GLOW","DOUBLE_FLASH","DOUBLE_SPIN","DOUBLE_SPIN_MS","DOUBLE_SPIN_MIN","DOUBLE_VARIETY","DOUBLE_STREAK_ANIM"],
      highscore: ["HIGHSCORE_THRESHOLD","HIGHSCORE_SHIMMER_MS","HIGHSCORE_GLOW_HEX","HIGHSCORE_GLOW","HIGHSCORE_FLASH","HIGHSCORE_SPIN","HIGHSCORE_SPIN_MS","HIGHSCORE_BOARD_FLASH","HIGHSCORE_THROW_FLASH",
                 "HIGHSCORE2_ENABLED","HIGHSCORE2_THRESHOLD","HIGHSCORE3_ENABLED","HIGHSCORE3_THRESHOLD","HIGHSCORE3_BANNER","FIRE26_ENABLED","FIRE26_VIDEO_URL","FIRE26_VIDEO_SCALE"],
      fx: [...FX_MATRIX_KEYS, "FX_MATRIX_ENABLED", "FX_SOUND_ENABLED"],
      win: ["WIN_VOLUME"],
      skin: ["SKIN_UI_SCALE","SKIN_SPACING_PLAYER","SKIN_BG_URL","SKIN_BG_OVERLAY_ALPHA","SKIN_PLAYER_BG_HEX","SKIN_PLAYER_BG_OPACITY"],
    };

    if (tab === "clock") {
      const keepEnabled = state.ui.clock.enabled;
      state.ui.clock = clone(DEFAULT_CLOCK);
      state.ui.clock.enabled = keepEnabled;
      buildClockIfNeeded();
      applyClockEnabled();
      applyClockStyle();
      applyClockScale();
      applyClockPosition();
      renderClockTime();
      saveStateDebounced();
      renderPanelIfOpen();
      showToast(T().toasts.resetTab);
      return;
    }

    const keys = map[tab] || [];
    keys.forEach(k => { c[k] = clone(d[k]); });

    applySafeClampsToCfg();
    saveStateDebounced();
    renderCss();
    dirtyTurn(); dirtyPlayers(); dirtyBoard(); dirtyBm(); dirtySkin();
    scheduleUpdate();
    showToast(T().toasts.resetTab);
    renderPanelIfOpen();
  }

  function resetPreset(idx) {
    state.presets[idx] = (idx === 0) ? presetA() : presetBC();
    applySafeClampsToCfg();
    saveStateDebounced();
    renderCss();
    applyToggleSideEffects();
    renderPanelIfOpen();
    showToast(T().toasts.resetPreset);
  }

  function resetAll() {
    if (!confirm(T().resetAllConfirm)) return;
    state = clone(DEFAULT_STATE);
    saveStateNow();
    ensureUIStyle();
    renderCss();
    applyToggleSideEffects();
    renderPanelIfOpen();
    if (panel) ensurePanelPosition();
    if (uiBtn) ensureMainButtonPosition();
    if (clockEl) applyClockEnabled();
    showToast(T().toasts.resetAll);
  }

  /* ================== UI BUILD ================== */
  function buildUIChrome() {
    if (uiBtn || panel) return;
    ensureUIStyle();

    uiBtn = document.createElement("button");
    uiBtn.type = "button";
    uiBtn.title = `${T().appTitle} (Shift+F)`;
    uiBtn.innerHTML = gearIconSvg();
    Object.assign(uiBtn.style, {
      position: "fixed",
      width: "44px",
      height: "44px",
      zIndex: 2147483647,
      display: "grid",
      placeItems: "center",
      padding: "0",
      touchAction: "none",
    });
    styleBtn(uiBtn);
    document.body.appendChild(uiBtn);
    ensureMainButtonPosition();

    // click vs drag
    let btnDrag = null;
    let btnMoved = false;

    uiBtn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      uiBtn.setPointerCapture?.(e.pointerId);
      btnMoved = false;
      btnDrag = {
        sx: e.clientX,
        sy: e.clientY,
        dx: e.clientX - uiBtn.offsetLeft,
        dy: e.clientY - uiBtn.offsetTop,
      };
    });

    window.addEventListener("pointermove", (e) => {
      if (!btnDrag) return;
      const dist = Math.abs(e.clientX - btnDrag.sx) + Math.abs(e.clientY - btnDrag.sy);
      if (dist > 4) btnMoved = true;

      const nx = e.clientX - btnDrag.dx;
      const ny = e.clientY - btnDrag.dy;
      const safe = ensureVisible(nx, ny, 44, 44, 8);
      state.ui.btnX = Math.round(safe.x);
      state.ui.btnY = Math.round(safe.y);
      uiBtn.style.left = state.ui.btnX + "px";
      uiBtn.style.top  = state.ui.btnY + "px";
      state.ui.btnL = state.ui.btnX;
      state.ui.btnB = Math.round(window.innerHeight - (state.ui.btnY + 44));
    }, { passive: true });

    window.addEventListener("pointerup", () => {
      if (!btnDrag) return;
      btnDrag = null;

      if (btnMoved) {
        saveStateDebounced();
        showToast(T().toasts.btnPosSaved);
        return;
      }

      setUIOpen(!state.ui.open);
      if (state.ui.open) { renderPanel(); ensurePanelPosition(); }
    });

    // panel
    panel = document.createElement("div");
    panel.id = "ad-core-panel";
    Object.assign(panel.style, {
      position: "fixed",
      left: "16px",
      top: "80px",
      zIndex: 2147483647,
      width: "780px",
      maxWidth: "calc(100vw - 32px)",
      maxHeight: "85vh",
      borderRadius: "16px",
      border: "1px solid rgba(255,255,255,0.14)",
      background: "rgba(0,0,0,0.78)",
      color: "#fff",
      boxShadow: "0 18px 48px rgba(0,0,0,0.62)",
      backdropFilter: "blur(10px)",
      fontFamily: "Arial, system-ui, sans-serif",
      display: state.ui.open ? "flex" : "none",
      flexDirection: "column",
      overflow: "hidden",
    });
    document.body.appendChild(panel);

    toastEl = document.createElement("div");
    Object.assign(toastEl.style, {
      position: "fixed",
      left: "50%",
      bottom: "18px",
      transform: "translateX(-50%) translateY(6px)",
      zIndex: 2147483647,
      padding: "10px 12px",
      borderRadius: "999px",
      border: "1px solid rgba(255,255,255,0.18)",
      background: "rgba(0,0,0,0.65)",
      color: "#fff",
      fontWeight: "900",
      opacity: "0",
      transition: "opacity .18s ease, transform .18s ease",
      pointerEvents: "none",
    });
    document.body.appendChild(toastEl);

    fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "application/json";
    fileInput.style.display = "none";
    document.body.appendChild(fileInput);

    fileInput.addEventListener("change", (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        const parsed = tryParseJSON(reader.result);
        if (!parsed) { alert(T().alerts.invalidJson); return; }
        state = migrateToState(parsed);
        applySafeClampsToCfg();
        saveStateDebounced();
        ensureUIStyle();
        renderCss();
        dirtyTurn(); dirtyPlayers(); dirtyBoard(); dirtyBm(); dirtySkin();
        scheduleUpdate();
        renderPanel();
        buildClockIfNeeded();
        applyClockEnabled();
        applyClockStyle();
        applyClockScale();
        applyClockPosition();
        renderClockTime();
        ensureBmBackButton();
        showToast(T().toasts.import);
      };
      reader.readAsText(f);
    });

    themeFileInput = document.createElement("input");
    themeFileInput.type = "file";
    themeFileInput.accept = "application/json";
    themeFileInput.style.display = "none";
    document.body.appendChild(themeFileInput);

    themeFileInput.addEventListener("change", (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        const parsed = tryParseJSON(reader.result);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { alert(T().alerts.invalidJson); return; }
        const idx = themeTargetPreset ?? state.activePreset;
        applyThemeDiffToPreset(parsed, idx);
        showToast(`${T().toasts.themeApplied} ${presetLabel(idx)}`);
      };
      reader.readAsText(f);
    });

    // drag panel via header
    let drag = null;
    panel.addEventListener("pointerdown", (e) => {
      const header = panel.querySelector(".ad-core-header");
      if (!header) return;
      if (!header.contains(e.target)) return;
      if (e.target.closest("button") || e.target.closest("input") || e.target.closest("a")) return;

      e.preventDefault();
      panel.setPointerCapture?.(e.pointerId);
      drag = { dx: e.clientX - panel.offsetLeft, dy: e.clientY - panel.offsetTop };
    });

    window.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const r = panel.getBoundingClientRect();
      const safe = ensureVisible(e.clientX - drag.dx, e.clientY - drag.dy, r.width, r.height, 8);
      state.ui.x = Math.round(safe.x);
      state.ui.y = Math.round(safe.y);
      panel.style.left = state.ui.x + "px";
      panel.style.top  = state.ui.y + "px";
      state.ui.panelL = state.ui.x;
      state.ui.panelB = Math.round(window.innerHeight - (state.ui.y + r.height));
    }, { passive: true });

    window.addEventListener("pointerup", () => {
      if (!drag) return;
      drag = null;
      saveStateDebounced();
      showToast(T().toasts.posSaved);
    });

    window.addEventListener("resize", () => {
      if (panel && panel.style.display !== "none") ensurePanelPosition();
      ensureMainButtonPosition();
      if (clockEl) applyClockPosition();
      dirtySkin();
      scheduleUpdate();
    }, { passive: true });

    window.addEventListener("fullscreenchange", () => {
      if (panel && panel.style.display !== "none") ensurePanelPosition();
      ensureMainButtonPosition();
      if (clockEl) applyClockPosition();
    }, { passive: true });

    renderPanel();
    requestAnimationFrame(ensurePanelPosition);
  }

  function renderPanel() {
    if (!panel) return;
    const c = cfg();
    const L = T();
    const compact = !!state.ui.compact;

    panel.innerHTML = "";

    // HEADER
    const header = document.createElement("div");
    header.className = "ad-core-header";
    Object.assign(header.style, {
      padding: compact ? "10px 10px 8px" : "12px 12px 10px",
      borderBottom: "1px solid rgba(255,255,255,0.10)",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "10px",
      cursor: "move",
      userSelect: "none",
      flex: "0 0 auto",
    });

    const leftHead = document.createElement("div");
    leftHead.style.display = "flex";
    leftHead.style.alignItems = "center";
    leftHead.style.gap = "10px";

    const title = document.createElement("div");
    title.textContent = L.appTitle;
    title.style.fontWeight = "900";
    title.style.fontSize = compact ? "13px" : "14px";
    leftHead.appendChild(title);

    const presetWrap = document.createElement("div");
    presetWrap.style.display = "flex";
    presetWrap.style.gap = "6px";
    presetWrap.style.flexWrap = "wrap";
    for (let i=0;i<PRESET_COUNT;i++){
      const b = mkButton(`${L.preset} ${presetLabel(i)}`, () => setActivePreset(i), i === state.activePreset ? "primary" : "ghost", compact);
      b.style.padding = compact ? "7px 9px" : "8px 10px";
      b.style.borderRadius = "999px";
      presetWrap.appendChild(b);
    }
    leftHead.appendChild(presetWrap);

    header.appendChild(leftHead);

    const rightHead = document.createElement("div");
    rightHead.style.display = "flex";
    rightHead.style.alignItems = "center";
    rightHead.style.gap = "8px";

    // Language buttons next to help
    const langWrap = document.createElement("div");
    langWrap.style.display = "flex";
    langWrap.style.gap = "6px";

    const btnHU = mkButton("HU", () => setLang("hu"), state.ui.lang === "hu" ? "primary" : "ghost", compact);
    const btnEN = mkButton("EN", () => setLang("en"), state.ui.lang === "en" ? "primary" : "ghost", compact);
    const btnDE = mkButton("DE", () => setLang("de"), state.ui.lang === "de" ? "primary" : "ghost", compact);

    [btnHU, btnEN, btnDE].forEach(b => {
      b.style.padding = compact ? "7px 9px" : "8px 10px";
      b.style.borderRadius = "999px";
    });

    langWrap.appendChild(btnHU);
    langWrap.appendChild(btnEN);
    langWrap.appendChild(btnDE);

    const helpBtn = mkButton(state.ui.helpOpen ? "✕" : "❓", () => {
      state.ui.helpOpen = !state.ui.helpOpen;
      saveStateDebounced();
      renderPanel();
    }, "ghost", compact);
    helpBtn.title = L.help;
    helpBtn.style.width = compact ? "34px" : "38px";
    helpBtn.style.height = compact ? "34px" : "38px";
    helpBtn.style.padding = "0";
    helpBtn.style.display = "grid";
    helpBtn.style.placeItems = "center";

    const closeBtn = mkButton("✕", () => setUIOpen(false), "ghost", compact);
    closeBtn.title = L.close;
    closeBtn.style.width = compact ? "34px" : "38px";
    closeBtn.style.height = compact ? "34px" : "38px";
    closeBtn.style.padding = "0";
    closeBtn.style.display = "grid";
    closeBtn.style.placeItems = "center";

    rightHead.appendChild(langWrap);
    rightHead.appendChild(helpBtn);
    rightHead.appendChild(closeBtn);

    header.appendChild(rightHead);
    panel.appendChild(header);

    // CONTENT
    const content = document.createElement("div");
    Object.assign(content.style, { flex: "1 1 auto", overflow: "auto" });
    panel.appendChild(content);

    const narrow = window.innerWidth < 920;
    const body = document.createElement("div");
    Object.assign(body.style, {
      display: "grid",
      gridTemplateColumns: narrow ? "1fr" : (compact ? "320px 1fr" : "350px 1fr"),
      gap: "0",
    });
    content.appendChild(body);

    // LEFT COL
    const leftCol = document.createElement("div");
    Object.assign(leftCol.style, {
      padding: compact ? "10px" : "12px",
      borderRight: narrow ? "none" : "1px solid rgba(255,255,255,0.10)",
      borderBottom: narrow ? "1px solid rgba(255,255,255,0.10)" : "none",
    });

    const listTitle = document.createElement("div");
    listTitle.textContent = L.modulesTitle;
    listTitle.style.fontWeight = "900";
    listTitle.style.fontSize = compact ? "12px" : "13px";
    listTitle.style.opacity = "0.95";
    listTitle.style.marginBottom = "10px";
    leftCol.appendChild(listTitle);

    function addModuleRow(tabKey, getter, setter, toggleDisabled=false, configurable=false, dim=false) {
      const row = document.createElement("div");
      row.className = `ad-mod-row ${configurable ? "is-config" : ""}`;
      Object.assign(row.style, {
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: "10px",
        alignItems: "center",
        padding: compact ? "9px 9px" : "10px 10px",
        borderRadius: "14px",
        border: "1px solid rgba(255,255,255,0.10)",
        background: state.ui.selectedTab === tabKey ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.06)",
        marginBottom: "8px",
        cursor: "pointer",
        opacity: dim ? "0.55" : "1",
      });

      const labelWrap = document.createElement("div");
      labelWrap.style.display = "flex";
      labelWrap.style.alignItems = "center";
      labelWrap.style.gap = "8px";

      const label = document.createElement("div");
      label.style.fontSize = compact ? "12px" : "13px";
      label.style.fontWeight = "800";
      label.style.display = "flex";
      label.style.alignItems = "center";
      label.style.gap = "8px";

      const nameSpan = document.createElement("span");
      nameSpan.textContent = tabTitle(tabKey);

      label.appendChild(nameSpan);

      // ✅ jelölés a név mellett, ha állítható
      if (configurable) {
        const ic = document.createElement("span");
        ic.className = "ad-mod-icon";
        ic.innerHTML = slidersTinySvg(14);
        ic.title = L.iconConfigTitle;
        label.appendChild(ic);

        const hint = document.createElement("span");
        hint.className = "ad-mod-hint";
        hint.textContent = L.hintConfig;
        labelWrap.appendChild(label);
        labelWrap.appendChild(hint);
      } else {
        labelWrap.appendChild(label);
      }

      const sw = document.createElement("input");
      sw.type = "checkbox";
      sw.checked = !!getter();
      sw.disabled = !!toggleDisabled;
      sw.style.transform = "scale(1.15)";

      row.addEventListener("click", () => {
        state.ui.selectedTab = tabKey;
        saveStateDebounced();
        renderPanel();
      });

      sw.addEventListener("click", (e) => e.stopPropagation());
      sw.addEventListener("change", () => {
        if (toggleDisabled) return;
        setter(!!sw.checked);
        saveStateDebounced();
        renderCss();
        applyToggleSideEffects();
        renderPanel();
        showToast(L.saved);
      });

      row.appendChild(labelWrap);
      row.appendChild(sw);
      leftCol.appendChild(row);
    }

    // Modules
    addModuleRow("general",  () => true, () => {}, true,  false, false);
    addModuleRow("diag",     () => true, () => {}, true,  false, false);

    // NEW: Skin toggle
    addModuleRow("skin",     () => c.SKIN_CSS, v => {
      c.SKIN_CSS = v;
      dirtySkin();
      scheduleUpdate();
      showToast(v ? L.toasts.skinOn : L.toasts.skinOff);
    }, false, true, false);

    addModuleRow("board",    () => c.BOARD_MARKER, v => { c.BOARD_MARKER = v; dirtyBoard(); scheduleUpdate(); }, false, false, false);
    addModuleRow("bmback",   () => c.BM_BACK_BUTTON, v => { c.BM_BACK_BUTTON = v; dirtyBm(); scheduleUpdate(); }, false, false, false);

    addModuleRow("throws",   () => c.THROWS_TO_POINTS, v => { c.THROWS_TO_POINTS = v; dirtyTurn(); scheduleUpdate(); }, false, true, false);
    addModuleRow("orig",     () => c.SHOW_ORIG_IN_CORNER, v => { c.SHOW_ORIG_IN_CORNER = v; dirtyTurn(); scheduleUpdate(); }, !c.THROWS_TO_POINTS, true, !c.THROWS_TO_POINTS);

    addModuleRow("total",    () => c.TOTAL_VIEW, v => { c.TOTAL_VIEW = v; dirtyTurn(); scheduleUpdate(); }, false, true, false);
    addModuleRow("checkout", () => c.CHECKOUT_VIEW, v => { c.CHECKOUT_VIEW = v; dirtyTurn(); scheduleUpdate(); }, false, true, false);
    addModuleRow("playerinfo", () => c.PLAYER_INFO, v => { c.PLAYER_INFO = v; renderCss(); dirtyPlayers(); dirtyTurn(); scheduleUpdate(); }, false, true, false);
    addModuleRow("active",   () => c.ACTIVE_PLAYER_HIGHLIGHT, v => { c.ACTIVE_PLAYER_HIGHLIGHT = v; dirtyPlayers(); scheduleUpdate(); }, false, true, false);
    addModuleRow("triple",   () => c.TRIPLE_ANIM, v => { c.TRIPLE_ANIM = v; dirtyTurn(); scheduleUpdate(); }, false, true, false);
    addModuleRow("double",   () => c.DOUBLE_ANIM, v => { c.DOUBLE_ANIM = v; dirtyTurn(); scheduleUpdate(); }, false, true, false);
    addModuleRow("highscore",() => c.HIGHSCORE_ANIM, v => { c.HIGHSCORE_ANIM = v; dirtyTurn(); scheduleUpdate(); }, false, true, false);
    addModuleRow("fx",       () => c.FX_MATRIX_ENABLED, v => { c.FX_MATRIX_ENABLED = v; renderPanelIfOpen(); }, false, true, false);
    addModuleRow("win",      () => c.WIN_MUSIC, v => { c.WIN_MUSIC = v; dirtyTurn(); scheduleUpdate(); }, false, true, false);

    addModuleRow("clock",    () => state.ui.clock.enabled, (v) => {
      state.ui.clock.enabled = v;
      buildClockIfNeeded();
      applyClockEnabled();
      if (v) { applyClockStyle(); applyClockScale(); applyClockPosition(); renderClockTime(); }
      showToast(v ? L.toasts.clockOn : L.toasts.clockOff);
    }, false, true, false);

    // Quick section
    const quick = document.createElement("div");
    quick.style.marginTop = "10px";
    quick.style.display = "grid";
    quick.style.gap = "8px";

    function quickToggle(labelTxt, value, onChange) {
      const wrap = document.createElement("div");
      Object.assign(wrap.style, {
        padding: compact ? "9px 9px" : "10px 10px",
        border: "1px solid rgba(255,255,255,0.10)",
        borderRadius: "14px",
        background: "rgba(255,255,255,0.06)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "10px",
      });
      const lab = document.createElement("div");
      lab.textContent = labelTxt;
      lab.style.fontWeight = "900";
      lab.style.fontSize = compact ? "12px" : "13px";
      lab.style.opacity = "0.92";
      const sw = document.createElement("input");
      sw.type = "checkbox";
      sw.checked = !!value;
      sw.style.transform = "scale(1.15)";
      sw.addEventListener("change", () => onChange(!!sw.checked));
      wrap.appendChild(lab);
      wrap.appendChild(sw);
      return wrap;
    }

    quick.appendChild(quickToggle(L.safeMode, state.ui.safeMode, (v) => {
      state.ui.safeMode = v;
      applySafeClampsToCfg();
      saveStateDebounced();
      renderCss();
      dirtyTurn(); dirtyPlayers(); dirtyBoard(); dirtyBm(); dirtySkin();
      scheduleUpdate();
      renderPanel();
      showToast(v ? L.toasts.safeOn : L.toasts.safeOff);
    }));

    quick.appendChild(quickToggle(L.compact, state.ui.compact, (v) => {
      state.ui.compact = v;
      saveStateDebounced();
      renderPanel();
      ensurePanelPosition();
      showToast(v ? L.toasts.compactOn : L.toasts.compactOff);
    }));

    const rowBtns = document.createElement("div");
    rowBtns.style.display = "flex";
    rowBtns.style.gap = "8px";

    const btnResetPos = mkButton(L.posReset, () => {
      state.ui.x = null; state.ui.y = null; state.ui.panelL = null; state.ui.panelB = null;
      saveStateDebounced();
      requestAnimationFrame(ensurePanelPosition);
      showToast(L.toasts.posReset);
    }, "ghost", compact);
    btnResetPos.style.flex = "1";

    const btnResetGearPos = mkButton(L.btnPosReset, () => {
      state.ui.btnX = null; state.ui.btnY = null; state.ui.btnL = null; state.ui.btnB = null;
      saveStateDebounced();
      ensureMainButtonPosition();
      showToast(L.toasts.btnPosReset);
    }, "ghost", compact);
    btnResetGearPos.style.flex = "1";

    rowBtns.appendChild(btnResetPos);
    rowBtns.appendChild(btnResetGearPos);
    quick.appendChild(rowBtns);

    const hotLine = document.createElement("div");
    hotLine.style.opacity = "0.65";
    hotLine.style.fontSize = "11px";
    hotLine.style.lineHeight = "1.35";
    hotLine.textContent = L.hotkeysLine;
    quick.appendChild(hotLine);

    leftCol.appendChild(quick);

    // RIGHT COL
    const rightCol = document.createElement("div");
    Object.assign(rightCol.style, { padding: compact ? "10px" : "12px" });

    const head2 = document.createElement("div");
    Object.assign(head2.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "10px",
      marginBottom: "10px",
    });

    const hTitle = document.createElement("div");
    hTitle.textContent = tabTitle(state.ui.selectedTab);
    hTitle.style.fontWeight = "900";
    hTitle.style.fontSize = compact ? "12px" : "13px";

    const canResetTab = ["skin","throws","orig","total","checkout","playerinfo","active","triple","win","clock"].includes(state.ui.selectedTab);
    const resetBtn = mkButton(L.reset, () => resetTab(state.ui.selectedTab), "ghost", compact);
    resetBtn.style.opacity = canResetTab ? "1" : "0.45";
    resetBtn.style.pointerEvents = canResetTab ? "auto" : "none";

    head2.appendChild(hTitle);
    head2.appendChild(resetBtn);
    rightCol.appendChild(head2);

    const box = document.createElement("div");
    Object.assign(box.style, {
      border: "1px solid rgba(255,255,255,0.10)",
      borderRadius: "16px",
      background: "rgba(255,255,255,0.06)",
      padding: compact ? "10px" : "12px",
      display: "grid",
      gap: compact ? "10px" : "12px",
    });
    rightCol.appendChild(box);

    function addColor(getter, setter, label) {
      const inp = document.createElement("input");
      inp.type = "color";
      inp.value = sanitizeHex(getter(), "#ffffff");
      inp.addEventListener("input", () => {
        setter(sanitizeHex(inp.value, getter()));
        saveStateDebounced();
        renderCss();
        dirtyTurn(); dirtyPlayers(); dirtyBoard(); dirtyBm(); dirtySkin();
        scheduleUpdate();
        showToast(L.saved);
      });
      box.appendChild(mkRow(label, inp, compact));
    }

    function addSliderPx(key, label, min, maxExt, step) {
      const max = state.ui.safeMode ? getMaxFor(key) : maxExt;
      let val = clamp(Number(c[key] ?? min), min, maxExt);
      if (state.ui.safeMode) val = clampIfSafe(key, val);

      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = String(min);
      slider.max = String(max ?? maxExt);
      slider.step = String(step);
      slider.value = String(val);

      const row = mkSliderRow(label, slider, `${val}px`, pillLevel(key, val), compact);
      box.appendChild(row.row);

      slider.addEventListener("input", () => {
        let v = clamp(Number.isFinite(+slider.value) ? +slider.value : min, min, maxExt);
        if (state.ui.safeMode) v = clampIfSafe(key, v);
        c[key] = v;
        row.setPill(`${v}px`, pillLevel(key, v));
        saveStateDebounced();
        renderCss();
        dirtyTurn();
        scheduleUpdate();
      });
      slider.addEventListener("change", () => showToast(L.saved));
    }

    function addSlider01(getter, setter, label, step=0.05) {
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "0"; slider.max = "1"; slider.step = String(step);
      slider.value = String(clamp(Number(getter() ?? 0), 0, 1));

      const v0 = clamp(Number(slider.value), 0, 1);
      const row = mkSliderRow(label, slider, `${Math.round(v0*100)}%`, "ok", compact);
      box.appendChild(row.row);

      slider.addEventListener("input", () => {
        const v = clamp(Number(slider.value) || 0, 0, 1);
        setter(v);
        row.setPill(`${Math.round(v*100)}%`, "ok");
        saveStateDebounced();
        renderCss();
        dirtyTurn();
        scheduleUpdate();
      });
      slider.addEventListener("change", () => showToast(L.saved));
    }

    function addSliderMs(key, label, min, max, step) {
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = String(min); slider.max = String(max); slider.step = String(step);
      slider.value = String(clamp(Number(c[key] ?? min), min, max));

      const v0 = Number(slider.value) || min;
      const row = mkSliderRow(label, slider, `${v0}ms`, "ok", compact);
      box.appendChild(row.row);

      slider.addEventListener("input", () => {
        const v = clamp(Number(slider.value) || min, min, max);
        c[key] = v;
        row.setPill(`${v}ms`, "ok");
        saveStateDebounced();
        renderCss();
        dirtyTurn();
        scheduleUpdate();
      });
      slider.addEventListener("change", () => showToast(L.saved));
    }

    // integer slider with a custom pill prefix (e.g. "T≥15")
    function addSliderInt(key, label, min, max, prefix="") {
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = String(min); slider.max = String(max); slider.step = "1";
      slider.value = String(clamp(Math.round(Number(c[key] ?? min)), min, max));
      const v0 = clamp(Math.round(Number(slider.value) || min), min, max);
      const row = mkSliderRow(label, slider, `${prefix}${v0}`, "ok", compact);
      box.appendChild(row.row);
      slider.addEventListener("input", () => {
        const v = clamp(Math.round(Number(slider.value) || min), min, max);
        c[key] = v;
        row.setPill(`${prefix}${v}`, "ok");
        saveStateDebounced();
        dirtyTurn();
        scheduleUpdate();
      });
      slider.addEventListener("change", () => showToast(L.saved));
    }

    // dropdown select; options = [[value,label],...]
    function addSelect(key, label, options, onChange){
      const sel = document.createElement("select");
      Object.assign(sel.style, { background:"rgba(255,255,255,.1)", border:"1px solid rgba(255,255,255,.25)", borderRadius:"6px", color:"#fff", padding:"3px 6px", fontSize:"13px" });
      for (const [val, txt] of options) {
        const o = document.createElement("option");
        o.value = val; o.textContent = txt;
        o.style.color = "#000";
        if (String(c[key]) === String(val)) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener("change", () => {
        c[key] = sel.value;
        saveStateDebounced();
        renderCss();
        dirtyTurn(); dirtyPlayers();
        scheduleUpdate();
        if (onChange) onChange();
        showToast(L.saved);
      });
      box.appendChild(mkRow(label, sel, compact));
    }

    function addCheckbox(label, getter, setter){
      const wrap = document.createElement("div");
      wrap.style.display = "flex";
      wrap.style.alignItems = "center";
      wrap.style.justifyContent = "space-between";
      wrap.style.gap = "10px";

      const lab = document.createElement("div");
      lab.textContent = label;
      lab.style.opacity = "0.9";
      lab.style.fontSize = compact ? "12px" : "13px";
      lab.style.fontWeight = "800";

      const sw = document.createElement("input");
      sw.type = "checkbox";
      sw.checked = !!getter();
      sw.style.transform = "scale(1.15)";
      sw.addEventListener("change", ()=>{
        setter(!!sw.checked);
        saveStateDebounced();
        dirtyTurn(); dirtyPlayers(); dirtyBoard(); dirtyBm(); dirtySkin();
        scheduleUpdate();
        renderPanelIfOpen();
        showToast(L.saved);
      });

      wrap.appendChild(lab);
      wrap.appendChild(sw);
      box.appendChild(wrap);
    }

    switch (state.ui.selectedTab) {
      case "general": {
        const row1 = document.createElement("div");
        row1.style.display = "flex";
        row1.style.gap = "8px";

        const btnExport = mkButton(L.export, () => {
          const payload = { version: SCRIPT_VERSION, state };
          const json = JSON.stringify(payload, null, 2);
          const blob = new Blob([json], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "autodarts_core_presets.json";
          a.click();
          URL.revokeObjectURL(url);
          showToast(L.toasts.export);
        }, "primary", compact);

        const btnImport = mkButton(L.import, () => { fileInput.value = ""; fileInput.click(); }, "ghost", compact);

        btnExport.style.flex = "1";
        btnImport.style.flex = "1";
        row1.appendChild(btnExport);
        row1.appendChild(btnImport);
        box.appendChild(row1);

        const pollWrap = document.createElement("div");
        pollWrap.style.display = "flex";
        pollWrap.style.alignItems = "center";
        pollWrap.style.justifyContent = "space-between";
        pollWrap.style.gap = "12px";

        const pollLabel = document.createElement("div");
        pollLabel.textContent = L.activeRefresh;
        pollLabel.style.opacity = "0.9";
        pollLabel.style.fontSize = compact ? "12px" : "13px";
        pollLabel.title = L.activeRefreshHint;

        const pollInput = document.createElement("input");
        pollInput.type = "number";
        pollInput.min = "0"; pollInput.max = "1000"; pollInput.step = "50";
        pollInput.value = String(Number(c.ACTIVE_POLL_MS || 0));
        Object.assign(pollInput.style, {
          width: "120px",
          borderRadius: "12px",
          border: "1px solid rgba(255,255,255,.18)",
          background: "rgba(255,255,255,.08)",
          color: "#fff",
          padding: "8px 10px",
          fontWeight: "900",
        });
        pollInput.addEventListener("change", () => {
          c.ACTIVE_POLL_MS = clamp(Number(pollInput.value) || 0, 0, 1000);
          saveStateDebounced();
          configureActivePolling();
          showToast(L.saved);
        });

        pollWrap.appendChild(pollLabel);
        pollWrap.appendChild(pollInput);
        box.appendChild(pollWrap);

        const row2 = document.createElement("div");
        row2.style.display = "flex";
        row2.style.gap = "8px";

        const btnResetPreset = mkButton(`${L.resetPreset} ${presetLabel(state.activePreset)}`, () => resetPreset(state.activePreset), "ghost", compact);
        const btnResetAll = mkButton(L.resetAll, () => resetAll(), "ghost", compact);

        btnResetPreset.style.flex = "1";
        btnResetAll.style.flex = "1";
        row2.appendChild(btnResetPreset);
        row2.appendChild(btnResetAll);
        box.appendChild(row2);

        // ---- Themes: load a shareable config-diff into a chosen preset slot ----
        const sepThemes = document.createElement("div");
        sepThemes.style.height = "1px";
        sepThemes.style.background = "rgba(255,255,255,0.10)";
        sepThemes.style.margin = "12px 0 10px";
        box.appendChild(sepThemes);

        const themesTitle = document.createElement("div");
        themesTitle.textContent = L.themesTitle;
        themesTitle.style.fontWeight = "900";
        themesTitle.style.opacity = "0.92";
        themesTitle.style.marginBottom = "8px";
        box.appendChild(themesTitle);

        if (themeTargetPreset == null) themeTargetPreset = state.activePreset;

        const targetRow = document.createElement("div");
        targetRow.style.display = "flex";
        targetRow.style.alignItems = "center";
        targetRow.style.flexWrap = "wrap";
        targetRow.style.gap = "8px";
        targetRow.style.marginBottom = "8px";

        const targetLabel = document.createElement("div");
        targetLabel.textContent = L.themeTarget;
        targetLabel.style.opacity = "0.85";
        targetLabel.style.fontSize = compact ? "12px" : "13px";
        targetRow.appendChild(targetLabel);

        const targetBtns = Array.from({ length: PRESET_COUNT }, (_, i) => i).map((i) => {
          const b = mkButton(presetLabel(i), () => {
            themeTargetPreset = i;
            refreshTargetSel();
          }, "ghost", true);
          targetRow.appendChild(b);
          return b;
        });
        const refreshTargetSel = () => {
          targetBtns.forEach((b, i) => {
            const on = i === themeTargetPreset;
            b.style.background = on ? "rgba(120,200,255,.30)" : "rgba(255,255,255,.08)";
            b.style.borderColor = on ? "rgba(120,200,255,.65)" : "rgba(255,255,255,.18)";
          });
        };
        refreshTargetSel();
        box.appendChild(targetRow);

        const themeBtnRow = document.createElement("div");
        themeBtnRow.style.display = "flex";
        themeBtnRow.style.gap = "8px";
        themeBtnRow.style.marginBottom = "8px";

        const btnThemeFile = mkButton(L.themeFromFile, () => { themeFileInput.value = ""; themeFileInput.click(); }, "ghost", compact);
        const btnThemeExport = mkButton(L.themeExportPreset, () => {
          const diff = diffPresetVsDefault(state.activePreset);
          const json = JSON.stringify(diff, null, 2);
          const blob = new Blob([json], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `autodarts_theme_${presetLabel(state.activePreset).toLowerCase()}.json`;
          a.click();
          URL.revokeObjectURL(url);
          showToast(L.toasts.export);
        }, "ghost", compact);
        const btnThemeBrowse = mkButton(L.themeBrowse, () => loadThemeGallery(), "primary", compact);

        btnThemeFile.style.flex = "1";
        btnThemeExport.style.flex = "1";
        btnThemeBrowse.style.flex = "1";
        themeBtnRow.appendChild(btnThemeFile);
        themeBtnRow.appendChild(btnThemeExport);
        themeBtnRow.appendChild(btnThemeBrowse);
        box.appendChild(themeBtnRow);

        const themeListEl = document.createElement("div");
        themeListEl.style.display = "flex";
        themeListEl.style.flexWrap = "wrap";
        themeListEl.style.gap = "6px";
        themeListEl.style.opacity = "0.9";
        themeListEl.style.fontSize = compact ? "12px" : "13px";
        box.appendChild(themeListEl);

        // Synthetic color swatch for a gallery item - no real screenshots exist, so this
        // approximates the theme's look from the colors already present in its diff JSON
        // (falling back to DEFAULT_CFG for anything the diff doesn't override).
        function buildThemeSwatchSvg(diff) {
          const g = (key, fallback) => sanitizeHex((diff && diff[key]) ?? DEFAULT_CFG[key], fallback);
          const cardBg = g("SKIN_PLAYER_BG_HEX", "#c0c0c0");
          const accent = g("ACTIVE_COLOR_HEX", "#ff0000");
          const chips = [
            g("PI_NAME_COLOR_HEX", "#ffffff"),
            g("PI_P2_NAME_COLOR_HEX", "#ffffff"),
            g("PI_P3_NAME_COLOR_HEX", "#ffffff"),
            g("PI_P4_NAME_COLOR_HEX", "#ffffff"),
          ];
          const svgNS = "http://www.w3.org/2000/svg";
          const mk = (tag, attrs) => {
            const el = document.createElementNS(svgNS, tag);
            for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
            return el;
          };
          const svg = mk("svg", { viewBox: "0 0 56 34", width: "56", height: "34" });
          svg.style.flex = "0 0 auto";
          svg.style.borderRadius = "6px";
          svg.appendChild(mk("rect", { x: 0, y: 0, width: 56, height: 34, rx: 6, fill: "#0a0a0e" }));
          svg.appendChild(mk("rect", { x: 2, y: 2, width: 52, height: 30, rx: 4, fill: cardBg, "fill-opacity": 0.35 }));
          svg.appendChild(mk("rect", { x: 2, y: 2, width: 52, height: 30, rx: 4, fill: "none", stroke: accent, "stroke-width": 1.5, "stroke-opacity": 0.85 }));
          chips.forEach((color, i) => {
            svg.appendChild(mk("circle", { cx: 10 + i * 12, cy: 25, r: 4, fill: color, stroke: "#000", "stroke-width": 0.5 }));
          });
          return svg;
        }

        const renderThemeList = (list) => {
          themeListEl.textContent = "";
          if (!list.length) { themeListEl.textContent = L.themeEmpty; return; }
          list.forEach((item) => {
            if (!item || !item.file) return;

            const row = document.createElement("div");
            row.style.display = "flex";
            row.style.alignItems = "center";
            row.style.gap = "6px";

            const applyDiff = (diff) => {
              const idx = themeTargetPreset ?? state.activePreset;
              applyThemeDiffToPreset(diff, idx);
              showToast(`${L.toasts.themeApplied} ${presetLabel(idx)}`);
            };
            const fetchDiff = async () => {
              if (item._diff) return item._diff;
              const r2 = await fetch(THEME_FILE_URL(item.file), { cache: "no-store" });
              if (!r2.ok) throw new Error("HTTP " + r2.status);
              const diff = await r2.json();
              if (!diff || typeof diff !== "object" || Array.isArray(diff)) throw new Error("bad theme file");
              item._diff = diff;
              return diff;
            };

            const b = mkButton(item.name || item.id || item.file, async () => {
              try { applyDiff(await fetchDiff()); }
              catch (err) { alert(`${L.themeLoadError}: ${err?.message || err}`); }
            }, "ghost", true);
            if (item.desc) b.title = item.desc;

            row.appendChild(b);
            themeListEl.appendChild(row);

            // Fetch the diff eagerly (small JSON files, same repo already being hit) so a
            // swatch can render next to the button before it's clicked.
            fetchDiff().then((diff) => row.insertBefore(buildThemeSwatchSvg(diff), b)).catch(() => {});
          });
        };

        async function loadThemeGallery() {
          themeListEl.textContent = L.themeLoading;
          try {
            const res = await fetch(THEMES_MANIFEST_URL, { cache: "no-store" });
            if (!res.ok) throw new Error("HTTP " + res.status);
            const list = await res.json();
            if (!Array.isArray(list)) throw new Error("bad manifest");
            themeGalleryCache = list;
            renderThemeList(list);
          } catch (err) {
            themeListEl.textContent = "";
            alert(`${L.themeLoadError}: ${err?.message || err}`);
          }
        }

        if (themeGalleryCache) renderThemeList(themeGalleryCache);

        break;
      }

    case "diag": {
      const title = document.createElement("div");
      title.textContent = tabTitle("diag");
      title.style.fontWeight = "900";
      title.style.opacity = "0.95";
      title.style.marginBottom = "6px";
      box.appendChild(title);

      const info = {
      schemaVersion: state.schemaVersion ?? null,  
      scriptVersion: SCRIPT_VERSION,
      storeKey: STORE_KEY_STATE,
      preset: presetLabel(state.activePreset),
      selectedTab: state.ui.selectedTab,
      path: location.pathname,
      safeMode: !!state.ui.safeMode,
      compact: !!state.ui.compact,
        modules: {
        SKIN_CSS: !!c.SKIN_CSS,
        BOARD_MARKER: !!c.BOARD_MARKER,
        BM_BACK_BUTTON: !!c.BM_BACK_BUTTON,
        THROWS_TO_POINTS: !!c.THROWS_TO_POINTS,
        TOTAL_VIEW: !!c.TOTAL_VIEW,
        CHECKOUT_VIEW: !!c.CHECKOUT_VIEW,
        ACTIVE_PLAYER_HIGHLIGHT: !!c.ACTIVE_PLAYER_HIGHLIGHT,
        TRIPLE_ANIM: !!c.TRIPLE_ANIM,
        WIN_MUSIC: !!c.WIN_MUSIC,
        CLOCK_ENABLED: !!state.ui.clock.enabled,
        },
     activePollMs: Number(c.ACTIVE_POLL_MS || 0),
     ua: navigator.userAgent,
     ts: new Date().toISOString(),
     };

      // Key-Value blokk
      const kvWrap = document.createElement("div");
      kvWrap.style.display = "grid";
      kvWrap.style.gap = "8px";

    function kv(label, value, level="ok") {
      const pill = makePill(String(value), level);
      kvWrap.appendChild(mkRow(label, pill, compact));
      }

      kv("Version", info.scriptVersion);
      kv("Store key", info.storeKey);
      kv("Schema", info.schemaVersion ?? "-", "ok");
      kv("Preset", info.preset);
      kv("Path", info.path);
      kv("SafeMode", info.safeMode ? "ON" : "OFF", info.safeMode ? "ok" : "warn");
      kv("Compact", info.compact ? "ON" : "OFF", info.compact ? "ok" : "warn");
      kv("Aktív poll", `${info.activePollMs} ms`, info.activePollMs ? "ok" : "warn");
      box.appendChild(kvWrap);

      // Copy debug
      const btnRow = document.createElement("div");
      btnRow.style.display = "flex";
      btnRow.style.gap = "8px";
      btnRow.style.marginTop = "10px";

      const btnCopy = mkButton(L.diagCopy, async () => {
      const txt = JSON.stringify(info, null, 2);
      try {
        await navigator.clipboard.writeText(txt);
        showToast(L.saved);
      } catch {
      // fallback
      prompt("Másold ki:", txt);
        }
      }, "primary", compact);

      const btnGenOverrides = mkButton(L.diagGenOverrides, async () => {
      const txt = formatPresetAOverridesSource();
      try {
        await navigator.clipboard.writeText(txt);
        showToast(L.saved);
      } catch {
      // fallback
      prompt("Másold ki:", txt);
        }
      }, "ghost", compact);

      btnCopy.style.flex = "1";
      btnGenOverrides.style.flex = "1";
      btnRow.appendChild(btnCopy);
      btnRow.appendChild(btnGenOverrides);
      box.appendChild(btnRow);

      // Selector check
      const sep = document.createElement("div");
      sep.style.height = "1px";
      sep.style.background = "rgba(255,255,255,0.10)";
      sep.style.margin = "12px 0 10px";
      box.appendChild(sep);

      const st = document.createElement("div");
      st.textContent = L.diagSelectors;
      st.style.fontWeight = "900";
      st.style.opacity = "0.92";
      st.style.marginBottom = "8px";
      box.appendChild(st);

      const checks = [
      ["#ad-ext-player-display", "Player display (#ad-ext-player-display)", true],
      ["#ad-ext-turn",          "Turn cards (#ad-ext-turn)",               true],

      // Chakra generált class: nem stabil, nem mindig jelenik meg → opcionális
      [".css-rc3vw3",           "Chakra (often used) .css-rc3vw3",          false],

      // ez sem “garantált”, de a Skin CSS-nél sokat segít, hagyjuk required helyett inkább optionalnak
      [".css-1cdcn26",          "Chakra (skin root) .css-1cdcn26",          false],

      // Marker ON esetén hasznos – de OFF-nál hiányozhat → optional
      ["div.ad-board-host, svg.ad-board-svg, img.ad-board-img", "Board marker (host/svg/img)", false],
      ];

    for (const [sel, label, required] of checks) {
      const ok = !!document.querySelector(sel);

      let text, level;
      if (ok) {
        text = L.diagOk; level = "ok";
      } else if (required) {
        text = L.diagMissing; level = "danger";
        } else {
          text = L.diagOptional; level = "warn";
          }

      box.appendChild(mkRow(label, makePill(text, level), compact));
    }

      break;
    }

      case "skin": {
        const info = document.createElement("div");
        info.style.opacity = "0.85";
        info.style.fontSize = "12px";
        info.style.lineHeight = "1.4";
        info.textContent = L.skinInfo;
        box.appendChild(info);

        addCheckbox(
          L.skinText.autoDisable,
          () => !!c.SKIN_AUTO_DISABLE_ON_MISMATCH,
          (v) => { c.SKIN_AUTO_DISABLE_ON_MISMATCH = v; }
        );

        // UI scale
        const scale = document.createElement("input");
        scale.type = "range";
        scale.min = "0.85";
        scale.max = "1.15";
        scale.step = "0.01";
        scale.value = String(clamp(Number(c.SKIN_UI_SCALE ?? 1), 0.85, 1.15));
        const s0 = Number(scale.value);
        const sRow = mkSliderRow(L.skinText.uiScale, scale, `${Math.round(s0*100)}%`, "ok", compact);
        box.appendChild(sRow.row);
        scale.addEventListener("input", () => {
          c.SKIN_UI_SCALE = clamp(Number(scale.value) || 1, 0.85, 1.15);
          sRow.setPill(`${Math.round(c.SKIN_UI_SCALE*100)}%`, "ok");
          saveStateDebounced();
          dirtySkin(); scheduleUpdate();
        });
        scale.addEventListener("change", () => showToast(L.saved));

        // spacing
        const sp = document.createElement("input");
        sp.type = "range";
        sp.min = "0";
        sp.max = "80";
        sp.step = "1";
        sp.value = String(clamp(Number(c.SKIN_SPACING_PLAYER ?? 20), 0, 80));
        const sp0 = Number(sp.value);
        const spRow = mkSliderRow(L.skinText.spacing, sp, `${sp0}px`, "ok", compact);
        box.appendChild(spRow.row);
        sp.addEventListener("input", () => {
          c.SKIN_SPACING_PLAYER = clamp(Number(sp.value) || 0, 0, 80);
          spRow.setPill(`${c.SKIN_SPACING_PLAYER}px`, "ok");
          saveStateDebounced();
          dirtySkin(); scheduleUpdate();
        });
        sp.addEventListener("change", () => showToast(L.saved));

        // overlay alpha
        const ov = document.createElement("input");
        ov.type = "range";
        ov.min = "0";
        ov.max = "1";
        ov.step = "0.05";
        ov.value = String(clamp(Number(c.SKIN_BG_OVERLAY_ALPHA ?? 0.55), 0, 1));
        const ov0 = Number(ov.value);
        const ovRow = mkSliderRow(L.skinText.overlay, ov, `${Math.round(ov0*100)}%`, "ok", compact);
        box.appendChild(ovRow.row);
        ov.addEventListener("input", () => {
          c.SKIN_BG_OVERLAY_ALPHA = clamp(Number(ov.value) || 0, 0, 1);
          ovRow.setPill(`${Math.round(c.SKIN_BG_OVERLAY_ALPHA*100)}%`, "ok");
          saveStateDebounced();
          dirtySkin(); scheduleUpdate();
        });
        ov.addEventListener("change", () => showToast(L.saved));

        // player bg color
        const pbg = document.createElement("input");
        pbg.type = "color";
        pbg.value = sanitizeHex(c.SKIN_PLAYER_BG_HEX, DEFAULT_CFG.SKIN_PLAYER_BG_HEX);
        pbg.addEventListener("input", () => {
          c.SKIN_PLAYER_BG_HEX = sanitizeHex(pbg.value, c.SKIN_PLAYER_BG_HEX);
          saveStateDebounced();
          dirtySkin(); scheduleUpdate();
          showToast(L.saved);
        });
        box.appendChild(mkRow(L.skinText.playerBg, pbg, compact));

        // player bg opacity
        const pbo = document.createElement("input");
        pbo.type = "range";
        pbo.min = "0"; pbo.max = "1"; pbo.step = "0.05";
        pbo.value = String(clamp(Number(c.SKIN_PLAYER_BG_OPACITY ?? DEFAULT_CFG.SKIN_PLAYER_BG_OPACITY), 0, 1));
        const pbo0 = Number(pbo.value);
        const pboRow = mkSliderRow(L.skinText.playerBgOpacity, pbo, `${Math.round(pbo0*100)}%`, "ok", compact);
        box.appendChild(pboRow.row);

        pbo.addEventListener("input", () => {
          c.SKIN_PLAYER_BG_OPACITY = clamp(Number(pbo.value) || 0, 0, 1);
          pboRow.setPill(`${Math.round(c.SKIN_PLAYER_BG_OPACITY*100)}%`, "ok");
          saveStateDebounced();
          dirtySkin(); scheduleUpdate();
        });
        pbo.addEventListener("change", () => showToast(L.saved));

        // background URL
        const urlWrap = document.createElement("div");
        urlWrap.style.display = "grid";
        urlWrap.style.gap = "8px";

        const urlLabel = document.createElement("div");
        urlLabel.textContent = L.skinText.bgUrl;
        urlLabel.style.fontWeight = "900";
        urlLabel.style.opacity = "0.9";
        urlLabel.style.fontSize = compact ? "12px" : "13px";
        urlWrap.appendChild(urlLabel);

        // built-in background presets (GitHub-hosted)
        const presetWrap = document.createElement("div");
        Object.assign(presetWrap.style, { display: "flex", flexWrap: "wrap", gap: "6px" });
        const refreshPresetSel = () => {
          [...presetWrap.children].forEach(b => {
            const on = b.dataset.url === String(c.SKIN_BG_URL || "");
            b.style.background = on ? "rgba(120,200,255,.30)" : "rgba(255,255,255,.08)";
            b.style.borderColor = on ? "rgba(120,200,255,.65)" : "rgba(255,255,255,.18)";
          });
        };
        BG_PRESETS.forEach(p => {
          const b = mkButton(p.name, () => {
            c.SKIN_BG_URL = p.url;
            urlInp.value = p.url;
            saveStateDebounced();
            dirtySkin(); scheduleUpdate();
            refreshPresetSel();
            showToast(L.saved);
          }, "ghost", true);
          b.dataset.url = p.url;
          presetWrap.appendChild(b);
        });
        urlWrap.appendChild(presetWrap);

        const urlInp = document.createElement("input");
        urlInp.type = "text";
        urlInp.value = String(c.SKIN_BG_URL || "");
        Object.assign(urlInp.style, {
          width: "100%",
          borderRadius: "12px",
          border: "1px solid rgba(255,255,255,.18)",
          background: "rgba(255,255,255,.08)",
          color: "#fff",
          padding: "10px 12px",
          fontWeight: "900",
          boxSizing: "border-box",
        });
        urlInp.addEventListener("change", () => {
          c.SKIN_BG_URL = String(urlInp.value || "").trim();
          saveStateDebounced();
          dirtySkin(); scheduleUpdate();
          refreshPresetSel();
          showToast(L.saved);
        });
        urlWrap.appendChild(urlInp);
        refreshPresetSel();

        box.appendChild(urlWrap);
        break;
      }

      case "board": {
        const info = document.createElement("div");
        info.style.opacity = "0.85";
        info.style.fontSize = "12px";
        info.style.lineHeight = "1.4";
        info.textContent = L.markerInfo;
        box.appendChild(info);

        const btn = mkButton(L.markerNow, () => { applyBoardMarkerNow(); showToast(L.toasts.marker); }, "primary", compact);
        box.appendChild(btn);
        break;
      }

      case "bmback": {
        const info = document.createElement("div");
        info.style.opacity = "0.85";
        info.style.fontSize = "12px";
        info.style.lineHeight = "1.4";
        info.textContent = L.bmInfo;
        box.appendChild(info);
        break;
      }

      case "throws":
        addSliderPx("THROW_VAL_FONT_PX", L.fields.fontSize, 20, EXT_LIMITS.THROW_VAL_FONT_PX, 1);
        addColor(()=>c.THROW_VAL_COLOR_HEX, v=>c.THROW_VAL_COLOR_HEX=v, L.fields.color);
        addSlider01(()=>c.THROW_VAL_OPACITY, v=>c.THROW_VAL_OPACITY=v, L.fields.opacity, 0.05);
        addColor(()=>c.THROW_BG_HEX, v=>c.THROW_BG_HEX=v, L.fields.bg);
        addSlider01(()=>c.THROW_BG_OPACITY, v=>c.THROW_BG_OPACITY=v, L.fields.bgOpacity, 0.05);

        addColor(()=>c.THROW_HOVER_BG_HEX, v=>c.THROW_HOVER_BG_HEX=v, L.fields.hoverBg);
        addSlider01(()=>c.THROW_HOVER_BG_OPACITY, v=>c.THROW_HOVER_BG_OPACITY=v, L.fields.hoverOpacity, 0.05);
        break;

      case "orig":
        addSliderPx("ORIG_FONT_PX", L.fields.fontSize, 10, EXT_LIMITS.ORIG_FONT_PX, 1);
        addColor(()=>c.ORIG_COLOR_HEX, v=>c.ORIG_COLOR_HEX=v, L.fields.color);
        addSlider01(()=>c.ORIG_OPACITY, v=>c.ORIG_OPACITY=v, L.fields.opacity, 0.05);
        break;

      case "total":
        addSliderPx("TOTAL_FONT_PX", L.fields.fontSize, 20, EXT_LIMITS.TOTAL_FONT_PX, 1);
        addColor(()=>c.TOTAL_COLOR_HEX, v=>c.TOTAL_COLOR_HEX=v, L.fields.color);
        addSlider01(()=>c.TOTAL_OPACITY, v=>c.TOTAL_OPACITY=v, L.fields.opacity, 0.05);
        addColor(()=>c.TOTAL_BG_HEX, v=>c.TOTAL_BG_HEX=v, L.fields.bg);
        addSlider01(()=>c.TOTAL_BG_OPACITY, v=>c.TOTAL_BG_OPACITY=v, L.fields.bgOpacity, 0.05);

        const info = document.createElement("div");
        info.style.opacity = "0.75";
        info.style.fontSize = "12px";
        info.style.lineHeight = "1.4";
        info.textContent = L.totalInfo;
        box.appendChild(info);
        break;

      case "checkout":
        addSliderPx("CHECKOUT_FONT_PX", L.fields.fontSize, 20, EXT_LIMITS.CHECKOUT_FONT_PX, 1);
        addColor(()=>c.CHECKOUT_COLOR_HEX, v=>c.CHECKOUT_COLOR_HEX=v, L.fields.color);
        addSlider01(()=>c.CHECKOUT_OPACITY, v=>c.CHECKOUT_OPACITY=v, L.fields.opacity, 0.05);
        break;

      case "playerinfo": {
        const pi = L.piText;

        const editRow = document.createElement("div");
        editRow.style.marginBottom = "10px";
        const editBtn = mkButton(pi.editModeOn, () => setEditMode(true), "primary", compact);
        editBtn.style.width = "100%";
        editRow.appendChild(editBtn);
        const editHintRow = document.createElement("div");
        editHintRow.textContent = pi.editHint;
        Object.assign(editHintRow.style, { opacity: "0.7", fontSize: compact ? "11px" : "12px", marginTop: "6px" });
        editRow.appendChild(editHintRow);
        box.appendChild(editRow);

        const piSection = (txt, first=false) => {
          const h = document.createElement("div");
          h.textContent = txt;
          Object.assign(h.style, {
            fontWeight: "900",
            fontSize: compact ? "11px" : "12px",
            opacity: "0.7",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            marginTop: first ? "0" : "6px",
            paddingTop: first ? "0" : "10px",
            borderTop: first ? "none" : "1px solid rgba(255,255,255,0.12)",
          });
          box.appendChild(h);
        };
        // unitless slider (avatar scale)
        const addSliderScale = (key, label, min, max, step) => {
          const slider = document.createElement("input");
          slider.type = "range";
          slider.min = String(min); slider.max = String(max); slider.step = String(step);
          const v0 = clamp(Number(c[key] ?? 7), min, max);
          slider.value = String(v0);
          const row = mkSliderRow(label, slider, `×${v0}`, "ok", compact);
          box.appendChild(row.row);
          slider.addEventListener("input", () => {
            const v = clamp(Number(slider.value) || min, min, max);
            c[key] = v;
            row.setPill(`×${v}`, "ok");
            saveStateDebounced();
            renderCss();
            dirtyTurn(); scheduleUpdate();
          });
          slider.addEventListener("change", () => showToast(L.saved));
        };

        // ---- SIZES ----
        piSection(pi.secSizes, true);
        addSliderPx("PI_NAME_FONT_PX", pi.name, 8, EXT_LIMITS.PI_NAME_FONT_PX, 1);
        addSliderPx("PI_SCORE_FONT_PX", pi.score, 20, EXT_LIMITS.PI_SCORE_FONT_PX, 1);
        addSliderPx("PI_AVG_FONT_PX", pi.average, 8, EXT_LIMITS.PI_AVG_FONT_PX, 1);
        addSliderPx("PI_HISTORY_FONT_PX", pi.history, 12, EXT_LIMITS.PI_HISTORY_FONT_PX, 1);
        addSliderScale("PI_AVATAR_SCALE", pi.avatarSize, 1, 10, 0.5);

        // ---- POSITIONING ----
        piSection(pi.secPos);
        addSliderPx("PI_STACK_GAP_PX", pi.spacing, 0, 160, 1);
        addSliderPx("PI_AVATAR_X_PX", pi.el.avatar + " ↔", -300, 300, 5);
        addSliderPx("PI_AVATAR_OFFSET_PX", pi.el.avatar + " ↕", -300, 300, 5);
        addSliderPx("PI_SCORE_X_PX", pi.el.score + " ↔", -300, 300, 5);
        addSliderPx("PI_SCORE_Y_PX", pi.el.score + " ↕", -300, 300, 5);
        addSliderPx("PI_NAME_X_PX", pi.el.name + " ↔", -300, 300, 5);
        addSliderPx("PI_NAME_Y_PX", pi.el.name + " ↕", -300, 300, 5);
        addSliderPx("PI_AVG_X_PX", pi.el.average + " ↔", -300, 300, 5);
        addSliderPx("PI_AVG_Y_PX", pi.el.average + " ↕", -300, 300, 5);
        addSliderPx("PI_HISTORY_X_PX", pi.el.history + " ↔", -300, 300, 5);
        addSliderPx("PI_HISTORY_OFFSET_PX", pi.el.history + " ↕", -100, 400, 5);
        addSliderPx("PI_HISTORY_WIDTH_PX", pi.historyWidth, 0, 600, 10);
        addSliderPx("PI_HISTORY_HEIGHT_PX", pi.historyHeight, 0, 900, 10);
        addSliderPx("PI_P1_SHIFT_Y", pi.alignP1, -200, 200, 2);
        addSliderPx("PI_P2_SHIFT_Y", pi.alignP2, -200, 200, 2);
        addSliderPx("PI_P3_SHIFT_Y", pi.alignP3, -200, 200, 2);
        addSliderPx("PI_P4_SHIFT_Y", pi.alignP4, -200, 200, 2);

        // ---- 3-4 PLAYER FIT ----
        piSection(pi.secGrid);
        addCheckbox(pi.gridAdjust, ()=>!!c.PI_GRID_ADJUST, v=>{ c.PI_GRID_ADJUST=v; });
        addSlider01(()=>c.PI_GRID_SCALE, v=>c.PI_GRID_SCALE=v, pi.gridScale, 0.05);
        {
          const gridInfo = document.createElement("div");
          gridInfo.textContent = pi.gridIndependentInfo;
          Object.assign(gridInfo.style, { opacity: "0.7", fontSize: compact ? "11px" : "12px", marginTop: "2px" });
          box.appendChild(gridInfo);
        }

        // ---- CARD ----
        piSection(pi.secCard);
        addSliderPx("PI_CARD_WIDTH_PX", pi.cardWidth, 0, 900, 10);
        addSliderPx("PI_CARD_HEIGHT_PX", pi.cardHeight, 0, 1400, 10);

        // ---- TEXT EFFECTS (stackable list) ----
        piSection(pi.secEffect);
        if (!Array.isArray(c.PI_TEXT_EFFECTS)) c.PI_TEXT_EFFECTS = [];
        const fxApply = () => { saveStateDebounced(); renderCss(); dirtyPlayers(); dirtyTurn(); scheduleUpdate(); };
        const fxStyleOpts = [["outline", pi.fxOutline], ["emboss", pi.fxEmboss], ["glow", pi.fxGlow], ["shadow", pi.fxShadow]];
        c.PI_TEXT_EFFECTS.forEach((eff, idx) => {
          const card = document.createElement("div");
          Object.assign(card.style, { border:"1px solid rgba(255,255,255,0.10)", borderRadius:"10px", padding:"8px", display:"grid", gap:"8px", marginBottom:"6px" });

          // header row: "Effect N" + remove
          const hdr = document.createElement("div");
          Object.assign(hdr.style, { display:"flex", alignItems:"center", justifyContent:"space-between" });
          const ht = document.createElement("div");
          ht.textContent = `${pi.effectStyle} ${idx + 1}`;
          ht.style.cssText = "font-weight:800;opacity:.85;font-size:12px;";
          const rm = mkButton("✕", () => { c.PI_TEXT_EFFECTS.splice(idx, 1); fxApply(); renderPanelIfOpen(); }, "ghost", true);
          rm.style.padding = "2px 8px";
          hdr.appendChild(ht); hdr.appendChild(rm);
          card.appendChild(hdr);

          // style select
          const sel = document.createElement("select");
          Object.assign(sel.style, { background:"rgba(255,255,255,.1)", border:"1px solid rgba(255,255,255,.25)", borderRadius:"6px", color:"#fff", padding:"3px 6px", fontSize:"13px" });
          for (const [val, txt] of fxStyleOpts) {
            const o = document.createElement("option"); o.value = val; o.textContent = txt; o.style.color = "#000";
            if (eff.style === val) o.selected = true; sel.appendChild(o);
          }
          sel.addEventListener("change", () => { eff.style = sel.value; fxApply(); renderPanelIfOpen(); });
          card.appendChild(mkRow(pi.effectStyle, sel, true));

          // size slider
          const sl = document.createElement("input");
          sl.type = "range"; sl.min = "1"; sl.max = "12"; sl.step = "1";
          sl.value = String(clamp(Math.round(Number(eff.size) || 2), 1, 12));
          const slRow = mkSliderRow(pi.effectSize, sl, `${sl.value}px`, "ok", true);
          card.appendChild(slRow.row);
          sl.addEventListener("input", () => { eff.size = clamp(Math.round(Number(sl.value) || 2), 1, 12); slRow.setPill(`${eff.size}px`, "ok"); fxApply(); });
          sl.addEventListener("change", () => showToast(L.saved));

          // colour (outline / glow only)
          if (eff.style === "outline" || eff.style === "glow") {
            const inp = document.createElement("input");
            inp.type = "color"; inp.value = sanitizeHex(eff.color, "#000000");
            inp.addEventListener("input", () => { eff.color = sanitizeHex(inp.value, "#000000"); fxApply(); });
            card.appendChild(mkRow(pi.effectColor, inp, true));
          }

          box.appendChild(card);
        });
        const addFxBtn = mkButton("➕ " + pi.addEffect, () => {
          if (c.PI_TEXT_EFFECTS.length >= 6) return;
          c.PI_TEXT_EFFECTS.push({ style: "outline", size: 2, color: "#000000" });
          fxApply(); renderPanelIfOpen();
        }, "primary", compact);
        box.appendChild(addFxBtn);

        // ---- COLOURS ----
        piSection(pi.secColors);
        addCheckbox(pi.customColors, ()=>!!c.PI_CUSTOM_COLORS, v=>{ c.PI_CUSTOM_COLORS=v; });
        addCheckbox(pi.perPlayerColors, ()=>!!c.PI_PER_PLAYER_COLORS, v=>{ c.PI_PER_PLAYER_COLORS=v; renderPanelIfOpen(); });
        const perPlayer = !!c.PI_PER_PLAYER_COLORS;
        const p1 = (s)=> perPlayer ? (pi.p1Prefix + " " + s) : s;
        addColor(()=>c.PI_NAME_COLOR_HEX, v=>c.PI_NAME_COLOR_HEX=v, p1(pi.nameColor));
        addColor(()=>c.PI_SCORE_COLOR_HEX, v=>c.PI_SCORE_COLOR_HEX=v, p1(pi.scoreColor));
        addColor(()=>c.PI_AVG_COLOR_HEX, v=>c.PI_AVG_COLOR_HEX=v, p1(pi.avgColor));
        addColor(()=>c.PI_HISTORY_COLOR_HEX, v=>c.PI_HISTORY_COLOR_HEX=v, p1(pi.historyColor));
        if (perPlayer) {
          [2,3,4].forEach(n => {
            const pre = pi["p" + n + "Prefix"] || ("P" + n);
            addColor(()=>c["PI_P"+n+"_NAME_COLOR_HEX"], v=>c["PI_P"+n+"_NAME_COLOR_HEX"]=v, pre + " " + pi.nameColor);
            addColor(()=>c["PI_P"+n+"_SCORE_COLOR_HEX"], v=>c["PI_P"+n+"_SCORE_COLOR_HEX"]=v, pre + " " + pi.scoreColor);
            addColor(()=>c["PI_P"+n+"_AVG_COLOR_HEX"], v=>c["PI_P"+n+"_AVG_COLOR_HEX"]=v, pre + " " + pi.avgColor);
            addColor(()=>c["PI_P"+n+"_HISTORY_COLOR_HEX"], v=>c["PI_P"+n+"_HISTORY_COLOR_HEX"]=v, pre + " " + pi.historyColor);
          });
        }

        const piInfo = document.createElement("div");
        piInfo.style.opacity = "0.75";
        piInfo.style.fontSize = "12px";
        piInfo.style.lineHeight = "1.4";
        piInfo.textContent = pi.info;
        box.appendChild(piInfo);
        break;
      }

      case "active": {
        addCheckbox(L.fields.perPlayer, ()=>!!c.ACTIVE_PER_PLAYER, v=>{ c.ACTIVE_PER_PLAYER=v; renderPanelIfOpen(); });
        const aPP = !!c.ACTIVE_PER_PLAYER;
        const a1 = (s)=> aPP ? (L.fields.p1 + " " + s) : s;
        // Player 1 (or shared)
        addColor(()=>c.ACTIVE_COLOR_HEX, v=>c.ACTIVE_COLOR_HEX=v, a1(L.fields.color));
        addSliderPx("ACTIVE_OUTLINE_PX", a1(L.fields.outline), 0, EXT_LIMITS.ACTIVE_OUTLINE_PX, 1);
        addSlider01(()=>c.ACTIVE_GLOW, v=>c.ACTIVE_GLOW=v, a1(L.fields.glow), 0.01);
        addCheckbox(a1(L.fields.trailEnabled), ()=>!!c.ACTIVE_TRAIL, v=>{ c.ACTIVE_TRAIL=v; });
        addColor(()=>c.ACTIVE_TRAIL_COLOR_HEX||c.ACTIVE_COLOR_HEX, v=>c.ACTIVE_TRAIL_COLOR_HEX=v, a1(L.fields.trailColor));
        addSliderMs("ACTIVE_TRAIL_SPEED_MS", a1(L.fields.trailSpeed), 500, 10000, 100);
        if (aPP) {
          [2,3,4].forEach(n => {
            const sep = document.createElement("div");
            sep.style.cssText = "height:1px;background:rgba(255,255,255,0.12);margin:6px 0;";
            box.appendChild(sep);
            const pre = L.fields["p" + n] || ("P" + n);
            addColor(()=>c["ACTIVE_P"+n+"_COLOR_HEX"], v=>c["ACTIVE_P"+n+"_COLOR_HEX"]=v, pre + " " + L.fields.color);
            addSliderPx("ACTIVE_P"+n+"_OUTLINE_PX", pre + " " + L.fields.outline, 0, EXT_LIMITS["ACTIVE_P"+n+"_OUTLINE_PX"], 1);
            addSlider01(()=>c["ACTIVE_P"+n+"_GLOW"], v=>c["ACTIVE_P"+n+"_GLOW"]=v, pre + " " + L.fields.glow, 0.01);
            addCheckbox(pre + " " + L.fields.trailEnabled, ()=>!!c["ACTIVE_P"+n+"_TRAIL"], v=>{ c["ACTIVE_P"+n+"_TRAIL"]=v; });
            addColor(()=>c["ACTIVE_P"+n+"_TRAIL_COLOR_HEX"]||c["ACTIVE_P"+n+"_COLOR_HEX"], v=>c["ACTIVE_P"+n+"_TRAIL_COLOR_HEX"]=v, pre + " " + L.fields.trailColor);
            addSliderMs("ACTIVE_P"+n+"_TRAIL_SPEED_MS", pre + " " + L.fields.trailSpeed, 500, 10000, 100);
          });
        }
        break;
      }

      case "triple":
        addCheckbox(L.fields.varietyEnabled, ()=>!!c.TRIPLE_VARIETY, v=>{ c.TRIPLE_VARIETY=v; });
        addColor(()=>c.TRIPLE_GLOW_HEX, v=>c.TRIPLE_GLOW_HEX=v, L.fields.glowColor);
        addSlider01(()=>c.TRIPLE_GLOW, v=>c.TRIPLE_GLOW=v, L.fields.glow, 0.05);
        addCheckbox(L.fields.flashEnabled, ()=>!!c.TRIPLE_FLASH, v=>{ c.TRIPLE_FLASH=v; });
        addSliderMs("TRIPLE_SHIMMER_MS", L.fields.highlightSpeed, 400, 6000, 50);
        addSliderMs("TRIPLE_SLAM_MS", L.fields.numberAnim, 80, 1200, 10);
        addSliderMs("TRIPLE_RATTLE_MS", L.fields.rattleDur, 80, 2000, 20);
        addSliderMs("TRIPLE_RATTLE_DELAY_MS", L.fields.rattleDelay, 0, 2500, 25);
        addCheckbox(L.fields.spinEnabled, ()=>!!c.TRIPLE_SPIN, v=>{ c.TRIPLE_SPIN=v; });
        addSliderInt("TRIPLE_SPIN_MIN", L.fields.spinMin, 1, 20, "T≥");
        addSliderMs("TRIPLE_SPIN_MS", L.fields.spinDuration, 300, 6000, 50);
        break;

      case "double":
        addCheckbox(L.fields.varietyEnabled, ()=>!!c.DOUBLE_VARIETY, v=>{ c.DOUBLE_VARIETY=v; });
        addCheckbox(L.fields.doubleStreak, ()=>!!c.DOUBLE_STREAK_ANIM, v=>{ c.DOUBLE_STREAK_ANIM=v; });
        addColor(()=>c.DOUBLE_GLOW_HEX, v=>c.DOUBLE_GLOW_HEX=v, L.fields.glowColor);
        addSlider01(()=>c.DOUBLE_GLOW, v=>c.DOUBLE_GLOW=v, L.fields.glow, 0.05);
        addCheckbox(L.fields.flashEnabled, ()=>!!c.DOUBLE_FLASH, v=>{ c.DOUBLE_FLASH=v; });
        addSliderMs("DOUBLE_SHIMMER_MS", L.fields.highlightSpeed, 400, 6000, 50);
        addSliderMs("DOUBLE_SLAM_MS", L.fields.numberAnim, 80, 1200, 10);
        addSliderMs("DOUBLE_RATTLE_MS", L.fields.rattleDur, 80, 2000, 20);
        addSliderMs("DOUBLE_RATTLE_DELAY_MS", L.fields.rattleDelay, 0, 2500, 25);
        addCheckbox(L.fields.spinEnabled, ()=>!!c.DOUBLE_SPIN, v=>{ c.DOUBLE_SPIN=v; });
        addSliderInt("DOUBLE_SPIN_MIN", L.fields.spinMin, 1, 20, "D≥");
        addSliderMs("DOUBLE_SPIN_MS", L.fields.spinDuration, 300, 6000, 50);
        break;

      case "highscore": {
        // Threshold input (integer), optionally paired with an enable checkbox (tiers 2/3).
        const addThresholdRow = (label, thresholdKey, def, enabledKey) => {
          const wrap = document.createElement("div");
          Object.assign(wrap.style, { display:"flex", alignItems:"center", justifyContent:"space-between", gap:"10px" });
          const left = document.createElement("div");
          Object.assign(left.style, { display:"flex", alignItems:"center", gap:"8px" });
          if (enabledKey) {
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = !!c[enabledKey];
            cb.addEventListener("change", () => { c[enabledKey] = cb.checked; saveStateDebounced(); showToast(L.saved); });
            left.appendChild(cb);
          }
          const lbl = document.createElement("div");
          lbl.textContent = label;
          lbl.style.fontSize = compact ? "12px" : "13px";
          lbl.style.fontWeight = "800";
          lbl.style.opacity = "0.9";
          left.appendChild(lbl);
          const input = document.createElement("input");
          input.type = "number";
          input.min = "1"; input.max = "180"; input.step = "1";
          input.value = String(clamp(Math.round(Number(c[thresholdKey]) || def), 1, 180));
          Object.assign(input.style, { width:"60px", background:"rgba(255,255,255,.1)", border:"1px solid rgba(255,255,255,.25)", borderRadius:"6px", color:"#fff", padding:"2px 6px", fontSize:"13px", textAlign:"center" });
          input.addEventListener("input", () => {
            c[thresholdKey] = clamp(Math.round(Number(input.value) || def), 1, 180);
            saveStateDebounced();
          });
          input.addEventListener("change", () => showToast(L.saved));
          wrap.appendChild(left); wrap.appendChild(input);
          box.appendChild(wrap);
        };

        addThresholdRow(L.fields.threshold, "HIGHSCORE_THRESHOLD", 100, null);
        addThresholdRow(L.fields.tier2, "HIGHSCORE2_THRESHOLD", 140, "HIGHSCORE2_ENABLED");
        addThresholdRow(L.fields.tier3, "HIGHSCORE3_THRESHOLD", 180, "HIGHSCORE3_ENABLED");
        addCheckbox(L.fields.bannerEnabled, ()=>!!c.HIGHSCORE3_BANNER, v=>{ c.HIGHSCORE3_BANNER=v; });
        addCheckbox(L.fields.fire26Enabled, ()=>!!c.FIRE26_ENABLED, v=>{ c.FIRE26_ENABLED=v; });

        addColor(()=>c.HIGHSCORE_GLOW_HEX, v=>c.HIGHSCORE_GLOW_HEX=v, L.fields.glowColor);
        addSlider01(()=>c.HIGHSCORE_GLOW, v=>c.HIGHSCORE_GLOW=v, L.fields.glow, 0.05);
        addCheckbox(L.fields.flashEnabled, ()=>!!c.HIGHSCORE_FLASH, v=>{ c.HIGHSCORE_FLASH=v; });
        addCheckbox(L.fields.spinEnabled, ()=>!!c.HIGHSCORE_SPIN, v=>{ c.HIGHSCORE_SPIN=v; });
        addSliderMs("HIGHSCORE_SPIN_MS", L.fields.spinDuration, 400, 15000, 100);
        addCheckbox(L.fields.boardFlash, ()=>!!c.HIGHSCORE_BOARD_FLASH, v=>{ c.HIGHSCORE_BOARD_FLASH=v; });
        addCheckbox(L.fields.throwFlash, ()=>!!c.HIGHSCORE_THROW_FLASH, v=>{ c.HIGHSCORE_THROW_FLASH=v; });
        addSliderMs("HIGHSCORE_SHIMMER_MS", L.fields.highlightSpeed, 400, 6000, 50);

        const fxInfo = document.createElement("div");
        fxInfo.style.opacity = "0.75";
        fxInfo.style.fontSize = "12px";
        fxInfo.style.lineHeight = "1.4";
        fxInfo.textContent = L.fields.fxMatrixInfo;
        box.appendChild(fxInfo);
        break;
      }

      case "fx": {
        addCheckbox(L.fields.fxMasterEnabled, ()=>!!c.FX_MATRIX_ENABLED, v=>{ c.FX_MATRIX_ENABLED=v; renderPanelIfOpen(); });
        addCheckbox(L.fields.fxSoundEnabled, ()=>!!c.FX_SOUND_ENABLED, v=>{ c.FX_SOUND_ENABLED=v; });

        if (c.FX_MATRIX_ENABLED) {
          const table = document.createElement("table");
          Object.assign(table.style, { borderCollapse: "collapse", width: "100%", fontSize: compact ? "11px" : "12px", marginTop: "8px" });

          const thead = document.createElement("thead");
          const headRow = document.createElement("tr");
          const cornerTh = document.createElement("th");
          headRow.appendChild(cornerTh);
          for (const trig of FX_TRIGGERS) {
            const th = document.createElement("th");
            th.textContent = L.fxTriggers[trig] || trig;
            Object.assign(th.style, { padding: "3px 4px", opacity: "0.8", fontWeight: "800", textAlign: "center" });
            headRow.appendChild(th);
          }
          thead.appendChild(headRow);
          table.appendChild(thead);

          const tbody = document.createElement("tbody");
          for (const eff of FX_EFFECTS) {
            const row = document.createElement("tr");
            const rowLabel = document.createElement("td");
            rowLabel.textContent = L.fxEffects[eff] || eff;
            Object.assign(rowLabel.style, { padding: "3px 6px 3px 0", fontWeight: "800", opacity: "0.9", whiteSpace: "nowrap" });
            row.appendChild(rowLabel);
            for (const trig of FX_TRIGGERS) {
              const td = document.createElement("td");
              td.style.textAlign = "center";
              td.style.padding = "2px";
              const cb = document.createElement("input");
              cb.type = "checkbox";
              const key = fxKey(eff, trig);
              cb.checked = !!c[key];
              cb.addEventListener("change", () => { c[key] = cb.checked; saveStateDebounced(); showToast(L.saved); });
              td.appendChild(cb);
              row.appendChild(td);
            }
            tbody.appendChild(row);
          }
          table.appendChild(tbody);
          box.appendChild(table);
        }
        break;
      }

      case "win": {
        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = "0"; slider.max = "1"; slider.step = "0.05";
        slider.value = String(clamp(Number(c.WIN_VOLUME ?? 1), 0, 1));

        const row = mkSliderRow(L.fields.volume, slider, `${Math.round(Number(slider.value)*100)}%`, "ok", compact);
        box.appendChild(row.row);

        slider.addEventListener("input", () => {
          const v = clamp(Number(slider.value) || 0, 0, 1);
          c.WIN_VOLUME = v;
          row.setPill(`${Math.round(v*100)}%`, "ok");
          if (winAudio) winAudio.volume = v;
          saveStateDebounced();
        });
        slider.addEventListener("change", () => showToast(L.saved));
        break;
      }

      case "clock": {
        const cs = state.ui.clock;
        buildClockIfNeeded();

        addCheckbox(L.clockText.enabled, ()=>cs.enabled, (v)=>{
          cs.enabled = v;
          applyClockEnabled();
          if (v) { applyClockStyle(); applyClockScale(); applyClockPosition(); renderClockTime(); }
          showToast(v ? L.toasts.clockOn : L.toasts.clockOff);
        });

        const scaleSlider = document.createElement("input");
        scaleSlider.type = "range";
        scaleSlider.min = String(CLOCK_SCALE_MIN);
        scaleSlider.max = String(CLOCK_SCALE_MAX);
        scaleSlider.step = String(CLOCK_SCALE_STEP);
        scaleSlider.value = String(clamp(Number(cs.scale ?? 1), CLOCK_SCALE_MIN, CLOCK_SCALE_MAX));

        const sRow = mkSliderRow(L.clockText.scale, scaleSlider, `${Math.round(Number(scaleSlider.value)*100)}%`, "ok", compact);
        box.appendChild(sRow.row);

        scaleSlider.addEventListener("input", ()=>{
          cs.scale = clamp(Number(scaleSlider.value) || 1, CLOCK_SCALE_MIN, CLOCK_SCALE_MAX);
          sRow.setPill(`${Math.round(cs.scale*100)}%`, "ok");
          applyClockScale();
          applyClockPosition();
          saveStateDebounced();
        });
        scaleSlider.addEventListener("change", ()=>showToast(L.saved));

        addColor(()=>cs.bgHex, v=>{ cs.bgHex=v; applyClockStyle(); }, L.clockText.bg);
        addSlider01(()=>cs.bgAlpha, v=>{ cs.bgAlpha=v; applyClockStyle(); }, L.clockText.bgAlpha, 0.05);
        addColor(()=>cs.textHex, v=>{ cs.textHex=v; applyClockStyle(); }, L.clockText.text);

        addCheckbox(L.clockText.format24, ()=>cs.format24, (v)=>{ cs.format24=v; renderClockTime(); });
        addCheckbox(L.clockText.seconds, ()=>cs.showSeconds, (v)=>{ cs.showSeconds=v; renderClockTime(); });

        const rowBtns = document.createElement("div");
        rowBtns.style.display = "flex";
        rowBtns.style.gap = "8px";

        const b1 = mkButton(L.clockText.resetLook, ()=>{ resetClockLook(); renderPanelIfOpen(); showToast(L.saved); }, "ghost", compact);
        const b2 = mkButton(L.clockText.resetPos, ()=>{ resetClockPosition(); renderPanelIfOpen(); showToast(L.saved); }, "ghost", compact);
        b1.style.flex = "1"; b2.style.flex = "1";
        rowBtns.appendChild(b1); rowBtns.appendChild(b2);
        box.appendChild(rowBtns);

        const hint = document.createElement("div");
        hint.style.opacity = "0.75";
        hint.style.fontSize = "12px";
        hint.style.lineHeight = "1.4";
        hint.textContent = L.clockText.hint;
        box.appendChild(hint);

        break;
      }
    }

    if (state.ui.helpOpen) {
      const help = document.createElement("div");
      Object.assign(help.style, {
        marginTop: "10px",
        padding: compact ? "10px" : "12px",
        borderRadius: "16px",
        border: "1px solid rgba(255,255,255,0.10)",
        background: "rgba(255,255,255,0.06)",
        fontSize: "12px",
        lineHeight: "1.45",
        opacity: "0.92",
      });
      help.innerHTML = L.helpHtml;
      rightCol.appendChild(help);
    }

    body.appendChild(leftCol);
    body.appendChild(rightCol);

    requestAnimationFrame(ensurePanelPosition);
  }

  /* ================== HOTKEYS ================== */
  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toUpperCase() : "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    if (matchHotkey(e, HOTKEY_PANEL)) {
      e.preventDefault();
      setUIOpen(!state.ui.open);
      if (state.ui.open) { renderPanel(); ensurePanelPosition(); }
      return;
    }

    if (matchHotkey(e, HOTKEY_HELP)) {
      e.preventDefault();
      state.ui.helpOpen = !state.ui.helpOpen;
      saveStateDebounced();
      renderPanelIfOpen();
      return;
    }

    if (matchHotkey(e, HOTKEY_SAFE)) {
      e.preventDefault();
      state.ui.safeMode = !state.ui.safeMode;
      applySafeClampsToCfg();
      saveStateDebounced();
      renderCss();
      dirtyTurn(); dirtyPlayers(); dirtyBoard(); dirtyBm(); dirtySkin();
      scheduleUpdate();
      renderPanelIfOpen();
      showToast(state.ui.safeMode ? T().toasts.safeOn : T().toasts.safeOff);
      return;
    }

    if (matchHotkey(e, HOTKEY_PRESET_1)) { e.preventDefault(); setActivePreset(0); return; }
    if (matchHotkey(e, HOTKEY_PRESET_2)) { e.preventDefault(); setActivePreset(1); return; }
    if (matchHotkey(e, HOTKEY_PRESET_3)) { e.preventDefault(); setActivePreset(2); return; }

    if (matchHotkey(e, HOTKEY_CLOCK_TOGGLE)) {
      e.preventDefault();
      state.ui.clock.enabled = !state.ui.clock.enabled;
      buildClockIfNeeded();
      applyClockEnabled();
      if (state.ui.clock.enabled) { applyClockStyle(); applyClockScale(); applyClockPosition(); renderClockTime(); }
      saveStateDebounced();
      renderPanelIfOpen();
      showToast(state.ui.clock.enabled ? T().toasts.clockOn : T().toasts.clockOff);
      return;
    }

    if (matchHotkey(e, HOTKEY_CLOCK_RESET)) {
      e.preventDefault();
      const keepEnabled = state.ui.clock.enabled;
      state.ui.clock = clone(DEFAULT_CLOCK);
      state.ui.clock.enabled = keepEnabled;
      buildClockIfNeeded();
      applyClockStyle(); applyClockScale(); applyClockPosition(); applyClockEnabled(); renderClockTime();
      saveStateDebounced();
      renderPanelIfOpen();
      showToast(T().saved);
      return;
    }

    // clock scale from keyboard
    if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      if (!state.ui.clock.enabled) return;
      e.preventDefault();
      const dir = (e.key === "ArrowUp") ? 1 : -1;
      const cs = state.ui.clock;
      cs.scale = clamp(Math.round((cs.scale + dir * CLOCK_SCALE_STEP) * 100) / 100, CLOCK_SCALE_MIN, CLOCK_SCALE_MAX);
      buildClockIfNeeded();
      applyClockScale();
      applyClockPosition();
      saveStateDebounced();
      renderPanelIfOpen();
      return;
    }

    if (e.key === "Escape") {
      if (state.ui.open) { e.preventDefault(); setUIOpen(false); return; }
    }
  }, true);

  /* ================== INIT ================== */
  function start() {
      // reset main scope (listeners/timers) if start() is ever called again
    if (scopeMain) scopeMain.abort();
    scopeMain = makeScope();
    
    initStickyThrowSelectOnce();
    ensureHead(() => {
      ensureUIStyle();
      renderCss();
      ensureSkinCss(); // ✅ skin css initial
      if (cfg().WIN_MUSIC) initWinMusicOnce();

      // Scoped observers + dirty flags
      let turnObs = null;
      let playersObs = null;
      let lastTurn = null;
      let lastPlayers = null;

      function attachScopedObservers() {
        const turn = document.querySelector("#ad-ext-turn");
        if (turn && turn !== lastTurn) {
          if (turnObs) turnObs.disconnect();
          lastTurn = turn;
          turn.removeAttribute(TURN_SEL_ATTR);
          turnObs = new MutationObserver(() => { dirtyTurn(); scheduleUpdate(); });
          turnObs.observe(turn, { subtree: true, childList: true, characterData: true, attributes: true });
          dirtyTurn();
        }

        const players = document.querySelector("#ad-ext-player-display");
        if (players && players !== lastPlayers) {
          if (playersObs) playersObs.disconnect();
          lastPlayers = players;
          playersObs = new MutationObserver(() => { dirtyPlayers(); scheduleUpdate(); });
          playersObs.observe(players, { subtree: true, childList: true, attributes: true });
          dirtyPlayers();
        }
      }

      const obs = new MutationObserver((muts) => {
        // New board visuals? board marker might need refresh
        for (const m of muts) {
          if (m.addedNodes && m.addedNodes.length) {
            for (const n of m.addedNodes) {
              if (n && n.nodeType === 1) {
                const el = n;
                if (el.tagName === "SVG" || el.tagName === "IMG" || el.querySelector?.("svg") || el.querySelector?.("img")) dirtyBoard();
              }
            }
          }
        }

        if (isBoardsPage()) dirtyBm();

        attachScopedObservers();
        scheduleUpdate();
      });

      obs.observe(document.documentElement, { subtree: true, childList: true });
      attachScopedObservers();

      configureActivePolling();

      scopeMain.on(window, "resize", () => { dirtySkin(); scheduleUpdate(); }, { passive: true });
      scopeMain.on(window, "fullscreenchange", () => { dirtySkin(); scheduleUpdate(); }, { passive: true });

      setTimeout(scheduleUpdate, 60);
      setTimeout(scheduleUpdate, 200);
      setTimeout(scheduleUpdate, 700);
    });

    ensureBody(() => {
      buildUIChrome();
      applySafeClampsToCfg();
      renderCss();

      dirtyTurn(); dirtyPlayers(); dirtyBoard(); dirtyBm(); dirtySkin();
      scheduleUpdate();

      buildClockIfNeeded();
      applyClockEnabled();
      applyClockStyle();
      applyClockScale();
      applyClockPosition();
      renderClockTime();

      ensureBmBackButton();
    });
  }

  start();
})();
