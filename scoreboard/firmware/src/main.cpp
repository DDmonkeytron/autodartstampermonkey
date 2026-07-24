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
#include <WiFiClientSecure.h> // remote OTA: HTTPS pull of the firmware image
#include <HTTPUpdate.h>       // remote OTA: stream the image straight into flash
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
#define FW_VERSION __DATE__ " " __TIME__   // auto-stamped per build — no two builds ever claim the same version

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
volatile bool otaPullPending = false; // remote OTA: /ota_pull sets this; loop() runs the download
volatile bool gifPullPending = false; String gifPullName = "";   // remote GIF push: board pulls the file from R2

struct Player { String name = "PLAYER"; int score = 501; int legs = 0; float avg = 0; int c180 = 0; int high = 0; String co = ""; float f9 = 0; int coPct = 0; };  // co = autodarts' own checkout suggestion (verbatim), "" = compute ours; f9 = first-9 avg; coPct = checkout %
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
String evQueue[6]; int evVal[6]; String evText[6]; int evPlayer[6]; int evCount = 0;   // evText = dynamic text; evPlayer = who triggered it (for per-player GIFs)
bool summaryPending = false; int summaryWinner = 0;  // gameWon played → show the match-summary card after it
bool summaryShowing = false;                         // card on screen (guards marker animation / idle)

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
// Static images: browser-converted ".img" raw format — 4-byte header 'I','M',w,h then
// w*h RGB565 little-endian. No decoder library needed; the web UI does the resizing.
bool drawImg(const char *path, int x0, int w0) {
  File f = LittleFS.open(path, "r"); if (!f) return false;
  uint8_t hd[4];
  if (f.read(hd, 4) != 4 || hd[0] != 'I' || hd[1] != 'M') { f.close(); return false; }
  int w = hd[2], h = hd[3];
  int ox = x0 + (w0 - w) / 2, oy = (PANEL_H - h) / 2;
  static uint8_t row[PW_MAX * 2];
  for (int y = 0; y < h && f.read(row, w * 2) == w * 2; y++)
    for (int x = 0; x < w; x++) dma->drawPixel(ox + x, oy + y, row[x * 2] | (row[x * 2 + 1] << 8));
  f.close(); return true;
}
bool isImgFile(const String &p) { return p.endsWith(".img"); }

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
  if (t == "f9")       return String(pl.f9, 1);          // first-9 average
  if (t == "co%")      return String(pl.coPct) + "%";    // checkout percentage
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
  idle = false; summaryShowing = false;
  if (gifPlaying && !eventUntil) { gif.close(); gifPlaying = false; }   // stale idle-screensaver GIF (events manage their own)
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
  dma->setTextSize(1);
  if (players[0].legs || players[1].legs) {              // live match standings (this session)
    dma->setTextColor(C_CYAN); dma->setCursor(2, 34); dma->printf("LEGS %d-%d", players[0].legs, players[1].legs);
  }
  dma->setTextColor(C_DIM);
  dma->setCursor(2, 44); dma->printf("180s %d-%d", players[0].c180, players[1].c180);
  dma->setCursor(2, 54); dma->printf("HI %d", max(players[0].high, players[1].high));
}

