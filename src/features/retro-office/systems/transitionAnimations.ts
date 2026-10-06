// Pure easing + state-transition helpers for the enhanced agent animations.
//
// The base scene (`objects/agents.tsx`) snaps between poses the moment a
// RenderAgent's `state` changes. The enhanced layer blends poses over a short
// window instead. Everything in here is framework-free so it can be unit
// tested and reused by both the 3D office and the pixel office.

import type { RenderAgent } from "@/features/retro-office/core/types";

export type AgentPoseState = RenderAgent["state"];

/** Transition durations keyed by `from→to`; `*` matches any state. */
export const STATE_TRANSITION_MS: Record<string, number> = {
  "standing→walking": 300,
  "walking→standing": 350,
  "walking→sitting": 500,
  "sitting→standing": 400,
  "sitting→walking": 450,
  "standing→working_out": 600,
  "working_out→standing": 500,
  "standing→dancing": 400,
  "dancing→standing": 450,
  "*→away": 800,
  "away→*": 600,
};

export const DEFAULT_TRANSITION_MS = 400;

export const resolveTransitionDurationMs = (
  from: AgentPoseState,
  to: AgentPoseState,
): number => {
  if (from === to) return 0;
  return (
    STATE_TRANSITION_MS[`${from}→${to}`] ??
    STATE_TRANSITION_MS[`*→${to}`] ??
    STATE_TRANSITION_MS[`${from}→*`] ??
    DEFAULT_TRANSITION_MS
  );
};

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

export const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const easeInOutCubic = (t: number): number => {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};

export const easeOutBack = (t: number, overshoot = 1.4): number => {
  const x = clamp01(t);
  const c3 = overshoot + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + overshoot * Math.pow(x - 1, 2);
};

export const easeOutQuad = (t: number): number => {
  const x = clamp01(t);
  return 1 - (1 - x) * (1 - x);
};

/** Smooth bell curve in [0,1] peaking at t=0.5. Handy for one-shot gestures. */
export const bell = (t: number): number => {
  const x = clamp01(t);
  return Math.sin(x * Math.PI);
};

// ---------------------------------------------------------------------------
// Per-agent transition tracker
// ---------------------------------------------------------------------------

export type PoseTransition = {
  from: AgentPoseState;
  to: AgentPoseState;
  startedAt: number;
  durationMs: number;
};

export type PoseBlend = {
  /** Current target state. */
  state: AgentPoseState;
  /** Previous state while a transition is in flight, else same as `state`. */
  previous: AgentPoseState;
  /** 0 = fully previous pose, 1 = fully current pose (eased). */
  weight: number;
  /** True while blending. */
  transitioning: boolean;
};

/**
 * Tracks the last observed state per agent and reports an eased blend weight.
 * Call `observe()` once per frame per agent.
 */
export class PoseTransitionTracker {
  private transitions = new Map<string, PoseTransition>();
  private lastState = new Map<string, AgentPoseState>();

  observe(agentId: string, state: AgentPoseState, now: number): PoseBlend {
    const prev = this.lastState.get(agentId);
    if (prev === undefined) {
      this.lastState.set(agentId, state);
      return { state, previous: state, weight: 1, transitioning: false };
    }
    if (prev !== state) {
      const active = this.transitions.get(agentId);
      // If we flip mid-transition, start from the visually dominant pose so
      // the blend never jumps backwards.
      const from =
        active && now - active.startedAt < active.durationMs / 2 ? active.from : prev;
      this.transitions.set(agentId, {
        from,
        to: state,
        startedAt: now,
        durationMs: resolveTransitionDurationMs(from, state),
      });
      this.lastState.set(agentId, state);
    }
    const t = this.transitions.get(agentId);
    if (!t) return { state, previous: state, weight: 1, transitioning: false };
    const raw = t.durationMs <= 0 ? 1 : (now - t.startedAt) / t.durationMs;
    if (raw >= 1) {
      this.transitions.delete(agentId);
      return { state, previous: state, weight: 1, transitioning: false };
    }
    return {
      state,
      previous: t.from,
      weight: easeInOutCubic(raw),
      transitioning: true,
    };
  }

  forget(agentId: string) {
    this.transitions.delete(agentId);
    this.lastState.delete(agentId);
  }

