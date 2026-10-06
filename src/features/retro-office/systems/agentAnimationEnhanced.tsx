"use client";

// Enhanced agent animation layer.
//
// `objects/agents.tsx` owns the base character rig and resets every limb
// rotation inside its own useFrame. Rather than fork that file, this layer
// wraps <AgentModel> in an outer group and applies *additive* whole-body
// motion on top each frame:
//
//   - eased pose transitions (squash/stretch anticipation instead of a snap)
//   - idle micro-animations: weight shift, periodic glance, lean-back stretch
//   - walking dynamics: speed-aware forward lean and extra head-bob
//   - working focus: lean deepens with work duration, flickering monitor glow
//   - social awareness: a sitting/standing agent glances toward whoever walks
//     up to them
//
// Because the inner AgentModel positions itself in world space, rotating the
// outer group would swing the character around the world origin. The wrapper
// therefore re-anchors the pivot every frame: outer.position = p - M·p, where
// p is the inner group's position and M the outer rotation/scale.
//
// Drop-in: replace `<AgentModel .../>` with `<EnhancedAgentModel .../>` (same
// props, plus `config`). Everything degrades gracefully on the "low" tier.

import { useFrame } from "@react-three/fiber";
import { memo, useMemo, useRef } from "react";
import * as THREE from "three";
import { AGENT_SCALE, WALK_SPEED, CANVAS_W, CANVAS_H } from "@/features/retro-office/core/constants";
import type { GraphicsQualityConfig } from "@/features/retro-office/core/graphicsQuality";
import type { RenderAgent } from "@/features/retro-office/core/types";
import { AgentModel } from "@/features/retro-office/objects/agents";
import type { AgentModelProps } from "@/features/retro-office/objects/types";
import { toWorld } from "@/features/retro-office/core/geometry";
import {
  bell,
  easeOutBack,
  hashUnit,
  lerp,
  periodicGesturePhase,
  PoseTransitionTracker,
  resolveWalkDynamics,
} from "@/features/retro-office/systems/transitionAnimations";

export type EnhancedAgentModelProps = AgentModelProps & {
  config: GraphicsQualityConfig;
  /** Disable all additive motion (keeps the wrapper a pure pass-through). */
  disabled?: boolean;
};

/** One tracker shared by every wrapper instance in the scene. */
const sharedTracker = new PoseTransitionTracker();

/** Canvas-unit radius within which another agent counts as "approaching". */
const GLANCE_RADIUS = 110;
const GLANCE_RADIUS_SQ = GLANCE_RADIUS * GLANCE_RADIUS;

const WEIGHT_SHIFT_PERIOD_S = 4.2;
const WEIGHT_SHIFT_AMPLITUDE = 0.022;

const GLANCE_PERIOD_MS = 11_000;
const GLANCE_DURATION_MS = 2_200;
const GLANCE_YAW = 0.26;

const STRETCH_PERIOD_MS = 70_000;
const STRETCH_DURATION_MS = 2_400;
const STRETCH_LEAN_BACK = -0.16;

const FOCUS_LEAN_MAX = 0.07;
const FOCUS_LEAN_RAMP_MS = 10_000;

const MONITOR_GLOW_COLOR = "#9fd3ff";
const MONITOR_GLOW_DISTANCE = 1.1 * AGENT_SCALE;

