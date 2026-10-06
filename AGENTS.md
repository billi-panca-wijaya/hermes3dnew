# Agent Instructions

Keep repository instructions generic and safe for open source.

This repo is the Hermes3D frontend. It talks to the Hermes backend over the gateway WebSocket protocol and does not contain the backend itself.

When the user asks for changes, they are asking for changes to this app. Apply solutions here, and treat the gateway protocol and the Hermes HTTP API as external contracts you read rather than edit.

If you use local private overlay instructions, keep them outside the repository and do not commit them here.

Do not commit personal, environment-specific, or secret instructions to this repository.

## Development environment instructions

### Service overview

Hermes3D is a Next.js 16 frontend (TypeScript, React 19, Three.js, Phaser) for the Hermes backend. It runs a custom Node.js server (`server/index.js`) that bundles a same-origin WebSocket proxy to the upstream gateway. No database or Docker is required. The only hard system dependency is Node.js 20+ with npm 10+.

### Running the app

- `npm run dev` starts the dev server on port 43210 via the custom server (`node server/index.js --dev`).
- `npm run hermes-adapter` starts the bundled Hermes gateway adapter (`server/hermes-gateway-adapter.js`) on `ws://localhost:18789`. `npm run demo-gateway` starts the mock gateway instead.
- The app requires a running gateway to show agent data. Without one, the UI loads but shows the gateway connection form. This is expected and not an error.
- `.env` is copied from `.env.example`; see `README.md` "Configuration" for variable descriptions.

### Lint, typecheck, and tests

- `npm run lint` — ESLint. The codebase has a small number of pre-existing warnings and one pre-existing error (in `RetroOffice3D.tsx`).
- `npm run typecheck` — `tsc --noEmit`. Pre-existing type errors exist in some test files (`agentChatPanel-*.test.ts`) due to a stale `onOpenSettings` prop.
- `npm run test -- --run` — Vitest unit tests (use `--run` for single-run mode). A few pre-existing failures exist.
- `npm run e2e` — Playwright E2E tests; requires `npx playwright install` first.
- `npm run smoke:dev-server` — starts the dev server on a random port and verifies HTTP response.

### Build

- `npm run build` — Next.js production build.

### Gotchas

- `npm run studio:setup` is interactive (TTY prompts) — avoid running it in non-interactive cloud environments.
- Vitest runs in watch mode by default; always pass `--run` for CI/cloud agent use.
- On Windows, `tests/unit/gatewayMediaRoute.test.ts` fails with `EPERM` (symlink creation needs elevated rights). This is OS-specific, not a code bug.
- `tests/unit/useAgentSettingsMutationController.test.ts` is timing-sensitive and can fail under heavy CPU load (e.g. lint running in parallel); re-run it alone.
- The React Compiler ESLint rule (`react-hooks/immutability`) forbids mutating values returned from `useMemo`/hooks inside `useFrame`. For per-frame buffers, build a `THREE.BufferGeometry` once and write into `geometry.getAttribute(...).array` (see `systems/atmosphere.tsx` `DustMotes` and `systems/particleEffects.tsx`).

### Telegram bridge

- `npm run telegram` starts `server/telegram-bridge.js`, a peer WebSocket client of the gateway (same protocol the browser uses), exposed as a Telegram bot. Requires `TELEGRAM_BOT_TOKEN` in `.env`; see `.env.example` for the other `TELEGRAM_*` variables.
- It has no extra npm dependency: Telegram's HTTP API is called with Node's global `fetch` (long polling), the gateway with the existing `ws` package.
- `server/telegram-bridge-protocol.js` is the reusable gateway client (`GatewayPeerClient`, frame builders, session-key helpers). Unit tests: `tests/unit/telegramBridgeProtocol.test.ts`.
- Session keys follow `agent:<agentId>:<type>`; `TELEGRAM_SESSION_MODE=per-user` uses `tg-<telegramUserId>` as the type so every Telegram user gets isolated history without adapter changes.

### Enhanced animation overlays

- `src/features/retro-office/systems/transitionAnimations.ts`, `particleEffects.tsx`, `roleVisuals.tsx`, `agentAnimationEnhanced.tsx` are additive overlay components that read `agentsRef`/`OfficeAnimationState` and never mutate agent state. They are integrated directly into `RetroOffice3D.tsx`.
- All of them respect `GraphicsQualityConfig`: fully off when `postProcessing` is false (low tier).
- `PRD.md` is the living progress log for this work — update its §0 table when continuing.
### Handoff / Continuation State (2026-10-06)

