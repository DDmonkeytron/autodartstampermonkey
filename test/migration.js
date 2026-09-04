// v2 state migration test.
//
// Saved presets carry PI_* position offsets tuned for the OLD absolutely-positioned
// layout (PI_SCORE_Y_PX:-193 and friends). On the rebuilt autodarts.com card those
// throw the name and score clean off it, so normalizeState() zeroes them exactly once.
//
// Runs BOTH directions in one process: a pre-v2 state must be zeroed, and an
// already-v2 state must be left alone. Without that negative control this test would
// pass on a migration that did nothing at all -- which is how the first version of it
// was written, and it was worthless.
//
// NOTE: migrateToState() discards any object lacking `ui`, so the seed must include it.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const src = fs.readFileSync(path.join(__dirname, '..', 'autodarts-theme.user.js'), 'utf8');

function run(schemaVersion) {
  return new Promise((resolve) => {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
      { url: 'https://play.autodarts.com/matches/abc', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    w.localStorage.setItem('ad_core_state', JSON.stringify({
      schemaVersion,
      activePreset: 0,
      ui: { open: false, lang: 'en' },
      presets: [{ PI_SCORE_Y_PX: -193, PI_NAME_Y_PX: -190, PI_SCORE_FONT_PX: 220 }],
    }));
    w.HTMLMediaElement.prototype.play = () => Promise.resolve();
    w.fetch = () => Promise.resolve({ ok: false, json: async () => ({}), text: async () => '' });
    try { w.eval(src); } catch (e) { console.log('threw:', e.message); }
    setTimeout(() => {
      const st = JSON.parse(w.localStorage.getItem('ad_core_state'));
      const p0 = (st.presets && st.presets[0]) || {};
      const pre = schemaVersion < 2;
      const wantY = pre ? 0 : -193;
      const wantN = pre ? 0 : -190;
      console.log(`\n--- seeded schemaVersion ${schemaVersion} ${pre ? '(pre-v2: MUST zero)' : '(v2: must NOT touch)'} ---`);
      console.log('  stored schemaVersion :', st.schemaVersion);
      console.log('  PI_SCORE_Y_PX        :', p0.PI_SCORE_Y_PX, '(expect ' + wantY + ')');
      console.log('  PI_NAME_Y_PX         :', p0.PI_NAME_Y_PX, '(expect ' + wantN + ')');
      console.log('  PI_SCORE_FONT_PX     :', p0.PI_SCORE_FONT_PX, '(must stay 220 either way)');
      const ok = p0.PI_SCORE_Y_PX === wantY && p0.PI_NAME_Y_PX === wantN
              && p0.PI_SCORE_FONT_PX === 220 && st.schemaVersion === 2;
      console.log('  ' + (ok ? 'PASS' : 'FAIL'));
      dom.window.close();
      resolve(ok);
    }, 1500);
  });
}

(async () => {
  const a = await run(1);   // migration must fire
  const b = await run(2);   // migration must not fire
  console.log('\n' + (a && b ? 'MIGRATION PASS' : 'MIGRATION FAIL'));
  process.exit(a && b ? 0 : 1);
})();
