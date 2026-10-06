"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useRef, type RefObject } from "react";
import * as THREE from "three";
import { toWorld } from "@/features/retro-office/core/geometry";
import type { RenderAgent } from "@/features/retro-office/core/types";
import {
  calculateFocusOffset,
  dampScalar,
} from "@/features/retro-office/systems/transitionAnimations";
import type { CameraPreset } from "@/features/retro-office/systems/cameraLighting";

export type FocusCameraState =
  | "overview"
  | "enteringFocus"
  | "focused"
  | "leavingFocus";

type OrbitControllerLike = {
  target: THREE.Vector3;
  update: () => void;
  enabled?: boolean;
};

export type FocusCameraControllerProps = {
  focusedAgentId: string | null;
  agentsRef: RefObject<RenderAgent[]>;
  agentLookupRef?: RefObject<Map<string, RenderAgent>>;
  orbitRef: RefObject<OrbitControllerLike | null>;
  isMobile?: boolean;
  panelWidthRatio?: number;
  overviewPreset?: CameraPreset;
  onFocusStateChange?: (state: FocusCameraState) => void;
};

/** Nominal vertical world height of the agent character model (~0.55 * 1.75 AGENT_SCALE) */
const CHARACTER_WORLD_HEIGHT = 0.96;
/** Desired vertical occupancy ratio of the character in the focused camera view (65-80%) */
const DESIRED_VERTICAL_OCCUPANCY = 0.72;
/** Elevation angle for clear, unobstructed 3/4 face-and-body view */
const ELEVATION_ANGLE_RAD = (18 * Math.PI) / 180;
/** Azimuthal angle offset from agent facing (3/4 perspective) */
const AZIMUTH_OFFSET_RAD = 0.38;

