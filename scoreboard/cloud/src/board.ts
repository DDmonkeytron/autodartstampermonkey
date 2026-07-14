import { DurableObject } from "cloudflare:workers";

export interface Env {
  BOARD: DurableObjectNamespace<BoardDO>;
  BOARD_TOKENS: string; // JSON: { "<boardId>": "<token>" }
  DASH_PASSWORD: string; // dashboard login password (secret)
}

// One Durable Object per board. Holds the board's outbound WebSocket (the
// "tunnel") and relays admin HTTP requests to it, request/response matched by id.
export class BoardDO extends DurableObject<Env> {
  private pending = new Map<string, (r: ProxyRes) => void>();

  // The ESP32 dials in here (WebSocket upgrade). Hibernatable so an idle board is ~free.
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    await this.ctx.storage.put("lastSeen", Date.now());
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private sock(): WebSocket | undefined {
    return this.ctx.getWebSockets()[0];
  }

  // RPC (called by the Worker): forward one admin HTTP request down the tunnel.
  async proxy(method: string, path: string, ctype: string, bodyB64: string): Promise<ProxyRes> {
    const ws = this.sock();
    if (!ws) return { status: 503, ctype: "text/plain", body: btoa("board offline") };
    const rid = crypto.randomUUID();
    const done = new Promise<ProxyRes>((res) => this.pending.set(rid, res));
    const timeout = new Promise<ProxyRes>((res) =>
      setTimeout(() => res({ status: 504, ctype: "text/plain", body: btoa("board timeout") }), 20000),
    );
    ws.send(JSON.stringify({ t: "req", rid, method, path, ctype, body: bodyB64 }));
    const r = await Promise.race([done, timeout]);
    this.pending.delete(rid);
    return r;
  }

  // RPC: online status + last-reported metadata for the dashboard list.
  async status(): Promise<{ online: boolean; lastSeen: number | null; meta: unknown }> {
    return {
      online: !!this.sock(),
      lastSeen: (await this.ctx.storage.get<number>("lastSeen")) ?? null,
      meta: (await this.ctx.storage.get("meta")) ?? {},
    };
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let m: any;
    try { m = JSON.parse(message); } catch { return; }
    if (m.t === "res") {
      const cb = this.pending.get(m.rid);
      if (cb) cb({ status: m.status | 0, ctype: m.ctype || "application/octet-stream", body: m.body || "" });
    } else if (m.t === "hello") {
      await this.ctx.storage.put("meta", m.meta ?? {});
      await this.ctx.storage.put("lastSeen", Date.now());
    } else if (m.t === "ping") {
      await this.ctx.storage.put("lastSeen", Date.now());
      ws.send(JSON.stringify({ t: "pong" }));
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try { ws.close(); } catch {}
  }
}

export type ProxyRes = { status: number; ctype: string; body: string };
