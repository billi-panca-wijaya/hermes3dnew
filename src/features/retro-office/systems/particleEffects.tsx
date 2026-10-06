"use client";

// Particle overlays for the immersive office. Each system is a single
// `THREE.Points` mesh shared by every agent, so the per-frame cost is one draw
// call regardless of how many agents are on the floor.
//
// Overlay-only: these components read `agentsRef` (the same ref the scene
// already passes to AgentModel) and never mutate agent state. They can be
// dropped inside the existing <Canvas> without touching RetroOffice3D.tsx.

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, type RefObject } from "react";
import * as THREE from "three";
import { AGENT_SCALE } from "@/features/retro-office/core/constants";
import { toWorld } from "@/features/retro-office/core/geometry";
import type { GraphicsQualityConfig } from "@/features/retro-office/core/graphicsQuality";
import type { RenderAgent } from "@/features/retro-office/core/types";
import { hashUnit } from "@/features/retro-office/systems/transitionAnimations";

type AgentFlags = Record<string, boolean>;

export type ParticleEffectsProps = {
  agentsRef: RefObject<RenderAgent[]>;
  config: GraphicsQualityConfig;
  /** From OfficeAnimationState.streamingByAgentId — drives the thinking cloud. */
  streamingByAgentId?: AgentFlags;
  /** From OfficeAnimationState.thinkingByAgentId — drives the thinking cloud. */
  thinkingByAgentId?: AgentFlags;
};

/** Budget per quality tier (total particles across all agents). */
export const resolveParticleBudget = (config: GraphicsQualityConfig): number => {
  if (!config.postProcessing) return 0; // "low"
  return config.followDepthOfField ? 200 : 100; // "ultra" : "balanced"
};

const HEAD_Y = 0.47 * AGENT_SCALE;
const DESK_HANDS_Y = 0.2 * AGENT_SCALE;

type Particle = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  size: number;
};

const EMPTY_FLAGS: AgentFlags = {};

/**
 * Generic pooled points system. `spawn` is called with the pool and the live
 * agents each frame so each effect decides where to emit.
 */
const createParticlePool = (capacity: number): Particle[] =>
  Array.from({ length: capacity }, () => ({
    x: 0,
    y: -100,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    life: 0,
    maxLife: 1,
    size: 1,
  }));

/**
 * Builds the points geometry up front so the per-frame loop only writes into
 * `geometry.attributes.*.array` (the same pattern `DustMotes` in
 * atmosphere.tsx uses), which keeps the React Compiler immutability lint happy.
 */
const createParticleGeometry = (capacity: number): THREE.BufferGeometry => {
  const size = Math.max(1, capacity);
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(size * 3);
  for (let i = 0; i < size; i += 1) positions[i * 3 + 1] = -100;
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(size), 1));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(size), 1));
  return geometry;
};

const PARTICLE_VERTEX = /* glsl */ `
  attribute float aAlpha;
  attribute float aSize;
  varying float vAlpha;
  void main() {
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (120.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const PARTICLE_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    float soft = smoothstep(0.5, 0.15, d);
    gl_FragColor = vec4(uColor, soft * vAlpha);
    if (gl_FragColor.a < 0.01) discard;
  }
`;

function ParticlePoints({
  capacity,
  color,
  tick,
}: {
  capacity: number;
  color: string;
  tick: (pool: Particle[], dt: number, now: number) => void;
}) {
  const poolRef = useRef<Particle[] | null>(null);
  const geometry = useMemo(() => createParticleGeometry(capacity), [capacity]);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(color) } },
        vertexShader: PARTICLE_VERTEX,
        fragmentShader: PARTICLE_FRAGMENT,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [color],
  );

  useFrame((_, delta) => {
    if (capacity === 0) return;
    if (!poolRef.current || poolRef.current.length !== capacity) {
      poolRef.current = createParticlePool(capacity);
    }
    const pool = poolRef.current;
    const positionAttr = geometry.getAttribute("position") as THREE.BufferAttribute;
    const alphaAttr = geometry.getAttribute("aAlpha") as THREE.BufferAttribute;
    const sizeAttr = geometry.getAttribute("aSize") as THREE.BufferAttribute;
    const positions = positionAttr.array as Float32Array;
    const alphas = alphaAttr.array as Float32Array;
    const sizes = sizeAttr.array as Float32Array;
    const dt = Math.min(delta, 0.05);
    const now = performance.now();
    tick(pool, dt, now);

    for (let i = 0; i < capacity; i += 1) {
      const p = pool[i];
      if (p.life > 0) {
        p.life -= dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        const t = p.life / p.maxLife;
        alphas[i] = t < 0.25 ? t / 0.25 : t;
        sizes[i] = p.size;
        positions[i * 3] = p.x;
        positions[i * 3 + 1] = p.y;
        positions[i * 3 + 2] = p.z;
      } else {
        alphas[i] = 0;
        positions[i * 3 + 1] = -100;
      }
    }
    positionAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;
  });

  if (capacity === 0) return null;

  return <points geometry={geometry} material={material} frustumCulled={false} />;
}

// ---------------------------------------------------------------------------
// Effect definitions
// ---------------------------------------------------------------------------

const takeDead = (pool: Particle[]): Particle | null => {
  for (const p of pool) if (p.life <= 0) return p;
  return null;
};

