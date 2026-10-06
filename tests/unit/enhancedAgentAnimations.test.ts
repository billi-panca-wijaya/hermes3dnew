import { describe, expect, it } from "vitest";
import {
  bell,
  easeInOutCubic,
  easeOutBack,
  hashUnit,
  periodicGesturePhase,
  PoseTransitionTracker,
  resolveTransitionDurationMs,
  resolveWalkDynamics,
} from "@/features/retro-office/systems/transitionAnimations";
import { classifyAgentRole } from "@/features/retro-office/systems/roleVisuals";

describe("transitionAnimations", () => {
  it("resolves specific, wildcard and default durations", () => {
    expect(resolveTransitionDurationMs("standing", "walking")).toBe(300);
    expect(resolveTransitionDurationMs("dancing", "away")).toBe(800);
    expect(resolveTransitionDurationMs("away", "sitting")).toBe(600);
    expect(resolveTransitionDurationMs("working_out", "dancing")).toBe(400);
    expect(resolveTransitionDurationMs("sitting", "sitting")).toBe(0);
  });

  it("easing functions stay within [0,1] at the bounds", () => {
    for (const fn of [easeInOutCubic, bell]) {
      expect(fn(0)).toBeCloseTo(0, 5);
      expect(fn(1)).toBeCloseTo(fn === bell ? 0 : 1, 5);
      expect(fn(-1)).toBeCloseTo(fn(0), 5);
      expect(fn(2)).toBeCloseTo(fn(1), 5);
    }
    expect(easeOutBack(1)).toBeCloseTo(1, 5);
    expect(easeOutBack(0.6)).toBeGreaterThan(1); // overshoot
  });

  it("hashUnit is deterministic, salted, and in [0,1)", () => {
    expect(hashUnit("hermes")).toBe(hashUnit("hermes"));
    expect(hashUnit("hermes")).not.toBe(hashUnit("hermes", 1));
    expect(hashUnit("hermes")).not.toBe(hashUnit("mika"));
    for (const id of ["a", "b", "backend-dev-1234"]) {
      const v = hashUnit(id);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("periodicGesturePhase fires for durationMs out of every periodMs", () => {
    let active = 0;
    const samples = 1000;
    for (let i = 0; i < samples; i += 1) {
      if (periodicGesturePhase("agent", i * 10, 10_000, 2_000) !== null) active += 1;
    }
    expect(active).toBeGreaterThan(samples * 0.15);
    expect(active).toBeLessThan(samples * 0.25);
  });

  it("tracks eased pose transitions and completes them", () => {
    const tracker = new PoseTransitionTracker();
    expect(tracker.observe("a", "standing", 0)).toMatchObject({ weight: 1, transitioning: false });

    const start = tracker.observe("a", "walking", 1000);
    expect(start).toMatchObject({ state: "walking", previous: "standing", transitioning: true });
    expect(start.weight).toBeCloseTo(0, 5);

    const mid = tracker.observe("a", "walking", 1150);
    expect(mid.transitioning).toBe(true);
    expect(mid.weight).toBeCloseTo(0.5, 2);

    const done = tracker.observe("a", "walking", 1400);
    expect(done).toMatchObject({ weight: 1, transitioning: false, previous: "walking" });

    tracker.prune(["b"]);
    expect(tracker.observe("a", "walking", 2000)).toMatchObject({ weight: 1, transitioning: false });
  });

  it("walk dynamics scale with speed and flag hurrying", () => {
    const base = resolveWalkDynamics(0.3, 0.3);
    expect(base).toMatchObject({ strideScale: 1, lean: 0, cadence: 1, hurrying: false });
    const rush = resolveWalkDynamics(0.3 * 4.5, 0.3);
    expect(rush.hurrying).toBe(true);
    expect(rush.lean).toBeGreaterThan(0);
    expect(rush.lean).toBeLessThanOrEqual(0.14);
    expect(rush.strideScale).toBeGreaterThan(1);
    expect(rush.cadence).toBeGreaterThan(1);
  });
});

describe("classifyAgentRole", () => {
  it("maps role text to visual buckets", () => {
    expect(classifyAgentRole("Orchestrator")).toBe("orchestrator");
    expect(classifyAgentRole("Python backend specialist")).toBe("developer");
    expect(classifyAgentRole("Research")).toBe("researcher");
    expect(classifyAgentRole("UX designer")).toBe("designer");
    expect(classifyAgentRole("QA engineer")).toBe("qa");
    expect(classifyAgentRole("Security auditor")).toBe("security");
    expect(classifyAgentRole("DevOps / infra")).toBe("devops");
    expect(classifyAgentRole("Technical writer")).toBe("writer");
    expect(classifyAgentRole("Builder")).toBe("developer");
    expect(classifyAgentRole("", "Avery")).toBe("generic");
    expect(classifyAgentRole(null)).toBe("generic");
  });
});