**Phase 4 Visual Realignment & System Polish is COMPLETE and TESTED.**
- **Rig Proportions & Overlap Fix (`agents.tsx`)**:
  - Floor contact: shoes start at Y=0.00 and extend to Y=0.04.
  - Pants: span Y=0.04 to Y=0.20 (full 0.16 height completely visible, no truncation).
  - Hip pivot: Y=0.20. Torso & jacket start exactly at Y=0.20 and span to Y=0.38 (zero overlap between legs and torso).
  - Arm shoulder pivots: Y=0.35, hanging down to Y=0.175.
  - Sitting posture: removed forward spine tilt (`rotation.x = 0` when seated) and shortened typing reach (`-0.42` rad) to prevent penetrating desk and chair props.
- **Loading Avatar Rig Connection (`RunningAvatarLoader.tsx`)**:
  - Fixed 28px visual disconnect between torso and legs. Added `height: 7 * S` to `.ra-leg-l` and `.ra-leg-r` containers anchored at `bottom: 0`, ensuring hip rotation origins (`50% 0`) directly meet the bottom edge of the torso (`bottom: 7 * S`).
- **Camera Floor Protection (`RetroOffice3D.tsx` & `focusCamera.tsx`)**:
  - Enforced per-frame `camera.position.y >= 0.5` and clamped orbit target `y >= 0` in `CameraRig`.
  - Limited `OrbitControls maxPolarAngle={Math.PI / 2.25}`.
  - Clamped all focus and overview targets in `FocusCameraController` to `y >= 0.5`.
- **Docked Block Chat Panel (`OfficeScreen.tsx` & `AgentChatPanel.tsx`)**:
  - Docks to the right on desktop (`w-[clamp(380px,40vw,560px)]`, `top-12 bottom-0 z-30`), keeping 3D world interactive without obscuring left-framed focused character.
  - Self-hosted Monocraft font configured via `@font-face` in `globals.css`.
  - Block UI styling with `.block-panel`, `.block-card`, `.block-button`, `.block-button-primary`, `.block-button-danger`.

- **Character Jitter Elimination (`agents.tsx`)**:
  - Fixed inverted angular difference on body facing: `rotDelta = targetY - rotation.y` (positive direction) to eliminate the positive-feedback loop that caused characters to spin and vibrate wildly.
  - Decoupled horizontal motion from vertical bounce/breathing: `position.x` and `position.z` lerp smoothly towards target while `position.y` is exclusively driven by `bounce + breathe`.
  - Continuous walking locomotion driven by `frameValue * WALK_ANIM_SPEED` without jerky distance delta thresholds.
- **Chat Textbox Height & Layout Fix (`AgentChatPanel.tsx` & `OfficeScreen.tsx`)**:
  - Constrained textarea height: `min-h-[36px]` to `max-h-[120px]`, `resizeDraft` clamped between 36px and 120px.
  - Composer wrapper set to `shrink-0`, allowing `AgentChatTranscript` to expand and occupy all remaining vertical space (`flex-1 min-h-0`).
  - Compact padding (`p-2 sm:p-2.5`) on composer card.

**Phase 5: Final Jitter and Pathfinding Polish (Complete & Tested)**
- **Hover Jitter Elimination (`RetroOffice3D.tsx`)**:
  - Extracted inline object props (`camera`, `shadows`, `gl`, `style`) into `useMemo` constants to prevent R3F `<Canvas>` from resetting/re-rendering wildly during rapid rapid hover events (which rapidly changed the React state `hoverUid`).
- **Pathfinding Clipping Fix (`navigation.ts`)**:
  - In `astar()`, the final waypoint in the generated path was previously being unconditionally overridden with the exact (often blocked) destination coordinate (even if `findFree` had correctly snapped the target to an adjacent unblocked cell). Now, A* correctly uses the unblocked cell's center unless the original target itself was completely free. This prevents characters from walking into desks/walls at the very end of their path.
- **Click Swallowing on Doors (`primitives.tsx`)**:
  - Shrunk `touchPad` on `PrimitiveDoorModel` to prevent invisible mesh overlap that was swallowing floor clicks.
- **ESLint Fixes (`RetroOffice3D.tsx`)**:
  - Adhered to `react-hooks/immutability` rule inside `useFrame` by mutating `state.camera` rather than a closure reference.

**Transform Ownership Rules (DO NOT BREAK):**
1. **World Position**: Exclusively owned by `AgentModel`'s internal lerp against `renderAgentLookupRef` / `renderAgentsRef`. Never wrap with an outer position lerp.
2. **Limb Joint Angles**: Exclusively owned by `AgentModel`'s internal pose machine (`headGroupRef`, `leftArmRef`, `rightArmRef`, `leftLegRef`, `rightLegRef`).
3. **Camera & Projection**: Controlled by `FocusCameraController` when an agent is selected, and `OrbitControls` / `CameraRig` during overview.
4. **Terminal commands**: On Windows, use `npm.cmd` and `npx.cmd`.