/**
 * Typing sparks: warm motes rising from a working agent's hands.
 * Thinking cloud: cool dots orbiting above the head while a stream is live.
 * Error sparks: sharp red bursts from the status light.
 * Conversation glow: soft motes drifting between huddle participants.
 */
export function AgentParticleEffects({
  agentsRef,
  config,
  streamingByAgentId = EMPTY_FLAGS,
  thinkingByAgentId = EMPTY_FLAGS,
}: ParticleEffectsProps) {
  const budget = resolveParticleBudget(config);
  if (budget === 0) return null;

  const typingCap = Math.floor(budget * 0.4);
  const thinkingCap = Math.floor(budget * 0.3);
  const errorCap = Math.floor(budget * 0.1);
  const convoCap = budget - typingCap - thinkingCap - errorCap;

  const readAgents = () => agentsRef.current ?? [];

  return (
    <group>
      <ParticlePoints
        capacity={typingCap}
        color="#ffd79a"
        tick={(pool, dt, now) => {
          for (const agent of readAgents()) {
            if (agent.state !== "sitting" || agent.status !== "working") continue;
            // ~6 sparks / second per working agent, desynchronised by hash.
            if ((now * 0.001 + hashUnit(agent.id)) % (1 / 6) > dt) continue;
            const p = takeDead(pool);
            if (!p) break;
            const [wx, , wz] = toWorld(agent.x, agent.y);
            const fwd = agent.facing;
            p.x = wx + Math.sin(fwd) * 0.18 + (Math.random() - 0.5) * 0.16;
            p.y = DESK_HANDS_Y;
            p.z = wz + Math.cos(fwd) * 0.18 + (Math.random() - 0.5) * 0.16;
            p.vx = (Math.random() - 0.5) * 0.08;
            p.vy = 0.25 + Math.random() * 0.2;
            p.vz = (Math.random() - 0.5) * 0.08;
            p.maxLife = p.life = 1.2 + Math.random() * 0.6;
            p.size = 0.9 + Math.random() * 0.6;
          }
        }}
      />
      <ParticlePoints
        capacity={thinkingCap}
        color="#a7c4ef"
        tick={(pool, dt, now) => {
          for (const agent of readAgents()) {
            const active = streamingByAgentId[agent.id] || thinkingByAgentId[agent.id];
            if (!active || agent.state === "away") continue;
            if ((now * 0.001 + hashUnit(agent.id, 7)) % 0.33 > dt) continue;
            const p = takeDead(pool);
            if (!p) break;
            const [wx, , wz] = toWorld(agent.x, agent.y);
            const angle = now * 0.0018 + hashUnit(agent.id, 11) * Math.PI * 2;
            const r = 0.26;
            p.x = wx + Math.cos(angle) * r;
            p.y = HEAD_Y + 0.3 + Math.sin(angle * 2) * 0.03;
            p.z = wz + Math.sin(angle) * r * 0.65;
            p.vx = -Math.sin(angle) * 0.22;
            p.vy = 0.03;
            p.vz = Math.cos(angle) * 0.14;
            p.maxLife = p.life = 1.6;
            p.size = 1.3;
          }
        }}
      />
      <ParticlePoints
        capacity={errorCap}
        color="#ff5a5a"
        tick={(pool, dt, now) => {
          for (const agent of readAgents()) {
            if (agent.status !== "error") continue;
            // One burst every ~3s per agent.
            if ((now * 0.001 + hashUnit(agent.id, 3) * 3) % 3 > dt) continue;
            const [wx, , wz] = toWorld(agent.x, agent.y);
            for (let i = 0; i < 4; i += 1) {
              const p = takeDead(pool);
              if (!p) break;
              const a = Math.random() * Math.PI * 2;
              p.x = wx;
              p.y = HEAD_Y + 0.42;
              p.z = wz;
              p.vx = Math.cos(a) * 0.9;
              p.vy = 0.6 + Math.random() * 0.5;
              p.vz = Math.sin(a) * 0.9;
              p.maxLife = p.life = 0.3 + Math.random() * 0.1;
              p.size = 1.1;
            }
          }
        }}
      />
      <ParticlePoints
        capacity={convoCap}
        color="#ffe3bd"
        tick={(pool, dt, now) => {
          const agents = readAgents();
          for (const agent of agents) {
            if (agent.conversationGroupId === undefined || agent.state !== "standing") continue;
            if ((now * 0.001 + hashUnit(agent.id, 5)) % 0.5 > dt) continue;
            const p = takeDead(pool);
            if (!p) break;
            const [wx, , wz] = toWorld(agent.x, agent.y);
            const tx = agent.conversationTargetX ?? agent.x;
            const ty = agent.conversationTargetY ?? agent.y;
            const [cx, , cz] = toWorld(tx, ty);
            // Drift from the speaker toward the circle centre.
            const dx = cx - wx;
            const dz = cz - wz;
            p.x = wx + Math.sin(agent.facing) * 0.1;
            p.y = HEAD_Y - 0.05 + Math.random() * 0.1;
            p.z = wz + Math.cos(agent.facing) * 0.1;
            p.vx = dx * 0.4 + Math.sin(agent.facing) * 0.25;
            p.vy = 0.04;
            p.vz = dz * 0.4 + Math.cos(agent.facing) * 0.25;
            p.maxLife = p.life = 1.4;
            p.size = 1.0;
          }
        }}
      />
    </group>
  );
}