export function FocusCameraController({
  focusedAgentId,
  agentsRef,
  agentLookupRef,
  orbitRef,
  isMobile = false,
  panelWidthRatio = 0.4,
  overviewPreset,
  onFocusStateChange,
}: FocusCameraControllerProps) {
  const stateRef = useRef<FocusCameraState>("overview");
  const overviewSnapshotRef = useRef<{
    pos: THREE.Vector3;
    target: THREE.Vector3;
  } | null>(null);

  const currentOffsetXRef = useRef<number>(0);
  const targetCamPosRef = useRef(new THREE.Vector3());
  const targetLookAtRef = useRef(new THREE.Vector3());
  const camOffsetRef = useRef(new THREE.Vector3());
  const lastActiveAgentIdRef = useRef<string | null>(null);

  const updateState = (next: FocusCameraState) => {
    if (stateRef.current !== next) {
      stateRef.current = next;
      onFocusStateChange?.(next);
    }
  };

  // Keep orbit enabled/disabled properly coordinated
  useEffect(() => {
    const orbit = orbitRef.current;
    if (!orbit) return;

    if (focusedAgentId !== null) {
      // Temporarily disable manual orbit rotate during transition to prevent fighting
      orbit.enabled = false;
    } else {
      orbit.enabled = true;
    }
  }, [focusedAgentId, orbitRef]);

  useFrame((threeState, delta) => {
    const { camera, size } = threeState;
    if (!(camera instanceof THREE.PerspectiveCamera)) return;
    const orbit = orbitRef.current;
    if (!orbit) return;

    const dt = Math.min(delta, 0.1); // clamp delta to prevent explosions on tab resume

    // -------------------------------------------------------------------------
    // 1. FOCUSING / FOCUSED ON AN AGENT
    // -------------------------------------------------------------------------
    if (focusedAgentId !== null) {
      const agent =
        agentLookupRef?.current?.get(focusedAgentId) ??
        agentsRef.current?.find((a) => a.id === focusedAgentId);

      // If agent is missing/offline, gracefully return to overview
      if (!agent) {
        if (stateRef.current !== "leavingFocus" && stateRef.current !== "overview") {
          updateState("leavingFocus");
        }
      } else {
        // Entering focus for the first time: snapshot current overview pose
        if (stateRef.current === "overview") {
          overviewSnapshotRef.current = {
            pos: camera.position.clone(),
            target: orbit.target.clone(),
          };
          updateState("enteringFocus");
        } else if (
          stateRef.current === "focused" &&
          lastActiveAgentIdRef.current !== focusedAgentId
        ) {
          // Switched between agent A and B: transition directly without resetting snapshot
          updateState("enteringFocus");
        }
        lastActiveAgentIdRef.current = focusedAgentId;

        // Compute world position of agent
        const [wx, , wz] = toWorld(agent.x, agent.y);
        // Look at center of character's torso / chest (Y = 0.48)
        targetLookAtRef.current.set(wx, 0.48, wz);

        // Compute distance so character occupies ~72% of visible vertical height
        const halfFovRad = THREE.MathUtils.degToRad(camera.fov / 2);
        const visibleWorldHeight = CHARACTER_WORLD_HEIGHT / DESIRED_VERTICAL_OCCUPANCY;
        const distance = visibleWorldHeight / (2 * Math.tan(halfFovRad));

        // 3/4 front angle relative to agent's facing
        const camAngle = agent.facing + AZIMUTH_OFFSET_RAD;
        camOffsetRef.current.set(
          distance * Math.cos(ELEVATION_ANGLE_RAD) * Math.sin(camAngle),
          distance * Math.sin(ELEVATION_ANGLE_RAD),
          distance * Math.cos(ELEVATION_ANGLE_RAD) * Math.cos(camAngle),
        );
        targetCamPosRef.current.copy(targetLookAtRef.current).add(camOffsetRef.current);

        // Smooth damping towards agent focus pose (0.6 - 0.9s feel)
        camera.position.x = dampScalar(camera.position.x, targetCamPosRef.current.x, 6.0, dt);
        camera.position.y = Math.max(0.5, dampScalar(camera.position.y, targetCamPosRef.current.y, 6.0, dt));
        camera.position.z = dampScalar(camera.position.z, targetCamPosRef.current.z, 6.0, dt);

        orbit.target.x = dampScalar(orbit.target.x, targetLookAtRef.current.x, 6.0, dt);
        orbit.target.y = Math.max(0, dampScalar(orbit.target.y, targetLookAtRef.current.y, 6.0, dt));
        orbit.target.z = dampScalar(orbit.target.z, targetLookAtRef.current.z, 6.0, dt);
        orbit.update();
        camera.lookAt(orbit.target);

        // Smoothly interpolate lateral view offset to position character on the left (28-32%)
        const targetOffsetPx = calculateFocusOffset(size.width, panelWidthRatio, isMobile);
        currentOffsetXRef.current = dampScalar(
          currentOffsetXRef.current,
          targetOffsetPx,
          6.0,
          dt,
        );

        if (currentOffsetXRef.current > 0.5) {
          camera.setViewOffset(
            size.width,
            size.height,
            currentOffsetXRef.current,
            0,
            size.width,
            size.height,
          );
          camera.updateProjectionMatrix();
        }

        // Check if settled into focused state
        const dist = camera.position.distanceTo(targetCamPosRef.current);
        const offsetDiff = Math.abs(currentOffsetXRef.current - targetOffsetPx);
        if (stateRef.current === "enteringFocus" && dist < 0.08 && offsetDiff < 2) {
          updateState("focused");
        }
        return;
      }
    }

    // -------------------------------------------------------------------------
    // 2. RETURNING TO OVERVIEW (focusedAgentId === null)
    // -------------------------------------------------------------------------
    if (stateRef.current === "focused" || stateRef.current === "enteringFocus") {
      updateState("leavingFocus");
    }

    if (stateRef.current === "leavingFocus") {
      const snap = overviewSnapshotRef.current ?? {
        pos: new THREE.Vector3(...(overviewPreset?.pos ?? [0, 10, 12])),
        target: new THREE.Vector3(...(overviewPreset?.target ?? [0, 0, 0])),
      };

      // Smoothly return camera position and orbit target to snapshot
      camera.position.x = dampScalar(camera.position.x, snap.pos.x, 6.0, dt);
      camera.position.y = Math.max(0.5, dampScalar(camera.position.y, snap.pos.y, 6.0, dt));
      camera.position.z = dampScalar(camera.position.z, snap.pos.z, 6.0, dt);

      orbit.target.x = dampScalar(orbit.target.x, snap.target.x, 6.0, dt);
      orbit.target.y = Math.max(0, dampScalar(orbit.target.y, snap.target.y, 6.0, dt));
      orbit.target.z = dampScalar(orbit.target.z, snap.target.z, 6.0, dt);
      orbit.update();
      camera.lookAt(orbit.target);

      // Smoothly return view offset to 0
      currentOffsetXRef.current = dampScalar(
        currentOffsetXRef.current,
        0,
        7.0,
        dt,
      );

      if (currentOffsetXRef.current > 0.5) {
        camera.setViewOffset(
          size.width,
          size.height,
          currentOffsetXRef.current,
          0,
          size.width,
          size.height,
        );
        camera.updateProjectionMatrix();
      } else if (camera.view !== null) {
        camera.clearViewOffset();
        camera.updateProjectionMatrix();
      }

      // Check if settled back into overview
      const dist = camera.position.distanceTo(snap.pos);
      if (dist < 0.06 && currentOffsetXRef.current <= 0.5) {
        camera.clearViewOffset();
        camera.updateProjectionMatrix();
        overviewSnapshotRef.current = null;
        lastActiveAgentIdRef.current = null;
        orbit.enabled = true;
        updateState("overview");
      }
    }
  });

  return null;
}
