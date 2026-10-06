"use strict";

/**
 * Telegram Bot Bridge for Hermes3D
 *
 * Connects to a Hermes3D gateway (demo, hermes-adapter, or any peer speaking the
 * gateway protocol) as an ordinary WS client and exposes the agents through a
 * Telegram bot. Because the bridge is a peer of the browser, every chat sent
 * from Telegram shows up as agent activity in the 3D office.
 *
 * Zero extra dependencies: uses Node's global fetch for the Telegram HTTP API
 * (long polling) and the `ws` package already in this repo for the gateway.
 *
 * Environment variables (see .env.example):
 *   TELEGRAM_BOT_TOKEN       required
 *   TELEGRAM_ALLOWED_USERS   comma-separated user ids; empty = allow all
 *   TELEGRAM_GATEWAY_URL     default ws://localhost:18789
 *   TELEGRAM_GATEWAY_TOKEN   optional
 *   TELEGRAM_DEFAULT_AGENT   optional agent id; empty = gateway default
 *   TELEGRAM_SESSION_MODE    "shared" (default) | "per-user"
 */

const fs = require("node:fs");
const path = require("node:path");
const {
  GatewayPeerClient,
  buildSessionKey,
  extractChatText,
} = require("./telegram-bridge-protocol");

// ---------------------------------------------------------------------------
// .env loading (same approach as hermes-gateway-adapter.js)
// ---------------------------------------------------------------------------

function loadDotenvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    let value = rawValue.replace(/\s+#.*$/, "").trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
loadDotenvFile(path.join(process.cwd(), ".env.local"));
loadDotenvFile(path.join(process.cwd(), ".env"));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const GATEWAY_URL = (process.env.TELEGRAM_GATEWAY_URL || "ws://localhost:18789").trim();
const GATEWAY_TOKEN = (process.env.TELEGRAM_GATEWAY_TOKEN || "").trim();
const DEFAULT_AGENT = (process.env.TELEGRAM_DEFAULT_AGENT || "").trim();
const SESSION_MODE = (process.env.TELEGRAM_SESSION_MODE || "shared").trim() === "per-user" ? "per-user" : "shared";
const ALLOWED_USERS = new Set(
  (process.env.TELEGRAM_ALLOWED_USERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_MAX_MESSAGE_CHARS = 4096;
const STREAM_EDIT_INTERVAL_MS = 700;
const POLL_TIMEOUT_S = 30;
const TYPING_ACTION_INTERVAL_MS = 4_000;

if (!BOT_TOKEN) {
  console.error("[telegram-bridge] TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather and add the token to .env");
  process.exit(1);
}

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
const redactToken = (s) => (typeof s === "string" && BOT_TOKEN ? s.split(BOT_TOKEN).join("[REDACTED]") : s);

// ---------------------------------------------------------------------------
// Telegram HTTP API (minimal)
// ---------------------------------------------------------------------------

async function tg(method, body) {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    const err = new Error(`telegram ${method}: ${json.description || res.status}`);
    err.telegram = json;
    throw err;
  }
  return json.result;
}

const sendMessage = (chatId, text, extra) =>
  tg("sendMessage", { chat_id: chatId, text, ...extra });
const editMessageText = (chatId, messageId, text, extra) =>
  tg("editMessageText", { chat_id: chatId, message_id: messageId, text, ...extra });
const sendChatAction = (chatId, action = "typing") =>
  tg("sendChatAction", { chat_id: chatId, action }).catch(() => {});

/** Split long text on paragraph/line boundaries to fit Telegram's limit. */
function splitForTelegram(text, max = TELEGRAM_MAX_MESSAGE_CHARS) {
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest) out.push(rest);
  return out;
}

// ---------------------------------------------------------------------------
// Gateway peer client
// ---------------------------------------------------------------------------

const gateway = new GatewayPeerClient({
  url: GATEWAY_URL,
  token: GATEWAY_TOKEN,
  clientId: "telegram-bridge",
  mode: "telegram",
  log,
});

/** @type {Map<string, {id:string,name:string,role?:string}>} */
let agentIndex = new Map();
let defaultAgentId = DEFAULT_AGENT || null;

async function refreshAgents() {
  try {
    const payload = await gateway.listAgents();
    const agents = Array.isArray(payload?.agents) ? payload.agents : [];
    agentIndex = new Map(agents.map((a) => [a.id, { id: a.id, name: a.name || a.id, role: a.role || "" }]));
    if (!DEFAULT_AGENT) {
      defaultAgentId = payload?.defaultId || gateway.defaultAgentId || agents[0]?.id || null;
    }
    log(`[telegram-bridge] agents: ${[...agentIndex.values()].map((a) => `${a.name}(${a.id})`).join(", ") || "(none)"}; default=${defaultAgentId}`);
  } catch (err) {
    log(`[telegram-bridge] agents.list failed: ${err.message}`);
  }
}

/** Resolve a user-typed agent reference (id, name, or name prefix) → agent. */
function resolveAgent(ref) {
  const needle = (ref || "").trim().toLowerCase();
  if (!needle) return null;
  if (agentIndex.has(needle)) return agentIndex.get(needle);
  for (const a of agentIndex.values()) {
    if (a.id.toLowerCase() === needle || a.name.toLowerCase() === needle) return a;
  }
  for (const a of agentIndex.values()) {
    if (a.name.toLowerCase().startsWith(needle) || a.id.toLowerCase().startsWith(needle)) return a;
  }
  return null;
}

function sessionKeyFor(agentId, telegramUserId) {
  return SESSION_MODE === "per-user"
    ? buildSessionKey(agentId, `tg-${telegramUserId}`)
    : buildSessionKey(agentId, "main");
}

// ---------------------------------------------------------------------------
// Per-chat state
// ---------------------------------------------------------------------------

/** chatId → agentId the chat is currently talking to */
const chatAgent = new Map();

/**
 * runId → active stream state
 * @type {Map<string, {chatId:number, messageId:number|null, text:string, lastEditAt:number, editTimer:NodeJS.Timeout|null, typingTimer:NodeJS.Timeout|null, done:boolean, sessionKey:string}>}
 */
const activeStreams = new Map();
/** sessionKey → runId, for runs we started whose events arrive before the res */
const sessionToRun = new Map();

async function flushStreamEdit(stream, force = false) {
  const now = Date.now();
  if (!force && now - stream.lastEditAt < STREAM_EDIT_INTERVAL_MS) {
    if (!stream.editTimer) {
      stream.editTimer = setTimeout(() => {
        stream.editTimer = null;
        void flushStreamEdit(stream, true);
      }, STREAM_EDIT_INTERVAL_MS - (now - stream.lastEditAt));
    }
    return;
  }
  stream.lastEditAt = now;
  const preview = stream.text.trim() || "…";
  const shown = preview.length > TELEGRAM_MAX_MESSAGE_CHARS - 2 ? `${preview.slice(0, TELEGRAM_MAX_MESSAGE_CHARS - 2)}…` : preview;
  if (shown === stream.lastShown) return;
  stream.lastShown = shown;
  try {
    if (stream.messageId == null) {
      const msg = await sendMessage(stream.chatId, shown);
      stream.messageId = msg.message_id;
    } else {
      await editMessageText(stream.chatId, stream.messageId, shown);
    }
  } catch (err) {
    // "message is not modified" is harmless; log everything else quietly.
    if (!/not modified/i.test(err.message)) log(`[telegram-bridge] edit failed: ${redactToken(err.message)}`);
  }
}

function endStream(stream) {
  stream.done = true;
  if (stream.editTimer) clearTimeout(stream.editTimer);
  if (stream.typingTimer) clearInterval(stream.typingTimer);
  activeStreams.delete(stream.runId);
  if (sessionToRun.get(stream.sessionKey) === stream.runId) sessionToRun.delete(stream.sessionKey);
}

async function finalizeStream(stream, finalText) {
  const text = (finalText || stream.text || "").trim() || "(empty response)";
  const parts = splitForTelegram(text);
  try {
    if (stream.messageId == null) {
      const msg = await sendMessage(stream.chatId, parts[0]);
      stream.messageId = msg.message_id;
    } else if (parts[0] !== stream.lastShown) {
      await editMessageText(stream.chatId, stream.messageId, parts[0]);
    }
    for (let i = 1; i < parts.length; i += 1) {
      await sendMessage(stream.chatId, parts[i]);
    }
  } catch (err) {
    if (!/not modified/i.test(err.message)) log(`[telegram-bridge] finalize failed: ${redactToken(err.message)}`);
  }
  endStream(stream);
}

gateway.on("chat", (payload) => {
  const runId = typeof payload.runId === "string" ? payload.runId : null;
  const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : "";
  let stream = runId ? activeStreams.get(runId) : null;
  if (!stream && sessionKey && sessionToRun.has(sessionKey)) {
    // Our chat.send response may not have arrived yet; adopt by session.
    const pendingRunId = sessionToRun.get(sessionKey);
    stream = activeStreams.get(pendingRunId);
    if (stream && runId && pendingRunId !== runId) {
      activeStreams.delete(pendingRunId);
      stream.runId = runId;
      activeStreams.set(runId, stream);
      sessionToRun.set(sessionKey, runId);
    }
  }
  if (!stream || stream.done) return;

  const state = payload.state;
  if (state === "delta") {
    stream.text = extractChatText(payload) || stream.text;
    void flushStreamEdit(stream);
  } else if (state === "final") {
    void finalizeStream(stream, extractChatText(payload));
  } else if (state === "error") {
    void finalizeStream(stream, `⚠️ Agent error: ${payload.errorMessage || "unknown error"}`);
  } else if (state === "aborted") {
    void finalizeStream(stream, `${stream.text.trim()}\n\n(aborted)`.trim());
  }
});

gateway.on("hello", () => {
  log(`[telegram-bridge] gateway connected (${GATEWAY_URL})`);
  void refreshAgents();
});
gateway.on("disconnected", ({ code }) => {
  log(`[telegram-bridge] gateway disconnected (${code}); active streams: ${activeStreams.size}`);
  for (const stream of [...activeStreams.values()]) {
    void finalizeStream(stream, `${stream.text.trim()}\n\n⚠️ Connection to gateway lost. Reconnecting…`.trim());
  }
});
gateway.on("error", () => {});

// ---------------------------------------------------------------------------
// Command handling
// ---------------------------------------------------------------------------

const HELP_TEXT = [
  "🏢 Hermes3D Telegram Bridge",
  "",
  "Send any text to chat with the current agent.",
  "",
  "Commands:",
  "/team — list agents",
  "/agent <name> — switch which agent you talk to",
  "/agent <name> <message> — one-off message to an agent",
  "/who — show current agent",
  "/reset — clear this session's history",
  "/stop — abort the current response",
  "/status — gateway status",
  "/model — list models",
].join("\n");

function gatewayOfflineText() {
  return `⚠️ Gateway offline (${GATEWAY_URL}).\nStart it with \`npm run demo-gateway\` or \`npm run hermes-adapter\`, the bridge reconnects automatically.`;
}

async function handleChatMessage(chatId, userId, agentId, text) {
  if (!gateway.connected) {
    await sendMessage(chatId, gatewayOfflineText());
    return;
  }
  const agent = agentIndex.get(agentId);
  if (!agent) {
    await sendMessage(chatId, "Agent not found. Use /team to see available agents.");
    return;
  }
  const sessionKey = sessionKeyFor(agentId, userId);
  if (sessionToRun.has(sessionKey)) {
    await sendMessage(chatId, "⏳ Still answering the previous message. Use /stop to abort it.");
    return;
  }

  const provisionalRunId = `pending-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stream = {
    runId: provisionalRunId,
    chatId,
    sessionKey,
    messageId: null,
    text: "",
    lastShown: "",
    lastEditAt: 0,
    editTimer: null,
    typingTimer: null,
    done: false,
  };
  activeStreams.set(provisionalRunId, stream);
  sessionToRun.set(sessionKey, provisionalRunId);
  void sendChatAction(chatId);
  stream.typingTimer = setInterval(() => void sendChatAction(chatId), TYPING_ACTION_INTERVAL_MS);

  try {
    const res = await gateway.sendChat({ sessionKey, message: text });
    const runId = typeof res?.runId === "string" ? res.runId : null;
    if (res?.status === "no-op") {
      endStream(stream);
      return;
    }
    if (runId && activeStreams.get(provisionalRunId) === stream) {
      activeStreams.delete(provisionalRunId);
      stream.runId = runId;
      activeStreams.set(runId, stream);
      sessionToRun.set(sessionKey, runId);
    }
    log(`[telegram-bridge] chat.send → ${agent.name} (${sessionKey}) run=${stream.runId}`);
  } catch (err) {
    endStream(stream);
    await sendMessage(chatId, `⚠️ Failed to send: ${err.message}`);
  }
}

async function handleCommand(chatId, userId, command, args) {
  switch (command) {
    case "start":
    case "help":
      await sendMessage(chatId, HELP_TEXT);
      return;

    case "team": {
      if (!gateway.connected) return void (await sendMessage(chatId, gatewayOfflineText()));
      await refreshAgents();
      if (agentIndex.size === 0) return void (await sendMessage(chatId, "No agents reported by the gateway."));
      const current = chatAgent.get(chatId) || defaultAgentId;
      const lines = [...agentIndex.values()].map(
        (a) => `${a.id === current ? "▶" : "•"} ${a.name}${a.role ? ` — ${a.role}` : ""}\n   id: ${a.id}`,
      );
      await sendMessage(chatId, `👥 Team (${agentIndex.size}):\n\n${lines.join("\n")}`);
      return;
    }

    case "agent": {
      if (!gateway.connected) return void (await sendMessage(chatId, gatewayOfflineText()));
      if (agentIndex.size === 0) await refreshAgents();
      const [ref, ...rest] = args;
      if (!ref) return void (await sendMessage(chatId, "Usage: /agent <name> [message]"));
      const agent = resolveAgent(ref);
      if (!agent) return void (await sendMessage(chatId, `Agent "${ref}" not found. Use /team.`));
      const message = rest.join(" ").trim();
      if (message) {
        await handleChatMessage(chatId, userId, agent.id, message);
      } else {
        chatAgent.set(chatId, agent.id);
        await sendMessage(chatId, `▶ Now talking to ${agent.name}${agent.role ? ` (${agent.role})` : ""}.`);
      }
      return;
    }

    case "who": {
      const id = chatAgent.get(chatId) || defaultAgentId;
      const a = id ? agentIndex.get(id) : null;
      await sendMessage(chatId, a ? `▶ Current agent: ${a.name} (${a.id})\nSession: ${sessionKeyFor(a.id, userId)}` : "No agent selected yet.");
      return;
    }

    case "reset": {
      if (!gateway.connected) return void (await sendMessage(chatId, gatewayOfflineText()));
      const id = chatAgent.get(chatId) || defaultAgentId;
      if (!id) return void (await sendMessage(chatId, "No agent selected."));
      const key = sessionKeyFor(id, userId);
      try {
        await gateway.resetSession(key);
        await sendMessage(chatId, `🧹 Session reset: ${key}`);
      } catch (err) {
        await sendMessage(chatId, `⚠️ Reset failed: ${err.message}`);
      }
      return;
    }

    case "stop": {
      const id = chatAgent.get(chatId) || defaultAgentId;
      const key = id ? sessionKeyFor(id, userId) : null;
      const runId = key ? sessionToRun.get(key) : null;
      if (!runId || !gateway.connected) return void (await sendMessage(chatId, "Nothing to stop."));
      try {
        await gateway.abortChat({ runId: runId.startsWith("pending-") ? undefined : runId, sessionKey: key });
        await sendMessage(chatId, "⏹ Abort requested.");
      } catch (err) {
        await sendMessage(chatId, `⚠️ Abort failed: ${err.message}`);
      }
      return;
    }

    case "status": {
      if (!gateway.connected) return void (await sendMessage(chatId, gatewayOfflineText()));
      try {
        const [st] = await Promise.all([gateway.status(), refreshAgents()]);
        const recent = Array.isArray(st?.sessions?.recent) ? st.sessions.recent.length : 0;
        await sendMessage(
          chatId,
          [
            `✅ Gateway connected`,
            `URL: ${GATEWAY_URL}`,
            `Adapter: ${gateway.hello?.adapterType || "?"} (protocol ${gateway.hello?.protocol || "?"})`,
            `Agents: ${agentIndex.size}`,
            `Active sessions: ${recent}`,
            `Session mode: ${SESSION_MODE}`,
          ].join("\n"),
        );
      } catch (err) {
        await sendMessage(chatId, `⚠️ status failed: ${err.message}`);
      }
      return;
    }

    case "model": {
      if (!gateway.connected) return void (await sendMessage(chatId, gatewayOfflineText()));
      try {
        const res = await gateway.listModels();
        const models = Array.isArray(res?.models) ? res.models : [];
        await sendMessage(chatId, models.length ? `🧠 Models:\n${models.map((m) => `• ${m.name || m.id}`).join("\n")}` : "No models reported.");
      } catch (err) {
        await sendMessage(chatId, `⚠️ models.list failed: ${err.message}`);
      }
      return;
    }

    default:
      await sendMessage(chatId, `Unknown command /${command}. Send /help.`);
  }
}

async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg || typeof msg.text !== "string") return;
  const chatId = msg.chat?.id;
  const userId = msg.from?.id;
  if (chatId == null || userId == null) return;

  if (ALLOWED_USERS.size > 0 && !ALLOWED_USERS.has(String(userId))) {
    log(`[telegram-bridge] ignored message from unauthorized user ${userId}`);
    return;
  }

  const text = msg.text.trim();
  const cmdMatch = text.match(/^\/([a-zA-Z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (cmdMatch) {
    const command = cmdMatch[1].toLowerCase();
    const args = (cmdMatch[2] || "").trim().split(/\s+/).filter(Boolean);
    await handleCommand(chatId, userId, command, args);
    return;
  }

  if (agentIndex.size === 0 && gateway.connected) await refreshAgents();
  const agentId = chatAgent.get(chatId) || defaultAgentId;
  if (!agentId) {
    await sendMessage(chatId, gateway.connected ? "No agents available. Try /team." : gatewayOfflineText());
    return;
  }
  await handleChatMessage(chatId, userId, agentId, text);
}

// ---------------------------------------------------------------------------
// Long polling loop
// ---------------------------------------------------------------------------

let pollOffset = 0;
let stopping = false;

async function pollLoop() {
  while (!stopping) {
    try {
      const updates = await tg("getUpdates", {
        offset: pollOffset,
        timeout: POLL_TIMEOUT_S,
        allowed_updates: ["message", "edited_message"],
      });
      for (const update of updates) {
        pollOffset = Math.max(pollOffset, update.update_id + 1);
        handleUpdate(update).catch((err) => log(`[telegram-bridge] update error: ${redactToken(err.message)}`));
      }
    } catch (err) {
      const status = err.telegram?.error_code;
      if (status === 401) {
        console.error("[telegram-bridge] Telegram rejected the bot token (401). Check TELEGRAM_BOT_TOKEN.");
        process.exit(1);
      }
      if (status === 409) {
        log("[telegram-bridge] 409 Conflict: another instance of this bot is polling. Only one bridge may run per bot token.");
      } else {
        log(`[telegram-bridge] poll error: ${redactToken(err.message)}`);
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
}

async function main() {
  const me = await tg("getMe").catch((err) => {
    console.error(`[telegram-bridge] getMe failed: ${redactToken(err.message)}`);
    process.exit(1);
  });
  log(`[telegram-bridge] ✓ Bot @${me.username} (id ${me.id})`);
  log(`[telegram-bridge] ✓ Gateway ${GATEWAY_URL} (token ${GATEWAY_TOKEN ? "present" : "absent"})`);
  log(`[telegram-bridge] ✓ Session mode: ${SESSION_MODE}; allowed users: ${ALLOWED_USERS.size || "all"}`);

  await tg("setMyCommands", {
    commands: [
      { command: "help", description: "Show help" },
      { command: "team", description: "List agents" },
      { command: "agent", description: "Switch / message an agent" },
      { command: "who", description: "Current agent" },
      { command: "reset", description: "Reset session history" },
      { command: "stop", description: "Abort current response" },
      { command: "status", description: "Gateway status" },
      { command: "model", description: "List models" },
    ],
  }).catch(() => {});

  gateway.start();
  await pollLoop();
}

const shutdown = () => {
  if (stopping) return;
  stopping = true;
  log("[telegram-bridge] shutting down");
  gateway.stop();
  setTimeout(() => process.exit(0), 200);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("[telegram-bridge] fatal:", redactToken(err?.message || String(err)));
  process.exit(1);
});