  /** Drop agents that no longer exist so the maps don't grow forever. */
  prune(liveAgentIds: Iterable<string>) {
    const keep = new Set(liveAgentIds);
    for (const id of [...this.lastState.keys()]) {
      if (!keep.has(id)) this.forget(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Deterministic per-agent randomness
// ---------------------------------------------------------------------------

/** Stable 0..1 hash from a string + salt; keeps idle gestures desynchronised. */
export const hashUnit = (id: string, salt = 0): number => {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
};

/**
 * Returns the phase (0..1) of a one-shot gesture that fires every `periodMs`
 * for `durationMs`, or null when the gesture is not active. Offset by a
 * per-agent hash so agents never gesture in unison.
 */
export const periodicGesturePhase = (
  agentId: string,
  now: number,
  periodMs: number,
  durationMs: number,
  salt = 0,
): number | null => {
  const offset = hashUnit(agentId, salt) * periodMs;
  const local = (now + offset) % periodMs;
  return local < durationMs ? local / durationMs : null;
};

// ---------------------------------------------------------------------------
// Walk dynamics
// ---------------------------------------------------------------------------

export type WalkDynamics = {
  /** Multiplier on arm/leg swing amplitude. */
  strideScale: number;
  /** Forward lean (radians) that grows with speed. */
  lean: number;
  /** Multiplier on the walk-cycle frequency. */
  cadence: number;
  /** True when the agent is hurrying (conversation approach, working rush). */
  hurrying: boolean;
};

export const resolveWalkDynamics = (
  walkSpeed: number,
  baseWalkSpeed: number,
): WalkDynamics => {
  const ratio = baseWalkSpeed > 0 ? walkSpeed / baseWalkSpeed : 1;
  const hurrying = ratio > 1.6;
  return {
    strideScale: clamp01((ratio - 1) / 3) * 0.6 + 1,
    lean: hurrying ? Math.min(0.14, 0.04 + (ratio - 1.6) * 0.04) : 0,
    cadence: 1 + clamp01((ratio - 1) / 4) * 0.8,
    hurrying,
  };
};

// ---------------------------------------------------------------------------
// Math & Framing Helpers for Block Rig & Camera Focus
// ---------------------------------------------------------------------------

/** Exponential damping helper: frame-rate independent scalar interpolation. */
export const dampScalar = (
  current: number,
  target: number,
  lambda: number,
  dt: number,
): number => {
  if (dt <= 0) return current;
  return target + (current - target) * Math.exp(-lambda * dt);
};

/** Normalizes the angle difference to [-PI, PI] to guarantee shortest-path rotation from source to target. */
export const shortestAngleDiff = (from: number, to: number): number => {
  let diff = to - from;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
};

/**
 * Calculates the view offset in pixels for camera.setViewOffset so that the target
 * is centered within the visible 3D canvas (on the left), while the chat panel occupies the right.
 */
export const calculateFocusOffset = (
  viewportWidth: number,
  panelWidthRatio = 0.4,
  isMobile = false,
): number => {
  if (isMobile || viewportWidth < 768) return 0;
  const panelWidth = Math.min(560, Math.max(380, viewportWidth * panelWidthRatio));
  return panelWidth / 2;
};

/**
 * One-shot success gesture tracker: ensures success animation triggers once per
 * event and doesn't loop infinitely across rerenders or repeated status payloads.
 */
export class SuccessEventTracker {
  private lastTriggered = new Map<string, number>();

  trigger(agentId: string, now: number): boolean {
    const last = this.lastTriggered.get(agentId) ?? 0;
    // Don't re-trigger within 2.5 seconds
    if (now - last < 2500) return false;
    this.lastTriggered.set(agentId, now);
    return true;
  }

  isGesturing(agentId: string, now: number, durationMs = 800): boolean {
    const last = this.lastTriggered.get(agentId) ?? 0;
    return now - last < durationMs;
  }

  progress(agentId: string, now: number, durationMs = 800): number {
    const last = this.lastTriggered.get(agentId) ?? 0;
    const elapsed = now - last;
    if (elapsed >= durationMs) return 1;
    return clamp01(elapsed / durationMs);
  }

  forget(agentId: string) {
    this.lastTriggered.delete(agentId);
  }
}

