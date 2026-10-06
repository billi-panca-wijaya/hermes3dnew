"use strict";

/**
 * Minimal Node.js client for the Hermes3D gateway WebSocket protocol (v3).
 *
 * Used by the Telegram bridge, but has no Telegram dependency so it can be
 * reused by any other server-side peer client (Discord, Slack, cron, ...).
 *
 * Protocol recap (see server/hermes-gateway-adapter.js for the server side):
 *   - gateway sends  {type:"event", event:"connect.challenge", payload:{nonce}}
 *   - client sends   {type:"req", id, method:"connect", params:{auth, client}}
 *   - gateway sends  {type:"res", id, ok:true, payload:{type:"hello-ok", ...}}
 *   - afterwards: req/res pairs keyed by `id`, plus unsolicited `event` frames.
 */

const { EventEmitter } = require("node:events");
const { randomBytes } = require("node:crypto");

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000];

const isObject = (value) => Boolean(value && typeof value === "object");

function randomId(prefix = "") {
  return `${prefix}${randomBytes(8).toString("hex")}`;
}

/** Build the `connect` request frame. Pure; exported for tests. */
function buildConnectFrame({ id, token, clientId = "telegram-bridge", mode = "telegram" }) {
  const params = { client: { id: clientId, mode } };
  if (typeof token === "string" && token.trim()) {
    params.auth = { token: token.trim() };
  }
  return { type: "req", id, method: "connect", params };
}

/** Build a generic request frame. Pure; exported for tests. */
function buildRequestFrame({ id, method, params }) {
  return { type: "req", id, method, params: isObject(params) ? params : {} };
}

/** `agent:<agentId>:<sessionType>` — mirrors src/lib/gateway session-key helpers. */
function buildSessionKey(agentId, sessionType = "main") {
  return `agent:${agentId}:${sessionType}`;
}

function parseAgentIdFromSessionKey(sessionKey) {
  if (typeof sessionKey !== "string") return null;
  const parts = sessionKey.split(":");
  return parts.length >= 2 && parts[0] === "agent" && parts[1] ? parts[1] : null;
}

/** Classify an incoming raw frame. Returns null for unparseable input. */
function parseFrame(raw) {
  let frame;
  try {
    frame = JSON.parse(typeof raw === "string" ? raw : String(raw ?? ""));
  } catch {
    return null;
  }
  if (!isObject(frame) || typeof frame.type !== "string") return null;
  if (frame.type === "res" && typeof frame.id === "string") return frame;
  if (frame.type === "event" && typeof frame.event === "string") return frame;
  return null;
}

/** Extract assistant text from a chat event payload (delta or final). */
function extractChatText(payload) {
  const message = isObject(payload) ? payload.message : null;
  if (!isObject(message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (isObject(part) && typeof part.text === "string" ? part.text : "")).join("");
  }
  return "";
}

/**
 * GatewayPeerClient — reconnecting WS client with request/response tracking.
 *
 * Events emitted:
 *   "hello"        (helloPayload)        after a successful connect handshake
 *   "event"        (frame)               every unsolicited gateway event
 *   "chat"         (payload)             convenience: `event === "chat"`
 *   "disconnected" ({code, reason})
 *   "reconnecting" ({attempt, delayMs})
 *   "error"        (err)                 non-fatal transport errors
 */
class GatewayPeerClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.url
   * @param {string} [opts.token]
   * @param {string} [opts.clientId]
   * @param {string} [opts.mode]
   * @param {Function} [opts.WebSocketImpl]  injectable for tests
   * @param {(msg: string) => void} [opts.log]
   * @param {number} [opts.requestTimeoutMs]
   * @param {number} [opts.connectTimeoutMs]
   */
  constructor(opts) {
    super();
    this.url = opts.url;
    this.token = opts.token || "";
    this.clientId = opts.clientId || "telegram-bridge";
    this.mode = opts.mode || "telegram";
    this.WebSocketImpl = opts.WebSocketImpl || require("ws").WebSocket;
    this.log = opts.log || (() => {});
    this.requestTimeoutMs = opts.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    this.connectTimeoutMs = opts.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS;

    this.ws = null;
    this.hello = null;
    this.connected = false;
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    /** @type {Map<string, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
    this.pending = new Map();
  }

  start() {
    this.stopped = false;
    this._open();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._flushPending(new Error("gateway client stopped"));
    try {
      this.ws?.close(1000, "client stopped");
    } catch {}
    this.ws = null;
    this.connected = false;
  }

  _open() {
    if (this.stopped) return;
    const ws = new this.WebSocketImpl(this.url);
    this.ws = ws;
    let connectId = null;
    let connectTimer = null;

    const sendConnect = () => {
      if (connectId) return;
      connectId = randomId("c-");
      const frame = buildConnectFrame({
        id: connectId,
        token: this.token,
        clientId: this.clientId,
        mode: this.mode,
      });
      this._sendRaw(frame);
      connectTimer = setTimeout(() => {
        this.log("[gateway-peer] connect handshake timed out");
        try {
          ws.terminate?.();
          ws.close?.();
        } catch {}
      }, this.connectTimeoutMs);
    };

    ws.on("open", () => {
      this.log(`[gateway-peer] socket open → ${this.url}`);
      // Most gateways send a challenge first; if they don't, connect anyway
      // after a short grace period.
      setTimeout(sendConnect, 150);
    });

    ws.on("message", (raw) => {
      const frame = parseFrame(raw);
      if (!frame) return;

      if (frame.type === "event") {
        if (frame.event === "connect.challenge") {
          sendConnect();
          return;
        }
        this.emit("event", frame);
        if (frame.event === "chat") this.emit("chat", frame.payload || {});
        return;
      }

      // type === "res"
      if (connectId && frame.id === connectId) {
        if (connectTimer) clearTimeout(connectTimer);
        if (frame.ok && isObject(frame.payload) && frame.payload.type === "hello-ok") {
          this.hello = frame.payload;
          this.connected = true;
          this.reconnectAttempt = 0;
          this.log(
            `[gateway-peer] hello-ok adapterType=${frame.payload.adapterType || "?"} protocol=${frame.payload.protocol || "?"}`,
          );
          this.emit("hello", frame.payload);
        } else {
          const err = frame.error || {};
          this.log(`[gateway-peer] connect rejected: ${err.code || "?"} ${err.message || ""}`);
          this.emit("error", new Error(`connect rejected: ${err.message || err.code || "unknown"}`));
          try {
            ws.close(1008, "connect rejected");
          } catch {}
        }
        return;
      }

      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.ok) {
        pending.resolve(frame.payload ?? {});
      } else {
        const err = new Error(frame.error?.message || "gateway error");
        err.code = frame.error?.code || "gateway_error";
        pending.reject(err);
      }
    });

    ws.on("close", (code, reasonBuf) => {
      if (connectTimer) clearTimeout(connectTimer);
      const reason = Buffer.isBuffer(reasonBuf) ? reasonBuf.toString() : String(reasonBuf ?? "");
      const wasConnected = this.connected;
      this.connected = false;
      this.hello = null;
      this._flushPending(new Error(`gateway closed (${code})`));
      if (this.ws === ws) this.ws = null;
      this.log(`[gateway-peer] closed code=${code} reason=${reason || "(none)"}`);
      if (wasConnected) this.emit("disconnected", { code, reason });
      this._scheduleReconnect();
    });

    ws.on("error", (err) => {
      this.log(`[gateway-peer] socket error: ${err?.message || err}`);
      this.emit("error", err);
      // "close" follows and handles reconnect.
    });
  }

  _scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delayMs = RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
    this.reconnectAttempt += 1;
    this.emit("reconnecting", { attempt: this.reconnectAttempt, delayMs });
    this.log(`[gateway-peer] reconnecting in ${delayMs}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._open();
    }, delayMs);
  }

  _sendRaw(frame) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1 /* OPEN */) {
      throw new Error("gateway socket not open");
    }
    ws.send(JSON.stringify(frame));
  }

  _flushPending(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /**
   * Send a request and await the matching response payload.
   * @returns {Promise<any>}
   */
  request(method, params) {
    if (!this.connected) {
      return Promise.reject(Object.assign(new Error("gateway not connected"), { code: "not_connected" }));
    }
    const id = randomId("r-");
    const frame = buildRequestFrame({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`request ${method} timed out`), { code: "timeout" }));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._sendRaw(frame);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  // ---- convenience wrappers -------------------------------------------------

  listAgents() {
    return this.request("agents.list", {});
  }

  sendChat({ sessionKey, message, idempotencyKey }) {
    return this.request("chat.send", {
      sessionKey,
      message,
      idempotencyKey: idempotencyKey || randomId("tg-"),
    });
  }

  abortChat({ runId, sessionKey }) {
    return this.request("chat.abort", runId ? { runId } : { sessionKey });
  }

  resetSession(sessionKey) {
    return this.request("sessions.reset", { key: sessionKey });
  }

  status() {
    return this.request("status", {});
  }

  listModels() {
    return this.request("models.list", {});
  }

  /** Default agent id from the hello snapshot, or null. */
  get defaultAgentId() {
    const snap = this.hello?.snapshot?.health;
    return typeof snap?.defaultAgentId === "string" ? snap.defaultAgentId : null;
  }
}

module.exports = {
  GatewayPeerClient,
  buildConnectFrame,
  buildRequestFrame,
  buildSessionKey,
  parseAgentIdFromSessionKey,
  parseFrame,
  extractChatText,
  RECONNECT_BACKOFF_MS,
};
