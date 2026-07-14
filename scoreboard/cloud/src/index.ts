import { BoardDO, type Env } from "./board";
export { BoardDO };

// base64 <-> bytes (handles binary bodies: gif uploads, thumbnails, etc.)
const toB64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s || ""), (c) => c.charCodeAt(0));

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

    // --- everything below is meant to sit behind Cloudflare Access (see README) ---

    // 2) Board list + live status for the dashboard.
    if (url.pathname === "/api/boards") {
      const out = [];
      for (const id of Object.keys(tokens)) out.push({ id, ...(await env.BOARD.getByName(id).status()) });
      return Response.json(out, { headers: { "cache-control": "no-store" } });
    }

    // 3) Proxy the board's OWN web UI/API under /board/:id/*  (reuses the whole existing UI).
    const m = url.pathname.match(/^\/board\/([^/]+)(\/.*)?$/);
    if (m) {
      const id = m[1];
      if (!tokens[id]) return new Response("unknown board", { status: 404 });
      const path = (m[2] || "/") + url.search;
      const bodyB64 = request.method === "GET" || request.method === "HEAD" ? "" : toB64(await request.arrayBuffer());
      const res = await env.BOARD.getByName(id).proxy(
        request.method,
        path,
        request.headers.get("content-type") || "",
        bodyB64,
      );
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
button:disabled{opacity:.4;cursor:not-allowed}.name{color:#8cf}.sp{flex:1}
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
   d.innerHTML='<span class=dot>'+(b.online?'🟢':'🔴')+'</span> <b>'+b.id+'</b>'+((b.meta&&b.meta.name)?' <span class=name>'+b.meta.name+'</span>':'')+'<span class=sp></span>';
   const btn=document.createElement('button');btn.textContent='Open control panel';btn.disabled=!b.online;btn.onclick=()=>opn(b.id);
   d.appendChild(btn);list.appendChild(d);
  }
 }catch(e){list.textContent='Error loading boards: '+e}
}
function opn(id){
 view.innerHTML='';
 const cb=document.createElement('button');cb.className='close';cb.textContent='✕ Close '+id;cb.onclick=()=>{view.innerHTML=''};
 const fr=document.createElement('iframe');fr.src='/board/'+id+'/';fr.style.display='block';
 view.appendChild(cb);view.appendChild(fr);
}
load();setInterval(load,5000);
</script>`;