// ---- match-end summary (shown after the gameWon celebration, until the next score/idle) ----
void smallAt(int x, int y, const String &v, char align) {   // TomThumb print with alignment (≈4px/char)
  int w = v.length() * 4;
  if (align == 'r') x -= w; else if (align == 'c') x -= w / 2;
  dma->setCursor(x, y + 5); dma->print(v);
}
void drawSummary() {
  summaryShowing = true; idle = false;
  dma->clearScreen(); dma->setTextWrap(false);
  int w = constrain(summaryWinner, 0, 3);
  int cx = panelW / 2;
  dma->setTextSize(1); dma->setTextColor(C_YELLOW);
  String n = players[w].name; dma->setCursor(cx - (int)n.length() * 3, 1); dma->print(n);
  String t = "WINS";
  if (numPlayers == 2) t += " " + String(players[0].legs) + "-" + String(players[1].legs);
  dma->setTextColor(C_WHITE); dma->setCursor(cx - (int)t.length() * 3, 11); dma->print(t);
  if (numPlayers < 2) return;
  // stats table (players 0+1) in the tiny font: label | P0 | P1
  int c0 = panelW * 3 / 5, c1 = panelW - 2, y = 22;
  dma->setFont(&TomThumb);
  dma->setTextColor(C_CYAN);
  smallAt(c0, y, players[0].name.substring(0, 5), 'r');
  smallAt(c1, y, players[1].name.substring(0, 5), 'r');
  y += 8;
  struct { const char *l; String a, b; } rows[] = {
    { "AVG", String(players[0].avg, 1), String(players[1].avg, 1) },
    { "F9",  String(players[0].f9, 1),  String(players[1].f9, 1) },
    { "CO%", String(players[0].coPct),  String(players[1].coPct) },
    { "180", String(players[0].c180),   String(players[1].c180) },
    { "HI",  String(players[0].high),   String(players[1].high) },
  };
  for (auto &r : rows) {
    dma->setTextColor(C_DIM);   smallAt(2, y, r.l, 'l');
    dma->setTextColor(C_WHITE); smallAt(c0, y, r.a, 'r'); smallAt(c1, y, r.b, 'r');
    y += 7;
  }
  dma->setFont(nullptr);
  LOG("summary shown");
}

