"use client";

// Role-specific visual indicators: a small procedural icon floating above each
// agent's nameplate, plus optional held props while they work. Everything is
// built from Three.js primitives — no fonts, no model assets — so it loads
// instantly and matches the office's procedural art direction.
//
// Overlay-only: reads `agentsRef`, never mutates agent state.

import { Billboard } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { memo, useMemo, useRef, type ReactElement, type RefObject } from "react";
import * as THREE from "three";
import { AGENT_SCALE } from "@/features/retro-office/core/constants";
import { toWorld } from "@/features/retro-office/core/geometry";
import type { GraphicsQualityConfig } from "@/features/retro-office/core/graphicsQuality";
import type { OfficeAgent, RenderAgent } from "@/features/retro-office/core/types";
import { hashUnit } from "@/features/retro-office/systems/transitionAnimations";

export type AgentRoleKind =
  | "orchestrator"
  | "developer"
  | "researcher"
  | "designer"
  | "qa"
  | "security"
  | "devops"
  | "writer"
  | "generic";

export const ROLE_COLORS: Record<AgentRoleKind, string> = {
  orchestrator: "#ffd700",
  developer: "#06b6d4",
  researcher: "#a855f7",
  designer: "#ec4899",
  qa: "#22c55e",
  security: "#ef4444",
  devops: "#f97316",
  writer: "#3b82f6",
  generic: "#e2e8f0",
};

// Prefix-anchored (leading \b only) so "Orchestrator", "analyst", "writer",
// "security" all match their stems.
const ROLE_PATTERNS: Array<[AgentRoleKind, RegExp]> = [
  ["orchestrator", /\b(orchestrat|manager|lead\b|director|coordinat|\bpm\b|product owner|ceo\b|head\b)/i],
  ["qa", /\b(qa\b|quality|test(er|ing)?\b|verif|review)/i],
  ["security", /\b(secur|pentest|auth\b|compliance|infosec)/i],
  ["devops", /\b(devops|infra|sre\b|ops\b|deploy|platform|cloud|kubernetes|docker)/i],
  ["designer", /\b(design|ux\b|ui\b|creative|visual|brand|art\b)/i],
  ["writer", /\b(writ|docs?\b|documentation|content|copy\b|editor)/i],
  ["researcher", /\b(research|analy|data\b|scien|insight|market|strateg)/i],
  ["developer", /\b(dev\b|developer|engineer|coder|programm|builder|backend|frontend|full ?stack|software|swe\b)/i],
];

