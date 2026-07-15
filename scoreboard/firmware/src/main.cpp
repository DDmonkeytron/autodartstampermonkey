/*
 * Autodarts LED Scoreboard — ESP32-S3 (N16R8)
 * ============================================================
 *  Matrix : 64x64 HUB75  — scoreboard (2-4 players) + animated GIF sprites
 *                          + scrolling event text + checkout suggestions
 *  Strips : 2x WS2812     — parametric LED effects, current-limited
 *  WiFi   : WiFiManager captive portal, mDNS http://darts.local, NTP clock
 *  Storage: LittleFS      — GIF library + config.json
 *  Extras : web config UI (/), OTA updates (/update), idle clock, event queue
 *
 *  Control model: Tampermonkey (or the web UI) pushes config + live data and
 *  uploads GIFs. The ESP32 stores everything and renders.
 *
 *  HTTP API
 *    GET  /            web config UI
 *    GET  /ping        identify (scan)             GET  /status   heap/rssi/uptime
 *    GET  /config      read config                 POST /config   replace config
 *    GET  /sprites     list GIFs                    POST /sprite   upload GIF (multipart)
 *    POST /delete?name=x.gif   delete a GIF         POST /update   OTA firmware (multipart)
 *    POST /score       scoreboard data             POST /event    trigger celebration
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <HTTPClient.h>       // cloud tunnel: loopback proxy to our own web server
#include <ESPmDNS.h>
#include <LittleFS.h>
#include <Update.h>
#include <time.h>
#include <WiFiManager.h>
#include <ArduinoJson.h>
#include <WebSocketsClient.h> // cloud remote: outbound WSS tunnel to the relay
#include <mbedtls/base64.h>   // base64 for tunnelled request/response bodies
#include <ESP32-HUB75-MatrixPanel-I2S-DMA.h>
#include <FastLED.h>
#include <AnimatedGIF.h>
#include <Fonts/TomThumb.h>   // tiny ~4x6 font for the "small" text-field size

// ===================== FIXED CONFIG =====================
#define PANEL_RES_X 64          // one panel's native width
#define PANEL_H 64
#define PW_MAX 128              // max canvas width (two panels chained) — sizes static buffers
int panelW = PANEL_RES_X;       // live canvas width = PANEL_RES_X * chain, set at boot from config
// HUB75 -> S3 (r1,g1,b1,r2,g2,b2,a,b,c,d,e,lat,oe,clk)
#define P_R1 4
#define P_G1 5
#define P_B1 6
#define P_R2 7
#define P_G2 15
#define P_B2 16
#define P_A 18
#define P_B 8
#define P_C 9
#define P_D 10
#define P_E 11
#define P_LAT 13
#define P_OE 14
#define P_CLK 12
// Strip data pins + LED counts now live in config.json (web UI → Scoreboard panel;
// reboot to apply). Defaults: strip1 = IO17, strip2 = IO21, 60 LEDs each.
// STRIP_MAX is only the buffer ceiling.
#define STRIP_MAX 300
#define DEF_PANEL_BRI 120
#define DEF_STRIP_BRI 90
#define DEF_MAX_MA 8000          // strip current cap (protects the shared 5V PSU)
#define DEF_IDLE_MS 90000
#define DEF_EVENT_MS 5000
#define AP_NAME "DartsScoreboard-Setup"
#define MDNS_NAME "darts"

// ===================== GLOBALS =====================
MatrixPanel_I2S_DMA *dma = nullptr;
CRGB strip1[STRIP_MAX], strip2[STRIP_MAX];
int s1n = 60, s2n = 60;              // actual LED counts (from config at boot)
uint32_t identifyUntil = 0;          // "which strip is which" mode
WebServer server(80);
AnimatedGIF gif;
JsonDocument cfg;
uint16_t C_WHITE, C_RED, C_GREEN, C_YELLOW, C_CYAN, C_DIM;
bool cloudUp = false;                // cloud tunnel connected? (reported by /status; set by the cloud task)

struct Player { String name = "PLAYER"; int score = 501; int legs = 0; float avg = 0; int c180 = 0; int high = 0; String co = ""; };  // co = autodarts' own checkout suggestion (verbatim), "" = compute ours
Player players[4];
int numPlayers = 2, activePlayer = 0;
int turnThrows[3] = {0, 0, 0}, turnThrowCount = 0;

bool gifPlaying = false; int gifX = 0, gifY = 0; uint32_t gifNextFrame = 0; char gifPath[64] = {0};
String eventText = ""; uint32_t eventUntil = 0; int marqueeX = panelW; uint32_t lastMarquee = 0;

// per-strip effect state: each strip has its own effect/colour/palette/speed,
// or strip 2 can "mirror" (replicate) strip 1's buffer exactly.
struct StripFx { String effect = "off"; CRGB color = CRGB::White; CRGBPalette16 pal = RainbowColors_p; uint8_t speed = 4; };
StripFx sfx[2]; bool mirror2 = true;
String panelFx = ""; CRGBPalette16 panelPal = RainbowColors_p;
File gifFile, uploadFile;
uint32_t lastActivity = 0; bool idle = false;
String evQueue[6]; int evVal[6]; String evText[6]; int evCount = 0;   // evText = optional dynamic text per queued event

// debug log ring buffer + per-turn stats dedup
#define LOGN 30
String logBuf[LOGN]; int logHead = 0; String lastTurnSig = "";
void LOG(const String &s) { logBuf[logHead] = String(millis() / 1000) + "s  " + s; logHead = (logHead + 1) % LOGN; Serial.println(s); }

// ===================== CHECKOUTS =====================
String checkoutFor(int score) {
  static int lastS = -1; static String lastR = "";
  if (score == lastS) return lastR;
  lastS = score;
  auto done = [&](String r) { lastR = r; return r; };
  if (score < 2 || score > 170) return done("");
  static int segV[64], dblV[24], nSeg = 0, nDbl = 0; static char segN[64][5], dblN[24][5];
  if (!nSeg) {
    for (int i = 20; i >= 1; i--) { segV[nSeg] = i * 3; sprintf(segN[nSeg], "T%d", i); nSeg++; }
    segV[nSeg] = 50; strcpy(segN[nSeg], "50"); nSeg++;   // "50" keeps 3-dart routes ≤11 chars wide
    segV[nSeg] = 25; strcpy(segN[nSeg], "25"); nSeg++;
    for (int i = 20; i >= 1; i--) { segV[nSeg] = i; sprintf(segN[nSeg], "S%d", i); nSeg++; }
    for (int i = 20; i >= 1; i--) { dblV[nDbl] = i * 2; sprintf(dblN[nDbl], "D%d", i); nDbl++; }
    dblV[nDbl] = 50; strcpy(dblN[nDbl], "BULL"); nDbl++;
  }
  // in composed routes bull shortens to "B" so 3-dart strings fit 64px (e.g. 170 = "T20 T20 B")
  auto D = [&](int d) { return String(dblN[d]) == "BULL" ? String("B") : String(dblN[d]); };
  for (int d = 0; d < nDbl; d++) if (dblV[d] == score) return done(dblN[d]);
  for (int a = 0; a < nSeg; a++) for (int d = 0; d < nDbl; d++)
    if (segV[a] + dblV[d] == score) return done(String(segN[a]) + " " + D(d));
  for (int a = 0; a < nSeg; a++) for (int b = 0; b < nSeg; b++) for (int d = 0; d < nDbl; d++)
    if (segV[a] + segV[b] + dblV[d] == score) return done(String(segN[a]) + " " + segN[b] + " " + D(d));
  return done("");
}
// Prefer autodarts' own suggestion (sent per-player as "co"); else fall back to our computed route.
String checkoutStr(const Player &pl) {
  if (pl.co.length()) return pl.co;
  return (pl.score >= 2 && pl.score <= 170) ? checkoutFor(pl.score) : "";
}

// ===================== GIF =====================
void *GIFOpen(const char *fn, int32_t *pSize) { gifFile = LittleFS.open(fn, "r"); if (!gifFile) return nullptr; *pSize = gifFile.size(); return (void *)&gifFile; }
void GIFClose(void *h) { if (h) ((File *)h)->close(); }
int32_t GIFRead(GIFFILE *pF, uint8_t *b, int32_t l) { File *f = (File *)pF->fHandle; int32_t r = f->read(b, l); pF->iPos = f->position(); return r; }
int32_t GIFSeek(GIFFILE *pF, int32_t p) { File *f = (File *)pF->fHandle; f->seek(p); pF->iPos = f->position(); return pF->iPos; }
void GIFDraw(GIFDRAW *pDraw) {
  int w = pDraw->iWidth; if (w > panelW) w = panelW;
  uint16_t *pal = pDraw->pPalette; uint8_t *s = pDraw->pPixels;
  int y = gifY + pDraw->iY + pDraw->y;
  if (pDraw->ucDisposalMethod == 2) for (int x = 0; x < w; x++) if (s[x] == pDraw->ucTransparent) s[x] = pDraw->ucBackground;
  for (int x = 0; x < w; x++) { if (pDraw->ucHasTransparency && s[x] == pDraw->ucTransparent) continue; dma->drawPixel(gifX + pDraw->iX + x, y, pal[s[x]]); }
}
int evX0 = 0, evW = PANEL_RES_X; bool evSplit = false;   // event render region (x, width) + split-screen flag
void setRegion(const char *r) {    // "full" | "left" | "right" (left/right only meaningful on a 128-wide board)
  if (panelW >= 128 && !strcmp(r, "left"))       { evX0 = 0;  evW = 64; }
  else if (panelW >= 128 && !strcmp(r, "right")) { evX0 = 64; evW = 64; }
  else                                           { evX0 = 0;  evW = panelW; }
}
bool openGif(const char *path) {
  if (gifPlaying) { gif.close(); gifPlaying = false; }
  if (!path || !LittleFS.exists(path)) return false;
  strncpy(gifPath, path, sizeof(gifPath) - 1);
  if (gif.open((char *)gifPath, GIFOpen, GIFClose, GIFRead, GIFSeek, GIFDraw)) {
    gifX = evX0 + (evW - gif.getCanvasWidth()) / 2; gifY = (PANEL_H - gif.getCanvasHeight()) / 2;
    gifPlaying = true; gifNextFrame = 0; return true;
  }
  return false;
}

// ===================== SCOREBOARD =====================
void drawPlayer(int i, int yTop, int rowH) {
  Player &p = players[i]; bool a = (i == activePlayer);
  dma->setTextWrap(false);
  if (rowH < 28) {                              // compact (3-4 players)
    dma->setTextSize(1); dma->setTextColor(a ? C_YELLOW : C_DIM);
    dma->setCursor(1, yTop); dma->print(p.name.substring(0, 8));
    dma->setTextColor(C_WHITE); dma->setCursor(1, yTop + 8); dma->printf("%d", p.score);
    if (a) dma->fillRect(60, yTop, 3, 7, C_GREEN);
    return;
  }
  bool showAvg = cfg["layout"]["showAvg"] | true, showLegs = cfg["layout"]["showLegs"] | true;
  bool showThrows = cfg["layout"]["showThrows"] | false, showCk = cfg["layout"]["showCheckout"] | false;
  dma->setTextSize(1); dma->setTextColor(a ? C_YELLOW : C_DIM);
  dma->setCursor(1, yTop); dma->print(p.name.substring(0, 10));
  uint16_t pc = C_WHITE;                          // optional per-player colour
  JsonArray pcs = cfg["layout"]["playerColors"].as<JsonArray>();
  if (!pcs.isNull() && i < (int)pcs.size()) pc = dma->color565(pcs[i][0] | 255, pcs[i][1] | 255, pcs[i][2] | 255);
  // a 32px half is exactly name(8) + size-2 score(16) + line(8): rows yTop..+7, +8..+23, +24..+31
  dma->setTextSize(2); dma->setTextColor(pc);
  dma->setCursor(1, yTop + 8); dma->print(p.score);
  dma->setTextSize(1); dma->setCursor(1, yTop + 24);
  String co = (a && showCk) ? checkoutStr(p) : "";
  if (a && showThrows && turnThrowCount > 0) {                 // priority 1: this turn's darts
    dma->setTextColor(C_YELLOW);
    for (int k = 0; k < turnThrowCount; k++) { if (k) dma->print(" "); dma->print(turnThrows[k]); }
  } else if (co.length()) {                                    // priority 2: checkout route
    dma->setTextColor(C_GREEN); dma->setCursor(0, yTop + 24); dma->print(co);   // x=0: fits 3-dart routes
  } else {                                                     // priority 3: legs / average
    dma->setTextColor(C_CYAN);
    if (showLegs) dma->printf("L%d ", p.legs);
    if (showAvg) dma->printf("%.1f", p.avg);
  }
  if (a) dma->fillRect(60, yTop, 3, 8, C_GREEN);
}
// ---- config-driven field layout (the drag-drop editor writes layout.fields) ----
String fieldValue(const String &t, int p, JsonObject f) {
  if (t == "label") return (const char *)(f["v"] | "");
  if (p < 0 || p >= numPlayers) return "";
  Player &pl = players[p];
  bool act = (p == activePlayer);
  if (t == "name")     return pl.name;
  if (t == "score")    return String(pl.score);
  if (t == "avg")      return String(pl.avg, 1);
  if (t == "legs")     return String(pl.legs);
  if (t == "180s")     return String(pl.c180);
  if (t == "high")     return String(pl.high);
  if (t == "checkout") return checkoutStr(pl);
  if (!act) return "";                                   // turn fields: active player only
  if (t == "darts")    return String(turnThrowCount);
  if (t == "last")     return turnThrowCount ? String(turnThrows[turnThrowCount - 1]) : "";
  if (t == "turn")   { String s; for (int k = 0; k < turnThrowCount; k++) { if (k) s += " "; s += turnThrows[k]; } return s; }
  if (t == "total")  { int s = 0; for (int k = 0; k < turnThrowCount; k++) s += turnThrows[k]; return String(s); }
  return "";
}
uint16_t markColor(const char *fx) {                  // active-marker colour for the current instant
  uint32_t now = millis();
  if (!strcmp(fx, "blink")) return ((now / 400) % 2) ? 0 : C_GREEN;                 // on/off blink (~1.25 Hz)
  if (!strcmp(fx, "pulse")) { uint8_t b = beatsin8(45, 45, 255); return dma->color565(0, b, 0); }   // brightness pulse
  return C_GREEN;                                     // "on" = solid
}
void drawFields(JsonArray fields) {
  dma->clearScreen(); dma->setTextWrap(false);
  for (JsonObject f : fields) {
    String t = (const char *)(f["t"] | "");
    int p = f["p"] | 0, x = f["x"] | 0, y = f["y"] | 0, size = f["s"] | 1;
    bool act = (p == activePlayer && p >= 0 && p < numPlayers);
    if (t == "amark") { if (act) { uint16_t g = markColor(f["fx"] | "on"); if (g) dma->fillRect(x, y, 3, 8, g); } continue; }   // active-player marker (fx: on/blink/pulse)
    if (t == "hline") { dma->drawFastHLine(x, y, panelW - x, C_DIM); continue; }    // horizontal divider
    if (t == "vline") { dma->drawFastVLine(x, y, PANEL_H - y, C_DIM); continue; }    // vertical divider (e.g. split 128x64)
    String v = fieldValue(t, p, f);
    if (!v.length()) continue;
    uint16_t col;
    JsonArray c = f["c"].as<JsonArray>();
    if (!c.isNull() && c.size() == 3) col = dma->color565((int)(c[0] | 255), (int)(c[1] | 255), (int)(c[2] | 255));
    else if (t == "score") {                             // score, no explicit colour → per-player colour (classic look)
      JsonArray pcs = cfg["layout"]["playerColors"].as<JsonArray>();
      if (!pcs.isNull() && p >= 0 && p < (int)pcs.size() && !pcs[p].isNull())
        col = dma->color565((int)(pcs[p][0] | 255), (int)(pcs[p][1] | 255), (int)(pcs[p][2] | 255));
      else col = act ? C_YELLOW : C_WHITE;
    }
    else col = act ? C_YELLOW : C_WHITE;                 // no explicit colour → highlight active player
    const char *a = f["a"] | "l";
    int cw = (size <= 0) ? 4 : 6 * size;               // char cell width; size 0 = tiny TomThumb font (~4x6)
    int w = (int)v.length() * cw;
    if (a[0] == 'r') x -= w; else if (a[0] == 'c') x -= w / 2;
    dma->setTextColor(col);
    if (size <= 0) { dma->setFont(&TomThumb); dma->setCursor(x, y + 5); dma->print(v); dma->setFont(nullptr); }  // baseline font: y+5 puts glyph top ~y
    else { dma->setTextSize(size); dma->setCursor(x, y); dma->print(v); }
  }
}
void drawScoreboard() {
  idle = false;
  JsonArray fields = cfg["layout"]["fields"].as<JsonArray>();
  if (!fields.isNull() && fields.size() > 0) { drawFields(fields); return; }   // custom layout
  dma->clearScreen();
  int n = max(1, min(numPlayers, 4)), rowH = PANEL_H / n;
  // rows start at i*rowH; divider sits on the LAST row of the half above (GFX leaves it blank)
  for (int i = 0; i < n; i++) { drawPlayer(i, i * rowH, rowH); if (i) dma->drawFastHLine(0, i * rowH - 1, panelW, C_DIM); }
}
void animateMarkers(uint32_t now) {                   // repaint only the blink/pulse active markers (no full redraw = no flicker)
  JsonArray fields = cfg["layout"]["fields"].as<JsonArray>();
  if (fields.isNull()) return;
  for (JsonObject f : fields) {
    if (strcmp(f["t"] | "", "amark")) continue;
    const char *fx = f["fx"] | "on";
    if (!strcmp(fx, "on")) continue;                  // static marker — nothing to animate
    int p = f["p"] | 0;
    if (p != activePlayer || p < 0 || p >= numPlayers) continue;
    dma->fillRect((int)(f["x"] | 0), (int)(f["y"] | 0), 3, 8, markColor(fx));
  }
}
void drawIdle() {
  static uint32_t last = 0; if (millis() - last < 1000) return; last = millis();
  dma->clearScreen(); struct tm t;
  if (getLocalTime(&t, 5)) {
    char buf[6]; strftime(buf, sizeof(buf), "%H:%M", &t);
    dma->setTextSize(2); dma->setTextColor(C_CYAN); dma->setCursor(8, 18); dma->print(buf);
  } else { dma->setTextSize(1); dma->setTextColor(C_DIM); dma->setCursor(3, 22); dma->print("AUTODARTS"); }
  // session stats under the clock
  dma->setTextSize(1); dma->setTextColor(C_DIM);
  dma->setCursor(2, 44); dma->printf("180s %d-%d", players[0].c180, players[1].c180);
  dma->setCursor(2, 54); dma->printf("HI %d", max(players[0].high, players[1].high));
}

// ===================== EFFECTS (palettes · 1D strips · 2D panel) =====================
CRGBPalette16 paletteByName(const String &n) {
  if (n == "fire" || n == "heat") return HeatColors_p;
  if (n == "lava") return LavaColors_p;
  if (n == "ocean") return OceanColors_p;
  if (n == "forest") return ForestColors_p;
  if (n == "party") return PartyColors_p;
  if (n == "cloud") return CloudColors_p;
  return RainbowColors_p;
}

// ---- 1D strip effects (per-strip config) ----
void parseFx(JsonVariantConst o, StripFx &f) {
  f.effect = (const char *)(o["effect"] | "off");
  f.speed = o["speed"] | 4;
  f.color = CRGB(o["color"][0] | 255, o["color"][1] | 255, o["color"][2] | 255);
  f.pal = paletteByName((const char *)(o["palette"] | "rainbow"));
}
void applyEffect(CRGB *arr, int n, uint32_t now, uint8_t hue, StripFx &f) {
  if (f.effect == "solid") fill_solid(arr, n, f.color);
  else if (f.effect == "flash") fill_solid(arr, n, ((now / 120) % 2) ? f.color : CRGB::Black);
  else if (f.effect == "strobe") fill_solid(arr, n, ((now / 60) % 2) ? CRGB::White : CRGB::Black);
  else if (f.effect == "pulse") { CRGB v = f.color; v.nscale8(beatsin8(30)); fill_solid(arr, n, v); }
  else if (f.effect == "rainbow") fill_rainbow(arr, n, hue, 4);
  else if (f.effect == "palette") for (int i = 0; i < n; i++) arr[i] = ColorFromPalette(f.pal, hue + i * (255 / max(1, n)));
  else if (f.effect == "running") for (int i = 0; i < n; i++) arr[i] = ColorFromPalette(f.pal, hue + sin8(i * 16 + now / 8));
  else if (f.effect == "sparkle") { fadeToBlackBy(arr, n, 40); arr[random16(n)] = f.color; }
  else if (f.effect == "twinkle") { fadeToBlackBy(arr, n, 20); if (random8() < 90) arr[random16(n)] = ColorFromPalette(f.pal, random8()); }
  else if (f.effect == "comet") { fadeToBlackBy(arr, n, 64); arr[(now / 30) % n] = f.color; }
  else fill_solid(arr, n, CRGB::Black);
}
void runEffect(uint32_t now) {
  static uint32_t last = 0; static uint8_t hue[2] = {0, 0};
  if (now - last < 20) return; last = now;
  hue[0] += sfx[0].speed;
  applyEffect(strip1, s1n, now, hue[0], sfx[0]);
  if (mirror2) { for (int i = 0; i < s2n; i++) strip2[i] = strip1[i % s1n]; }   // slave/replicate
  else { hue[1] += sfx[1].speed; applyEffect(strip2, s2n, now, hue[1], sfx[1]); }
  FastLED.show();
}
void stopEffect() { fill_solid(strip1, s1n, CRGB::Black); fill_solid(strip2, s2n, CRGB::Black); FastLED.show(); }

// FastLED pins are template parameters, so runtime pin choice = a switch over the
// clean spare GPIOs on this board (avoids reserved 26-37 and strapping/USB pins).
template <uint8_t PIN> void addStripT(CRGB *buf, int n) { FastLED.addLeds<WS2812B, PIN, GRB>(buf, n); }
void addStripPin(int pin, CRGB *buf, int n) {
  switch (pin) {
    case 1: addStripT<1>(buf, n); break;   case 2: addStripT<2>(buf, n); break;
    case 17: addStripT<17>(buf, n); break; case 21: addStripT<21>(buf, n); break;
    case 38: addStripT<38>(buf, n); break; case 39: addStripT<39>(buf, n); break;
    case 40: addStripT<40>(buf, n); break; case 41: addStripT<41>(buf, n); break;
    case 42: addStripT<42>(buf, n); break; case 47: addStripT<47>(buf, n); break;
    case 48: addStripT<48>(buf, n); break;
    default: LOG("invalid strip pin " + String(pin) + " — using IO17"); addStripT<17>(buf, n);
  }
}

// ---- 2D panel effects (rendered pixel-by-pixel on the 64x64) ----
// Returns true when it actually redrew (so overlays can repaint in the same pass).
bool runPanelFx(uint32_t now, const String &fx, const CRGBPalette16 &pal) {
  static uint32_t last = 0; if (now - last < 33) return false; last = now;   // ~30 fps
  static uint16_t z = 0; z += 22;
  if (fx == "plasma" || fx == "noise") {
    for (int y = 0; y < PANEL_H; y++) for (int x = 0; x < panelW; x++) {
      CRGB c = ColorFromPalette(pal, inoise8(x * 24, y * 24, z));
      dma->drawPixelRGB888(x, y, c.r, c.g, c.b);
    }
  } else if (fx == "fire") {
    for (int y = 0; y < PANEL_H; y++) for (int x = 0; x < panelW; x++) {
      uint8_t v = inoise8(x * 30, y * 35 - z * 3, z);
      uint8_t heat = qsub8(v, (uint8_t)((PANEL_H - 1 - y) * 3));      // hotter at the bottom
      CRGB c = ColorFromPalette(HeatColors_p, heat);
      dma->drawPixelRGB888(x, y, c.r, c.g, c.b);
    }
  } else if (fx == "matrix") {                                        // falling green code
    static int head[PW_MAX]; static bool init = false;
    if (!init) { for (int x = 0; x < panelW; x++) head[x] = random16(PANEL_H); init = true; }
    dma->clearScreen();
    for (int x = 0; x < panelW; x++) {
      head[x] = (head[x] + 1) % PANEL_H;
      for (int t = 0; t < 10; t++) { int y = (head[x] - t + PANEL_H) % PANEL_H; uint8_t b = 255 - t * 26; dma->drawPixelRGB888(x, y, 0, b, 0); }
    }
  } else if (fx == "sparkle") {
    dma->clearScreen();
    for (int i = 0; i < 45; i++) { CRGB c = ColorFromPalette(pal, random8()); dma->drawPixelRGB888(random16(panelW), random16(PANEL_H), c.r, c.g, c.b); }
  } else return false;
  return true;
}

// ===================== EVENTS (with queue) =====================
void playEvent(const String &name, int value, const String &ovText) {
  JsonObject o = cfg["events"][name];
  if (o.isNull()) return;
  eventText = ovText.length() ? ovText : (const char *)(o["text"] | name.c_str());  // dynamic text overrides config
  // strips: flat fields = strip 1; optional "fx1" object overrides; "fx2" is
  // "mirror" (default — replicate strip 1), "off", or its own {effect,palette,color,speed}
  parseFx(o, sfx[0]);
  if (!o["fx1"].isNull()) parseFx(o["fx1"], sfx[0]);
  JsonVariant f2 = o["fx2"];
  if (f2.isNull()) { sfx[1] = sfx[0]; mirror2 = true; }
  else if (f2.is<const char *>()) {
    mirror2 = (String((const char *)f2) == "mirror");
    if (!mirror2) sfx[1].effect = "off";
  } else { mirror2 = false; parseFx(f2, sfx[1]); }
  panelFx = (const char *)(o["panelFx"] | "");
  panelPal = paletteByName((const char *)(o["palette"] | "rainbow"));
  eventUntil = millis() + (uint32_t)(o["ms"] | DEF_EVENT_MS);
  setRegion(o["region"] | "full");               // which panel(s) the GIF plays on: full / left / right
  evSplit = (o["split"] | false) && evW < panelW;   // split-screen: keep the live scoreboard on the OTHER panel
  if (evSplit) panelFx = "";                      // no full-screen 2D backdrop when splitting
  marqueeX = evX0 + evW; lastMarquee = 0;
  if (evSplit) { drawScoreboard(); dma->fillRect(evX0, 0, evW, PANEL_H, 0); }   // scoreboard stays; clear only the event panel
  else dma->clearScreen();                        // full celebration: clear the whole board
  const char *g = o["gif"] | "";
  String gp;                                      // resolve gif: "cat:NAME" plays a RANDOM gif from that category
  if (!strncmp(g, "cat:", 4)) { JsonArray cat = cfg["layout"]["gifCategories"][g + 4].as<JsonArray>();
    if (!cat.isNull() && cat.size()) gp = (const char *)cat[random(cat.size())]; }
  else gp = g;
  if (gp.length() && openGif(gp.c_str())) panelFx = "";     // a GIF takes precedence over a 2D effect
}
void enqueueEvent(const String &name, int value, const String &ovText) {
  JsonObject o = cfg["events"][name];
  if (o.isNull()) { LOG("unmapped event: " + name); return; }
  if (!(o["enabled"] | true)) { LOG("disabled: " + name); return; }
  int mn = o["min"] | 0;                          // celebration threshold, e.g. treble min 15 = T15+
  if (mn && value && value < mn) { LOG(name + " " + value + " < min " + mn + ", skipped"); return; }
  if (!eventUntil) playEvent(name, value, ovText);
  else if (evCount < 6) { evQueue[evCount] = name; evVal[evCount] = value; evText[evCount] = ovText; evCount++; }
  else LOG("queue full, dropped: " + name);
}

// ===================== CONFIG =====================
void applyLive() {
  dma->setBrightness8(cfg["layout"]["brightness"] | DEF_PANEL_BRI);
  dma->setRotation(cfg["layout"]["rotation"] | 0);
  FastLED.setBrightness(cfg["layout"]["stripBrightness"] | DEF_STRIP_BRI);
  FastLED.setMaxPowerInVoltsAndMilliamps(5, cfg["layout"]["maxMilliamps"] | DEF_MAX_MA);
}
void saveConfig() { File f = LittleFS.open("/config.json", "w"); if (f) { serializeJson(cfg, f); f.close(); } }
void loadConfig() {
  if (LittleFS.exists("/config.json")) {
    File f = LittleFS.open("/config.json", "r");
    DeserializationError e = deserializeJson(cfg, f); f.close();
    if (!e) return;
  }
  cfg.clear();
  JsonObject L = cfg["layout"].to<JsonObject>();
  L["players"] = 2; L["showAvg"] = true; L["showLegs"] = true; L["showThrows"] = false;
  L["showCheckout"] = true; L["brightness"] = DEF_PANEL_BRI; L["stripBrightness"] = DEF_STRIP_BRI;
  L["rotation"] = 0; L["maxMilliamps"] = DEF_MAX_MA; L["idleMs"] = DEF_IDLE_MS; L["tzOffset"] = 0; L["panelChain"] = 1;
  L["idleFx"] = ""; L["idlePalette"] = "ocean";   // idleFx: ""|plasma|fire|matrix|sparkle
  L["strip1Pin"] = 17; L["strip2Pin"] = 21;       // strip data GPIOs (reboot to apply)
  L["strip1Count"] = 60; L["strip2Count"] = 60;   // LED counts (reboot to apply)
  // cloud remote (System -> Cloud): board dials out to the Cloudflare relay; reboot to (re)connect
  L["cloudEnabled"] = false; L["cloudHost"] = "darts-scoreboard-relay.ddmonkeytron.workers.dev";
  L["cloudId"] = ""; L["cloudToken"] = ""; L["cloudName"] = "";
  JsonObject ev = cfg["events"].to<JsonObject>();
  auto add = [&](const char *k, const char *g, const char *t, const char *fx, int r, int gg, int b) {
    JsonObject o = ev[k].to<JsonObject>(); o["gif"] = g; o["text"] = t; o["effect"] = fx;
    o["color"][0] = r; o["color"][1] = gg; o["color"][2] = b; o["ms"] = DEF_EVENT_MS;
  };
  add("180", "/gifs/laugh.gif", "180!", "flash", 255, 0, 0);
  add("140", "/gifs/fire.gif", "140", "comet", 255, 120, 0);
  add("100", "/gifs/fire.gif", "TON", "pulse", 255, 200, 0);
  add("26", "/gifs/laugh.gif", "26", "rainbow", 0, 0, 0);
  add("double", "/gifs/target.gif", "DOUBLE", "sparkle", 0, 200, 255);
  add("treble", "/gifs/target.gif", "TREBLE", "sparkle", 0, 255, 120);
  add("bust", "/gifs/cry.gif", "BUST", "strobe", 80, 80, 255);
  add("legWon", "/gifs/trophy.gif", "LEG WON", "sparkle", 255, 215, 0);
  add("gameWon", "/gifs/trophy.gif", "GAME SHOT!", "rainbow", 255, 215, 0);
  add("miss", "", "MISS", "strobe", 120, 120, 120);   // dart off the board
  add("highFinish", "", "HIGH CHECKOUT", "flash", 255, 180, 0); ev["highFinish"]["min"] = 100;   // checkout >= 100
  add("shanghai", "", "SHANGHAI!", "strobe", 255, 0, 255);      // S+D+T of one number in a visit
  add("legStart", "", "GAME ON", "rainbow", 0, 255, 120);       // new leg begins
  // showcase palettes + 2D panel effects (panelFx renders when no gif is set/found)
  ev["180"]["palette"] = "party";
  ev["140"]["palette"] = "lava";
  ev["gameWon"]["panelFx"] = "plasma"; ev["gameWon"]["palette"] = "party"; ev["gameWon"]["gif"] = "";
  ev["bust"]["effect"] = "twinkle"; ev["bust"]["palette"] = "ocean";
  // celebration thresholds: only celebrate D10+ / T15+ by default (set 0 = every one)
  ev["double"]["min"] = 10;
  ev["treble"]["min"] = 15;
  // per-strip showcase: on gameWon, strip 1 rainbows while strip 2 runs a gold comet
  ev["gameWon"]["fx2"]["effect"] = "comet"; ev["gameWon"]["fx2"]["color"][0] = 255;
  ev["gameWon"]["fx2"]["color"][1] = 215; ev["gameWon"]["fx2"]["color"][2] = 0;
  saveConfig();
}

// ===================== HTTP HANDLERS =====================
void handleScore() {
  if (!server.hasArg("plain")) { server.send(400, "text/plain", "no body"); return; }
  JsonDocument d;
  if (deserializeJson(d, server.arg("plain"))) { server.send(400, "text/plain", "bad json"); return; }
  activePlayer = d["activePlayer"] | activePlayer;
  JsonArray a = d["players"].as<JsonArray>();
  if (!a.isNull()) {
    numPlayers = min((int)a.size(), 4);
    for (int i = 0; i < numPlayers; i++) {
      players[i].name = (const char *)(a[i]["name"] | players[i].name.c_str());
      players[i].score = a[i]["score"] | players[i].score;
      players[i].legs = a[i]["legs"] | players[i].legs;
      players[i].avg = a[i]["avg"] | players[i].avg;
      players[i].co = (const char *)(a[i]["co"] | "");   // autodarts' suggestion; absent/"" → firmware computes its own
    }
  }
  JsonArray th = d["throws"].as<JsonArray>(); turnThrowCount = 0;
  if (!th.isNull()) for (size_t i = 0; i < th.size() && i < 3; i++) { turnThrows[i] = th[i] | 0; turnThrowCount++; }
  // stats: highest turn + 180 count (once per completed 3-dart turn)
  if (turnThrowCount == 3 && activePlayer >= 0 && activePlayer < 4) {
    String sig = String(activePlayer) + ":" + turnThrows[0] + "," + turnThrows[1] + "," + turnThrows[2];
    if (sig != lastTurnSig) {
      lastTurnSig = sig;
      int sum = turnThrows[0] + turnThrows[1] + turnThrows[2];
      if (sum > players[activePlayer].high) players[activePlayer].high = sum;
      if (sum == 180) players[activePlayer].c180++;
    }
  }
  lastActivity = millis();
  if (!eventUntil && !identifyUntil) drawScoreboard();
  server.send(200, "application/json", "{\"ok\":true}");
}
void handleEvent() {
  if (!server.hasArg("plain")) { server.send(400, "text/plain", "no body"); return; }
  JsonDocument d;
  if (deserializeJson(d, server.arg("plain"))) { server.send(400, "text/plain", "bad json"); return; }
  lastActivity = millis();
  String name = (const char *)(d["event"] | "");
  int value = d["value"] | 0;                     // dart number / turn total (for min thresholds)
  String ovText = (const char *)(d["text"] | "");  // optional dynamic text, e.g. "DAVETHEW WINS THE LEG 2-1"
  LOG("event: " + name + (value ? " (" + String(value) + ")" : ""));
  enqueueEvent(name, value, ovText);
  server.send(200, "application/json", "{\"ok\":true}");
}
void handleConfigGet() { File f = LittleFS.open("/config.json", "r"); if (!f) { server.send(200, "application/json", "{}"); return; } server.streamFile(f, "application/json"); f.close(); }
void handleConfigPost() {
  if (!server.hasArg("plain")) { server.send(400, "text/plain", "no body"); return; }
  JsonDocument d;
  if (deserializeJson(d, server.arg("plain"))) { server.send(400, "text/plain", "bad json"); return; }
  cfg = d; saveConfig(); applyLive();            // (panelDriver / strip pins+counts need a reboot)
  if (!eventUntil && !identifyUntil) drawScoreboard();
  server.send(200, "application/json", "{\"ok\":true}");
}
void handleSprites() {
  String out = "["; File dir = LittleFS.open("/gifs");
  if (dir) for (File f = dir.openNextFile(); f; f = dir.openNextFile()) { if (out.length() > 1) out += ","; out += "\"" + String(f.name()) + "\""; }
  server.send(200, "application/json", out + "]");
}
void handleSpriteUpload() {
  HTTPUpload &up = server.upload();
  if (up.status == UPLOAD_FILE_START) { if (!LittleFS.exists("/gifs")) LittleFS.mkdir("/gifs"); uploadFile = LittleFS.open("/gifs/" + up.filename, "w"); }
  else if (up.status == UPLOAD_FILE_WRITE) { if (uploadFile) uploadFile.write(up.buf, up.currentSize); }
  else if (up.status == UPLOAD_FILE_END) { if (uploadFile) uploadFile.close(); }
}
void handleDelete() { if (server.hasArg("name")) LittleFS.remove("/gifs/" + server.arg("name")); server.send(200, "application/json", "{\"ok\":true}"); }
void handleStatus() {
  JsonDocument s; s["heap"] = ESP.getFreeHeap(); s["rssi"] = WiFi.RSSI();
  s["ip"] = WiFi.localIP().toString(); s["gif"] = gifPath; s["uptime"] = millis() / 1000; s["queue"] = evCount;
  for (int i = 0; i < numPlayers; i++) { s["c180"][i] = players[i].c180; s["high"][i] = players[i].high; }
  s["cloud"]["enabled"] = (bool)(cfg["layout"]["cloudEnabled"] | false); s["cloud"]["up"] = cloudUp;
  String o; serializeJson(s, o); server.send(200, "application/json", o);
}
void handleOTAUpload() {
  HTTPUpload &up = server.upload();
  if (up.status == UPLOAD_FILE_START) Update.begin(UPDATE_SIZE_UNKNOWN);
  else if (up.status == UPLOAD_FILE_WRITE) Update.write(up.buf, up.currentSize);
  else if (up.status == UPLOAD_FILE_END) Update.end(true);
}
void handleText() {                              // scroll arbitrary text on demand
  if (!server.hasArg("plain")) { server.send(400, "text/plain", "no body"); return; }
  JsonDocument d;
  if (deserializeJson(d, server.arg("plain"))) { server.send(400, "text/plain", "bad json"); return; }
  eventText = (const char *)(d["text"] | "");
  parseFx(d.as<JsonVariantConst>(), sfx[0]); sfx[1] = sfx[0]; mirror2 = true;
  panelFx = (const char *)(d["panelFx"] | "");   // default "" — don't inherit a stale 2D backdrop
  panelPal = paletteByName((const char *)(d["palette"] | "rainbow"));
  eventUntil = millis() + (uint32_t)(d["ms"] | 5000);
  marqueeX = panelW; lastMarquee = 0;
  setRegion(d["region"] | "full");
  const char *g = d["gif"] | "";
  if (strlen(g)) { if (openGif(g)) panelFx = ""; }   // play the requested GIF; text (if any) scrolls off the bottom
  else if (gifPlaying) { gif.close(); gifPlaying = false; }
  dma->clearScreen(); lastActivity = millis();
  LOG("text: " + eventText);
  server.send(200, "application/json", "{\"ok\":true}");
}
void handleLog() {
  String o; for (int i = 0; i < LOGN; i++) { String &l = logBuf[(logHead + i) % LOGN]; if (l.length()) o += l + "\n"; }
  server.send(200, "text/plain", o);
}
void handleReset() { for (int i = 0; i < 4; i++) { players[i].c180 = 0; players[i].high = 0; } LOG("stats reset"); server.send(200, "application/json", "{\"ok\":true}"); }
void handleIdentify() {                          // light each output so you can see which is which
  identifyUntil = millis() + 8000;
  eventUntil = 0; evCount = 0;
  if (gifPlaying) { gif.close(); gifPlaying = false; }
  fill_solid(strip1, s1n, CRGB::Red);
  fill_solid(strip2, s2n, CRGB::Blue);
  FastLED.show();
  dma->clearScreen(); dma->setTextSize(1);
  dma->setTextColor(C_WHITE);  dma->setCursor(8, 4);  dma->print("IDENTIFY");
  dma->setTextColor(C_RED);    dma->setCursor(2, 20); dma->printf("S1 RED %d", (int)(cfg["layout"]["strip1Pin"] | 17));
  dma->setTextColor(dma->color565(90, 90, 255)); dma->setCursor(2, 32); dma->printf("S2 BLU %d", (int)(cfg["layout"]["strip2Pin"] | 21));
  dma->setTextColor(C_GREEN);  dma->setCursor(2, 48); dma->print("PANEL OK");
  LOG("identify: strip1=RED strip2=BLUE");
  server.send(200, "application/json", "{\"ok\":true}");
}
void handleWifiReset() { server.send(200, "text/plain", "wifi reset, rebooting"); WiFiManager wm; wm.resetSettings(); delay(400); ESP.restart(); }

static const char PAGE[] PROGMEM = R"HTML(
<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Darts Scoreboard</title>
<style>*{box-sizing:border-box}
body{font-family:sans-serif;background:#111;color:#eee;margin:0}
.app{display:flex;min-height:100vh}
.side{width:164px;flex:none;background:#181818;border-right:1px solid #2c2c2c;padding:.6em .5em;position:sticky;top:0;align-self:flex-start;height:100vh}
.brand{font-weight:bold;color:#fc6;font-size:1.05em;margin:.2em .3em 1em}
.nav{display:block;width:100%;text-align:left;margin:.12em 0;padding:.55em .7em;background:transparent;border:0;color:#bbb;border-radius:6px;cursor:pointer;font-size:.95em}
.nav:hover{background:#242424;color:#fff}.nav.sel{background:#1c3a24;color:#8f8}
.main{flex:1;min-width:0;padding:1em 1.2em;max-width:900px}
.panel{display:none}.panel.on{display:block}
.bar{position:sticky;top:0;background:#111;padding:.5em 0;z-index:5;margin-bottom:.4em;border-bottom:1px solid #222}
h2{margin:.1em 0 .5em}h3{margin-top:1.1em;color:#8cf}
.hint{color:#888;font-size:.9em;margin:.2em 0 .6em}
textarea{width:100%;height:240px;background:#1c1c1c;color:#6f6;font-family:monospace;border:1px solid #333;border-radius:6px}
button{margin:.15em;padding:.42em .7em;background:#2a2a2a;color:#eee;border:1px solid #444;border-radius:5px;cursor:pointer}
button:hover{background:#333}.primary{background:#164;font-weight:bold}
input,select{color:#eee;background:#1c1c1c;border:1px solid #444;padding:.3em;margin:.1em;border-radius:4px}
input[type=color]{padding:0;width:34px;height:24px;vertical-align:middle}
label{margin-right:.6em;white-space:nowrap;display:inline-block}
fieldset{border:1px solid #333;border-radius:8px;margin:.5em 0;padding:.6em}
legend{color:#fc6;padding:0 .4em}
.gif{display:inline-flex;align-items:center;gap:.3em;margin:.2em;padding:.3em .5em;background:#222;border-radius:6px}
img{image-rendering:pixelated}pre{background:#1c1c1c;padding:.6em;white-space:pre-wrap;border-radius:6px}
@media(max-width:640px){.app{flex-direction:column}.side{width:auto;height:auto;position:static;display:flex;flex-wrap:wrap;gap:.2em}.brand{width:100%}.nav{width:auto}}</style>
<div class=app>
<nav class=side>
<div class=brand>🎯 Scoreboard</div>
<button class=nav data-p=layout onclick="nav('layout')">Layout</button>
<button class=nav data-p=events onclick="nav('events')">Celebrations</button>
<button class=nav data-p=gifs onclick="nav('gifs')">GIFs</button>
<button class=nav data-p=test onclick="nav('test')">Test</button>
<button class=nav data-p=system onclick="nav('system')">System</button>
<button class=nav data-p=adv onclick="nav('adv')">Advanced</button>
</nav>
<main class=main>
<div class=bar><button onclick=save() class=primary>💾 Save &amp; apply</button>
<button onclick=load()>Reload</button><button onclick=dl()>Download backup</button></div>

<section id=p-layout class="panel on">
<h2>Layout</h2>
<h3>Panel options</h3><div id=lo></div>
<h3>Layout editor</h3><div class=hint>Drag fields on the 64&times;64, click to select. Empty = classic layout.</div>
<div>Add for player <select id=lp><option>0</option><option>1</option><option>2</option><option>3</option></select> <span id=addbtns></span></div>
<div id=led style="position:relative;width:320px;height:320px;background:#000;border:1px solid #555;margin:.4em 0;overflow:hidden"></div>
<div id=fprops style="min-height:2em;margin:.3em 0">(no field selected)</div>
<button onclick=savelay() class=primary>💾 Save &amp; apply</button>
<button onclick=deffields()>Load classic layout</button> <button onclick=clearfields()>Clear (blank &rarr; classic)</button>
<div style="margin-top:.5em">Presets: <select id=preset></select> <button onclick=loadpreset()>Load into editor</button>
 &nbsp;<input id=pname placeholder="new preset name" style=width:130px><button onclick=savepreset()>Save as preset</button> <button onclick=delpreset()>Delete</button></div>
</section>

<section id=p-events class=panel>
<h2>Celebrations</h2>
<div class=hint>min = only celebrate when the dart/turn value &ge; min (0 = always). Strip 2: mirror = replicate strip 1.</div>
<div id=evl></div>
<input id=ne placeholder="new event name"><button onclick=addev()>+ add event</button>
</section>

<section id=p-gifs class=panel>
<h2>GIFs</h2>
<h3>Uploaded GIFs</h3>
<div id=s></div>
<div style="margin-top:.6em"><input type=file id=f accept=.gif><button onclick=up()>Upload GIF</button></div>
<div class=hint>A <b>128&times;64</b> GIF fills both panels; a 64&times;64 fills one (centred). Resize at ezgif.com.</div>
<h3>Categories</h3>
<div class=hint>Group GIFs into named categories. An event set to a category plays a <b>random</b> GIF from it. Deleting a category keeps the GIFs.</div>
<div id=catlist></div>
<div style="margin-top:.5em"><input id=cname placeholder="new category name"><button onclick=addcat()>Add category</button></div>
</section>

<section id=p-test class=panel>
<h2>Test &mdash; send to board</h2>
<label>gif <select id=tgif></select></label>
<input id=tx placeholder="message under gif (optional)"><label>ms <input id=tms type=number value=6000 style="width:64px"></label>
<label>panel <select id=treg><option>full</option><option>left</option><option>right</option></select></label>
<button onclick=sendgif()>Send GIF</button> <button onclick=say()>Send text only</button>
<div style="margin-top:.6em"><button onclick=idf()>🔦 Identify outputs</button> <button onclick=rst()>Reset stats</button></div>
</section>

<section id=p-system class=panel>
<h2>System</h2>
<h3>Panels</h3><div id=panels></div>
<h3>Cloud remote</h3><div id=cloud></div>
<h3>Firmware update (OTA)</h3><input type=file id=fw accept=.bin><button onclick=ota()>OTA update</button>
<h3>Device</h3><button onclick=rb()>Reboot</button><button onclick=wr()>Reset WiFi</button>
<h3>Status</h3><pre id=st></pre>
<h3>Log</h3><pre id=lg style="height:180px;overflow:auto"></pre>
</section>

<section id=p-adv class=panel>
<h2>Advanced</h2>
<div class=hint>Raw config JSON &mdash; edit then apply to the form, or Save &amp; apply from the top bar.</div>
<textarea id=c></textarea><br><button onclick=applyRaw()>Apply raw JSON to form</button>
</section>
</main>
</div>
<script>
let C=null,gifs=[];
const FX=['off','solid','flash','strobe','pulse','rainbow','palette','running','sparkle','twinkle','comet'];
const PAL=['rainbow','party','ocean','forest','lava','fire','cloud'];
const PFX=['','plasma','fire','matrix','sparkle'];
const DRV=['SHIFTREG','FM6126A','FM6124'];
const t=(p,o)=>fetch(p,o).then(r=>r.text());
const norm=n=>n.startsWith('/')?n:'/gifs/'+n;
const hx=a=>'#'+((Array.isArray(a)&&a.length?a:[255,255,255]).map(x=>(+x||0).toString(16).padStart(2,'0')).join(''));
const rgb=h=>[parseInt(h.substr(1,2),16),parseInt(h.substr(3,2),16),parseInt(h.substr(5,2),16)];
const esc=x=>String(x).replace(/"/g,'&quot;');
const opt=(a,v)=>a.map(o=>`<option value="${o}" ${o==v?'selected':''}>${o===''?'(none)':o}</option>`).join('');
const gifopt=v=>{const cs=Object.keys((C&&C.layout&&C.layout.gifCategories)||{}).map(n=>'cat:'+n);
 return ['',...gifs.map(norm),...cs].map(o=>`<option value="${o}" ${o==v?'selected':''}>${o?(o.slice(0,4)=='cat:'?'🎲 '+o.slice(4)+' (random)':o.split('/').pop()):'(none)'}</option>`).join('')};
function lset(k,v){C.layout[k]=v}
function pcol(i,h){if(!C.layout.playerColors)C.layout.playerColors=[];C.layout.playerColors[i]=rgb(h)}
function renderLayout(){const L=C.layout||(C.layout={});
 const chk=k=>`<label><input type=checkbox ${L[k]?'checked':''} onchange="lset('${k}',this.checked)"> ${k}</label>`;
 const num=k=>`<label>${k} <input type=number style="width:72px" value="${L[k]??''}" onchange="lset('${k}',+this.value)"></label>`;
 const sl=(k,a)=>`<label>${k} <select onchange="lset('${k}',this.value)">${opt(a,L[k]??a[0])}</select></label>`;
 const p=L.playerColors||[];
 lo.innerHTML=[num('players'),chk('showAvg'),chk('showLegs'),chk('showThrows'),chk('showCheckout'),num('brightness'),
  num('stripBrightness'),num('maxMilliamps'),num('rotation'),num('idleMs'),sl('idleFx',PFX),sl('idlePalette',PAL),
  num('tzOffset'),sl('panelDriver',DRV)].join(' ')
  +'<br>Player score colours: '+[0,1,2,3].map(i=>`P${i+1} <input type=color value="${hx(p[i])}" onchange="pcol(${i},this.value)">`).join(' ')
  +'<br><b>Outputs</b> (data GPIOs + LED counts — save then reboot to apply): '
  +[num('strip1Pin'),num('strip1Count'),num('strip2Pin'),num('strip2Count')].join(' ')
  +' <button onclick=idf()>🔦 Identify outputs</button>';
}
function renderPanels(){const L=C.layout||(C.layout={});
 panels.innerHTML=`Display: <select onchange="lset('panelChain',+this.value)"><option value=1 ${(L.panelChain||1)==1?'selected':''}>Single 64&times;64 (1 panel)</option><option value=2 ${(L.panelChain||1)==2?'selected':''}>Wide 128&times;64 (2 panels)</option></select> <span class=hint>reboot to apply &middot; each celebration can target the left or right panel (event &rarr; panel)</span>`;
}
function renderCloud(){const L=C.layout||(C.layout={});
 const cx=`<label><input type=checkbox ${L.cloudEnabled?'checked':''} onchange="lset('cloudEnabled',this.checked)"> <b>Enable cloud remote</b></label>`;
 const tx=(k,lbl,ph,w)=>`<label>${lbl} <input style="width:${w||220}px" value="${esc(L[k]??'')}" placeholder="${ph}" onchange="lset('${k}',this.value)"></label>`;
 cloud.innerHTML=cx+'<br>'+tx('cloudName','Name','friendly name shown in the dashboard',200)
  +'<br>'+tx('cloudHost','Relay','your-relay.workers.dev',300)
  +'<br>'+tx('cloudId','Board id','e.g. home',120)+' '+tx('cloudToken','Token','board token',260)
  +'<div class=hint>The board dials out to your relay so you can manage it from anywhere. Save, then <b>reboot</b> to (re)connect. Connection state shows in Status below (<code>cloud.up</code>).</div>';
}
function eset(k,f,v){C.events[k][f]=v}
function f2mode(k){const f=C.events[k].fx2;return f==null?'mirror':(typeof f=='string'?(f=='mirror'?'mirror':'off'):'custom')}
function setmode(k,m){if(m=='mirror')delete C.events[k].fx2;else if(m=='off')C.events[k].fx2='off';
 else C.events[k].fx2={effect:'sparkle',palette:'rainbow',color:[255,255,255]};renderEvents()}
function f2set(k,f,v){let o=C.events[k].fx2;if(typeof o!='object'||!o)o=C.events[k].fx2={};o[f]=v}
function delev(k){if(confirm('Delete event '+k+'?')){delete C.events[k];renderEvents()}}
function addev(){const n=ne.value.trim();if(!n)return;if(!C.events)C.events={};
 C.events[n]={enabled:true,text:n.toUpperCase(),effect:'flash',color:[255,255,255],ms:3000};ne.value='';renderEvents()}
function fire(k){fetch('/event',{method:'POST',body:JSON.stringify({event:k,value:999})})}
function renderEvents(){evl.innerHTML=Object.keys(C.events||{}).map(k=>{
 const o=C.events[k],m=f2mode(k),f2=(typeof o.fx2=='object'&&o.fx2)?o.fx2:{};
 return `<fieldset><legend><b>${k}</b> <button onclick="fire('${k}')">▶ test</button> <button onclick="delev('${k}')">✕</button></legend>
 <label><input type=checkbox ${o.enabled===false?'':'checked'} onchange="eset('${k}','enabled',this.checked)"> on</label>
 <label>min <input type=number style="width:54px" value="${o.min||0}" onchange="eset('${k}','min',+this.value)"></label>
 <label>text <input style="width:120px" value="${esc(o.text||'')}" onchange="eset('${k}','text',this.value)"></label>
 <label>ms <input type=number style="width:66px" value="${o.ms||5000}" onchange="eset('${k}','ms',+this.value)"></label>
 <label>gif <select onchange="eset('${k}','gif',this.value)">${gifopt(o.gif||'')}</select></label>
 <label>2D <select onchange="eset('${k}','panelFx',this.value)">${opt(PFX,o.panelFx||'')}</select></label> <label>panel <select onchange="eset('${k}','region',this.value)">${opt(['full','left','right'],o.region||'full')}</select></label> <label title="keep the live scoreboard on the other panel"><input type=checkbox ${o.split?'checked':''} onchange="eset('${k}','split',this.checked)"> split</label><br>
 <b>Strip 1:</b> <select onchange="eset('${k}','effect',this.value)">${opt(FX,o.effect||'off')}</select>
 <select onchange="eset('${k}','palette',this.value)">${opt(PAL,o.palette||'rainbow')}</select>
 <input type=color value="${hx(o.color)}" onchange="eset('${k}','color',rgb(this.value))">
 &nbsp; <b>Strip 2:</b> <select onchange="setmode('${k}',this.value)">${opt(['mirror','custom','off'],m)}</select>
 ${m=='custom'?` <select onchange="f2set('${k}','effect',this.value)">${opt(FX,f2.effect||'off')}</select>
 <select onchange="f2set('${k}','palette',this.value)">${opt(PAL,f2.palette||'rainbow')}</select>
 <input type=color value="${hx(f2.color)}" onchange="f2set('${k}','color',rgb(this.value))">`:''}
 </fieldset>`}).join('');
}
// ---- layout editor ----
const SCALE=5, FT=['name','score','avg','legs','darts','last','turn','total','checkout','180s','high','label','amark','hline','vline'];
function EW(){return 64*((C.layout&&C.layout.panelChain)||1)}   // editor canvas width in panel px (64 or 128)
let selF=-1;
function lfields(){if(!C.layout)C.layout={};if(!C.layout.fields)C.layout.fields=[];return C.layout.fields}
function renderAddBtns(){addbtns.innerHTML=FT.map(t=>`<button onclick="addF('${t}')">+${t}</button>`).join(' ')}
function addF(t){lfields().push({t,p:+lp.value,x:1,y:1,s:1,a:'l'});selF=lfields().length-1;renderLED()}
function fprev(f){return {name:'NAME',score:'501',avg:'0.0',legs:'0',darts:'3',last:'20',turn:'20 20',total:'60',checkout:'D20','180s':'1',high:'140',label:(f.v||'TEXT'),amark:'▮',hline:'──────────',vline:'│'}[f.t]||f.t}
function renderLED(){led.style.width=(EW()*SCALE)+'px';led.innerHTML='';lfields().forEach((f,i)=>{const d=document.createElement('div');
 const sz=f.s??1, cw=(sz<=0?4:6*sz), ch=(sz<=0?6:8*sz), t=fprev(f);        // panel char cell = cw x ch pixels (matches firmware)
 const a=f.a||'l', w=t.length*cw, off=a=='r'?w:a=='c'?w/2:0;
 const bw=w*SCALE, bh=ch*SCALE, fs=ch*SCALE, ls=(cw*SCALE-fs*0.6);         // exact footprint; letter-spacing tunes char advance to cw
 d.style.cssText=`position:absolute;left:${(f.x-off)*SCALE}px;top:${f.y*SCALE}px;width:${bw}px;height:${bh}px;overflow:hidden;font:${fs}px/1 monospace;letter-spacing:${ls.toFixed(1)}px;color:#fff;white-space:nowrap;cursor:move;outline:${i==selF?'2px solid #fc6':'1px dotted #667'};background:rgba(120,160,255,.14)`;
 d.textContent=t;d.onmousedown=e=>dragF(e,i);led.appendChild(d)});renderProps()}
function dragF(e,i){e.preventDefault();selF=i;const f=lfields()[i],r=led.getBoundingClientRect();const ox=e.clientX-r.left-f.x*SCALE,oy=e.clientY-r.top-f.y*SCALE;
 const mv=ev=>{f.x=Math.max(0,Math.min(EW()-1,Math.round((ev.clientX-r.left-ox)/SCALE)));f.y=Math.max(0,Math.min(63,Math.round((ev.clientY-r.top-oy)/SCALE)));renderLED()};
 const up=()=>{removeEventListener('mousemove',mv);removeEventListener('mouseup',up)};addEventListener('mousemove',mv);addEventListener('mouseup',up);renderProps()}
function renderProps(){const F=lfields();if(selF<0||selF>=F.length){fprops.innerHTML='(no field selected)';return}const f=F[selF];
 fprops.innerHTML=`<b>#${selF}</b> type <select onchange="fS('t',this.value)">${opt(FT,f.t)}</select> player <select onchange="fS('p',+this.value)">${opt(['0','1','2','3'],''+f.p)}</select> size <select onchange="fS('s',+this.value)"><option value=0 ${(f.s??1)==0?'selected':''}>small</option><option value=1 ${(f.s??1)==1?'selected':''}>1</option><option value=2 ${(f.s??1)==2?'selected':''}>2</option></select> align <select onchange="fS('a',this.value)">${opt(['l','c','r'],f.a||'l')}</select> x<input type=number style=width:46px value="${f.x}" onchange="fS('x',+this.value)"> y<input type=number style=width:46px value="${f.y}" onchange="fS('y',+this.value)"> <input type=color value="${hx(f.c)}" onchange="fS('c',rgb(this.value))"> ${f.t=='label'?`text <input value="${esc(f.v||'')}" onchange="fS('v',this.value)">`:''} ${f.t=='amark'?`fx <select onchange="fS('fx',this.value)">${opt(['on','blink','pulse'],f.fx||'on')}</select>`:''} <button onclick=centerX()>&#9678; centre</button> <button onclick="delF(${selF})">✕ delete</button>`}
function fS(k,v){lfields()[selF][k]=v;renderLED()}
function delF(i){lfields().splice(i,1);selF=-1;renderLED()}
async function savelay(){await save();alert('Layout saved & applied')}
function clearfields(){C.layout.fields=[];selF=-1;renderLED()}
function DEFAULT_FIELDS(){return [
 {t:'name',p:0,x:1,y:0,s:1,a:'l'},{t:'amark',p:0,x:60,y:0},{t:'score',p:0,x:1,y:8,s:2,a:'l'},{t:'legs',p:0,x:1,y:24,s:1,a:'l',c:[40,200,230]},{t:'avg',p:0,x:14,y:24,s:1,a:'l',c:[40,200,230]},
 {t:'hline',x:0,y:31},
 {t:'name',p:1,x:1,y:32,s:1,a:'l'},{t:'amark',p:1,x:60,y:32},{t:'score',p:1,x:1,y:40,s:2,a:'l'},{t:'legs',p:1,x:1,y:56,s:1,a:'l',c:[40,200,230]},{t:'avg',p:1,x:14,y:56,s:1,a:'l',c:[40,200,230]}]}
const clone=o=>JSON.parse(JSON.stringify(o));
function deffields(){C.layout.fields=DEFAULT_FIELDS();selF=-1;renderLED()}
function presets(){if(!C.layout.presets)C.layout.presets={};return C.layout.presets}
const _CY=[40,200,230],_GR=[40,220,60],_GD=[255,215,0],_MG=[230,80,230],_OR=[255,140,0];
function BUILTINS(){return {
 '1 Player':[{t:'name',p:0,x:32,y:1,s:1,a:'c'},{t:'score',p:0,x:32,y:12,s:2,a:'c'},{t:'checkout',p:0,x:32,y:32,s:1,a:'c',c:_GR},{t:'avg',p:0,x:32,y:44,s:1,a:'c',c:_CY},{t:'turn',p:0,x:32,y:54,s:1,a:'c',c:_GD}],
 '2 Player (classic)':DEFAULT_FIELDS(),
 '3 Player':[
  {t:'name',p:0,x:1,y:0,s:1,a:'l'},{t:'score',p:0,x:63,y:0,s:1,a:'r'},{t:'legs',p:0,x:1,y:9,s:1,a:'l',c:_CY},{t:'avg',p:0,x:63,y:9,s:1,a:'r',c:_CY},{t:'hline',x:0,y:20},
  {t:'name',p:1,x:1,y:22,s:1,a:'l'},{t:'score',p:1,x:63,y:22,s:1,a:'r'},{t:'legs',p:1,x:1,y:31,s:1,a:'l',c:_CY},{t:'avg',p:1,x:63,y:31,s:1,a:'r',c:_CY},{t:'hline',x:0,y:42},
  {t:'name',p:2,x:1,y:44,s:1,a:'l'},{t:'score',p:2,x:63,y:44,s:1,a:'r'},{t:'legs',p:2,x:1,y:53,s:1,a:'l',c:_CY},{t:'avg',p:2,x:63,y:53,s:1,a:'r',c:_CY}],
 '4 Player':[
  {t:'name',p:0,x:1,y:1,s:1,a:'l'},{t:'legs',p:0,x:32,y:1,s:1,a:'c',c:_CY},{t:'score',p:0,x:63,y:1,s:1,a:'r'},{t:'hline',x:0,y:15},
  {t:'name',p:1,x:1,y:17,s:1,a:'l'},{t:'legs',p:1,x:32,y:17,s:1,a:'c',c:_CY},{t:'score',p:1,x:63,y:17,s:1,a:'r'},{t:'hline',x:0,y:31},
  {t:'name',p:2,x:1,y:33,s:1,a:'l'},{t:'legs',p:2,x:32,y:33,s:1,a:'c',c:_CY},{t:'score',p:2,x:63,y:33,s:1,a:'r'},{t:'hline',x:0,y:47},
  {t:'name',p:3,x:1,y:49,s:1,a:'l'},{t:'legs',p:3,x:32,y:49,s:1,a:'c',c:_CY},{t:'score',p:3,x:63,y:49,s:1,a:'r'}],
 'Big Scores (2P)':[
  {t:'score',p:0,x:32,y:3,s:2,a:'c'},{t:'name',p:0,x:32,y:22,s:1,a:'c'},{t:'hline',x:0,y:31},
  {t:'score',p:1,x:32,y:35,s:2,a:'c'},{t:'name',p:1,x:32,y:54,s:1,a:'c'}],
 'Stats (2P)':[
  {t:'name',p:0,x:1,y:0,s:1,a:'l'},{t:'amark',p:0,x:60,y:0},{t:'score',p:0,x:1,y:8,s:2,a:'l'},{t:'avg',p:0,x:1,y:24,s:1,a:'l',c:_CY},{t:'180s',p:0,x:40,y:24,s:1,a:'l',c:_MG},{t:'high',p:0,x:52,y:24,s:1,a:'l',c:_OR},{t:'hline',x:0,y:31},
  {t:'name',p:1,x:1,y:32,s:1,a:'l'},{t:'amark',p:1,x:60,y:32},{t:'score',p:1,x:1,y:40,s:2,a:'l'},{t:'avg',p:1,x:1,y:56,s:1,a:'l',c:_CY},{t:'180s',p:1,x:40,y:56,s:1,a:'l',c:_MG},{t:'high',p:1,x:52,y:56,s:1,a:'l',c:_OR}],
 'Checkout (2P)':[
  {t:'name',p:0,x:1,y:0,s:1,a:'l'},{t:'amark',p:0,x:60,y:0},{t:'score',p:0,x:1,y:8,s:2,a:'l'},{t:'checkout',p:0,x:63,y:12,s:1,a:'r',c:_GR},{t:'hline',x:0,y:31},
  {t:'name',p:1,x:1,y:32,s:1,a:'l'},{t:'amark',p:1,x:60,y:32},{t:'score',p:1,x:1,y:40,s:2,a:'l'},{t:'checkout',p:1,x:63,y:44,s:1,a:'r',c:_GR}],
 'Head-to-head (128)':[
  {t:'name',p:0,x:32,y:1,s:1,a:'c'},{t:'amark',p:0,x:2,y:1},{t:'score',p:0,x:32,y:12,s:2,a:'c'},{t:'legs',p:0,x:20,y:38,s:1,a:'c',c:_CY},{t:'avg',p:0,x:44,y:38,s:1,a:'c',c:_CY},{t:'checkout',p:0,x:32,y:50,s:1,a:'c',c:_GR},
  {t:'vline',x:63,y:0},
  {t:'name',p:1,x:96,y:1,s:1,a:'c'},{t:'amark',p:1,x:122,y:1},{t:'score',p:1,x:96,y:12,s:2,a:'c'},{t:'legs',p:1,x:84,y:38,s:1,a:'c',c:_CY},{t:'avg',p:1,x:108,y:38,s:1,a:'c',c:_CY},{t:'checkout',p:1,x:96,y:50,s:1,a:'c',c:_GR}],
 'Wide + stats (128)':[
  {t:'name',p:0,x:1,y:0,s:1,a:'l'},{t:'amark',p:0,x:60,y:0},{t:'score',p:0,x:1,y:8,s:2,a:'l'},{t:'checkout',p:0,x:1,y:24,s:1,a:'l',c:_GR},
  {t:'label',v:'AVG',x:66,y:0,s:1,a:'l',c:_CY},{t:'avg',p:0,x:127,y:0,s:1,a:'r',c:_CY},{t:'label',v:'LEG',x:66,y:8,s:1,a:'l',c:_CY},{t:'legs',p:0,x:127,y:8,s:1,a:'r',c:_CY},{t:'label',v:'180',x:66,y:16,s:1,a:'l',c:_MG},{t:'180s',p:0,x:127,y:16,s:1,a:'r',c:_MG},{t:'label',v:'HI',x:66,y:24,s:1,a:'l',c:_OR},{t:'high',p:0,x:127,y:24,s:1,a:'r',c:_OR},
  {t:'hline',x:0,y:31},
  {t:'name',p:1,x:1,y:32,s:1,a:'l'},{t:'amark',p:1,x:60,y:32},{t:'score',p:1,x:1,y:40,s:2,a:'l'},{t:'checkout',p:1,x:1,y:56,s:1,a:'l',c:_GR},
  {t:'label',v:'AVG',x:66,y:32,s:1,a:'l',c:_CY},{t:'avg',p:1,x:127,y:32,s:1,a:'r',c:_CY},{t:'label',v:'LEG',x:66,y:40,s:1,a:'l',c:_CY},{t:'legs',p:1,x:127,y:40,s:1,a:'r',c:_CY},{t:'label',v:'180',x:66,y:48,s:1,a:'l',c:_MG},{t:'180s',p:1,x:127,y:48,s:1,a:'r',c:_MG},{t:'label',v:'HI',x:66,y:56,s:1,a:'l',c:_OR},{t:'high',p:1,x:127,y:56,s:1,a:'r',c:_OR}],
 '1 per panel (2P)':[
  {t:'name',p:0,x:32,y:0,s:1,a:'c'},{t:'amark',p:0,x:2,y:0},{t:'score',p:0,x:32,y:8,s:2,a:'c'},{t:'avg',p:0,x:32,y:26,s:1,a:'c',c:_CY},{t:'legs',p:0,x:14,y:38,s:1,a:'c',c:_CY},{t:'180s',p:0,x:50,y:38,s:1,a:'c',c:_MG},{t:'checkout',p:0,x:32,y:50,s:1,a:'c',c:_GR},
  {t:'vline',x:63,y:0},
  {t:'name',p:1,x:96,y:0,s:1,a:'c'},{t:'amark',p:1,x:122,y:0},{t:'score',p:1,x:96,y:8,s:2,a:'c'},{t:'avg',p:1,x:96,y:26,s:1,a:'c',c:_CY},{t:'legs',p:1,x:78,y:38,s:1,a:'c',c:_CY},{t:'180s',p:1,x:114,y:38,s:1,a:'c',c:_MG},{t:'checkout',p:1,x:96,y:50,s:1,a:'c',c:_GR}],
 '4 player (2 per panel)':[
  {t:'name',p:0,x:1,y:0,s:1,a:'l'},{t:'score',p:0,x:1,y:8,s:2,a:'l'},{t:'avg',p:0,x:63,y:1,s:1,a:'r',c:_CY},{t:'legs',p:0,x:63,y:16,s:1,a:'r',c:_CY},
  {t:'name',p:2,x:1,y:32,s:1,a:'l'},{t:'score',p:2,x:1,y:40,s:2,a:'l'},{t:'avg',p:2,x:63,y:33,s:1,a:'r',c:_CY},{t:'legs',p:2,x:63,y:48,s:1,a:'r',c:_CY},
  {t:'name',p:1,x:65,y:0,s:1,a:'l'},{t:'score',p:1,x:65,y:8,s:2,a:'l'},{t:'avg',p:1,x:127,y:1,s:1,a:'r',c:_CY},{t:'legs',p:1,x:127,y:16,s:1,a:'r',c:_CY},
  {t:'name',p:3,x:65,y:32,s:1,a:'l'},{t:'score',p:3,x:65,y:40,s:2,a:'l'},{t:'avg',p:3,x:127,y:33,s:1,a:'r',c:_CY},{t:'legs',p:3,x:127,y:48,s:1,a:'r',c:_CY},
  {t:'vline',x:63,y:0},{t:'hline',x:0,y:31}],
 'Stats board (2P wide)':[
  {t:'name',p:0,x:1,y:0,s:1,a:'l'},{t:'amark',p:0,x:60,y:0},{t:'score',p:0,x:1,y:8,s:2,a:'l'},{t:'hline',x:0,y:31},
  {t:'name',p:1,x:1,y:32,s:1,a:'l'},{t:'amark',p:1,x:60,y:32},{t:'score',p:1,x:1,y:40,s:2,a:'l'},{t:'vline',x:63,y:0},
  {t:'label',v:'AVG',x:66,y:0,s:1,a:'l',c:_CY},{t:'avg',p:0,x:127,y:0,s:1,a:'r',c:_CY},{t:'label',v:'LEG',x:66,y:8,s:1,a:'l',c:_CY},{t:'legs',p:0,x:127,y:8,s:1,a:'r',c:_CY},{t:'label',v:'180',x:66,y:16,s:1,a:'l',c:_MG},{t:'180s',p:0,x:127,y:16,s:1,a:'r',c:_MG},{t:'label',v:'HI',x:66,y:24,s:1,a:'l',c:_OR},{t:'high',p:0,x:127,y:24,s:1,a:'r',c:_OR},
  {t:'label',v:'AVG',x:66,y:34,s:1,a:'l',c:_CY},{t:'avg',p:1,x:127,y:34,s:1,a:'r',c:_CY},{t:'label',v:'LEG',x:66,y:42,s:1,a:'l',c:_CY},{t:'legs',p:1,x:127,y:42,s:1,a:'r',c:_CY},{t:'label',v:'180',x:66,y:50,s:1,a:'l',c:_MG},{t:'180s',p:1,x:127,y:50,s:1,a:'r',c:_MG},{t:'label',v:'HI',x:66,y:58,s:1,a:'l',c:_OR},{t:'high',p:1,x:127,y:58,s:1,a:'r',c:_OR}]
}}
function renderPresets(){const b=Object.keys(BUILTINS()),u=Object.keys(presets());
 preset.innerHTML=b.map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join('')+(u.length?`<option disabled>── my presets ──</option>`+u.map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join(''):'')}
function loadpreset(){const n=preset.value,b=BUILTINS();C.layout.fields=b[n]?clone(b[n]):clone(presets()[n]||[]);selF=-1;renderLED()}
async function savepreset(){const n=pname.value.trim();if(!n){alert('Enter a preset name');return}if(BUILTINS()[n]){alert('That name is a built-in — pick another');return}presets()[n]=clone(lfields());pname.value='';renderPresets();preset.value=n;await save();alert('Preset "'+n+'" saved')}
async function delpreset(){const n=preset.value;if(BUILTINS()[n]){alert("Built-in layouts can't be deleted");return}if(!presets()[n]){alert('Pick one of your saved presets');return}if(!confirm('Delete preset "'+n+'"?'))return;delete presets()[n];renderPresets();await save()}
function centerX(){const f=lfields()[selF];if(!f)return;f.a='c';f.x=32;renderLED()}
async function load(){C=JSON.parse(await t('/config')||'{}');c.value=JSON.stringify(C,null,1);renderLayout();renderEvents();renderLED();renderPresets();renderCats();renderPanels();renderCloud()}
async function save(){c.value=JSON.stringify(C,null,1);await fetch('/config',{method:'POST',body:JSON.stringify(C)})}
function applyRaw(){try{C=JSON.parse(c.value);renderLayout();renderEvents()}catch(e){alert('bad JSON: '+e)}}
function dl(){let a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(C,null,1)],{type:'application/json'}));a.download='config.json';a.click()}
async function sp(){gifs=JSON.parse(await t('/sprites'));
 s.innerHTML=gifs.map(n=>`<span class=gif><img src="${norm(n)}" height=32 onerror="this.remove()">${n.split('/').pop()} <button onclick="del('${n}')">x</button></span>`).join('')||'(none)';
 tgif.innerHTML=gifopt('');
 if(C){renderEvents();renderCats()}}
async function del(n){await fetch('/delete?name='+encodeURIComponent(n.split('/').pop()),{method:'POST'});sp()}
function catg(){if(!C.layout.gifCategories)C.layout.gifCategories={};return C.layout.gifCategories}
function renderCats(){if(!C)return;const g=catg(),ks=Object.keys(g);
 catlist.innerHTML=ks.length?ks.map(n=>{const arr=g[n]||[];
  const chips=arr.length?arr.map((p,i)=>`<span class=gif>${p.split('/').pop()} <button onclick="rmgif('${esc(n)}',${i})">x</button></span>`).join(' '):'<i>(empty)</i>';
  const opts=['',...gifs.map(norm)].map(p=>`<option value="${p}">${p?p.split('/').pop():'(pick a GIF…)'}</option>`).join('');
  return `<fieldset><legend>${esc(n)} <button onclick="delcat('${esc(n)}')">delete category</button></legend>${chips}<br><select>${opts}</select><button onclick="addgif(this,'${esc(n)}')">+ add GIF</button></fieldset>`;
 }).join(''):'<i>No categories yet.</i>'}
async function addcat(){const n=cname.value.trim();if(!n){alert('Enter a category name');return}if(catg()[n]){alert('Already exists');return}catg()[n]=[];cname.value='';await save();renderCats();renderEvents()}
async function delcat(n){if(!confirm('Delete category "'+n+'"? (the GIFs are kept)'))return;delete catg()[n];await save();renderCats();renderEvents()}
async function addgif(btn,n){const v=btn.previousElementSibling.value;if(!v)return;const a=catg()[n]||(catg()[n]=[]);if(!a.includes(v))a.push(v);await save();renderCats()}
async function rmgif(n,i){catg()[n].splice(i,1);await save();renderCats()}
async function up(){let x=f.files[0];if(!x)return;let d=new FormData();d.append('file',x,x.name);await fetch('/sprite',{method:'POST',body:d});sp()}
async function say(){await fetch('/text',{method:'POST',body:JSON.stringify({text:tx.value,ms:+tms.value||5000,effect:'pulse',color:[0,180,255]})})}
async function sendgif(){await fetch('/text',{method:'POST',body:JSON.stringify({gif:tgif.value,text:tx.value,ms:+tms.value||6000,region:treg.value})})}
async function rst(){await fetch('/reset',{method:'POST'});alert('stats reset')}
async function ota(){let x=fw.files[0];if(!x)return;let d=new FormData();d.append('f',x,x.name);await fetch('/update',{method:'POST',body:d});alert('updating, rebooting')}
async function wr(){if(confirm('Reset WiFi and reboot?'))await fetch('/wifi/reset',{method:'POST'})}
async function idf(){await fetch('/identify',{method:'POST'})}
async function rb(){if(confirm('Reboot device?'))await fetch('/reboot',{method:'POST'})}
async function stat(){st.textContent=await t('/status')}
async function lg_(){lg.textContent=await t('/log');lg.scrollTop=lg.scrollHeight}
function nav(p){document.querySelectorAll('.panel').forEach(e=>e.classList.remove('on'));document.getElementById('p-'+p).classList.add('on');document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('sel',b.dataset.p==p))}
(async()=>{await sp();await load();renderAddBtns();nav('layout');stat();lg_();setInterval(stat,3000);setInterval(lg_,2000)})();
</script>)HTML";

// ===================== CLOUD REMOTE (outbound WSS tunnel) =====================
// The board dials OUT to the Cloudflare relay (works behind home NAT, no port-forward).
// The relay forwards admin HTTP requests down the socket as {t:"req",...}; we replay each
// one to our OWN web server over loopback and send the response back as {t:"res",...}.
// Runs on its own FreeRTOS task (core 0): the loopback HTTP call is serviced by loop()'s
// server.handleClient() on core 1, so blocking here never deadlocks the single-threaded server.
WebSocketsClient cloudWS;
TaskHandle_t cloudTaskH = nullptr;
volatile bool cloudRun = false;

static String b64encode(const uint8_t *data, size_t len) {           // -> base64 String ("" on empty/oom)
  if (!len) return String();
  size_t olen = 0; mbedtls_base64_encode(nullptr, 0, &olen, data, len);   // query required size
  char *buf = (char *)malloc(olen + 1); if (!buf) return String();
  String out; if (mbedtls_base64_encode((unsigned char *)buf, olen + 1, &olen, data, len) == 0) { buf[olen] = 0; out = buf; }
  free(buf); return out;
}
static uint8_t *b64decode(const char *b64, size_t &outLen) {         // -> malloc'd bytes (caller frees) or nullptr
  outLen = 0; size_t inlen = strlen(b64); if (!inlen) return nullptr;
  size_t need = 0; mbedtls_base64_decode(nullptr, 0, &need, (const unsigned char *)b64, inlen);
  uint8_t *buf = (uint8_t *)malloc(need ? need : 1); if (!buf) return nullptr;
  if (mbedtls_base64_decode(buf, need, &outLen, (const unsigned char *)b64, inlen) != 0) { free(buf); outLen = 0; return nullptr; }
  return buf;
}

void sendHello() {
  String name = (const char *)(cfg["layout"]["cloudName"] | "");
  if (!name.length()) name = (const char *)(cfg["layout"]["cloudId"] | "darts");
  name.replace("\"", "");
  String msg = "{\"t\":\"hello\",\"meta\":{\"name\":\"" + name + "\",\"ip\":\"" + WiFi.localIP().toString() + "\",\"fw\":\"scoreboard\"}}";
  cloudWS.sendTXT(msg);
}

// Replay one tunnelled request to our own web server and stream the response back.
void handleTunnelReq(JsonDocument &m) {
  const char *rid = m["rid"] | "";
  String method = (const char *)(m["method"] | "GET");
  String path = (const char *)(m["path"] | "/");
  String ctype = (const char *)(m["ctype"] | "");
  const char *bodyB64 = m["body"] | "";
  size_t blen = 0; uint8_t *body = (bodyB64[0]) ? b64decode(bodyB64, blen) : nullptr;

  HTTPClient http;
  http.begin("http://" + WiFi.localIP().toString() + path);   // loopback to our own :80
  const char *hk[] = { "Content-Type" }; http.collectHeaders(hk, 1);
  if (ctype.length()) http.addHeader("Content-Type", ctype);
  http.setTimeout(15000);
  int code = (method == "GET") ? http.GET() : http.sendRequest(method.c_str(), body ? body : (uint8_t *)"", blen);
  if (body) free(body);

  int status = code > 0 ? code : 502;
  String rctype = http.header("Content-Type"); if (!rctype.length()) rctype = "application/octet-stream";
  String respB64;
  if (code > 0) {
    int clen = http.getSize();
    if (clen > 0) {                                            // known length: read exactly, then encode + free
      uint8_t *rb = (uint8_t *)malloc(clen);
      if (rb) { int got = http.getStreamPtr()->readBytes(rb, clen); respB64 = b64encode(rb, got); free(rb); }
    } else {                                                   // chunked / unknown length
      String s = http.getString(); respB64 = b64encode((const uint8_t *)s.c_str(), s.length());
    }
  }
  http.end();

  String msg; msg.reserve(respB64.length() + rctype.length() + 96);
  msg = "{\"t\":\"res\",\"rid\":\""; msg += rid; msg += "\",\"status\":"; msg += status;
  msg += ",\"ctype\":\""; msg += rctype; msg += "\",\"body\":\""; msg += respB64; msg += "\"}";
  respB64 = String();                                          // free the encoded copy before the WS/TLS send buffer
  cloudWS.sendTXT(msg);
}

void cloudEvent(WStype_t type, uint8_t *payload, size_t len) {
  if (type == WStype_CONNECTED) { cloudUp = true; LOG("cloud: connected"); sendHello(); }
  else if (type == WStype_DISCONNECTED) { if (cloudUp) LOG("cloud: disconnected"); cloudUp = false; }
  else if (type == WStype_TEXT) {
    JsonDocument m;
    if (deserializeJson(m, (char *)payload, len)) return;       // zero-copy over the WS receive buffer
    if (!strcmp(m["t"] | "", "req")) handleTunnelReq(m);
  }
}

void cloudTask(void *) {
  String host = (const char *)(cfg["layout"]["cloudHost"] | "");
  String id   = (const char *)(cfg["layout"]["cloudId"] | "");
  String tok  = (const char *)(cfg["layout"]["cloudToken"] | "");
  String path = "/connect?id=" + id + "&token=" + tok;
  cloudWS.beginSSL(host.c_str(), 443, path.c_str());            // TLS (workers.dev); token in the URL is the auth
  cloudWS.onEvent(cloudEvent);
  cloudWS.setReconnectInterval(5000);
  cloudWS.enableHeartbeat(15000, 4000, 2);                      // WS-level keepalive through NAT
  uint32_t lastPing = 0;
  while (cloudRun) {
    cloudWS.loop();
    uint32_t now = millis();
    if (cloudUp && now - lastPing > 30000) { lastPing = now; cloudWS.sendTXT("{\"t\":\"ping\"}"); }   // refresh lastSeen
    vTaskDelay(pdMS_TO_TICKS(5));
  }
  cloudWS.disconnect(); cloudUp = false; cloudTaskH = nullptr; vTaskDelete(nullptr);
}
void startCloud() {
  if (cloudTaskH) return;
  if (!(cfg["layout"]["cloudEnabled"] | false)) { LOG("cloud: disabled"); return; }
  if (!strlen(cfg["layout"]["cloudId"] | "") || !strlen(cfg["layout"]["cloudToken"] | "")) { LOG("cloud: id/token missing"); return; }
  cloudRun = true;
  xTaskCreatePinnedToCore(cloudTask, "cloud", 12288, nullptr, 1, &cloudTaskH, 0);
  LOG("cloud: connecting " + String((const char *)(cfg["layout"]["cloudHost"] | "")));
}

// ===================== SETUP / LOOP =====================
void setup() {
  Serial.begin(115200);
  LittleFS.begin(true);
  loadConfig();                                   // load before panel init (for driver/brightness)

  HUB75_I2S_CFG::i2s_pins pins = { P_R1, P_G1, P_B1, P_R2, P_G2, P_B2, P_A, P_B, P_C, P_D, P_E, P_LAT, P_OE, P_CLK };
  int chain = constrain((int)(cfg["layout"]["panelChain"] | 1), 1, 2);   // 1 = 64x64, 2 = 128x64 (two panels)
  panelW = PANEL_RES_X * chain;
  HUB75_I2S_CFG mx(PANEL_RES_X, PANEL_H, chain, pins); mx.clkphase = false;
  String drv = (const char *)(cfg["layout"]["panelDriver"] | "SHIFTREG");
  if (drv == "FM6126A") mx.driver = HUB75_I2S_CFG::FM6126A;
  else if (drv == "FM6124") mx.driver = HUB75_I2S_CFG::FM6124;
  dma = new MatrixPanel_I2S_DMA(mx); dma->begin();
  C_WHITE = dma->color565(255,255,255); C_RED = dma->color565(255,40,40); C_GREEN = dma->color565(40,220,60);
  C_YELLOW = dma->color565(255,210,40); C_CYAN = dma->color565(40,200,230); C_DIM = dma->color565(90,90,90);

  s1n = constrain((int)(cfg["layout"]["strip1Count"] | 60), 1, STRIP_MAX);
  s2n = constrain((int)(cfg["layout"]["strip2Count"] | 60), 1, STRIP_MAX);
  addStripPin(cfg["layout"]["strip1Pin"] | 17, strip1, s1n);
  addStripPin(cfg["layout"]["strip2Pin"] | 21, strip2, s2n);
  FastLED.clear(true);
  applyLive();                                    // brightness / rotation / current cap from config

  dma->setTextSize(1); dma->setCursor(1, 1); dma->print("WiFi setup.."); dma->setCursor(1, 12); dma->print(AP_NAME);
  WiFiManager wm; wm.setConfigPortalTimeout(180);
  if (!wm.autoConnect(AP_NAME)) ESP.restart();
  configTime((long)(cfg["layout"]["tzOffset"] | 0), 0, "pool.ntp.org");   // for the idle clock
  if (MDNS.begin(MDNS_NAME)) MDNS.addService("http", "tcp", 80);
  gif.begin(GIF_PALETTE_RGB565_LE);               // LE matches HUB75 drawPixel byte order (BE swaps colours: yellow->purple)
  players[0].name = "PLAYER 1"; players[1].name = "PLAYER 2";   // other fields use struct defaults

  server.on("/", HTTP_GET, [](){ server.send_P(200, "text/html", PAGE); });
  server.on("/ping", HTTP_GET, [](){ server.send(200,"application/json","{\"device\":\"darts-scoreboard\",\"ip\":\""+WiFi.localIP().toString()+"\"}"); });
  server.on("/status", HTTP_GET, handleStatus);
  server.on("/score", HTTP_POST, handleScore);
  server.on("/event", HTTP_POST, handleEvent);
  server.on("/config", HTTP_GET, handleConfigGet);
  server.on("/config", HTTP_POST, handleConfigPost);
  server.on("/sprites", HTTP_GET, handleSprites);
  server.on("/sprite", HTTP_POST, [](){ server.send(200,"application/json","{\"ok\":true}"); }, handleSpriteUpload);
  server.on("/delete", HTTP_POST, handleDelete);
  server.on("/text", HTTP_POST, handleText);
  server.on("/log", HTTP_GET, handleLog);
  server.on("/reset", HTTP_POST, handleReset);
  server.on("/identify", HTTP_POST, handleIdentify);
  server.on("/reboot", HTTP_POST, [](){ server.send(200, "text/plain", "rebooting"); delay(300); ESP.restart(); });
  server.on("/wifi/reset", HTTP_POST, handleWifiReset);
  server.on("/update", HTTP_POST, [](){ server.send(200,"text/plain",Update.hasError()?"FAIL":"OK"); delay(400); ESP.restart(); }, handleOTAUpload);
  server.serveStatic("/gifs", LittleFS, "/gifs");   // serve GIFs so the web UI can preview them
  server.enableCORS(true); server.begin();

  lastActivity = millis();
  drawScoreboard();
  LOG("ready http://" MDNS_NAME ".local " + WiFi.localIP().toString());
  startCloud();                                   // dial out to the relay if configured (System -> Cloud)
}

void loop() {
  server.handleClient();
  uint32_t now = millis();
  if (identifyUntil) {                              // identify mode holds red/blue until it expires
    if (now >= identifyUntil) { identifyUntil = 0; stopEffect(); drawScoreboard(); }
  } else if (eventUntil) {
    if (now < eventUntil) {
      bool redrew = false;                                                    // did the backdrop repaint this pass?
      if (gifPlaying) {                                                       // GIF backdrop
        if (now >= gifNextFrame) {
          int delayMs = 0;
          if (gif.playFrame(false, &delayMs, nullptr) == 0) gif.reset();      // rewind = loop (no reopen)
          gifNextFrame = now + (delayMs > 0 ? delayMs : 80);
          redrew = true;
        }
      } else if (panelFx.length()) redrew = runPanelFx(now, panelFx, panelPal); // 2D effect backdrop
      // scrolling text ticker — repaint whenever the backdrop repainted (kills flicker)
      if (eventText.length() && (redrew || now - lastMarquee > 33)) {
        lastMarquee = now;
        int textY = gifPlaying ? (PANEL_H - 10) : (PANEL_H / 2 - 4);   // GIF playing: just off the bottom; otherwise: vertically centred
        dma->fillRect(evX0, textY - 1, evW, 10, 0);                     // clear the text band within the active region
        dma->setTextSize(1); dma->setTextColor(C_WHITE);
        int w = eventText.length() * 6;
        if (evW < panelW) { dma->setCursor(evX0 + (evW - w) / 2, textY); dma->print(eventText); }   // one panel: static, centred (no spill)
        else { dma->setCursor(marqueeX, textY); dma->print(eventText); marqueeX -= 2; if (marqueeX < -w) marqueeX = panelW; }
      }
      runEffect(now);
    } else {                                        // event finished
      eventUntil = 0;
      if (gifPlaying) { gif.close(); gifPlaying = false; }
      stopEffect();
      if (evCount > 0) {
        String n = evQueue[0]; int v = evVal[0]; String t = evText[0];
        for (int i = 1; i < evCount; i++) { evQueue[i - 1] = evQueue[i]; evVal[i - 1] = evVal[i]; evText[i - 1] = evText[i]; }
        evCount--; playEvent(n, v, t);
      } else drawScoreboard();
    }
  } else {                                          // idle screen after inactivity
    uint32_t idleMs = cfg["layout"]["idleMs"] | DEF_IDLE_MS;
    if (idleMs && now - lastActivity > idleMs) {
      idle = true;
      String ifx = (const char *)(cfg["layout"]["idleFx"] | "");
      if (ifx.length()) {                           // animated 2D wallpaper + clock overlay
        bool redrew = runPanelFx(now, ifx, paletteByName((const char *)(cfg["layout"]["idlePalette"] | "ocean")));
        static uint32_t lc = 0; static char clk[6] = "";
        if (now - lc > 1000) { lc = now; struct tm t; if (getLocalTime(&t, 5)) strftime(clk, 6, "%H:%M", &t); }
        if (redrew && clk[0]) { dma->setTextSize(1); dma->setTextColor(C_WHITE); dma->setCursor(20, 2); dma->print(clk); }
      } else drawIdle();
    } else {                                          // scoreboard is showing — animate any blink/pulse markers
      static uint32_t lm = 0;
      if (now - lm > 33) { lm = now; animateMarkers(now); }
    }
  }
}
