# PRD — Telegram Integration & Enhanced 3D Animations

**Version:** 1.0
**Date:** 2026-10-05
**Author:** Devin (AI Assistant)
**Status:** APPROVED — Implementation In Progress

---

## 0. IMPLEMENTATION PROGRESS LOG (read this first if continuing)

> This section is for any AI agent / developer continuing the work. Update it after every step.

### Environment notes (Windows / Git Bash)

- `npm` on PATH is broken (points to missing `hermes/node/npm`). Use:
  `node "/c/Program Files/nodejs/node_modules/npm/bin/npm-cli.js" <command>`
- Node v22.23.2, npm 11.13.0
- `node_modules` was installed on 2026-10-05 (636 packages).

### Baseline captured 2026-10-05 (BEFORE any changes)

| Check | Result |
|-------|--------|
| `npm run lint` | 0 errors, 9 warnings |
| `npm run typecheck` | 0 errors |
| `npm run test -- --run` | 184 files: 182 passed, 2 failed. 1224 tests: 1222 passed, 2 failed |

Pre-existing failing tests (must stay exactly these 2, no more):
1. `tests/unit/colorSemanticsGuard.test.ts` — GatewayConnectScreen.tsx uses raw amber classes (upstream issue)
2. `tests/unit/gatewayMediaRoute.test.ts` — Windows `EPERM` on symlink creation (OS-specific, not a code bug)

### Step status

| Step | Status | Notes |
|------|--------|-------|
| 0 Baseline | DONE | see above |
| 1.1 `.env.example` Telegram vars | DONE | appended at end of file |
| 1.2 `server/telegram-bridge-protocol.js` | DONE | `GatewayPeerClient` + pure helpers, reconnect w/ backoff |
| 1.3 `server/telegram-bridge.js` | DONE | commands: help/team/agent/who/reset/stop/status/model; streaming edits; 4096 split |
| 1.4 `package.json` script `telegram` | DONE | |
| 1.5 `npm install node-telegram-bot-api` | SKIPPED (by design) | **Deviation from PRD §4.8**: implemented with Node 22 global `fetch` + long polling instead. Zero new deps, zero supply-chain risk. |
| 1.6 `tests/unit/telegramBridgeProtocol.test.ts` | DONE | 9 tests pass (pure helpers + FakeWebSocket handshake/req-res/reconnect) |
| 1.7 Manual test with demo-gateway | DONE | Peer client → demo gateway: hello-ok, agents.list, chat.send per-user session, delta→final OK. Bridge boot: missing/invalid token → clear error, exit 1. Full Telegram round-trip needs a real `TELEGRAM_BOT_TOKEN` (user must test). |
| 1.9 AGENTS.md docs | DONE | "Telegram bridge" + "Enhanced animation overlays" sections appended |
| 2.1 `transitionAnimations.ts` | DONE | easing, `PoseTransitionTracker`, `hashUnit`, `periodicGesturePhase`, `resolveWalkDynamics` |
| 2.2 `particleEffects.tsx` | DONE | `AgentParticleEffects` — 4 pooled `THREE.Points` systems (typing/thinking/error/conversation), budget 0/100/200 by tier |
| 2.3 `roleVisuals.tsx` | DONE | `AgentRoleVisuals` + `classifyAgentRole` — 9 procedural icons, billboard above nameplate, hidden on low tier & far camera |
| 2.4 `agentAnimationEnhanced.tsx` | DONE | `EnhancedAgentModel` drop-in wrapper around `AgentModel` (pivot-compensated additive motion + monitor glow) |
| 2.4b `tests/unit/enhancedAgentAnimations.test.ts` | DONE | 7 tests pass |
| 2.5 lint/typecheck/test verify | DONE | lint 0 err/9 warn (same), typecheck 0 err, tests 2 failed (same 2 pre-existing) / 184 passed (+2 new files). Note: `useAgentSettingsMutationController.test.ts` is timing-flaky under CPU load; passes alone. |
| 3.x Integration into RetroOffice3D.tsx | DONE | Wired Phase 2 overlay components. Reverted EnhancedAgentModel wrapper to AgentObjectModel to fix position lerp jitter. Fixed arm pivot points (Minecraft style), flag geometry, and glass z-fighting. |
| 4.x Visual Alignment, Loading Rig & Camera Bounds | DONE | 1) Fixed RunningAvatarLoader 28px leg disconnect; 2) Redesigned 3D Minecraft character rig: seamless hip-to-torso connection (Y=0.20), floor-contact shoes (Y=0.00), upright sitting posture eliminating desk & chair penetration; 3) Clamped camera bounds to Y >= 0.5 in CameraRig & FocusCameraController preventing floor penetration; 4) Docked right-side block chat panel with Monocraft font and projection-based left framing; 5) 11 new focus camera unit tests passing, full Next.js build clean. |

