export type Difficulty = "easy" | "medium" | "hard";
export type SpinKind = "topspin" | "flat" | "slice";
export type Side = "player" | "ai";

export interface Point { x: number; y: number }
export interface SwipeGesture { start: Point; end: Point; durationMs: number }
export interface ShotIntent { aim: number; power: number; spin: number; kind: SpinKind }
export interface MatchState { player: number; ai: number; server: Side; pointsPlayed: number }
export interface TrajectoryPoint { x: number; y: number; z: number }
export interface ShotTrajectory { vx: number; vy: number; vz: number; gravity: number; flightTime: number; netHeight: number }

export interface DifficultyConfig {
  reaction: number;
  speed: number;
  accuracy: number;
  errorRate: number;
  power: number;
}

export const DIFFICULTIES: Record<Difficulty, DifficultyConfig> = {
  easy: { reaction: 0.62, speed: 4.8, accuracy: 0.66, errorRate: 0.18, power: 0.82 },
  medium: { reaction: 0.4, speed: 6.2, accuracy: 0.8, errorRate: 0.1, power: 0.94 },
  hard: { reaction: 0.24, speed: 7.7, accuracy: 0.91, errorRate: 0.045, power: 1.05 },
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function classifySwipe(gesture: SwipeGesture): ShotIntent {
  const dx = gesture.end.x - gesture.start.x;
  const dy = gesture.end.y - gesture.start.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 12) return { aim: 0, power: 0.56, spin: 0, kind: "flat" };

  const speed = distance / Math.max(gesture.durationMs, 45);
  const verticalRatio = -dy / distance;
  const horizontalRatio = dx / distance;
  const spin = Math.abs(verticalRatio) < 0.18 ? 0 : clamp(verticalRatio, -1, 1);
  const kind: SpinKind = spin > 0 ? "topspin" : spin < 0 ? "slice" : "flat";
  return {
    aim: clamp(Math.sign(horizontalRatio) * Math.pow(Math.abs(horizontalRatio), 0.85) * 1.15, -1, 1),
    power: clamp(0.4 + distance / 400 + speed * 0.08, 0.45, 1),
    spin,
    kind,
  };
}

export function calculateTrajectory(start: TrajectoryPoint, target: TrajectoryPoint, power: number, spin: number, serving = false): ShotTrajectory {
  const baseTime = serving ? 1.02 - power * 0.3 : 1.28 - power * 0.42;
  const spinTime = spin > 0.15 ? 0.92 : spin < -0.15 ? 1.16 : 1;
  const flightTime = clamp(baseTime * spinTime, 0.62, 1.48);
  const netFraction = clamp(Math.abs((11.885 - start.z) / (target.z - start.z)), 0.05, 0.95);
  const arcLift = spin > 0.15 ? 0.72 : spin < -0.15 ? 1.08 : 0.86;
  const gravity = (2 * arcLift) / (flightTime * flightTime * netFraction * (1 - netFraction));
  const vy = (target.y - start.y + 0.5 * gravity * flightTime * flightTime) / flightTime;
  const chordHeight = start.y * (1 - netFraction) + target.y * netFraction;

  return {
    vx: (target.x - start.x) / flightTime,
    vy,
    vz: (target.z - start.z) / flightTime,
    gravity,
    flightTime,
    netHeight: chordHeight + arcLift,
  };
}

export function awardPoint(match: MatchState, winner: Side): MatchState {
  const player = match.player + (winner === "player" ? 1 : 0);
  const ai = match.ai + (winner === "ai" ? 1 : 0);
  const pointsPlayed = match.pointsPlayed + 1;
  return { player, ai, pointsPlayed, server: Math.floor(pointsPlayed / 2) % 2 === 0 ? "player" : "ai" };
}

export function matchWinner(match: MatchState): Side | null {
  if (match.player >= 11) return "player";
  if (match.ai >= 11) return "ai";
  return null;
}

export function pointInCourt(x: number, z: number) {
  return Math.abs(x) <= 4.115 && z >= 0 && z <= 23.77;
}
