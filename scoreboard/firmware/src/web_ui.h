// Web config UI, served from PROGMEM at "/" (a LittleFS /index.html override wins).
// Split out of main.cpp: this string is fully standalone (no firmware symbols).
#pragma once

const char PAGE[] PROGMEM = R"HTML(
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
<h3>Web UI override</h3><input type=file id=uif accept=.html><button onclick=uiUp()>Install</button> <button onclick=uiRst()>Remove override</button>
<div class=hint>An uploaded index.html replaces the built-in page (survives OTA). Remove to fall back to the firmware's UI.</div>
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
const IFX=[...PFX,'gifs'];   // idle screen additionally offers the GIF screensaver
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
 const txt=(k,w)=>`<label>${k} <input style="width:${w||140}px" value="${esc(L[k]??'')}" onchange="lset('${k}',this.value)"></label>`;
 const p=L.playerColors||[];
 lo.innerHTML=[num('players'),chk('showAvg'),chk('showLegs'),chk('showThrows'),chk('showCheckout'),chk('autoResetStats'),num('brightness'),
  num('stripBrightness'),num('maxMilliamps'),num('rotation'),num('idleMs'),sl('idleFx',IFX),sl('idlePalette',PAL),txt('idleGifCat',110),num('idleGifMs'),
  num('tzOffset'),txt('tz',150),sl('panelDriver',DRV)].join(' ')
  +'<div class=hint>tz = POSIX timezone for the idle clock (auto-DST). UK = <code>GMT0BST,M3.5.0/1,M10.5.0</code>. Blank = use the fixed tzOffset seconds instead. Reboot to apply.<br>idleFx <b>gifs</b> = GIF screensaver: cycles a random GIF from category <b>idleGifCat</b> (blank = all uploads) every idleGifMs. autoResetStats = fresh 180s/high each new match.</div>'
  +'<br><b>Night dimming:</b> '+[chk('nightDim'),num('nightFrom'),num('nightTo'),num('nightPanelBri'),num('nightStripBri')].join(' ')
  +'<div class=hint>Auto-dim between nightFrom and nightTo (24h hours, may span midnight). Needs the clock (tz) to be right.</div>'
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
const SCALE=5, FT=['name','score','avg','f9','co%','legs','darts','last','turn','total','checkout','180s','high','label','amark','hline','vline'];
function EW(){return 64*((C.layout&&C.layout.panelChain)||1)}   // editor canvas width in panel px (64 or 128)
let selF=-1;
function lfields(){if(!C.layout)C.layout={};if(!C.layout.fields)C.layout.fields=[];return C.layout.fields}
function renderAddBtns(){addbtns.innerHTML=FT.map(t=>`<button onclick="addF('${t}')">+${t}</button>`).join(' ')}
function addF(t){lfields().push({t,p:+lp.value,x:1,y:1,s:1,a:'l'});selF=lfields().length-1;renderLED()}
function fprev(f){return {name:'NAME',score:'501',avg:'0.0',f9:'0.0','co%':'40%',legs:'0',darts:'3',last:'20',turn:'20 20',total:'60',checkout:'D20','180s':'1',high:'140',label:(f.v||'TEXT'),amark:'▮',hline:'──────────',vline:'│'}[f.t]||f.t}
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
  {t:'label',v:'AVG',x:66,y:34,s:1,a:'l',c:_CY},{t:'avg',p:1,x:127,y:34,s:1,a:'r',c:_CY},{t:'label',v:'LEG',x:66,y:42,s:1,a:'l',c:_CY},{t:'legs',p:1,x:127,y:42,s:1,a:'r',c:_CY},{t:'label',v:'180',x:66,y:50,s:1,a:'l',c:_MG},{t:'180s',p:1,x:127,y:50,s:1,a:'r',c:_MG},{t:'label',v:'HI',x:66,y:58,s:1,a:'l',c:_OR},{t:'high',p:1,x:127,y:58,s:1,a:'r',c:_OR}],
 'Stats+ (2P wide, small)':[
  {t:'name',p:0,x:1,y:0,s:1,a:'l'},{t:'amark',p:0,x:60,y:0},{t:'score',p:0,x:1,y:9,s:2,a:'l'},{t:'checkout',p:0,x:1,y:26,s:0,a:'l',c:_GR},{t:'hline',x:0,y:31},
  {t:'name',p:1,x:1,y:32,s:1,a:'l'},{t:'amark',p:1,x:60,y:32},{t:'score',p:1,x:1,y:41,s:2,a:'l'},{t:'checkout',p:1,x:1,y:58,s:0,a:'l',c:_GR},{t:'vline',x:63,y:0},
  {t:'label',v:'AVG',x:66,y:0,s:0,a:'l',c:_CY},{t:'avg',p:0,x:127,y:0,s:0,a:'r',c:_CY},{t:'label',v:'F9',x:66,y:6,s:0,a:'l',c:_CY},{t:'f9',p:0,x:127,y:6,s:0,a:'r',c:_CY},{t:'label',v:'CO%',x:66,y:12,s:0,a:'l',c:_GR},{t:'co%',p:0,x:127,y:12,s:0,a:'r',c:_GR},{t:'label',v:'180',x:66,y:18,s:0,a:'l',c:_MG},{t:'180s',p:0,x:127,y:18,s:0,a:'r',c:_MG},{t:'label',v:'HI',x:66,y:24,s:0,a:'l',c:_OR},{t:'high',p:0,x:127,y:24,s:0,a:'r',c:_OR},
  {t:'label',v:'AVG',x:66,y:34,s:0,a:'l',c:_CY},{t:'avg',p:1,x:127,y:34,s:0,a:'r',c:_CY},{t:'label',v:'F9',x:66,y:40,s:0,a:'l',c:_CY},{t:'f9',p:1,x:127,y:40,s:0,a:'r',c:_CY},{t:'label',v:'CO%',x:66,y:46,s:0,a:'l',c:_GR},{t:'co%',p:1,x:127,y:46,s:0,a:'r',c:_GR},{t:'label',v:'180',x:66,y:52,s:0,a:'l',c:_MG},{t:'180s',p:1,x:127,y:52,s:0,a:'r',c:_MG},{t:'label',v:'HI',x:66,y:58,s:0,a:'l',c:_OR},{t:'high',p:1,x:127,y:58,s:0,a:'r',c:_OR}]
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
 s.innerHTML=gifs.map(n=>`<span class=gif><img src="${norm(n).replace(/^\//,'')}" height=32 onerror="this.remove()">${n.split('/').pop()} <button onclick="del('${n}')">x</button></span>`).join('')||'(none)';
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
async function uiUp(){let x=uif.files[0];if(!x)return;let d=new FormData();d.append('f',x,x.name);await fetch('/ui',{method:'POST',body:d});alert('UI override installed — reload the page')}
async function uiRst(){await fetch('/ui/reset',{method:'POST'});alert('override removed — reload for the built-in UI')}
async function wr(){if(confirm('Reset WiFi and reboot?'))await fetch('/wifi/reset',{method:'POST'})}
async function idf(){await fetch('/identify',{method:'POST'})}
async function rb(){if(confirm('Reboot device?'))await fetch('/reboot',{method:'POST'})}
async function stat(){st.textContent=await t('/status')}
async function lg_(){lg.textContent=await t('/log');lg.scrollTop=lg.scrollHeight}
function nav(p){document.querySelectorAll('.panel').forEach(e=>e.classList.remove('on'));document.getElementById('p-'+p).classList.add('on');document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('sel',b.dataset.p==p))}
(async()=>{await sp();await load();renderAddBtns();nav('layout');stat();lg_();setInterval(stat,3000);setInterval(lg_,2000)})();
</script>)HTML";