/** Classify a free-text role/subtitle into a visual role bucket. */
export const classifyAgentRole = (role: string | null | undefined, name?: string): AgentRoleKind => {
  const text = `${role ?? ""} ${name ?? ""}`.trim();
  if (!text) return "generic";
  for (const [kind, pattern] of ROLE_PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  return "generic";
};

// ---------------------------------------------------------------------------
// Procedural icons (all unit-sized, centred at origin)
// ---------------------------------------------------------------------------

function IconMaterial({ color }: { color: string }) {
  return (
    <meshStandardMaterial
      color={color}
      emissive={color}
      emissiveIntensity={0.9}
      roughness={0.35}
      metalness={0.2}
    />
  );
}

function CrownIcon({ color }: { color: string }) {
  return (
    <group>
      <mesh position={[0, -0.02, 0]}>
        <boxGeometry args={[0.16, 0.05, 0.03]} />
        <IconMaterial color={color} />
      </mesh>
      {[-0.055, 0, 0.055].map((x, i) => (
        <mesh key={i} position={[x, 0.035, 0]}>
          <coneGeometry args={[0.025, i === 1 ? 0.09 : 0.07, 4]} />
          <IconMaterial color={color} />
        </mesh>
      ))}
    </group>
  );
}

function CodeIcon({ color }: { color: string }) {
  // Two chevrons "<" and ">" from thin boxes.
  const bar = (x: number, rot: number, key: string) => (
    <mesh key={key} position={[x, 0, 0]} rotation={[0, 0, rot]}>
      <boxGeometry args={[0.018, 0.075, 0.018]} />
      <IconMaterial color={color} />
    </mesh>
  );
  return (
    <group>
      <group position={[-0.05, 0, 0]}>
        {bar(0, 0.65, "l1")}
        {bar(0, -0.65, "l2")}
      </group>
      <group position={[0.05, 0, 0]}>
        {bar(0, -0.65, "r1")}
        {bar(0, 0.65, "r2")}
      </group>
      <mesh rotation={[0, 0, 0.4]}>
        <boxGeometry args={[0.014, 0.11, 0.014]} />
        <IconMaterial color={color} />
      </mesh>
    </group>
  );
}

function MagnifierIcon({ color }: { color: string }) {
  return (
    <group rotation={[0, 0, -0.6]}>
      <mesh>
        <torusGeometry args={[0.05, 0.012, 8, 20]} />
        <IconMaterial color={color} />
      </mesh>
      <mesh position={[0, -0.085, 0]}>
        <boxGeometry args={[0.02, 0.07, 0.02]} />
        <IconMaterial color={color} />
      </mesh>
    </group>
  );
}

function PaletteIcon({ color }: { color: string }) {
  const dots = ["#f87171", "#fbbf24", "#34d399", "#60a5fa"];
  return (
    <group>
      <mesh>
        <cylinderGeometry args={[0.07, 0.07, 0.02, 20]} />
        <IconMaterial color={color} />
      </mesh>
      {dots.map((c, i) => {
        const a = (i / dots.length) * Math.PI * 2;
        return (
          <mesh key={c} position={[Math.cos(a) * 0.038, 0.014, Math.sin(a) * 0.038]}>
            <sphereGeometry args={[0.012, 8, 8]} />
            <meshStandardMaterial color={c} emissive={c} emissiveIntensity={0.6} />
          </mesh>
        );
      })}
    </group>
  );
}

function ShieldCheckIcon({ color }: { color: string }) {
  return (
    <group>
      <mesh>
        <cylinderGeometry args={[0.065, 0.02, 0.14, 6]} />
        <IconMaterial color={color} />
      </mesh>
      <mesh position={[-0.012, -0.012, 0.03]} rotation={[0, 0, -0.8]}>
        <boxGeometry args={[0.012, 0.05, 0.01]} />
        <meshStandardMaterial color="#ffffff" emissive="#ffffff" emissiveIntensity={0.6} />
      </mesh>
      <mesh position={[0.02, 0.005, 0.03]} rotation={[0, 0, 0.7]}>
        <boxGeometry args={[0.012, 0.085, 0.01]} />
        <meshStandardMaterial color="#ffffff" emissive="#ffffff" emissiveIntensity={0.6} />
      </mesh>
    </group>
  );
}

function LockIcon({ color }: { color: string }) {
  return (
    <group>
      <mesh position={[0, -0.025, 0]}>
        <boxGeometry args={[0.1, 0.08, 0.05]} />
        <IconMaterial color={color} />
      </mesh>
      <mesh position={[0, 0.035, 0]} rotation={[0, 0, 0]}>
        <torusGeometry args={[0.035, 0.01, 8, 16, Math.PI]} />
        <IconMaterial color={color} />
      </mesh>
    </group>
  );
}

function GearIcon({ color }: { color: string }) {
  return (
    <group>
      <mesh>
        <torusGeometry args={[0.045, 0.02, 8, 16]} />
        <IconMaterial color={color} />
      </mesh>
      {Array.from({ length: 6 }, (_, i) => {
        const a = (i / 6) * Math.PI * 2;
        return (
          <mesh key={i} position={[Math.cos(a) * 0.065, Math.sin(a) * 0.065, 0]} rotation={[0, 0, a]}>
            <boxGeometry args={[0.03, 0.024, 0.024]} />
            <IconMaterial color={color} />
          </mesh>
        );
      })}
    </group>
  );
}

function PenIcon({ color }: { color: string }) {
  return (
    <group rotation={[0, 0, -0.7]}>
      <mesh>
        <boxGeometry args={[0.028, 0.12, 0.028]} />
        <IconMaterial color={color} />
      </mesh>
      <mesh position={[0, -0.075, 0]} rotation={[Math.PI, 0, 0]}>
        <coneGeometry args={[0.018, 0.035, 4]} />
        <meshStandardMaterial color="#1f2937" />
      </mesh>
    </group>
  );
}

function DiamondIcon({ color }: { color: string }) {
  return (
    <mesh rotation={[0, 0, Math.PI / 4]}>
      <octahedronGeometry args={[0.055, 0]} />
      <IconMaterial color={color} />
    </mesh>
  );
}

const ICON_BY_ROLE: Record<AgentRoleKind, (p: { color: string }) => ReactElement> = {
  orchestrator: CrownIcon,
  developer: CodeIcon,
  researcher: MagnifierIcon,
  designer: PaletteIcon,
  qa: ShieldCheckIcon,
  security: LockIcon,
  devops: GearIcon,
  writer: PenIcon,
  generic: DiamondIcon,
};

// ---------------------------------------------------------------------------
// Per-agent floating badge
// ---------------------------------------------------------------------------

/** Height above the ground (world units) where the nameplate sits. */
const NAMEPLATE_WORLD_Y = 1.05 * AGENT_SCALE;
const BADGE_OFFSET_Y = 0.32;
/** Hide badges beyond this camera distance to keep the overview clean. */
const BADGE_MAX_CAMERA_DISTANCE = 26;

const RoleBadge = memo(function RoleBadge({
  agentId,
  kind,
  agentsRef,
  agentLookupRef,
}: {
  agentId: string;
  kind: AgentRoleKind;
  agentsRef: RefObject<RenderAgent[]>;
  agentLookupRef?: RefObject<Map<string, RenderAgent>>;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const spinRef = useRef<THREE.Group>(null);
  const target = useMemo(() => new THREE.Vector3(), []);
  const phase = useMemo(() => hashUnit(agentId, 21) * Math.PI * 2, [agentId]);
  const Icon = ICON_BY_ROLE[kind];
  const color = ROLE_COLORS[kind];

  useFrame(({ camera, clock }) => {
    const group = groupRef.current;
    if (!group) return;
    const agent =
      agentLookupRef?.current?.get(agentId) ??
      agentsRef.current?.find((candidate) => candidate.id === agentId);
    if (!agent || agent.state === "away") {
      group.visible = false;
      return;
    }
    const [wx, , wz] = toWorld(agent.x, agent.y);
    const t = clock.elapsedTime;
    const inHuddle = agent.conversationGroupId !== undefined;
    const seatLift = inHuddle ? ((agent.conversationSeatIndex ?? 0) % 4) * 0.17 * AGENT_SCALE : 0;
    target.set(
      wx,
      NAMEPLATE_WORLD_Y + BADGE_OFFSET_Y + seatLift + Math.sin(t * 2.1 + phase) * 0.012,
      wz,
    );
    group.position.lerp(target, 0.2);
    group.visible = camera.position.distanceTo(group.position) < BADGE_MAX_CAMERA_DISTANCE;
    if (spinRef.current) {
      // Slow idle turn; faster while working so the badge reads as "busy".
      const speed = agent.status === "working" ? 1.6 : 0.5;
      spinRef.current.rotation.y = t * speed + phase;
    }
  });

  return (
    <group ref={groupRef}>
      <Billboard follow lockX lockZ>
        <group ref={spinRef} scale={[0.9, 0.9, 0.9]}>
          <Icon color={color} />
        </group>
      </Billboard>
    </group>
  );
});

// ---------------------------------------------------------------------------
// Public overlay
// ---------------------------------------------------------------------------

export type RoleVisualsProps = {
  /** The same agent list passed to the scene (id, name, subtitle, status). */
  agents: OfficeAgent[];
  agentsRef: RefObject<RenderAgent[]>;
  agentLookupRef?: RefObject<Map<string, RenderAgent>>;
  config: GraphicsQualityConfig;
  /** Optional explicit role override by agent id (e.g. from gateway `role`). */
  roleByAgentId?: Record<string, string | null | undefined>;
};

/**
 * Floating role badges for every agent. Disabled on the "low" quality tier
 * (no post-processing) to keep the draw count minimal there.
 */
export function AgentRoleVisuals({
  agents,
  agentsRef,
  agentLookupRef,
  config,
  roleByAgentId,
}: RoleVisualsProps) {
  const badges = useMemo(
    () =>
      agents.map((agent) => ({
        id: agent.id,
        kind: classifyAgentRole(roleByAgentId?.[agent.id] ?? agent.subtitle, agent.name),
      })),
    [agents, roleByAgentId],
  );

  if (!config.postProcessing) return null;

  return (
    <group>
      {badges.map((badge) => (
        <RoleBadge
          key={badge.id}
          agentId={badge.id}
          kind={badge.kind}
          agentsRef={agentsRef}
          agentLookupRef={agentLookupRef}
        />
      ))}
    </group>
  );
}
