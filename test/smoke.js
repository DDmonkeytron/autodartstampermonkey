// Smoke test: load the userscript in a fake play.autodarts.com match view and assert
// it actually RUNS and builds its UI.
//
// Exists because v2.41.0 shipped with `playersHost()` calling itself -- infinite
// recursion that threw before the settings cog was ever created, so the whole script
// was dead on the page. `node --check` passes that file happily: it is valid syntax.
// Only executing it catches this class of bug.
//
//   cd test && npm install && npm test
//
const fs = require('fs');
const { JSDOM } = require('jsdom');

const src = fs.readFileSync(require('path').join(__dirname, '..', 'autodarts-theme.user.js'), 'utf8');

// A minimal stand-in for the rebuilt match view: two player columns flanking a
// board/turn column, with the class signatures AD2.tag() keys on.
const html = `<!doctype html><html><head></head><body><div id="root">
 <div class="relative z-10 flex-1 min-h-0 flex items-stretch justify-center gap-12 p-4 [container-type:size]">
  <div class="flex w-100 shrink-0 flex-col justify-center divide-y">
   <div class="relative flex w-full rounded-t-2xl overflow-hidden">
    <div class="relative isolate flex-1 flex flex-col items-center overflow-clip @container min-h-36 bg-raspberry-slush-diagonal">
     <div class="w-full flex justify-center items-center gap-1.5">
       <div class="size-2 rounded-full bg-mono-white shrink-0"></div>
       <div class="relative shrink-0 z-4 rounded-full border-2 border-black-05"><span class="bg-black-90 rounded-full"></span></div>
       <span class="font-display text-[18px] uppercase">davethew</span>
     </div>
     <div class="flex justify-center items-center gap-1.5">
       <div class="font-number font-bold text-[4.5rem]">501</div>
       <div class="rounded-sm size-8"><span class="font-number text-2xl">0</span></div>
     </div>
     <div class="flex items-center gap-2"><div class="flex gap-1">Leg 0.0</div><span class="text-[0.9em]">/</span><div class="flex gap-1">Match 0.0</div></div>
    </div></div></div>
  <div class="grid h-full min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-6">
    <div class="flex-1 flex items-stretch rounded-2xl overflow-hidden bg-surface-surface">
      <div class="flex-1 flex items-stretch justify-evenly overflow-hidden border-r border-black-70 pl-3 gap-3">
        <div class="@container relative flex justify-center items-center min-w-0 font-number font-bold"><span class="flex gap-1"><span class="font-medium">T</span><span>20</span></span></div>
        <div class="@container relative flex justify-center items-center min-w-0 font-number font-bold"></div>
        <div class="@container relative flex justify-center items-center min-w-0 font-number font-bold"></div>
      </div>
      <div class="@container relative flex justify-center items-center min-w-0 font-number font-bold"><span>60</span></div>
    </div>
  </div>
  <div class="flex w-100 shrink-0 flex-col justify-center divide-y">
   <div class="relative flex w-full rounded-t-2xl overflow-hidden">
    <div class="relative isolate flex-1 flex flex-col items-center overflow-clip @container min-h-36 bg-black-80">
     <div class="w-full flex justify-center items-center gap-1.5">
       <div class="size-2 rounded-full bg-mono-white shrink-0 invisible"></div>
       <div class="relative shrink-0 z-4 rounded-full border-2 border-black-05"><span class="bg-black-90 rounded-full"></span></div>
       <span class="font-display text-[18px] uppercase">Bot Level 1</span>
     </div>
     <div class="flex justify-center items-center gap-1.5">
       <div class="font-number font-bold text-[4.5rem]">501</div>
       <div class="rounded-sm size-8"><span class="font-number text-2xl">0</span></div>
     </div>
     <div class="flex items-center gap-2"><div class="flex gap-1">Leg 0.0</div><span class="text-[0.9em]">/</span><div class="flex gap-1">Match 0.0</div></div>
    </div></div></div>
 </div></div></body></html>`;