// ---- idle screensaver (idleFx = "gifs"): a specific GIF/image, or random cycling ----
// layout.idleGif   = one file to show ("" = cycle random from idleGifCat / all uploads)
// layout.idleRegion= full | left | right — left/right (128 board) puts a BIG clock on the other panel
// layout.idleClock = overlay HH:MM on the art in full mode
void drawIdleGifs(uint32_t now) {
  static uint32_t switchAt = 0, clockChk = 0; static bool lastFail = false, isImg = false;
  static String curPick = ""; static char clk[6] = "";
  JsonObject L = cfg["layout"];
  const char *reg = L["idleRegion"] | "full";
  bool split = panelW >= 128 && strcmp(reg, "full") != 0;
  if (now >= switchAt || (!gifPlaying && !isImg && !lastFail)) {   // time's up / gif was closed by an event — no retry spam on failure
    lastFail = false; isImg = false;
    String pick = (const char *)(L["idleGif"] | "");               // specific file wins
    if (pick.length() && !LittleFS.exists(pick)) pick = "";
    if (!pick.length()) {                                          // random: category, else any upload
      const char *cat = L["idleGifCat"] | "";
      JsonArray ca = L["gifCategories"][cat].as<JsonArray>();
      if (strlen(cat) && !ca.isNull() && ca.size()) pick = (const char *)ca[random(ca.size())];
      else {
        int count = 0; File dir = LittleFS.open("/gifs");
        if (dir) for (File f = dir.openNextFile(); f; f = dir.openNextFile()) count++;
        if (count) {
          int idx = random(count); dir = LittleFS.open("/gifs");
          for (File f = dir.openNextFile(); f; f = dir.openNextFile()) if (!idx--) { pick = "/gifs/" + String(f.name()); break; }
        }
      }
    }
    setRegion(reg);
    bool ok = false;
    if (pick.length()) {
      dma->clearScreen();
      if (isImgFile(pick)) { if (gifPlaying) { gif.close(); gifPlaying = false; } isImg = ok = drawImg(pick.c_str(), evX0, evW); }
      else ok = openGif(pick.c_str());
    }
    if (ok) { curPick = pick; switchAt = now + (uint32_t)(L["idleGifMs"] | 20000); clk[0] = 0; }   // clk reset forces clock repaint
    else { lastFail = true; switchAt = now + 3000; drawIdle(); return; }   // nothing playable → plain clock; retry soon
  }
  bool redrew = false;
  if (gifPlaying && now >= gifNextFrame) {
    int d = 0; if (gif.playFrame(false, &d, nullptr) == 0) gif.reset();
    gifNextFrame = now + (d > 0 ? d : 80); redrew = true;
  }
  // ---- clock ----
  char nc[6] = "";
  if (now - clockChk > 1000) { clockChk = now; struct tm t; if (getLocalTime(&t, 5)) strftime(nc, 6, "%H:%M", &t); }
  bool newMin = nc[0] && strcmp(nc, clk); if (newMin) strcpy(clk, nc);
  if (!clk[0]) return;
  if (split) {                                       // big clock + date on the OTHER panel
    if (newMin) {
      int cx0 = (evX0 == 0) ? 64 : 0;
      dma->fillRect(cx0, 0, 64, PANEL_H, 0);
      dma->setTextSize(2); dma->setTextColor(C_WHITE); dma->setCursor(cx0 + 2, 20); dma->print(clk);
      struct tm t;
      if (getLocalTime(&t, 5)) {
        char db[12]; strftime(db, sizeof(db), "%a %d %b", &t);
        dma->setTextSize(1); dma->setTextColor(C_DIM); dma->setCursor(cx0 + (64 - (int)strlen(db) * 6) / 2, 42); dma->print(db);
      }
    }
  } else if (L["idleClock"] | true) {                // overlay on the art (small, top-left of the region)
    if (isImg && newMin) { drawImg(curPick.c_str(), evX0, evW); redrew = true; }   // repaint image under the old digits
    if (redrew || newMin) {
      dma->fillRect(evX0 + 1, 1, 32, 9, 0);
      dma->setTextSize(1); dma->setTextColor(C_WHITE); dma->setCursor(evX0 + 2, 2); dma->print(clk);
    }
  }
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

// ===================== EVENTS (with queue + priority) =====================
// Priority: the moment that matters must not wait behind a 10 s Pac-Man. Higher
// priority preempts a running lower one (equal priority queues, so a nine-darter
// finishes before the gameWon that follows it plays).
int evPrio(const String &n) {
  if (n == "gameWon" || n == "nineDarter") return 3;
  if (n == "legWon" || n == "highFinish") return 2;
  return 1;
}
int curEvPrio = 0;                                   // priority of the event on screen (0 = none)

// Per-player celebrations: layout.playerRules[] = [{match,gif,events:{...}}]. The FIRST rule
// whose (lowercased) "match" substring is in player[who]'s name wins ("" or "*" = anyone).
// Guests and signed-in players both arrive as plain name strings, so matching is identical.
String asOverride = "";                              // test-button: match against this name instead of a real player
JsonObjectConst matchedRule(int who) {
  JsonArray rules = cfg["layout"]["playerRules"].as<JsonArray>();
  if (rules.isNull()) return JsonObjectConst();
  String nm;
  if (asOverride.length()) nm = asOverride;
  else if (who >= 0 && who < numPlayers) nm = players[who].name;
  else return JsonObjectConst();
  nm.toLowerCase();
  for (JsonObject r : rules) {
    String m = (const char *)(r["match"] | ""); m.toLowerCase(); m.trim();
    if (m.length() == 0 || m == "*" || nm.indexOf(m) >= 0) return r;
  }
  return JsonObjectConst();
}

void playEvent(const String &name, int value, const String &ovText, int who) {
  JsonObject base = cfg["events"][name];
  if (base.isNull()) return;
  // Overlay this player's rule: default gif, then a per-event override (which can re-set gif/text/fx).
  JsonDocument evd; evd.set(base);                    // working copy — safe to mutate + goes out of scope after
  JsonObjectConst rule = matchedRule(who);
  if (!rule.isNull()) {
    if (!rule["gif"].isNull()) evd["gif"] = rule["gif"];
    JsonObjectConst evov = rule["events"][name];
    if (!evov.isNull()) for (JsonPairConst kv : evov) evd[kv.key()] = kv.value();
  }
  JsonObject o = evd.as<JsonObject>();
  if (gifPlaying) { gif.close(); gifPlaying = false; }  // never inherit a stale GIF (idle screensaver / preempted event)
  curEvPrio = evPrio(name);
  if (name == "gameWon") { summaryPending = true; summaryWinner = value; }
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
  if (gp.length()) {                                        // art takes precedence over a 2D effect
    if (isImgFile(gp)) { if (drawImg(gp.c_str(), evX0, evW)) panelFx = ""; }   // static image backdrop
    else if (openGif(gp.c_str())) panelFx = "";
  }
}
void enqueueEvent(const String &name, int value, const String &ovText) {
  JsonObject o = cfg["events"][name];
  if (o.isNull()) { LOG("unmapped event: " + name); return; }
  if (!(o["enabled"] | true)) { LOG("disabled: " + name); return; }
  int mn = o["min"] | 0;                          // celebration threshold, e.g. treble min 15 = T15+
  if (mn && value && value < mn) { LOG(name + " " + value + " < min " + mn + ", skipped"); return; }
  int who = activePlayer;                          // capture NOW — a queued event may play after the turn moves on
  if (!eventUntil) playEvent(name, value, ovText, who);
  else if (evPrio(name) > curEvPrio) {            // big moment: cut the current celebration + drop the queued small stuff
    LOG("preempt: " + name);
    evCount = 0;
    playEvent(name, value, ovText, who);
  }
  else if (evCount < 6) { evQueue[evCount] = name; evVal[evCount] = value; evText[evCount] = ovText; evPlayer[evCount] = who; evCount++; }
  else LOG("queue full, dropped: " + name);
}

// ===================== CONFIG =====================
void applyLive() {
  dma->setBrightness8(cfg["layout"]["brightness"] | DEF_PANEL_BRI);
  dma->setRotation(cfg["layout"]["rotation"] | 0);
  FastLED.setBrightness(cfg["layout"]["stripBrightness"] | DEF_STRIP_BRI);
  FastLED.setMaxPowerInVoltsAndMilliamps(5, cfg["layout"]["maxMilliamps"] | DEF_MAX_MA);
}
// Auto-dim during configured night hours (a wall-mounted panel at full brightness owns a dark room).
// Checks every 30 s; window may span midnight (23 → 8). applyLive() restores day brightness.
void nightDimTick(uint32_t now) {
  static uint32_t lastChk = 0; static int nightState = -1;    // -1 = unknown yet
  if (now - lastChk < 30000) return; lastChk = now;
  JsonObject L = cfg["layout"];
  int state = 0;
  if (L["nightDim"] | false) {
    struct tm t;
    if (getLocalTime(&t, 5)) {
      int from = L["nightFrom"] | 23, to = L["nightTo"] | 8, h = t.tm_hour;
      state = (from > to) ? (h >= from || h < to) : (h >= from && h < to);
    } else state = (nightState == 1);               // clock not synced yet — hold current state
  }
  if (state != nightState) {
    nightState = state;
    if (state) {
      dma->setBrightness8(L["nightPanelBri"] | 25);
      FastLED.setBrightness(L["nightStripBri"] | 20);
      LOG("night dim ON");
    } else { applyLive(); LOG("night dim off"); }
  }
}
void saveConfig() { File f = LittleFS.open("/config.json", "w"); if (f) { serializeJson(cfg, f); f.close(); } }
void loadConfig() {
  if (LittleFS.exists("/config.json")) {
    File f = LittleFS.open("/config.json", "r");
    DeserializationError e = deserializeJson(cfg, f); f.close();
    if (!e) {
      // Backfill keys added by firmware upgrades so new features get their defaults
      // without wiping the user's existing settings. Only fills what's absent; persists once.
      JsonObject L = cfg["layout"]; bool changed = false;
      if (!L["tz"].is<const char *>()) { L["tz"] = "GMT0BST,M3.5.0/1,M10.5.0"; changed = true; }
      if (!L["cloudHost"].is<const char *>()) { L["cloudHost"] = "darts-scoreboard-relay.ddmonkeytron.workers.dev"; changed = true; }
      if (L["autoResetStats"].isNull()) { L["autoResetStats"] = true; changed = true; }
      if (L["nightDim"].isNull()) { L["nightDim"] = false; L["nightFrom"] = 23; L["nightTo"] = 8; L["nightPanelBri"] = 25; L["nightStripBri"] = 20; changed = true; }
      if (L["idleGifMs"].isNull()) { L["idleGifCat"] = ""; L["idleGifMs"] = 20000; changed = true; }
      if (L["idleClock"].isNull()) { L["idleGif"] = ""; L["idleClock"] = true; L["idleRegion"] = "full"; changed = true; }
      if (cfg["events"]["nineDarter"].isNull()) {   // new default celebration
        JsonObject nd = cfg["events"]["nineDarter"].to<JsonObject>();
        nd["gif"] = ""; nd["text"] = "9 DARTER!!!"; nd["effect"] = "strobe"; nd["palette"] = "party"; nd["panelFx"] = "plasma";
        nd["color"][0] = 255; nd["color"][1] = 215; nd["color"][2] = 0; nd["ms"] = 9000; changed = true;
      }
      if (changed) saveConfig();
      return;
    }
  }
  cfg.clear();
  JsonObject L = cfg["layout"].to<JsonObject>();
  L["players"] = 2; L["showAvg"] = true; L["showLegs"] = true; L["showThrows"] = false;
  L["showCheckout"] = true; L["brightness"] = DEF_PANEL_BRI; L["stripBrightness"] = DEF_STRIP_BRI;
  L["rotation"] = 0; L["maxMilliamps"] = DEF_MAX_MA; L["idleMs"] = DEF_IDLE_MS; L["tzOffset"] = 0; L["panelChain"] = 1;
  L["tz"] = "GMT0BST,M3.5.0/1,M10.5.0";           // POSIX TZ for the idle clock — auto BST/GMT (UK). "" = use tzOffset instead
  L["idleFx"] = ""; L["idlePalette"] = "ocean";   // idleFx: ""|plasma|fire|matrix|sparkle|gifs
  L["idleGifCat"] = ""; L["idleGifMs"] = 20000;   // idleFx "gifs": category to cycle ("" = all uploads) + per-gif dwell
  L["idleGif"] = ""; L["idleClock"] = true; L["idleRegion"] = "full";   // specific file, HH:MM overlay, full|left|right (split = big clock on other panel)
  L["autoResetStats"] = true;                     // fresh 180s/high per match (userscript sends matchId)
  L["nightDim"] = false; L["nightFrom"] = 23; L["nightTo"] = 8; L["nightPanelBri"] = 25; L["nightStripBri"] = 20;
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
  add("nineDarter", "", "9 DARTER!!!", "strobe", 255, 215, 0);  // perfect leg — the big one
  ev["nineDarter"]["ms"] = 9000; ev["nineDarter"]["panelFx"] = "plasma"; ev["nineDarter"]["palette"] = "party";
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

// ---- session stats persistence (180 count + high score survive reboots / remote OTA) ----
bool statsDirty = false; uint32_t statsSaveAt = 0;
void saveStats() {
  JsonDocument s;
  for (int i = 0; i < 4; i++) { s["c180"][i] = players[i].c180; s["high"][i] = players[i].high; }
  File f = LittleFS.open("/stats.json", "w"); if (f) { serializeJson(s, f); f.close(); }
}
void loadStats() {
  if (!LittleFS.exists("/stats.json")) return;
  File f = LittleFS.open("/stats.json", "r"); if (!f) return;
  JsonDocument s; DeserializationError e = deserializeJson(s, f); f.close();
  if (e) return;
  for (int i = 0; i < 4; i++) { players[i].c180 = s["c180"][i] | 0; players[i].high = s["high"][i] | 0; }
}
void markStatsDirty() { statsDirty = true; statsSaveAt = millis() + 3000; }   // debounce writes (flash wear)

// ===================== HTTP HANDLERS =====================
void handleScore() {
  if (!server.hasArg("plain")) { server.send(400, "text/plain", "no body"); return; }
  JsonDocument d;
  if (deserializeJson(d, server.arg("plain"))) { server.send(400, "text/plain", "bad json"); return; }
  // New match (userscript sends the autodarts match id) → optionally reset session stats,
  // so 180s / high score are per-match instead of per-index-forever. RAM-only current id:
  // a mid-match reboot leaves it empty, and the empty→id transition deliberately doesn't reset.
  static String curMatch = "";
  const char *mid = d["matchId"] | "";
  if (strlen(mid) && curMatch != mid) {
    if (curMatch.length() && (cfg["layout"]["autoResetStats"] | true)) {
      for (int i = 0; i < 4; i++) { players[i].c180 = 0; players[i].high = 0; }
      saveStats(); LOG("new match — stats reset");
    }
    curMatch = mid;
  }
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
      players[i].f9 = a[i]["f9"] | players[i].f9;         // first-9 average (from autodarts stats)
      players[i].coPct = a[i]["coPct"] | players[i].coPct; // checkout %
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
      if (sum > players[activePlayer].high) { players[activePlayer].high = sum; markStatsDirty(); }
      if (sum == 180) { players[activePlayer].c180++; markStatsDirty(); }
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
  asOverride = (const char *)(d["as"] | "");       // test button: preview a specific player's rule (best when idle)
  enqueueEvent(name, value, ovText);
  asOverride = "";
  server.send(200, "application/json", "{\"ok\":true}");
}
void handleConfigGet() { File f = LittleFS.open("/config.json", "r"); if (!f) { server.send(200, "application/json", "{}"); return; } server.streamFile(f, "application/json"); f.close(); }
void handleConfigPost() {
  if (!server.hasArg("plain")) { server.send(400, "text/plain", "no body"); return; }
  JsonDocument d;
  if (deserializeJson(d, server.arg("plain"))) { server.send(400, "text/plain", "bad json"); return; }
  // Wipe guard: a config that OMITS the cloud credentials / presets / gif categories
  // (e.g. the userscript's "Push default config") must not destroy them — losing
  // cloudToken would silently strand a remote board off the dashboard.
  {
    JsonObject dl = d["layout"].isNull() ? d["layout"].to<JsonObject>() : d["layout"].as<JsonObject>();
    JsonObject cl = cfg["layout"];
    const char *keep[] = { "cloudEnabled", "cloudHost", "cloudId", "cloudToken", "cloudName" };
    for (const char *k : keep) if (dl[k].isNull() && !cl[k].isNull()) dl[k] = cl[k];
    if (dl["presets"].isNull() && !cl["presets"].isNull()) dl["presets"] = cl["presets"];
    if (dl["gifCategories"].isNull() && !cl["gifCategories"].isNull()) dl["gifCategories"] = cl["gifCategories"];
    if (dl["fields"].isNull() && !cl["fields"].isNull()) dl["fields"] = cl["fields"];   // keep the custom layout too
    if (dl["playerRules"].isNull() && !cl["playerRules"].isNull()) dl["playerRules"] = cl["playerRules"];   // keep per-player GIFs
  }
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
  s["ver"] = FW_VERSION;
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
  dma->clearScreen();
  if (strlen(g)) {                                   // play the requested GIF/image; text (if any) scrolls off the bottom
    if (isImgFile(g)) { if (gifPlaying) { gif.close(); gifPlaying = false; } if (drawImg(g, evX0, evW)) panelFx = ""; }
    else if (openGif(g)) panelFx = "";
  }
  else if (gifPlaying) { gif.close(); gifPlaying = false; }
  lastActivity = millis();
  LOG("text: " + eventText);
  server.send(200, "application/json", "{\"ok\":true}");
}
void handleLog() {
  String o; for (int i = 0; i < LOGN; i++) { String &l = logBuf[(logHead + i) % LOGN]; if (l.length()) o += l + "\n"; }
  server.send(200, "text/plain", o);
}
void handleReset() { for (int i = 0; i < 4; i++) { players[i].c180 = 0; players[i].high = 0; } saveStats(); LOG("stats reset"); server.send(200, "application/json", "{\"ok\":true}"); }
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

#include "web_ui.h"   // the whole web config UI (PAGE)


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
  String msg = "{\"t\":\"hello\",\"meta\":{\"name\":\"" + name + "\",\"ip\":\"" + WiFi.localIP().toString() + "\",\"fw\":\"scoreboard\",\"ver\":\"" FW_VERSION "\"}}";
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

// Remote OTA (pull model): download our own firmware image from the relay's R2-backed
// /fw/<id>.bin endpoint and stream it straight into flash. The 1.2 MB image can't fit
// through the WS tunnel (1 MB msg cap) or RAM, so the board fetches it directly over HTTPS.
// Runs from loop() (core 1), NOT the cloud task, so we can cleanly tear the tunnel down first.
void doOtaPull() {
  otaPullPending = false;
  String host = (const char *)(cfg["layout"]["cloudHost"] | "");
  String id   = (const char *)(cfg["layout"]["cloudId"] | "");
  String tok  = (const char *)(cfg["layout"]["cloudToken"] | "");
  if (!host.length() || !id.length()) { LOG("ota-pull: cloud not configured"); return; }
  String url = "https://" + host + "/fw/" + id + ".bin?token=" + tok;
  LOG("ota-pull: starting from " + host);

  // Free the tunnel's TLS context first (frees ~50 KB) so the download's TLS + flash have room.
  // Signal the cloud task to stop and wait for IT to disconnect (never touch cloudWS cross-core).
  cloudRun = false;
  for (int i = 0; i < 150 && cloudTaskH; i++) delay(20);   // up to ~3 s for the task to exit
  cloudUp = false;

  if (dma) { dma->clearScreen(); dma->setTextColor(C_YELLOW); dma->setTextSize(1); dma->setCursor(2, 24); dma->print("UPDATING..."); }
  LOG("ota-pull: free heap " + String(ESP.getFreeHeap()));

  WiFiClientSecure sc; sc.setInsecure();                    // workers.dev; token in the URL is the auth
  httpUpdate.rebootOnUpdate(true);                          // reboots itself on success
  httpUpdate.setLedPin(-1);
  t_httpUpdate_return r = httpUpdate.update(sc, url);
  if (r == HTTP_UPDATE_FAILED) {
    LOG("ota-pull FAILED (" + String(httpUpdate.getLastError()) + ") " + httpUpdate.getLastErrorString());
    if (dma) { dma->setTextColor(C_RED); dma->setCursor(2, 44); dma->print("FAILED"); }
    delay(1800);
  } else if (r == HTTP_UPDATE_NO_UPDATES) {
    LOG("ota-pull: no update");
  }
  ESP.restart();                                            // clean recovery: reboot reconnects the tunnel (or boots new fw)
}

// Remote GIF push (pull model, like OTA): big GIFs can't ride the tunnel — the base64 body
// would need to fit whole in ~100 KB of heap. Instead the dashboard puts the file in R2 and
// the board streams it from https://<host>/gif/<id>/<name>?token= straight to LittleFS.
// Runs from loop(); the tunnel stays up (streaming needs no big buffer).
void doGifPull() {
  gifPullPending = false;
  String name = gifPullName; gifPullName = "";
  String host = (const char *)(cfg["layout"]["cloudHost"] | "");
  String id   = (const char *)(cfg["layout"]["cloudId"] | "");
  String tok  = (const char *)(cfg["layout"]["cloudToken"] | "");
  if (!host.length() || !id.length() || !name.length()) { LOG("gif-pull: not configured"); return; }
  WiFiClientSecure sc; sc.setInsecure();
  HTTPClient http;
  http.begin(sc, "https://" + host + "/gif/" + id + "/" + name + "?token=" + tok);
  http.setTimeout(20000);
  int code = http.GET();
  if (code == 200) {
    if (!LittleFS.exists("/gifs")) LittleFS.mkdir("/gifs");
    File f = LittleFS.open("/gifs/" + name, "w");
    if (f) {
      int n = http.writeToStream(&f);              // stream direct to flash — no big RAM buffer
      f.close();
      LOG("gif-pull: " + name + " " + String(n) + "B");
    } else LOG("gif-pull: fs open failed");
  } else LOG("gif-pull: HTTP " + String(code));
  http.end();
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
  {                                               // idle clock time: prefer a POSIX TZ (auto-DST) over the manual offset
    String tz = (const char *)(cfg["layout"]["tz"] | "");
    if (tz.length()) configTzTime(tz.c_str(), "pool.ntp.org");                       // e.g. UK "GMT0BST,M3.5.0/1,M10.5.0" flips BST/GMT itself
    else configTime((long)(cfg["layout"]["tzOffset"] | 0), 0, "pool.ntp.org");       // legacy fixed offset
  }
  if (MDNS.begin(MDNS_NAME)) MDNS.addService("http", "tcp", 80);
  gif.begin(GIF_PALETTE_RGB565_LE);               // LE matches HUB75 drawPixel byte order (BE swaps colours: yellow->purple)
  players[0].name = "PLAYER 1"; players[1].name = "PLAYER 2";   // other fields use struct defaults
  loadStats();                                    // restore 180 count + high score from before the last reboot

  // Web UI: a LittleFS override (/index.html, uploadable via POST /ui — even remotely) wins
  // over the compiled-in page, so UI tweaks don't need a firmware flash. POST /ui/reset removes it.
  server.on("/", HTTP_GET, [](){
    if (LittleFS.exists("/index.html")) { File f = LittleFS.open("/index.html", "r"); server.streamFile(f, "text/html"); f.close(); }
    else server.send_P(200, "text/html", PAGE);
  });
  server.on("/ui", HTTP_POST, [](){ server.send(200, "application/json", "{\"ok\":true}"); }, [](){
    HTTPUpload &up = server.upload();
    if (up.status == UPLOAD_FILE_START) uploadFile = LittleFS.open("/index.html", "w");
    else if (up.status == UPLOAD_FILE_WRITE) { if (uploadFile) uploadFile.write(up.buf, up.currentSize); }
    else if (up.status == UPLOAD_FILE_END) { if (uploadFile) uploadFile.close(); LOG("web UI override installed"); }
  });
  server.on("/ui/reset", HTTP_POST, [](){ LittleFS.remove("/index.html"); LOG("web UI override removed"); server.send(200, "application/json", "{\"ok\":true}"); });
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
  server.on("/ota_pull", HTTP_POST, [](){ otaPullPending = true; server.send(200, "application/json", "{\"ok\":true}"); });   // remote OTA trigger (loop() does the download)
  server.on("/gif_pull", HTTP_POST, [](){                                   // remote GIF push trigger: {"name":"x.gif"} waiting in R2
    JsonDocument d;
    if (!server.hasArg("plain") || deserializeJson(d, server.arg("plain")) || !strlen(d["name"] | "")) { server.send(400, "text/plain", "need {name}"); return; }
    gifPullName = (const char *)d["name"]; gifPullPending = true;
    server.send(200, "application/json", "{\"ok\":true}");
  });
  server.serveStatic("/gifs", LittleFS, "/gifs");   // serve GIFs so the web UI can preview them
  server.enableCORS(true); server.begin();

  lastActivity = millis();
  drawScoreboard();
  LOG("ready http://" MDNS_NAME ".local " + WiFi.localIP().toString());
  startCloud();                                   // dial out to the relay if configured (System -> Cloud)
}

void loop() {
  server.handleClient();
  if (otaPullPending) { doOtaPull(); return; }    // remote firmware update (tears down the tunnel, then reboots)
  if (gifPullPending) doGifPull();                // remote GIF push: stream the file from R2 to LittleFS
  if (statsDirty && millis() > statsSaveAt) { statsDirty = false; saveStats(); }   // debounced stats persist
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
      eventUntil = 0; curEvPrio = 0;
      if (gifPlaying) { gif.close(); gifPlaying = false; }
      stopEffect();
      if (evCount > 0) {
        String n = evQueue[0]; int v = evVal[0]; String t = evText[0]; int who = evPlayer[0];
        for (int i = 1; i < evCount; i++) { evQueue[i - 1] = evQueue[i]; evVal[i - 1] = evVal[i]; evText[i - 1] = evText[i]; evPlayer[i - 1] = evPlayer[i]; }
        evCount--; playEvent(n, v, t, who);
      } else if (summaryPending) { summaryPending = false; drawSummary(); }   // match over → stats card
      else drawScoreboard();
    }
  } else {                                          // idle screen after inactivity
    uint32_t idleMs = cfg["layout"]["idleMs"] | DEF_IDLE_MS;
    if (idleMs && now - lastActivity > idleMs) {
      idle = true; summaryShowing = false;
      String ifx = (const char *)(cfg["layout"]["idleFx"] | "");
      if (ifx == "gifs") drawIdleGifs(now);         // GIF screensaver (random from a category / all uploads)
      else if (ifx.length()) {                      // animated 2D wallpaper + clock overlay
        bool redrew = runPanelFx(now, ifx, paletteByName((const char *)(cfg["layout"]["idlePalette"] | "ocean")));
        static uint32_t lc = 0; static char clk[6] = "";
        if (now - lc > 1000) { lc = now; struct tm t; if (getLocalTime(&t, 5)) strftime(clk, 6, "%H:%M", &t); }
        if (redrew && clk[0]) { dma->setTextSize(1); dma->setTextColor(C_WHITE); dma->setCursor(20, 2); dma->print(clk); }
      } else drawIdle();
    } else if (!summaryShowing) {                     // scoreboard is showing — animate any blink/pulse markers
      static uint32_t lm = 0;
      if (now - lm > 33) { lm = now; animateMarkers(now); }
    }
  }
  nightDimTick(now);                                  // auto-dim panel+strips during configured night hours
}
