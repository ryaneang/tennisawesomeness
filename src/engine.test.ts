import { describe, expect, it } from "vitest";
import { awardPoint, calculateTrajectory, classifySwipe, matchWinner, type MatchState } from "./engine";

describe("swipe controls", () => {
  it("turns upward and downward gestures into spin", () => {
    expect(classifySwipe({ start: { x: 0, y: 100 }, end: { x: 30, y: 0 }, durationMs: 180 }).kind).toBe("topspin");
    expect(classifySwipe({ start: { x: 0, y: 0 }, end: { x: -30, y: 100 }, durationMs: 180 }).kind).toBe("slice");
  });

  it("uses horizontal movement to aim", () => {
    expect(classifySwipe({ start: { x: 0, y: 100 }, end: { x: 100, y: 10 }, durationMs: 160 }).aim).toBeGreaterThan(0);
    expect(classifySwipe({ start: { x: 100, y: 100 }, end: { x: 0, y: 10 }, durationMs: 160 }).aim).toBeLessThan(0);
  });

  it("keeps symmetric diagonal gestures aimed symmetrically", () => {
    const left = classifySwipe({ start: { x: 200, y: 200 }, end: { x: 100, y: 100 }, durationMs: 180 });
    const right = classifySwipe({ start: { x: 200, y: 200 }, end: { x: 300, y: 100 }, durationMs: 180 });
    expect(left.aim).toBeCloseTo(-right.aim);
  });

  it("provides a safe flat shot for a tap", () => {
    expect(classifySwipe({ start: { x: 10, y: 10 }, end: { x: 12, y: 12 }, durationMs: 80 })).toMatchObject({ aim: 0, kind: "flat" });
  });
});

describe("shot trajectories", () => {
  it("gives slices a safe, higher net crossing than topspin", () => {
    const start = { x: 0, y: 1.15, z: 1.2 };
    const target = { x: 2, y: 0.12, z: 20.5 };
    const slice = calculateTrajectory(start, target, 0.8, -0.8);
    const topspin = calculateTrajectory(start, target, 0.8, 0.8);
    expect(slice.netHeight).toBeGreaterThan(1.35);
    expect(slice.netHeight).toBeGreaterThan(topspin.netHeight);
    expect(slice.flightTime).toBeGreaterThan(topspin.flightTime);
  });

  it("sends left and right targets in the requested direction", () => {
    const start = { x: 0, y: 1.15, z: 1.2 };
    expect(calculateTrajectory(start, { x: -3, y: 0.12, z: 20 }, 0.7, 0).vx).toBeLessThan(0);
    expect(calculateTrajectory(start, { x: 3, y: 0.12, z: 20 }, 0.7, 0).vx).toBeGreaterThan(0);
  });
});

describe("arcade scoring", () => {
  it("alternates server after every two points", () => {
    let match: MatchState = { player: 0, ai: 0, pointsPlayed: 0, server: "player" };
    match = awardPoint(match, "player");
    expect(match.server).toBe("player");
    match = awardPoint(match, "ai");
    expect(match.server).toBe("ai");
  });

  it("ends when either side reaches eleven", () => {
    expect(matchWinner({ player: 11, ai: 7, pointsPlayed: 18, server: "ai" })).toBe("player");
    expect(matchWinner({ player: 5, ai: 11, pointsPlayed: 16, server: "player" })).toBe("ai");
  });
});