const dom = new JSDOM(html, { url: 'https://play.autodarts.com/matches/abc', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;

// the script measures fonts; jsdom returns "" for these, so give it plausible numbers
const realGCS = w.getComputedStyle.bind(w);
w.getComputedStyle = (el, pe) => {
  const cs = realGCS(el, pe);
  return new Proxy(cs, { get(t, k) {
    if (k === 'fontSize') {
      const c = (el.className && el.className.toString()) || '';
      if (/text-\[4\.5rem\]/.test(c)) return '120px';
      if (/text-2xl/.test(c)) return '24px';
      return '18px';
    }
    const v = t[k];
    return typeof v === 'function' ? v.bind(t) : v;
  }});
};
w.HTMLMediaElement.prototype.play = () => Promise.resolve();
w.HTMLMediaElement.prototype.pause = () => {};
w.fetch = () => Promise.resolve({ ok: false, json: async () => ({}), text: async () => '' });

const errors = [];
w.addEventListener('error', e => errors.push('window.error: ' + (e.error && e.error.stack || e.message)));
w.onerror = (m, s, l, c, err) => { errors.push('onerror: ' + (err && err.stack || m)); };

let threw = null;
try { w.eval(src); } catch (e) { threw = e; }

// let the rAF / timeout driven work run
setTimeout(() => {
  console.log('=== LOAD RESULT ===');
  console.log('threw synchronously :', threw ? (threw.stack || String(threw)).split('\n').slice(0,4).join('\n') : 'NO');
  console.log('async errors        :', errors.length ? errors.slice(0,3).join('\n---\n') : 'NONE');
  const d = w.document;
  console.log('');
  console.log('=== DID IT BUILD ITS UI? ===');
  const cog = [...d.querySelectorAll('button')].filter(b => b.style && b.style.position === 'fixed' && b.style.width === '44px');
  console.log('settings cog button :', cog.length ? 'YES (' + cog.length + ')' : 'NO  <-- the reported symptom');
  console.log('#ad-core-panel      :', !!d.getElementById('ad-core-panel'));
  console.log('style tag           :', !!d.getElementById('ad-core-ui-style-v245'));
  console.log('');
  console.log('=== DID THE COMPAT LAYER TAG? ===');
  console.log('.ad-core-game       :', d.querySelectorAll('.ad-core-game').length);
  console.log('.ad-core-col        :', d.querySelectorAll('.ad-core-col').length);
  console.log('.ad-core-card       :', d.querySelectorAll('.ad-core-card').length);
  console.log('.ad-active-player   :', d.querySelectorAll('.ad-active-player').length);
  console.log('#ad-ext-turn        :', !!d.getElementById('ad-ext-turn'));
  console.log('.ad-core-throw      :', d.querySelectorAll('.ad-core-throw').length);
  console.log('data-adraw values   :', [...d.querySelectorAll('[data-adraw]')].map(e => e.getAttribute('data-adraw')));

  // The Layout Editor drags these selectors and writes PI_*_X_PX / _Y_PX. If a target
  // stops resolving, or the CSS stops applying the offsets, dragging silently does
  // nothing -- which is exactly how v2.41.x shipped.
  console.log('');
  console.log('=== LAYOUT EDITOR TARGETS ===');
  const targets = { name: '.ad-ext-player-name', score: '.ad-ext-player-score',
                    avg: '.ad-core-pi-avg', avatar: '.ad-core-pi-avatar' };
  let missing = [];
  for (const [k, sel] of Object.entries(targets)) {
    const n = d.querySelectorAll(sel).length;
    console.log((k + '                ').slice(0, 20) + ':', n ? 'OK (' + n + ')' : 'MISSING ' + sel);
    if (!n) missing.push(k);
  }
  const css = [...d.querySelectorAll('style')].map(e => e.textContent).join(String.fromCharCode(10));
  console.log('');
  console.log('=== OFFSETS APPLIED IN CSS? ===');
  const offsetRules = ['--ad-pi-name-x', '--ad-pi-score-x', '--ad-pi-avg-x', '--pp-shift-x'];
  let noOffset = offsetRules.filter(v => !css.includes('translate: var(' + v));
  for (const v of offsetRules) console.log((v + '            ').slice(0, 18) + ':', css.includes('translate: var(' + v) ? 'applied' : 'NOT APPLIED');
  const migOk = true;   // migration is covered by migration.js (asserts on state, not CSS)
  const ok = !threw && !errors.length && cog.length && !missing.length && !noOffset.length && migOk;
  console.log('');
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
}, 2500);
