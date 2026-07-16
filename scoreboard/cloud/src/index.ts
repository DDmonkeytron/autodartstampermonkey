import { BoardDO, type Env, type ProxyRes } from "./board";
export { BoardDO };

type Status = { online: boolean; lastSeen: number | null; meta: unknown };

// base64 <-> bytes (handles binary bodies: gif uploads, thumbnails, etc.)
const toB64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s || ""), (c) => c.charCodeAt(0));

// --- dashboard login (simple password gate; /connect stays token-authed & open) ---
const sha256hex = async (s: string): Promise<string> => {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
const authToken = (env: Env) => sha256hex("darts-dash-v1:" + (env.DASH_PASSWORD || ""));
async function isAuthed(request: Request, env: Env): Promise<boolean> {
  if (!env.DASH_PASSWORD) return false; // no password set → fail closed
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)auth=([a-f0-9]+)/);
  return !!m && m[1] === (await authToken(env));
}
const loginHtml = (err: string) => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Darts Boards — Login</title>
<style>body{font-family:sans-serif;background:#111;color:#eee;margin:0;height:100vh;display:flex;align-items:center;justify-content:center}
form{background:#1a1a1a;padding:2em;border:1px solid #333;border-radius:12px;min-width:260px}h2{margin:0 0 .6em;color:#fc6}
input{padding:.55em;margin:.4em 0;width:100%;background:#1c1c1c;color:#eee;border:1px solid #444;border-radius:6px;box-sizing:border-box}
button{padding:.55em 1em;background:#164;color:#eee;border:0;border-radius:6px;cursor:pointer;width:100%;font-weight:bold}.err{color:#f77;min-height:1.1em;font-size:.9em}</style>
<form method=POST action=/login><h2>🎯 Darts Boards</h2><div class=err>${err}</div>
<input type=password name=password placeholder="Password" autofocus><button>Log in</button></form>`;


export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let tokens: Record<string, string> = {};
    try { tokens = JSON.parse(env.BOARD_TOKENS || "{}"); } catch {}

    // 1) Board dials in. NOT behind Access (devices can't do SSO) — authed by token.
    if (url.pathname === "/connect") {
      const id = url.searchParams.get("id") || "";
      const token = url.searchParams.get("token") || "";
      if (!tokens[id] || tokens[id] !== token) return new Response("unauthorized", { status: 401 });
      return env.BOARD.getByName(id).fetch(request);
    }

    // 1b) Board pulls its firmware image for remote OTA (token-authed, NOT behind the login gate —
    //     the board can't hold a dashboard cookie). It streams this straight into flash.
    const fwGet = url.pathname.match(/^\/fw\/([^/]+)\.bin$/);
    if (fwGet && request.method === "GET") {
      const id = fwGet[1];
      if (!tokens[id] || tokens[id] !== (url.searchParams.get("token") || "")) return new Response("unauthorized", { status: 401 });
      const obj = await env.FW.get(id);
      if (!obj) return new Response("no firmware uploaded", { status: 404 });
      return new Response(obj.body, {
        headers: { "content-type": "application/octet-stream", "content-length": String(obj.size), "cache-control": "no-store" },
      });
    }

    // --- login gate: everything below requires the dashboard password (/connect stays open above) ---
    if (url.pathname === "/login") {
      if (request.method === "POST") {
        const pw = String((await request.formData()).get("password") || "");
        if (env.DASH_PASSWORD && pw === env.DASH_PASSWORD)
          return new Response(null, {
            status: 302,
            headers: { Location: "/", "Set-Cookie": `auth=${await authToken(env)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000` },
          });
        return new Response(loginHtml("Wrong password"), { status: 401, headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response(loginHtml(""), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (!(await isAuthed(request, env))) return Response.redirect(new URL("/login", url).toString(), 302);

    // 1c) Dashboard uploads a firmware image for a board (behind login). The board pulls it via 1b.
    const fwPut = url.pathname.match(/^\/fw\/([^/]+)$/);
    if (fwPut && request.method === "POST") {
      const id = fwPut[1];
      if (!tokens[id]) return new Response("unknown board", { status: 404 });
      const buf = await request.arrayBuffer();
      if (!buf.byteLength) return new Response("empty upload", { status: 400 });
      await env.FW.put(id, buf, { httpMetadata: { contentType: "application/octet-stream" } });
      return Response.json({ ok: true, size: buf.byteLength });
    }

    // 2) Board list + live status for the dashboard.
    if (url.pathname === "/api/boards") {
      const out = [];
      for (const id of Object.keys(tokens)) {
        const s = (await env.BOARD.getByName(id).status()) as Status;
        out.push({ id, online: s.online, lastSeen: s.lastSeen, meta: s.meta });
      }
      return Response.json(out, { headers: { "cache-control": "no-store" } });
    }

    // 3) Proxy the board's OWN web UI/API under /board/:id/*  (reuses the whole existing UI).
    const m = url.pathname.match(/^\/board\/([^/]+)(\/.*)?$/);
    if (m) {
      const id = m[1];
      if (!tokens[id]) return new Response("unknown board", { status: 404 });
      const path = (m[2] || "/") + url.search;
      const bodyB64 = request.method === "GET" || request.method === "HEAD" ? "" : toB64(await request.arrayBuffer());
      const res = (await env.BOARD.getByName(id).proxy(
        request.method,
        path,
        request.headers.get("content-type") || "",
        bodyB64,
      )) as ProxyRes;
      let bytes: Uint8Array = fromB64(res.body);
      const ctype = res.ctype || "application/octet-stream";
      // Inject a shim so the board UI's absolute-path fetches ("/config" etc.) route back through /board/:id/.
      if (ctype.includes("text/html")) {
        const shim = `<script>(()=>{const b='/board/${id}',f=window.fetch;window.fetch=(u,o)=>f(typeof u==='string'&&u[0]==='/'?b+u:u,o);})();</script>`;
        const html = new TextDecoder().decode(bytes).replace("<!doctype html>", "<!doctype html>" + shim);
        bytes = new TextEncoder().encode(html);
      }
      return new Response(bytes, { status: res.status, headers: { "content-type": ctype, "cache-control": "no-store" } });
    }

    // 4) Dashboard.
    return new Response(DASH, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
};

const DASH = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Darts Boards</title>
<style>*{box-sizing:border-box}body{font-family:sans-serif;background:#111;color:#eee;margin:0;padding:1em}
h1{color:#fc6}.board{display:flex;align-items:center;gap:.6em;padding:.6em .8em;background:#1a1a1a;border:1px solid #333;border-radius:8px;margin:.4em 0}
.dot{font-size:.9em}button{padding:.45em .8em;background:#2a2a2a;color:#eee;border:1px solid #444;border-radius:5px;cursor:pointer}
button:disabled{opacity:.4;cursor:not-allowed}.name{color:#8cf}.meta{color:#888;font-size:.85em}.sp{flex:1}
iframe{width:100%;height:82vh;border:1px solid #333;border-radius:8px;margin-top:.6em;background:#000;display:none}
.close{background:#422}</style>
<h1>🎯 Darts Boards</h1>
<div id=list>Loading…</div>
<div id=view></div>
<script>
async function load(){
 try{
  const bs=await (await fetch('/api/boards',{cache:'no-store'})).json();
  list.innerHTML='';
  if(!bs.length){list.textContent='No boards configured.';return}
  for(const b of bs){
   const d=document.createElement('div');d.className='board';
   const meta=b.meta||{};
   const seen=b.lastSeen?new Date(b.lastSeen).toLocaleTimeString():'';
   const info=[meta.ver?'v'+meta.ver:'',meta.ip||'',b.online?'':(seen?'seen '+seen:'')].filter(Boolean).join(' · ');
   d.innerHTML='<span class=dot>'+(b.online?'🟢':'🔴')+'</span> <b>'+b.id+'</b>'+(meta.name?' <span class=name>'+meta.name+'</span>':'')+(info?' <span class=meta>'+info+'</span>':'')+'<span class=sp></span>';
   const btn=document.createElement('button');btn.textContent='Open control panel';btn.disabled=!b.online;btn.onclick=()=>opn(b.id);
   const fw=document.createElement('button');fw.textContent='⬆ Update firmware';fw.disabled=!b.online;fw.onclick=()=>fwPick(b.id);
   const st=document.createElement('span');st.id='fwst-'+b.id;st.className='name';
   d.appendChild(btn);d.appendChild(fw);d.appendChild(st);list.appendChild(d);
  }
 }catch(e){list.textContent='Error loading boards: '+e}
}
function fwPick(id){
 const inp=document.createElement('input');inp.type='file';inp.accept='.bin';
 inp.onchange=()=>{if(inp.files[0])fwSend(id,inp.files[0])};
 inp.click();
}
async function fwSend(id,f){
 const st=document.getElementById('fwst-'+id),set=m=>{if(st)st.textContent=' '+m};
 if(!/\\.bin$/i.test(f.name)||f.size<200000){if(!confirm(f.name+' ('+(f.size/1024|0)+'KB) doesn\\'t look like a firmware .bin. Send anyway?'))return}
 try{
  set('uploading '+(f.size/1024|0)+' KB…');
  const up=await fetch('/fw/'+id,{method:'POST',body:f});
  if(!up.ok){set('upload failed ('+up.status+')');return}
  const j=await up.json();
  set('uploaded '+(j.size/1024|0)+' KB — triggering…');
  const tr=await fetch('/board/'+id+'/ota_pull',{method:'POST'});
  if(!tr.ok){set('trigger failed ('+tr.status+')');return}
  await confirmOta(id,set);
 }catch(e){set('error: '+e)}
}
// Watch the board go offline (flashing) then come back, and report the firmware it booted.
async function confirmOta(id,set){
 set('⚡ flashing — waiting for reboot…');
 let down=false;
 for(let i=0;i<45;i++){                       // ~45 × 3s ≈ 135s window
  await new Promise(r=>setTimeout(r,3000));
  let b;try{const bs=await (await fetch('/api/boards',{cache:'no-store'})).json();b=bs.find(x=>x.id===id)}catch(e){continue}
  if(!b)continue;
  if(!b.online){down=true;set('⚡ flashing — board rebooting…');continue}
  if(down){set('✓ updated — now on v'+((b.meta&&b.meta.ver)||'?'));load();return}
 }
 set('⚠ no reboot seen — check the board manually');
}
function opn(id){
 view.innerHTML='';
 const cb=document.createElement('button');cb.className='close';cb.textContent='✕ Close '+id;cb.onclick=()=>{view.innerHTML=''};
 const fr=document.createElement('iframe');fr.src='/board/'+id+'/';fr.style.display='block';
 view.appendChild(cb);view.appendChild(fr);
}
load();setInterval(load,5000);
</script>`;