### Integration recipe for Phase 3 (when approved)

All three overlays consume refs/state RetroOffice3D.tsx already has. Inside the `<Canvas>`:

```tsx
import { AgentParticleEffects } from "@/features/retro-office/systems/particleEffects";
import { AgentRoleVisuals } from "@/features/retro-office/systems/roleVisuals";
import { EnhancedAgentModel } from "@/features/retro-office/systems/agentAnimationEnhanced";

// 1. Overlays (siblings of the agent models):
<AgentParticleEffects agentsRef={agentsRef} config={qualityConfig}
  streamingByAgentId={animationState.streamingByAgentId}
  thinkingByAgentId={animationState.thinkingByAgentId} />
<AgentRoleVisuals agents={agents} agentsRef={agentsRef} agentLookupRef={agentLookupRef} config={qualityConfig} />

// 2. Replace each <AgentObjectModel .../> with <EnhancedAgentModel config={qualityConfig} .../>
//    (identical props; `config` is the only addition).
```

`qualityConfig` = the `GraphicsQualityConfig` already passed to `SceneAtmosphere`/`ScenePostFx`.

### How to run what was built

```bash
# Telegram bridge (needs a bot token from @BotFather in .env):
npm run demo-gateway      # or: npm run hermes-adapter
npm run telegram
npm run dev               # open http://localhost:3000/office to watch agents react to Telegram chats

# Tests for the new code only:
npm run test -- --run tests/unit/telegramBridgeProtocol.test.ts tests/unit/enhancedAgentAnimations.test.ts
```

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Existing System Audit](#2-existing-system-audit)
3. [Scope & Non-Goals](#3-scope--non-goals)
4. [Phase 1 — Telegram Bot Bridge](#4-phase-1--telegram-bot-bridge)
5. [Phase 2 — Enhanced 3D Animations](#5-phase-2--enhanced-3d-animations)
6. [Technical Risk Registry](#6-technical-risk-registry)
7. [File Change Map (No-Break Guarantee)](#7-file-change-map-no-break-guarantee)
8. [Testing Strategy](#8-testing-strategy)
9. [Implementation Order](#9-implementation-order)
10. [Success Criteria](#10-success-criteria)

---

## 1. Executive Summary

This PRD covers two enhancements to Hermes3D:

| Feature | What | Why |
|---------|------|-----|
| **Telegram Bot Bridge** | A standalone Node.js process that connects to the Hermes3D gateway via WebSocket and exposes agent interaction through a Telegram bot | Allows mobile/remote interaction with AI agents while the 3D office stays synchronized |
| **Enhanced 3D Animations** | Richer, more realistic procedural animations for agent characters using the existing Three.js + React Three Fiber pipeline | Makes the office visually compelling and each agent's specialty recognizable at a glance |

**Core Constraint:** Zero modifications to existing files that could introduce regressions. All changes are additive — new files only, or strictly append-only edits to configuration files (`.env.example`, `package.json` scripts, `AGENTS.md`).

---

## 2. Existing System Audit

### 2.1 Known Pre-Existing Issues (DO NOT TOUCH)

These issues exist in the current codebase and must not be altered or accidentally fixed during this work:

| Issue | Location | Notes |
|-------|----------|-------|
| Pre-existing ESLint error | `RetroOffice3D.tsx` | Known, documented in AGENTS.md |
| Stale `onOpenSettings` prop type errors | `agentChatPanel-*.test.ts` | Known, documented in AGENTS.md |
| Pre-existing Vitest test failures | Various test files | Known, documented in AGENTS.md |
| Pre-existing ESLint warnings | Various | Known, documented in AGENTS.md |

### 2.2 Current Animation System Map

**Agent States** (from `src/features/retro-office/core/types.ts:RenderAgent`):
- `walking` — Sinusoidal arm/leg swing, vertical bounce
- `sitting` — Forward lean (-0.15 rad), arms forward (0.3 rad)
- `standing` — Breathing idle, occasional ambient speech bubble
- `away` — Semi-transparent (0.45 opacity), droopy eyes/brows
- `working_out` — 6 workout styles: `run`, `lift`, `bike`, `box`, `row`, `stretch`
- `dancing` — Full-body rhythmic motion with z-rotation sway

**Agent Statuses** (from `src/features/retro-office/core/types.ts:OfficeAgent`):
- `working` — Green pulse ring, focused eyes, concentration mouth
- `idle` — Amber status dot, relaxed expression, smile corners
- `error` — Red pulse ring, furrowed brows, frown corners

**Facial Animation System** (from `src/features/retro-office/objects/agents.tsx`):
- Eye blinking with per-agent hash-seeded cycles
- Eye scale/position varies by state (working=focused, error=wide, away=closed)
- Mouth shape morphing (smile/frown/concentration/talking)
- Eyebrow rotation (relaxed/focused/worried/sad)
- Speech bubble visibility with ambient idle chance

**Scene Systems** (from `src/features/retro-office/systems/`):
- `atmosphere.tsx` — HDRI sky, daylight drift, fog, dust motes, park trees, shadow rig
- `cameraLighting.tsx` — Camera presets, follow-cam with DOF, orbit controls
- `sceneRuntime.tsx` — Game loop, floor raycaster, ping-pong ball physics
- `visualSystems.tsx` — Heatmap overlay, trail system
- `NavigationSystem.tsx` — Collision avoidance, bump resolution
- `conversationChatterAudio.ts` — Ambient murmur during huddles

**Office Interaction Rooms/Zones**:
- Desk cubicles (assigned per agent via Studio settings)
- Meeting room (standup meetings)
- Server room (GitHub/code review holds)
- Gym (6 workout machines with staged door entry)
- QA Lab (3 station types: console, device rack, bench)
- Phone booth (phone calls with staged door)
- SMS booth (text messaging with staged door)
- ATM machine
- Ping-pong table (2-player session)
- Jukebox (Spotify integration)
- Kanban board
- Kitchen area

**Event-Driven Animation Pipeline**:
```
Gateway Events → eventTriggers.ts (reduce/reconcile) →
  OfficeAnimationTriggerState → buildOfficeAnimationState() →
    OfficeAnimationState → RetroOffice3D.tsx (useAgentTick) →
      RenderAgent positions/states → AgentModel (useFrame animations)
```

### 2.3 Gateway Protocol Summary

**Connection:** WebSocket JSON frames
**Handshake:** `connect.challenge` → `connect` req → `hello-ok` res
**Core Methods:** `chat.send`, `chat.abort`, `chat.history`, `agents.list`, `sessions.list`, `sessions.reset`, `status`
**Streaming Events:** `chat` (delta/final/error/aborted), `presence`, `heartbeat`, `cron`
**Session Key Format:** `agent:<agentId>:<sessionType>` (e.g., `agent:hermes:main`)

---

## 3. Scope & Non-Goals

### In Scope

- Telegram bot bridge as a standalone Node.js process
- Enhanced procedural animations for agent characters
- New animation states for role-specific behaviors
- Particle effects for visual flair
- Configuration additions to `.env.example`
- New npm scripts in `package.json`

### Non-Goals (Explicitly Out of Scope)

- Modifying the gateway protocol itself
- Changing existing event trigger logic in `eventTriggers.ts`
- Modifying existing agent rendering in `agents.tsx`
- Altering the Studio proxy (`gateway-proxy.js`) or server (`index.js`)
- Adding database dependencies
- Multi-user Telegram auth (beyond simple user-ID allowlist)
- Modifying any existing test files
- Changing the Hermes adapter or demo gateway behavior

---

## 4. Phase 1 — Telegram Bot Bridge

### 4.1 Architecture

```
Telegram Cloud ←── HTTPS polling ──→ telegram-bridge.js
                                           │
                                           ├── WS ──→ Gateway (ws://localhost:18789)
                                           │              Any adapter: demo / hermes / custom
                                           │
                                           └── Logs ──→ stdout (same as other server/ scripts)
```

The bot is a **peer client** alongside the browser — both connect to the same gateway independently. The gateway broadcasts events to all connected clients, so:
- Chat sent from Telegram → agent responds → browser 3D office sees the activity
- Chat sent from browser → agent responds → Telegram bot can optionally relay

### 4.2 New Files

| File | Purpose |
|------|---------|
| `server/telegram-bridge.js` | Main bot process: Telegram polling, WS gateway client, message routing, streaming response editing |
| `server/telegram-bridge-protocol.js` | Gateway WS protocol helper: connect handshake, request/response tracking, event listener |

### 4.3 Configuration

Additions to `.env.example` (append-only, no existing lines modified):

```env
# ─── Telegram Bot Bridge ───
# Run `npm run telegram` to start the Telegram bridge.
# Requires a running gateway (demo, hermes-adapter, or any WS gateway).
#
# TELEGRAM_BOT_TOKEN=            # From @BotFather
# TELEGRAM_ALLOWED_USERS=        # Comma-separated Telegram user IDs (optional security filter)
# TELEGRAM_GATEWAY_URL=ws://localhost:18789
# TELEGRAM_GATEWAY_TOKEN=        # Gateway auth token, if configured
# TELEGRAM_DEFAULT_AGENT=        # Agent ID to chat with by default (empty = orchestrator/default)
# TELEGRAM_SESSION_MODE=shared   # "shared" = all users share main session, "per-user" = each Telegram user gets own session
```

New npm script in `package.json` (additive):
```json
"telegram": "node server/telegram-bridge.js"
```

### 4.4 Bot Commands

| Command | Action | Gateway Method |
|---------|--------|----------------|
| `/start` | Welcome message with usage instructions | — |
| `/team` | List all agents with names and roles | `agents.list` |
| `/agent <name> <message>` | Send message to specific agent | `chat.send` with matched agent's sessionKey |
| `/reset` | Reset current session history | `sessions.reset` |
| `/status` | Show gateway connection status + active agents | `status` |
| `/model` | Show current model info | `models.list` |
| `<any text>` | Send to default agent (orchestrator) | `chat.send` with default sessionKey |

### 4.5 Response Streaming UX

1. User sends message → Bot replies with "..." placeholder
2. Gateway streams `chat` delta events → Bot edits the placeholder message every ~500ms with accumulated text (Telegram rate limit: 30 edits/sec per chat, we stay well under)
3. Gateway sends `chat` final event → Bot sends one final edit with complete response
4. If response exceeds Telegram's 4096-char limit → split into multiple messages

### 4.6 Error Handling

| Scenario | Behavior |
|----------|----------|
| Gateway unreachable | Bot replies "Gateway offline. Check that `npm run demo-gateway` or `npm run hermes-adapter` is running." |
| Gateway disconnects mid-chat | Bot replies "Connection lost. Reconnecting..." + auto-reconnect with exponential backoff (1s, 2s, 5s, 15s, 30s max) |
| Bot token invalid | Process exits with clear error message |
| Unauthorized user | Message silently ignored (no reply to prevent info leaking) |
| Agent not found | Bot replies "Agent not found. Use /team to see available agents." |
| Chat error from gateway | Bot replies with the error message from the gateway |

### 4.7 Session Management

**Shared mode** (default): All Telegram users interact with the same `agent:<id>:main` session. Conversation history is shared. Simple, mirrors the browser behavior.

**Per-user mode**: Each Telegram user gets a unique session key: `agent:<id>:tg-<telegramUserId>`. The gateway adapter stores independent history per session key. Note: the current `hermes-gateway-adapter.js` already supports arbitrary session keys in `chat.send` — no adapter changes needed.

### 4.8 Dependency

| Package | Version | Purpose | Already in project? |
|---------|---------|---------|---------------------|
| `node-telegram-bot-api` | `^0.66.0` | Telegram Bot API wrapper | No — must `npm install` |
| `ws` | `^8.18.3` | WebSocket client | Yes — already a dependency |

The `node-telegram-bot-api` package has been published for years with stable releases. Version `0.66.0` was published well over 7 days ago and is the widely-used standard for Node.js Telegram bots.

---

## 5. Phase 2 — Enhanced 3D Animations

### 5.1 Design Principles

1. **Additive only** — New animation modules are imported and composed, never patching existing animation code
2. **Performance budget** — All enhancements must run at 60fps on integrated GPUs; particle counts and effect complexity scale with the existing `GraphicsQuality` system
3. **Role-recognizable** — Each agent specialty should be visually distinct from across the room
4. **Procedural** — No external 3D model assets; everything is built from Three.js primitives and shaders (following the existing convention in `agents.tsx`)

### 5.2 New Files

| File | Purpose |
|------|---------|
| `src/features/retro-office/systems/agentAnimationEnhanced.tsx` | Enhanced animation tick system — interpolates between states with easing, adds micro-animations |
| `src/features/retro-office/systems/particleEffects.tsx` | Particle effect components: typing sparks, thinking clouds, code rain, etc. |
| `src/features/retro-office/systems/roleVisuals.tsx` | Role-specific visual indicators: floating role icons, specialty tool props |
| `src/features/retro-office/systems/transitionAnimations.ts` | Easing/interpolation utilities for smooth state transitions |

### 5.3 Enhanced Agent Animations

#### 5.3.1 Smooth State Transitions (NEW: `transitionAnimations.ts`)

**Current behavior:** Agent states snap instantly (walking→sitting, standing→working_out).
**Enhanced behavior:** Smooth interpolation between states using easing curves.

```typescript
// Transition timing per state change
const STATE_TRANSITION_MS: Record<string, number> = {
  "standing→walking": 300,
  "walking→sitting": 500,
  "sitting→standing": 400,
  "standing→working_out": 600,
  "working_out→standing": 500,
  "standing→dancing": 400,
  "*→away": 800,      // Slow fade-out
  "away→*": 600,      // Gradual return
};
```

Implementation: Export easing helpers consumed by the enhanced animation tick. The existing `useFrame` in `agents.tsx` remains untouched; the enhanced system provides a wrapper that existing code can opt into via the new `agentAnimationEnhanced.tsx` component.

#### 5.3.2 Idle Micro-Animations (NEW: `agentAnimationEnhanced.tsx`)

Subtle animations when agents are in `standing` or `sitting` state:

| Animation | State | Description |
|-----------|-------|-------------|
| **Weight shift** | standing | Slow lateral sway (±0.02 rad z-rotation, 4s period) |
| **Head turn** | standing | Occasional look-around (±15deg y-rotation, random 8-15s interval) |
| **Typing rhythm** | sitting + working | Subtle hand oscillation suggesting keyboard use (varying speed to avoid uncanny sync) |
| **Stretch** | sitting (after 30s) | Occasional lean-back micro-stretch (every 45-90s, 2s duration) |
| **Coffee sip** | standing + idle | Arm-raise gesture when near coffee machine or with mug (rare, ambient) |
| **Foot tap** | standing + idle | Slight foot movement suggesting impatience (when idle >20s) |

#### 5.3.3 Walking Enhancements (NEW: `agentAnimationEnhanced.tsx`)

| Feature | Description |
|---------|-------------|
| **Head bob** | Subtle vertical head movement synced to walk cycle (half amplitude of body bounce) |
| **Torso twist** | Slight counter-rotation of upper body during walk (±0.04 rad, opposite phase of arms) |
| **Speed-based stride** | Faster walk speed = wider arm/leg swing amplitude + faster cycle |
| **Urgency run** | When `CONVERSATION_APPROACH_SPEED` or `WORKING_WALK_SPEED_MULTIPLIER` is active: forward lean (0.12 rad), wider stride, arm pump |

#### 5.3.4 Working State Enhancements (NEW: `agentAnimationEnhanced.tsx`)

When agent status is `working` and state is `sitting`:

| Feature | Description |
|---------|-------------|
| **Focused posture** | Slight forward lean increases with work duration (0.15 → 0.22 rad over 10s) |
| **Hand tracking** | Left/right hand alternating micro-movements simulating mouse + keyboard |
| **Screen glow** | Subtle face illumination pulse from "monitor" (every 2-4s, ambient light flicker) |
| **Quick glance** | Rapid head turn toward approaching agents (when another agent enters desk radius) |

### 5.4 Particle & Visual Effects

#### 5.4.1 Typing Particles (NEW: `particleEffects.tsx`)

When agent is `sitting` + `working`:
- Tiny luminous dots float upward from desk position
- Color: warm amber (#ffe0a0), matching the dust mote palette
- Count: 3-8 particles, lifetime 1.5s, additive blending
- Scales with `GraphicsQuality`: disabled on `low`, reduced on `medium`

#### 5.4.2 Thinking Cloud (NEW: `particleEffects.tsx`)

When agent is `sitting` + `working` + recent streaming delta received:
- Small translucent dots orbit slowly above agent's head
- Color: soft blue (#a7c4ef), matching the sky fill light
- 4-6 particles in a slow elliptical orbit (2s period)
- Fades in over 0.5s, fades out when streaming stops

#### 5.4.3 Error Spark (NEW: `particleEffects.tsx`)

When agent status is `error`:
- Occasional red spark burst from status dot
- 2-4 particles, sharp velocity, fast decay (0.3s)
- Triggered max once per 3s to avoid visual noise

#### 5.4.4 Conversation Visual (NEW: `particleEffects.tsx`)

When agents are in a conversation group:
- Subtle connecting line particles between speakers
- Warm tone matching `SUN_WARM` (#ffe3bd)
- Active speaker gets brighter/larger particles near head
- Disabled on `low` quality

### 5.5 Role-Specific Visuals

#### 5.5.1 Floating Role Indicator (NEW: `roleVisuals.tsx`)

A small procedural icon floats above each agent's nameplate, indicating their specialty:

| Role Keyword | Icon (Procedural 3D) | Color |
|-------------|---------------------|-------|
| orchestrator / manager | Small crown / star shape | Gold (#ffd700) |
| developer / coder / builder | Angle brackets `</>` text | Cyan (#06b6d4) |
| researcher / analyst | Magnifying glass shape | Purple (#a855f7) |
| designer / creative | Palette circle | Pink (#ec4899) |
| qa / tester / quality | Checkmark shield | Green (#22c55e) |
| security | Lock shape | Red (#ef4444) |
| devops / infra | Gear shape | Orange (#f97316) |
| writer / docs | Pen nib shape | Blue (#3b82f6) |
| (default/unknown) | Diamond shape | White (#e2e8f0) |

Implementation: Simple `<mesh>` geometry (torus, box, sphere combos) rendered as a small Billboard element. No text rendering (avoids font loading). The icon gently bobs up and down (0.01 amplitude, 3s period).

#### 5.5.2 Held Props per State (NEW: `roleVisuals.tsx`)

Small procedural objects held or visible when agents perform role-specific tasks:

| Scenario | Prop |
|----------|------|
| Working at desk + developer role | Floating code bracket near hands |
| Working at desk + writer role | Floating quill/pen near hands |
| Walking + orchestrator role | Clipboard-like flat rectangle in hand |
| In gym | (Already exists: dumbbells, etc. — no change) |
| Conversation group | (No prop — speech bubbles already exist) |

Props are optional, subtle (small scale), and only visible at medium camera distance or closer.

### 5.6 Performance Considerations

All new visual systems respect the existing `GraphicsQualityConfig`:

| Quality Level | Particles | Role Icons | Transitions | Micro-Anims |
|---------------|-----------|------------|-------------|-------------|
| `low` | OFF | OFF | ON (simple) | Basic only |
| `medium` | Reduced (50%) | ON | ON (full) | ON |
| `high` | Full | ON | ON (full) | ON |

Particle systems use `THREE.Points` (instanced), not individual meshes. Maximum total particle count across all agents: 200 (high), 100 (medium).

---

## 6. Technical Risk Registry

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | Telegram `node-telegram-bot-api` rate limits (30 msg edits/min/chat) | Medium | Low | Throttle edit calls to max 1 per 500ms per chat, batch delta text |
| R2 | Gateway WS disconnect during Telegram chat | Medium | Medium | Auto-reconnect with backoff; queue pending user messages for replay |
| R3 | Particle effects cause frame drops on weak GPUs | Medium | Medium | Tied to GraphicsQuality; particle count budget enforced; disabled on `low` |
| R4 | New animation code conflicts with existing `useFrame` in `agents.tsx` | Low | High | **New files only** — enhanced animations are opt-in wrapper components, never patching the existing useFrame |
| R5 | Telegram message >4096 chars from long agent response | High | Low | Split into multiple messages with numbered parts |
| R6 | Per-user Telegram sessions create unbounded session keys in adapter memory | Low | Medium | Document memory impact; adapter already handles arbitrary session keys; TTL pruning as future enhancement |
| R7 | Multiple Telegram bot instances connect to same gateway | Low | Low | Document single-instance requirement; gateway handles multiple clients naturally |

---

## 7. File Change Map (No-Break Guarantee)

### 7.1 New Files (create only)

```
server/
  telegram-bridge.js              ← Phase 1: Main Telegram bot
  telegram-bridge-protocol.js     ← Phase 1: Gateway WS client helper

src/features/retro-office/systems/
  agentAnimationEnhanced.tsx      ← Phase 2: Enhanced animation tick
  particleEffects.tsx             ← Phase 2: Particle effect components
  roleVisuals.tsx                 ← Phase 2: Role-specific visual indicators
  transitionAnimations.ts         ← Phase 2: Easing/interpolation utilities

tests/unit/
  telegramBridgeProtocol.test.ts  ← Phase 1 tests
  enhancedAgentAnimations.test.ts ← Phase 2 tests
```

### 7.2 Modified Files (append-only, safe edits)

| File | Change Type | What Changes |
|------|-------------|-------------|
| `package.json` | Add script | Add `"telegram": "node server/telegram-bridge.js"` to scripts |
| `package.json` | ~~Add dependency~~ | **Not needed** — implemented with Node's global `fetch` (see §0 step 1.5) |
| `.env.example` | Append lines | Add Telegram config variables at end of file |
| `AGENTS.md` | Append section | Document Telegram bridge and new animation systems |

### 7.3 Files NOT Modified (explicit protection list)

These files are explicitly protected and will not be changed:

```
server/index.js                           ← Studio server entry
server/gateway-proxy.js                   ← WS proxy
server/hermes-gateway-adapter.js          ← Hermes adapter
server/demo-gateway-adapter.js            ← Demo gateway
server/studio-settings.js                 ← Settings loader
server/access-gate.js                     ← Access control
server/network-policy.js                  ← Network policy

src/features/retro-office/RetroOffice3D.tsx           ← Main 3D scene (has known ESLint error)
src/features/retro-office/objects/agents.tsx           ← Agent rendering
src/features/retro-office/core/types.ts               ← Type definitions
src/features/retro-office/core/constants.ts           ← Constants
src/features/retro-office/core/navigation.ts          ← Nav grid
src/features/retro-office/systems/atmosphere.tsx      ← Atmosphere
src/features/retro-office/systems/sceneRuntime.tsx    ← Scene runtime
src/features/retro-office/systems/cameraLighting.tsx  ← Camera system

src/lib/office/eventTriggers.ts           ← Office animation triggers
src/lib/office/deskDirectives.ts          ← Intent parsing
src/lib/gateway/GatewayClient.ts          ← Gateway client

src/features/agents/state/*               ← All agent state files
src/features/office/screens/*             ← All office screens

tests/**                                  ← All existing test files
```

### 7.4 Integration Strategy for Phase 2

The enhanced animation components are designed as **overlay components** that can be added to the 3D scene declaratively without modifying `RetroOffice3D.tsx`. They consume the same `agentsRef` / `RenderAgent[]` data that existing systems already expose.

Future integration into `RetroOffice3D.tsx` can be done as a separate step:
1. Import the new components
2. Add them as children inside the existing `<Canvas>` element
3. Pass the existing `agentsRef` prop

This is a one-line-per-component addition that can be reviewed and tested independently.

---

## 8. Testing Strategy

### 8.1 Phase 1 — Telegram Bridge

| Test | Type | How |
|------|------|-----|
| Bot connects to gateway | Manual | Run `npm run demo-gateway` + `npm run telegram`, verify bot responds to `/start` |
| Chat round-trip | Manual | Send message in Telegram, verify response streams back |
| Office sync | Manual | Run `npm run dev` alongside, verify 3D office shows agent activity when Telegram chat happens |
| Agent selection | Manual | Test `/team` and `/agent <name> <msg>` commands |
| Reconnection | Manual | Kill gateway, verify bot auto-reconnects when gateway restarts |
| Unit: protocol helper | Automated | New test file `tests/unit/telegramBridgeProtocol.test.ts` testing frame construction and parsing |

### 8.2 Phase 2 — Enhanced Animations

| Test | Type | How |
|------|------|-----|
| No existing test breakage | Automated | Run `npm run test -- --run` and confirm same pass/fail as before |
| No new lint errors | Automated | Run `npm run lint` and confirm no new errors (existing known error in RetroOffice3D.tsx unchanged) |
| No new type errors | Automated | Run `npm run typecheck` and confirm no new errors (existing known errors unchanged) |
| Visual regression | Manual | Compare office rendering before/after with demo gateway running |
| Performance | Manual | Verify 60fps on medium-spec hardware with all effects on `high` |
| Quality scaling | Manual | Toggle graphics quality and verify effects scale down correctly |

### 8.3 Pre-Existing Test Baseline

Before starting implementation, document the current test state:
```bash
npm run test -- --run 2>&1 | tail -20   # Capture current pass/fail count
npm run lint 2>&1 | tail -10            # Capture current warning/error count
npm run typecheck 2>&1 | tail -10       # Capture current error count
```

After implementation, these numbers must be identical or improved (fewer failures), never worse.

---

## 9. Implementation Order

### Phase 1 — Telegram Bot Bridge

```
Step 1.1  Add TELEGRAM_* vars to .env.example (append)
Step 1.2  Create server/telegram-bridge-protocol.js (gateway WS client helper)
Step 1.3  Create server/telegram-bridge.js (main bot with all commands)
Step 1.4  Add "telegram" script to package.json
Step 1.5  npm install node-telegram-bot-api
Step 1.6  Create tests/unit/telegramBridgeProtocol.test.ts
Step 1.7  Manual integration test with demo-gateway
Step 1.8  Manual integration test with hermes-adapter (if available)
Step 1.9  Update AGENTS.md with Telegram bridge documentation
```

### Phase 2 — Enhanced 3D Animations

```
Step 2.1  Create src/features/retro-office/systems/transitionAnimations.ts
Step 2.2  Create src/features/retro-office/systems/particleEffects.tsx
Step 2.3  Create src/features/retro-office/systems/roleVisuals.tsx
Step 2.4  Create src/features/retro-office/systems/agentAnimationEnhanced.tsx
Step 2.5  Run lint + typecheck to verify zero new errors
Step 2.6  Manual visual testing with demo-gateway
Step 2.7  Performance profiling on target hardware
Step 2.8  Update AGENTS.md with animation system documentation
```

### Phase 3 — Integration (Separate PR / Approval Step)

```
Step 3.1  Import enhanced animation components into RetroOffice3D.tsx
Step 3.2  Visual review and approval
Step 3.3  Final regression test suite
```

---

## 10. Success Criteria

### Phase 1 — Telegram Bot

- [ ] Bot responds to all 6 commands (`/start`, `/team`, `/agent`, `/reset`, `/status`, `/model`)
- [ ] Free-text messages route to default agent and stream response back
- [ ] Responses stream with visible "typing" effect (message edits)
- [ ] Long responses (>4096 chars) split correctly
- [ ] Bot auto-reconnects after gateway restart within 30s
- [ ] 3D office shows agent animation when chat originates from Telegram
- [ ] Per-user session mode creates isolated conversation histories
- [ ] No existing tests broken
- [ ] No new lint/typecheck errors

### Phase 2 — Enhanced Animations

- [ ] Idle agents show visible micro-animations (weight shift, head turn)
- [ ] Working agents show typing rhythm and thinking particles
- [ ] Walking agents show enhanced body mechanics (head bob, torso twist)
- [ ] State transitions are smooth (no snapping)
- [ ] Role icons float above agent nameplates
- [ ] Error state shows spark particles
- [ ] All effects disabled on `low` quality setting
- [ ] Maintained 60fps with 10 agents on medium-spec hardware
- [ ] No existing tests broken
- [ ] No new lint/typecheck errors
- [ ] Pre-existing ESLint error in RetroOffice3D.tsx unchanged

---

## Appendix A — Gateway Protocol Reference (for Telegram Bridge)

### Connect Handshake

```json
// 1. Gateway sends challenge
{"type":"event","event":"connect.challenge","payload":{"nonce":"abc123"}}

// 2. Client sends connect
{"type":"req","id":"c1","method":"connect","params":{"auth":{"token":"..."},"client":{"id":"telegram-bridge","mode":"telegram"}}}

// 3. Gateway responds
{"type":"res","id":"c1","ok":true,"payload":{"type":"hello-ok","protocol":3,"adapterType":"hermes","features":{...},"snapshot":{...}}}
```

### Chat Flow

```json
// Send message
{"type":"req","id":"m1","method":"chat.send","params":{"sessionKey":"agent:hermes:main","message":"Hello","idempotencyKey":"unique123"}}

// Immediate response
{"type":"res","id":"m1","ok":true,"payload":{"status":"started","runId":"run-xyz"}}

// Stream events (multiple)
{"type":"event","event":"chat","payload":{"runId":"run-xyz","sessionKey":"agent:hermes:main","state":"delta","message":{"role":"assistant","content":"Partial..."}}}

// Final event
{"type":"event","event":"chat","payload":{"runId":"run-xyz","sessionKey":"agent:hermes:main","state":"final","stopReason":"end_turn","message":{"role":"assistant","content":"Full response"}}}
```

### List Agents

```json
{"type":"req","id":"a1","method":"agents.list","params":{}}
// Response includes: { defaultId, mainKey, agents: [{id, name, role, ...}] }
```

## Appendix B — Existing Constants Reference

From `src/features/retro-office/core/constants.ts`:

| Constant | Value | Used For |
|----------|-------|----------|
| `WALK_SPEED` | 0.3 | Base agent walk speed |
| `WALK_ANIM_SPEED` | 0.15 | Walk cycle frequency |
| `AGENT_SCALE` | 1.75 | Agent model scale |
| `CONVERSATION_APPROACH_SPEED` | WALK_SPEED * 4.5 | Hurry speed for conversation groups |
| `WORKING_WALK_SPEED_MULTIPLIER` | 3 | Speed boost when working |
| `BUMP_RECOVERY_MS` | 1200 | Collision recovery time |
| `CANVAS_W` / `CANVAS_H` | 1800 | Office floor dimensions |
| `SCALE` | 0.018 | Canvas-to-world coordinate scale |

## Appendix C — Quality Config Integration Point

From `src/features/retro-office/core/graphicsQuality.ts`, the `GraphicsQualityConfig` object is already consumed by all scene systems. New effects should check:

```typescript
// Existing pattern — follow this for new effects
if (!config.postProcessing) return null;   // Low quality
if (!config.bloom) return null;            // Medium without bloom
```

New particle/visual systems should accept `config: GraphicsQualityConfig` and respect the same flags.
