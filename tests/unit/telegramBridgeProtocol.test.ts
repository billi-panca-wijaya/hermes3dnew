import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

const {
  GatewayPeerClient,
  buildConnectFrame,
  buildRequestFrame,
  buildSessionKey,
  parseAgentIdFromSessionKey,
  parseFrame,
  extractChatText,
} = await import("../../server/telegram-bridge-protocol.js");

/** In-memory stand-in for `ws` so the client can be driven deterministically. */
class FakeWebSocket extends EventEmitter {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  url: string;

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }

  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }

  terminate() {
    this.close(1006, "terminated");
  }

  // test helpers
  open() {
    this.readyState = 1;
    this.emit("open");
  }

  receive(frame: unknown) {
    this.emit("message", JSON.stringify(frame));
  }

  lastSent() {
    return this.sent[this.sent.length - 1];
  }
}

const flush = () => new Promise((r) => setTimeout(r, 200));

const makeClient = (extra: Record<string, unknown> = {}) =>
  new GatewayPeerClient({
    url: "ws://fake:18789",
    WebSocketImpl: FakeWebSocket as unknown as typeof import("ws").WebSocket,
    requestTimeoutMs: 500,
    connectTimeoutMs: 500,
    ...extra,
  });

describe("telegram-bridge-protocol pure helpers", () => {
  it("builds a connect frame with optional auth token", () => {
    expect(buildConnectFrame({ id: "c1", token: "  secret " })).toEqual({
      type: "req",
      id: "c1",
      method: "connect",
      params: { client: { id: "telegram-bridge", mode: "telegram" }, auth: { token: "secret" } },
    });
    expect(buildConnectFrame({ id: "c2", token: "" }).params).not.toHaveProperty("auth");
  });

  it("builds request frames and normalises params", () => {
    expect(buildRequestFrame({ id: "r1", method: "status", params: null })).toEqual({
      type: "req",
      id: "r1",
      method: "status",
      params: {},
    });
  });

  it("builds and parses session keys the same way the browser does", () => {
    expect(buildSessionKey("hermes")).toBe("agent:hermes:main");
    expect(buildSessionKey("hermes", "tg-42")).toBe("agent:hermes:tg-42");
    expect(parseAgentIdFromSessionKey("agent:backend-dev-a1b2:main")).toBe("backend-dev-a1b2");
    expect(parseAgentIdFromSessionKey("nope")).toBeNull();
  });

  it("parses only well-formed res/event frames", () => {
    expect(parseFrame("not json")).toBeNull();
    expect(parseFrame(JSON.stringify({ type: "req", id: "x" }))).toBeNull();
    expect(parseFrame(JSON.stringify({ type: "res", id: "x", ok: true }))).toMatchObject({ type: "res" });
    expect(parseFrame(JSON.stringify({ type: "event", event: "chat" }))).toMatchObject({ event: "chat" });
  });

  it("extracts assistant text from string and array content", () => {
    expect(extractChatText({ message: { role: "assistant", content: "hi" } })).toBe("hi");
    expect(
      extractChatText({ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }),
    ).toBe("ab");
    expect(extractChatText({})).toBe("");
  });
});

describe("GatewayPeerClient", () => {
  it("completes the challenge → connect → hello-ok handshake", async () => {
    FakeWebSocket.instances = [];
    const client = makeClient();
    const hello = new Promise((resolve) => client.once("hello", resolve));
    client.start();

    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: "event", event: "connect.challenge", payload: { nonce: "n" } });

    const connectFrame = ws.lastSent();
    expect(connectFrame).toMatchObject({ type: "req", method: "connect" });

    ws.receive({
      type: "res",
      id: connectFrame.id,
      ok: true,
      payload: {
        type: "hello-ok",
        protocol: 3,
        adapterType: "demo",
        snapshot: { health: { defaultAgentId: "demo-orchestrator" } },
      },
    });

    await hello;
    expect(client.connected).toBe(true);
    expect(client.defaultAgentId).toBe("demo-orchestrator");
    client.stop();
  });

  it("resolves requests by id and rejects gateway errors", async () => {
    FakeWebSocket.instances = [];
    const client = makeClient();
    client.start();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: "event", event: "connect.challenge", payload: {} });
    ws.receive({ type: "res", id: ws.lastSent().id, ok: true, payload: { type: "hello-ok" } });

    const ok = client.request("agents.list", {});
    const okFrame = ws.lastSent();
    ws.receive({ type: "res", id: okFrame.id, ok: true, payload: { agents: [{ id: "a" }] } });
    await expect(ok).resolves.toEqual({ agents: [{ id: "a" }] });

    const bad = client.request("chat.send", {});
    const badFrame = ws.lastSent();
    ws.receive({ type: "res", id: badFrame.id, ok: false, error: { code: "boom", message: "nope" } });
    await expect(bad).rejects.toMatchObject({ code: "boom", message: "nope" });
    client.stop();
  });

  it("re-emits chat events and rejects requests when disconnected", async () => {
    FakeWebSocket.instances = [];
    const client = makeClient();
    client.start();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: "event", event: "connect.challenge", payload: {} });
    ws.receive({ type: "res", id: ws.lastSent().id, ok: true, payload: { type: "hello-ok" } });

    const chat = new Promise((resolve) => client.once("chat", resolve));
    ws.receive({ type: "event", event: "chat", payload: { runId: "r", state: "delta" } });
    await expect(chat).resolves.toMatchObject({ runId: "r", state: "delta" });

    client.stop();
    await expect(client.request("status", {})).rejects.toMatchObject({ code: "not_connected" });
  });

  it("schedules a reconnect after the socket closes", async () => {
    FakeWebSocket.instances = [];
    const client = makeClient();
    const reconnecting = new Promise((resolve) => client.once("reconnecting", resolve));
    client.start();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: "event", event: "connect.challenge", payload: {} });
    ws.receive({ type: "res", id: ws.lastSent().id, ok: true, payload: { type: "hello-ok" } });

    ws.close(1012, "upstream closed");
    await expect(reconnecting).resolves.toMatchObject({ attempt: 1, delayMs: 1000 });
    expect(client.connected).toBe(false);
    client.stop();
    await flush();
    // stop() cancels the pending reconnect, so no second socket is opened.
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