export const EnhancedAgentModel = memo(function EnhancedAgentModel({
  config,
  disabled = false,
  ...agentProps
}: EnhancedAgentModelProps) {
  const { agentId, agentsRef, agentLookupRef } = agentProps;
  const outerRef = useRef<THREE.Group>(null);
  const glowRef = useRef<THREE.PointLight>(null);
  const workStartRef = useRef<number | null>(null);
  const smoothedYawRef = useRef(0);
  const smoothedPitchRef = useRef(0);
  const smoothedRollRef = useRef(0);
  const smoothedScaleYRef = useRef(1);
  const posRef = useRef(new THREE.Vector3(0, 0, 0));
  const proxyLookupRef = useRef(new Map<string, RenderAgent>());
  const emptyAgentsRef = useRef<RenderAgent[]>([]);
  
  const tmp = useMemo(
    () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(), e: new THREE.Euler() }),
    [],
  );
  const phase = useMemo(() => hashUnit(agentId, 31) * Math.PI * 2, [agentId]);
  const enableGlow = config.postProcessing && !disabled;
  const lowTier = !config.postProcessing;

  useFrame(({ clock }) => {
    const agent =
      agentLookupRef?.current?.get(agentId) ??
      agentsRef.current?.find((candidate) => candidate.id === agentId);

    // Provide a proxy to the inner AgentModel so it remains at (0,0,0) locally.
    if (agent) {
      proxyLookupRef.current.set(agentId, { ...agent, x: CANVAS_W / 2, y: CANVAS_H / 2 });
    }

    const outer = outerRef.current;
    if (!outer) return;
    const inner = outer.children[0] as THREE.Group | undefined;
    if (!inner) return;

    if (!agent || disabled) {
      outer.rotation.set(0, 0, 0);
      outer.scale.setScalar(1);
      if (agent) {
        const [wx, , wz] = toWorld(agent.x, agent.y);
        posRef.current.set(wx, 0, wz);
        outer.position.lerp(posRef.current, 0.15);
      }
      if (glowRef.current) glowRef.current.intensity = 0;
      return;
    }

    const now = performance.now();
    const t = clock.elapsedTime;
    const blend = sharedTracker.observe(agentId, agent.state, now);
    const working = agent.status === "working";
    const isSitting = agent.state === "sitting";
    const isStanding = agent.state === "standing";
    const isWalking = agent.state === "walking";
    const inHuddle = agent.conversationGroupId !== undefined;

    // ---- target additive angles --------------------------------------
    let yaw = 0;
    let pitch = 0;
    let roll = 0;
    let scaleY = 1;

    // Weight shift while standing (skipped in huddles: seats face a centre).
    if (isStanding && !inHuddle && !lowTier) {
      roll = Math.sin(t * ((Math.PI * 2) / WEIGHT_SHIFT_PERIOD_S) + phase) * WEIGHT_SHIFT_AMPLITUDE;
    }

    // Periodic glance when idle (standing or sitting, not working, not huddling).
    if ((isStanding || isSitting) && !working && !inHuddle) {
      const g = periodicGesturePhase(agentId, now, GLANCE_PERIOD_MS, GLANCE_DURATION_MS, 41);
      if (g !== null) {
        const side = hashUnit(agentId, 43) > 0.5 ? 1 : -1;
        yaw += bell(g) * GLANCE_YAW * side;
      }
    }

    // Social glance: look toward the nearest approaching walker.
    if ((isStanding || isSitting) && !inHuddle) {
      let bestDistSq = GLANCE_RADIUS_SQ;
      let bestDx = 0;
      let bestDy = 0;
      for (const other of agentsRef.current ?? []) {
        if (other.id === agentId || other.state !== "walking") continue;
        const dx = other.x - agent.x;
        const dy = other.y - agent.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestDistSq) {
          bestDistSq = d2;
          bestDx = dx;
          bestDy = dy;
        }
      }
      if (bestDistSq < GLANCE_RADIUS_SQ) {
        // Canvas y maps to world z; facing is a yaw around +Y.
        const toOther = Math.atan2(bestDx, bestDy);
        let delta = toOther - agent.facing;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        const proximity = 1 - Math.sqrt(bestDistSq) / GLANCE_RADIUS;
        yaw += THREE.MathUtils.clamp(delta, -0.6, 0.6) * 0.55 * proximity;
      }
    }

    // Working focus lean + occasional stretch while sitting.
    if (isSitting) {
      if (working) {
        if (workStartRef.current === null) workStartRef.current = now;
        const ramp = Math.min(1, (now - workStartRef.current) / FOCUS_LEAN_RAMP_MS);
        pitch += ramp * FOCUS_LEAN_MAX;
      } else {
        workStartRef.current = null;
      }
      const s = periodicGesturePhase(agentId, now, STRETCH_PERIOD_MS, STRETCH_DURATION_MS, 47);
      if (s !== null) pitch += bell(s) * STRETCH_LEAN_BACK;
    } else {
      workStartRef.current = null;
    }

    // Walking dynamics: speed-aware lean and extra bob.
    let extraBob = 0;
    if (isWalking) {
      const dyn = resolveWalkDynamics(agent.walkSpeed, WALK_SPEED);
      pitch += dyn.lean;
      const stride = Math.sin(agent.frame * 0.15 * dyn.cadence * 2 + phase);
      extraBob = Math.abs(stride) * 0.012 * dyn.strideScale * AGENT_SCALE;
      // Torso counter-twist opposite to the arm swing.
      yaw += Math.sin(agent.frame * 0.15 * dyn.cadence) * 0.035 * dyn.strideScale;
    }

    // Pose transition anticipation: brief squash → overshoot stretch.
    if (blend.transitioning) {
      const w = blend.weight;
      scaleY = w < 0.4 ? lerp(1, 0.94, w / 0.4) : lerp(0.94, 1, easeOutBack((w - 0.4) / 0.6, 1.2));
    }

    // ---- smooth toward targets ------------------------------------------
    const k = 0.14;
    smoothedYawRef.current = lerp(smoothedYawRef.current, yaw, k);
    smoothedPitchRef.current = lerp(smoothedPitchRef.current, pitch, k);
    smoothedRollRef.current = lerp(smoothedRollRef.current, roll, k);
    smoothedScaleYRef.current = lerp(smoothedScaleYRef.current, scaleY, 0.25);

    // Pitch/roll are expressed in the agent's local heading so a forward lean
    // is always forward regardless of where the character faces.
    const heading = inner.rotation.y;
    const localPitch = smoothedPitchRef.current;
    const localRoll = smoothedRollRef.current;
    const pitchX = Math.cos(heading) * localPitch + Math.sin(heading) * localRoll;
    const pitchZ = -Math.sin(heading) * localPitch + Math.cos(heading) * localRoll;

    tmp.e.set(pitchX, smoothedYawRef.current, pitchZ, "YXZ");
    outer.quaternion.setFromEuler(tmp.e);
    // Use uniform scale to prevent shearing the inner rotated limbs.
    outer.scale.setScalar(smoothedScaleYRef.current);

    // Apply the exact same position lerp that AgentModel normally does,
    // but on the outer wrapper so it correctly translates the rotated group.
    const [wx, , wz] = toWorld(agent.x, agent.y);
    posRef.current.set(wx, 0, wz);
    outer.position.lerp(posRef.current, 0.15);
    outer.position.y += extraBob;

    // Monitor glow on the face while working at a desk.
    if (glowRef.current) {
      if (enableGlow && isSitting && working) {
        const flicker = 0.75 + Math.sin(t * 9.1 + phase) * 0.08 + Math.sin(t * 2.3 + phase * 1.7) * 0.12;
        glowRef.current.intensity = flicker * 0.9;
        const [gx, gz] = [Math.sin(agent.facing), Math.cos(agent.facing)];
        glowRef.current.position.set(
          inner.position.x + gx * 0.22 * AGENT_SCALE,
          0.5 * AGENT_SCALE,
          inner.position.z + gz * 0.22 * AGENT_SCALE,
        );
      } else {
        glowRef.current.intensity = 0;
      }
    }
  });

  return (
    <>
      <group ref={outerRef}>
        <AgentModel
          {...agentProps}
          agentLookupRef={proxyLookupRef}
          agentsRef={emptyAgentsRef}
        />
      </group>
      {enableGlow ? (
        <pointLight
          ref={glowRef}
          color={MONITOR_GLOW_COLOR}
          intensity={0}
          distance={MONITOR_GLOW_DISTANCE}
          decay={2}
        />
      ) : null}
    </>
  );
});

/** Call once per frame from any scene-level system to free stale trackers. */
export const pruneEnhancedAnimationState = (agents: Pick<RenderAgent, "id">[]) => {
  sharedTracker.prune(agents.map((agent) => agent.id));
};
