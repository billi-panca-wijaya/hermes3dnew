import { describe, expect, it } from "vitest";
import {
  calculateFocusOffset,
  dampScalar,
  shortestAngleDiff,
  SuccessEventTracker,
} from "@/features/retro-office/systems/transitionAnimations";

describe("transitionAnimations", () => {
  describe("dampScalar", () => {
    it("moves current towards target over delta time", () => {
      const initial = 0;
      const target = 10;
      const damped = dampScalar(initial, target, 6, 0.1);
      expect(damped).toBeGreaterThan(initial);
      expect(damped).toBeLessThan(target);
    });

    it("converges to target as dt becomes large", () => {
      const damped = dampScalar(0, 10, 6, 5);
      expect(damped).toBeCloseTo(10, 4);
    });

    it("handles zero dt without moving", () => {
      const damped = dampScalar(5, 10, 6, 0);
      expect(damped).toBe(5);
    });
  });

  describe("shortestAngleDiff", () => {
    it("computes standard angle difference within [-PI, PI]", () => {
      const diff = shortestAngleDiff(0, Math.PI / 2);
      expect(diff).toBeCloseTo(Math.PI / 2);
    });

    it("takes the shortest rotation path across -PI / PI wrap", () => {
      // From 170 deg to -170 deg: shortest turn is +20 deg (+0.349 rad), NOT -340 deg
      const from = (170 * Math.PI) / 180;
      const to = (-170 * Math.PI) / 180;
      const diff = shortestAngleDiff(from, to);
      expect(diff).toBeCloseTo((20 * Math.PI) / 180, 4);
    });

    it("handles full rotations smoothly", () => {
      const diff = shortestAngleDiff(0, Math.PI * 2);
      expect(diff).toBeCloseTo(0, 4);
    });
  });

  describe("calculateFocusOffset", () => {
    it("returns 0 for mobile devices (scene at top, panel at bottom)", () => {
      const offset = calculateFocusOffset(390, 0.4, true);
      expect(offset).toBe(0);
    });

    it("calculates view offset in pixels to shift projection on desktop", () => {
      // 1440px desktop, 40% panel width = 576px panel, clamped to max 560px
      // offset is panelWidth / 2 = 560 / 2 = 280px
      const offset = calculateFocusOffset(1440, 0.4, false);
      expect(offset).toBe(280);
    });

    it("clamps panel width between 380px and 560px on desktop", () => {
      // 1000px with 0.1 ratio -> 100px clamped up to min 380px -> 380 / 2 = 190px
      const offsetLow = calculateFocusOffset(1000, 0.1, false);
      expect(offsetLow).toBe(190);

      // 1000px with 0.8 ratio -> 800px clamped down to max 560px -> 560 / 2 = 280px
      const offsetHigh = calculateFocusOffset(1000, 0.8, false);
      expect(offsetHigh).toBe(280);
    });
  });

  describe("SuccessEventTracker", () => {
    it("triggers one-shot gesture and reports true while within duration", () => {
      const tracker = new SuccessEventTracker();
      const now = 10000;
      const agentId = "agent-1";

      expect(tracker.isGesturing(agentId, now, 800)).toBe(false);

      tracker.trigger(agentId, now);
      expect(tracker.isGesturing(agentId, now + 100, 800)).toBe(true);
      expect(tracker.progress(agentId, now + 400, 800)).toBeCloseTo(0.5, 2);

      // After duration expires, gesture ends
      expect(tracker.isGesturing(agentId, now + 900, 800)).toBe(false);
      expect(tracker.progress(agentId, now + 900, 800)).toBe(1);
    });

    it("does not loop without a new trigger", () => {
      const tracker = new SuccessEventTracker();
      tracker.trigger("agent-1", 1000);
      expect(tracker.isGesturing("agent-1", 3000, 800)).toBe(false);
    });
  });
});
