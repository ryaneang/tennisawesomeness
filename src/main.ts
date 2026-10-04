import "./style.css";
import {
  DIFFICULTIES,
  awardPoint,
  calculateTrajectory,
  classifySwipe,
  matchWinner,
  pointInCourt,
  type Difficulty,
  type MatchState,
  type Point,
  type ShotIntent,
  type Side,
} from "./engine";

const COURT_LENGTH = 23.77;
const COURT_HALF = 5.485;
const SINGLES_HALF = 4.115;
const NET_Z = COURT_LENGTH / 2;
const BALL_RADIUS = 0.12;

type Phase = "menu" | "preServe" | "toss" | "rally" | "pointOver" | "matchOver" | "paused";

interface Ball {
  x: number; y: number; z: number; vx: number; vy: number; vz: number;
  spin: number; gravity: number; moving: boolean; lastHit: Side; bounces: number; isServe: boolean; trail: Array<{ x: number; y: number; z: number; life: number }>;
}

interface Athlete { x: number; targetX: number; vx: number; z: number; swing: number; side: Side }
interface Particle { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; color: string }

const $ = <T extends HTMLElement>(selector: string) => {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing element: ${selector}`);
  return node;
};

const canvas = $("#game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const staticCanvas = document.createElement("canvas");
const staticCtx = staticCanvas.getContext("2d")!;
const menuScreen = $("#menuScreen");
const howScreen = $("#howScreen");
const pauseScreen = $("#pauseScreen");
const resultScreen = $("#resultScreen");
const scoreboard = $("#scoreboard");
const shotPrompt = $("#shotPrompt");
const promptTitle = $("#promptTitle");
const promptSub = $("#promptSub");
const toast = $("#toast");
const playerScore = $("#playerScore");
const aiScore = $("#aiScore");
const serveIndicator = $("#serveIndicator");

let width = 0;
let height = 0;
let dpr = 1;
let phase: Phase = "menu";
let previousPhase: Phase = "rally";
let difficulty: Difficulty = "medium";
let soundEnabled = true;
let lastTime = performance.now();
let accumulator = 0;
let phaseTime = 0;
let serveAttempt = 1;
let retryServe = false;
let aiActionAt = 0;
let pendingShot: { intent: ShotIntent; expires: number } | null = null;
let pointer: { id: number; start: Point; current: Point; startTime: number; dragging: boolean } | null = null;
let toastTimer = 0;
let rallyHits = 0;
let shake = 0;
let audioContext: AudioContext | null = null;

let match: MatchState = { player: 0, ai: 0, server: "player", pointsPlayed: 0 };
const player: Athlete = { x: 0, targetX: 0, vx: 0, z: -1.2, swing: 0, side: "player" };
const rival: Athlete = { x: 0, targetX: 0, vx: 0, z: COURT_LENGTH + 1.15, swing: 0, side: "ai" };
const ball: Ball = { x: 0, y: 1.2, z: 0, vx: 0, vy: 0, vz: 0, spin: 0, gravity: 9.8, moving: false, lastHit: "player", bounces: 0, isServe: false, trail: [] };
const particles: Particle[] = [];

function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }
function lerp(a: number, b: number, amount: number) { return a + (b - a) * amount; }

function resize() {
  width = window.innerWidth;
  height = window.innerHeight;
  dpr = Math.min(window.devicePixelRatio || 1, width < 900 ? 1.5 : 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  staticCanvas.width = Math.round(width * dpr);
  staticCanvas.height = Math.round(height * dpr);
  staticCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBackground(staticCtx);
}
window.addEventListener("resize", resize);
resize();

function project(x: number, y: number, z: number) {
  const t = clamp(z / COURT_LENGTH, -0.08, 1.08);
  const depth = Math.pow(clamp(1 - t, 0, 1), 0.72);
  const groundY = lerp(height * 0.225, height * 0.89, depth);
  const halfWidth = lerp(width * 0.135, width * 0.39, depth);
  const scale = lerp(0.32, 1.05, depth);
  return { x: width / 2 + (x / COURT_HALF) * halfWidth, y: groundY - y * height * 0.092 * scale, scale };
}

function courtPath(g: CanvasRenderingContext2D, points: Array<[number, number]>) {
  g.beginPath();
  points.forEach(([x, z], index) => {
    const p = project(x, 0, z);
    if (index === 0) g.moveTo(p.x, p.y); else g.lineTo(p.x, p.y);
  });
  g.closePath();
}

function drawBackground(g: CanvasRenderingContext2D) {
  g.clearRect(0, 0, width, height);
  const sky = g.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#071521");
  sky.addColorStop(0.43, "#123649");
  sky.addColorStop(1, "#07171e");
  g.fillStyle = sky; g.fillRect(0, 0, width, height);

  const horizon = height * 0.22;
  const glow = g.createRadialGradient(width * .5, horizon, 0, width * .5, horizon, width * .48);
  glow.addColorStop(0, "rgba(93,188,193,.28)"); glow.addColorStop(.5, "rgba(38,96,115,.1)"); glow.addColorStop(1, "rgba(4,17,25,0)");
  g.fillStyle = glow; g.fillRect(0, 0, width, height * .7);

  // Stadium seating and crowd lights.
  g.fillStyle = "#081a25";
  g.beginPath(); g.moveTo(0, horizon * .58); g.lineTo(width * .18, horizon * .8); g.lineTo(width * .82, horizon * .8); g.lineTo(width, horizon * .58); g.lineTo(width, horizon + 34); g.lineTo(0, horizon + 34); g.closePath(); g.fill();
  g.fillStyle = "rgba(167,214,216,.34)";
  for (let row = 0; row < 4; row++) {
    const y = horizon * .68 + row * 11;
    for (let x = 12 + (row % 2) * 7; x < width; x += 24) {
      if ((x * 7 + row * 13) % 5 !== 0) { g.beginPath(); g.arc(x, y, 1.2, 0, Math.PI * 2); g.fill(); }
    }
  }
  g.strokeStyle = "rgba(161,214,219,.13)"; g.lineWidth = 1;
  for (let row = 0; row < 4; row++) { g.beginPath(); g.moveTo(0, horizon * .64 + row * 11); g.lineTo(width, horizon * .64 + row * 11); g.stroke(); }

  // Floodlights create depth without loading large image assets.
  for (const side of [-1, 1]) {
    const x = width / 2 + side * width * .39;
    g.strokeStyle = "rgba(156,201,206,.35)"; g.lineWidth = 3; g.beginPath(); g.moveTo(x, horizon + 20); g.lineTo(x + side * 14, horizon * .24); g.stroke();
    g.fillStyle = "rgba(228,250,239,.8)"; g.fillRect(x + side * 4 - 18, horizon * .18, 36, 8);
    g.shadowColor = "rgba(189,240,232,.7)"; g.shadowBlur = 22; g.fillRect(x + side * 4 - 13, horizon * .2, 26, 3); g.shadowBlur = 0;
  }

  const floor = g.createLinearGradient(0, horizon, 0, height);
  floor.addColorStop(0, "#102e3a"); floor.addColorStop(1, "#071920");
  g.fillStyle = floor; g.fillRect(0, horizon, width, height - horizon);

  // Court surround, then the playing surface inset within it.
  courtPath(g, [[-COURT_HALF - 2.3, -2.4], [COURT_HALF + 2.3, -2.4], [COURT_HALF + 2.3, COURT_LENGTH + 2.2], [-COURT_HALF - 2.3, COURT_LENGTH + 2.2]]);
  const surround = g.createLinearGradient(0, height * .24, 0, height);
  surround.addColorStop(0, "#163c58"); surround.addColorStop(1, "#0c2a40"); g.fillStyle = surround; g.fill();
  courtPath(g, [[-COURT_HALF, 0], [COURT_HALF, 0], [COURT_HALF, COURT_LENGTH], [-COURT_HALF, COURT_LENGTH]]);
  const court = g.createLinearGradient(0, height * .25, 0, height);
  court.addColorStop(0, "#3d84a5"); court.addColorStop(.56, "#327696"); court.addColorStop(1, "#286480"); g.fillStyle = court; g.fill();

  // Subtle brushed-court bands give the flat canvas surface texture.
  g.save(); courtPath(g, [[-COURT_HALF, 0], [COURT_HALF, 0], [COURT_HALF, COURT_LENGTH], [-COURT_HALF, COURT_LENGTH]]); g.clip();
  for (let y = horizon; y < height; y += 5) { g.fillStyle = `rgba(255,255,255,${y % 10 === 0 ? .012 : .006})`; g.fillRect(0, y, width, 2); }
  g.restore();

  g.strokeStyle = "rgba(240,249,240,.96)"; g.lineWidth = Math.max(1.4, width / 800);
  const line = (x1: number, z1: number, x2: number, z2: number) => {
    const a = project(x1, .015, z1), b = project(x2, .015, z2);
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
  };
  line(-SINGLES_HALF, 0, -SINGLES_HALF, COURT_LENGTH);
  line(SINGLES_HALF, 0, SINGLES_HALF, COURT_LENGTH);
  line(-COURT_HALF, 0, COURT_HALF, 0);
  line(-COURT_HALF, COURT_LENGTH, COURT_HALF, COURT_LENGTH);
  line(-SINGLES_HALF, NET_Z - 6.4, SINGLES_HALF, NET_Z - 6.4);
  line(-SINGLES_HALF, NET_Z + 6.4, SINGLES_HALF, NET_Z + 6.4);
  line(0, NET_Z - 6.4, 0, NET_Z + 6.4);

  drawNet(g);
}

function drawNet(g: CanvasRenderingContext2D) {
  const leftGround = project(-COURT_HALF - .4, 0, NET_Z);
  const rightGround = project(COURT_HALF + .4, 0, NET_Z);
  const leftTop = project(-COURT_HALF - .4, 1.02, NET_Z);
  const rightTop = project(COURT_HALF + .4, 1.02, NET_Z);
  g.fillStyle = "rgba(2,14,21,.38)";
  g.beginPath(); g.moveTo(leftGround.x, leftGround.y); g.lineTo(leftTop.x, leftTop.y); g.lineTo(rightTop.x, rightTop.y); g.lineTo(rightGround.x, rightGround.y); g.closePath(); g.fill();
  g.strokeStyle = "rgba(220,241,238,.22)"; g.lineWidth = .7;
  for (let i = 0; i <= 18; i++) {
    const t = i / 18;
    g.beginPath(); g.moveTo(lerp(leftGround.x, rightGround.x, t), lerp(leftGround.y, rightGround.y, t)); g.lineTo(lerp(leftTop.x, rightTop.x, t), lerp(leftTop.y, rightTop.y, t)); g.stroke();
  }
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    g.beginPath(); g.moveTo(lerp(leftGround.x, leftTop.x, t), lerp(leftGround.y, leftTop.y, t)); g.lineTo(lerp(rightGround.x, rightTop.x, t), lerp(rightGround.y, rightTop.y, t)); g.stroke();
  }
  g.strokeStyle = "#eef7ed"; g.lineWidth = 3; g.shadowColor = "rgba(255,255,255,.35)"; g.shadowBlur = 5;
  g.beginPath(); g.moveTo(leftTop.x, leftTop.y); g.lineTo(rightTop.x, rightTop.y); g.stroke(); g.shadowBlur = 0;
}

function drawAthlete(athlete: Athlete) {
  const p = project(athlete.x, 0, athlete.z);
  const s = p.scale * clamp(Math.min(width / 820, height / 560), .72, 1.45);
  const facing = athlete.side === "player" ? -1 : 1;
  const running = clamp(Math.abs(athlete.vx) / 6, 0, 1);
  const stride = Math.sin(phaseTime * 14) * running;
  const swingProgress = athlete.swing > 0 ? Math.sin((1 - athlete.swing) * Math.PI) : 0;
  const shirt = athlete.side === "player" ? "#f3f4e8" : "#ff775f";
  const accent = athlete.side === "player" ? "#dfff3f" : "#f4f6e9";
  ctx.save(); ctx.translate(p.x, p.y);
  ctx.fillStyle = "rgba(1,12,18,.34)"; ctx.filter = "blur(2px)"; ctx.beginPath(); ctx.ellipse(0, 5, 31 * s, 7 * s, 0, 0, Math.PI * 2); ctx.fill(); ctx.filter = "none";

  // Legs use a two-joint pose so side-to-side movement feels alive.
  ctx.strokeStyle = "#c88868"; ctx.lineWidth = 6.5 * s; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(-7 * s, -19 * s); ctx.lineTo((-10 - stride * 7) * s, -5 * s); ctx.lineTo((-18 - stride * 8) * s, 2 * s); ctx.moveTo(7 * s, -19 * s); ctx.lineTo((11 + stride * 7) * s, -5 * s); ctx.lineTo((18 + stride * 8) * s, 2 * s); ctx.stroke();
  ctx.strokeStyle = accent; ctx.lineWidth = 5.5 * s; ctx.beginPath(); ctx.moveTo((-18 - stride * 8) * s, 2 * s); ctx.lineTo((-25 - stride * 8) * s, 3 * s); ctx.moveTo((18 + stride * 8) * s, 2 * s); ctx.lineTo((25 + stride * 8) * s, 3 * s); ctx.stroke();

  // Shorts and shaped jersey.
  ctx.fillStyle = "#102b3a"; ctx.beginPath(); ctx.moveTo(-14 * s, -29 * s); ctx.lineTo(14 * s, -29 * s); ctx.lineTo(12 * s, -15 * s); ctx.lineTo(2 * s, -15 * s); ctx.lineTo(0, -22 * s); ctx.lineTo(-2 * s, -15 * s); ctx.lineTo(-12 * s, -15 * s); ctx.closePath(); ctx.fill();
  ctx.fillStyle = shirt; ctx.beginPath(); ctx.moveTo(-12 * s, -55 * s); ctx.quadraticCurveTo(0, -60 * s, 12 * s, -55 * s); ctx.lineTo(16 * s, -29 * s); ctx.quadraticCurveTo(0, -24 * s, -16 * s, -29 * s); ctx.closePath(); ctx.fill();
  ctx.fillStyle = accent; ctx.fillRect(-15 * s, -33 * s, 30 * s, 4 * s);

  // Free arm and racket arm.
  const swingAngle = facing * (.35 + swingProgress * 1.75);
  ctx.strokeStyle = "#c88868"; ctx.lineWidth = 5.5 * s;
  ctx.beginPath(); ctx.moveTo(-facing * 9 * s, -51 * s); ctx.lineTo(-facing * (20 + running * 4) * s, (-41 + stride * 2) * s); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(facing * 9 * s, -51 * s); ctx.lineTo(facing * 25 * s, (-39 + swingProgress * 5) * s); ctx.stroke();

  // Neck, head, hair, and visor.
  ctx.fillStyle = "#c88868"; ctx.fillRect(-4 * s, -62 * s, 8 * s, 10 * s); ctx.beginPath(); ctx.arc(0, -69 * s, 10.5 * s, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = athlete.side === "player" ? "#17252c" : "#402a2a"; ctx.beginPath(); ctx.arc(0, -72 * s, 10.5 * s, Math.PI, Math.PI * 2); ctx.lineTo(10 * s, -68 * s); ctx.lineTo(-10 * s, -68 * s); ctx.fill();
  ctx.fillStyle = accent; ctx.fillRect(-11 * s, -72 * s, 22 * s, 3 * s);

  ctx.save(); ctx.translate(facing * 27 * s, (-37 + swingProgress * 5) * s); ctx.rotate(swingAngle);
  ctx.strokeStyle = "#d6e5df"; ctx.lineWidth = 2.3 * s; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, 25 * s); ctx.stroke();
  ctx.strokeStyle = accent; ctx.lineWidth = 3 * s; ctx.beginPath(); ctx.ellipse(0, 36 * s, 11.5 * s, 16 * s, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = "rgba(230,246,240,.45)"; ctx.lineWidth = .7 * s;
  for (let i = -6; i <= 6; i += 4) { ctx.beginPath(); ctx.moveTo(i * s, 22 * s); ctx.lineTo(i * .6 * s, 50 * s); ctx.stroke(); }
  for (let i = 27; i <= 45; i += 5) { ctx.beginPath(); ctx.moveTo(-9 * s, i * s); ctx.lineTo(9 * s, i * s); ctx.stroke(); }
  ctx.restore();
  ctx.restore();
}

function drawBall() {
  if (!ball.moving && phase !== "preServe") return;
  const shadow = project(ball.x, 0, ball.z);
  const p = project(ball.x, ball.y, ball.z);
  ctx.fillStyle = `rgba(4,17,20,${clamp(.34 - ball.y * .035, .08, .3)})`;
  ctx.beginPath(); ctx.ellipse(shadow.x, shadow.y, 10 * shadow.scale, 4 * shadow.scale, 0, 0, Math.PI * 2); ctx.fill();
  if (ball.trail.length > 2) {
    ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.shadowColor = "rgba(218,255,71,.5)"; ctx.shadowBlur = 9;
    for (let i = 1; i < ball.trail.length; i++) {
      const a = project(ball.trail[i - 1].x, ball.trail[i - 1].y, ball.trail[i - 1].z);
      const b = project(ball.trail[i].x, ball.trail[i].y, ball.trail[i].z);
      ctx.strokeStyle = `rgba(218,255,71,${(i / ball.trail.length) * .32})`; ctx.lineWidth = Math.max(1, (i / ball.trail.length) * 5 * b.scale);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.restore();
  }
  const radius = clamp(7 * p.scale, 3, 10);
  ctx.shadowColor = "rgba(232,255,67,.8)"; ctx.shadowBlur = 12; ctx.fillStyle = "#e8ff43";
  ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(28,53,52,.7)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(p.x - radius * .25, p.y, radius * .65, -1.2, 1.2); ctx.stroke();
}

function drawContactCue() {
  if (phase !== "rally" || ball.lastHit !== "ai" || ball.vz >= 0 || ball.z > 8) return;
  const ground = project(ball.x, .03, clamp(ball.z, 0, COURT_LENGTH));
  const urgency = clamp(1 - ball.z / 8, 0, 1);
  const pulse = .82 + Math.sin(performance.now() * .012) * .12;
  ctx.save(); ctx.translate(ground.x, ground.y); ctx.scale(1, .38);
  ctx.strokeStyle = `rgba(218,255,71,${.32 + urgency * .5})`; ctx.lineWidth = 2; ctx.setLineDash([7, 5]);
  ctx.beginPath(); ctx.arc(0, 0, (25 - urgency * 7) * pulse, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]); ctx.strokeStyle = `rgba(255,255,255,${.2 + urgency * .35})`; ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
}

function drawGesture() {
  if (!pointer?.dragging) return;
  const { start, current } = pointer;
  const dx = current.x - start.x, dy = current.y - start.y;
  const kind = -dy > 12 ? "TOPSPIN" : dy > 12 ? "SLICE" : "FLAT";
  const intent = classifySwipe({ start, end: current, durationMs: Math.max(performance.now() - pointer.startTime, 45) });
  const baselineInset = lerp(8.3, 2.4, intent.power);
  const targetZ = phase === "toss" ? NET_Z + lerp(4.4, 5.9, intent.power) : COURT_LENGTH - baselineInset;
  const target = project(intent.aim * 4.05, .03, targetZ);
  ctx.save();
  ctx.strokeStyle = "rgba(232,255,67,.9)"; ctx.lineWidth = 2; ctx.setLineDash([5, 5]);
  ctx.beginPath(); ctx.ellipse(target.x, target.y, 17 * target.scale, 7 * target.scale, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]); ctx.fillStyle = "rgba(232,255,67,.18)"; ctx.beginPath(); ctx.arc(target.x, target.y, 11 * target.scale, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  ctx.save(); ctx.strokeStyle = "#e8ff43"; ctx.fillStyle = "#e8ff43"; ctx.lineWidth = 5; ctx.lineCap = "round"; ctx.shadowColor = "#e8ff43"; ctx.shadowBlur = 12;
  ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.quadraticCurveTo(lerp(start.x, current.x, .45) + dy * .08, lerp(start.y, current.y, .45) - dx * .04, current.x, current.y); ctx.stroke();
  const angle = Math.atan2(dy, dx); ctx.beginPath(); ctx.moveTo(current.x, current.y); ctx.lineTo(current.x - 15 * Math.cos(angle - .45), current.y - 15 * Math.sin(angle - .45)); ctx.lineTo(current.x - 15 * Math.cos(angle + .45), current.y - 15 * Math.sin(angle + .45)); ctx.closePath(); ctx.fill();
  ctx.shadowBlur = 0; ctx.font = "800 12px DM Sans"; ctx.textAlign = "center"; ctx.fillText(kind, current.x, current.y - 18); ctx.restore();
}

function drawParticles() {
  for (const particle of particles) {
    const p = project(particle.x, particle.y, particle.z);
    ctx.globalAlpha = clamp(particle.life, 0, 1); ctx.fillStyle = particle.color; ctx.beginPath(); ctx.arc(p.x, p.y, 3 * p.scale * particle.life, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function render() {
  ctx.save();
  if (shake > 0) ctx.translate((Math.random() - .5) * shake, (Math.random() - .5) * shake);
  ctx.drawImage(staticCanvas, 0, 0, staticCanvas.width, staticCanvas.height, 0, 0, width, height);
  drawAthlete(rival);
  drawContactCue();
  drawBall();
  drawAthlete(player);
  drawParticles();
  drawGesture();
  ctx.restore();
}

function playTone(frequency: number, duration: number, type: OscillatorType = "sine", volume = .06) {
  if (!soundEnabled) return;
  audioContext ??= new AudioContext();
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = type; oscillator.frequency.value = frequency; gain.gain.setValueAtTime(volume, audioContext.currentTime); gain.gain.exponentialRampToValueAtTime(.0001, audioContext.currentTime + duration);
  oscillator.connect(gain).connect(audioContext.destination); oscillator.start(); oscillator.stop(audioContext.currentTime + duration);
}

function burst(x: number, y: number, z: number, color = "#e8ff43", amount = 9) {
  for (let i = 0; i < amount; i++) particles.push({ x, y, z, vx: (Math.random() - .5) * 3, vy: 1 + Math.random() * 3, vz: (Math.random() - .5) * 3, life: .5 + Math.random() * .45, color });
}

function showToast(message: string) {
  toast.textContent = message; toast.classList.remove("hidden"); toast.style.animation = "none"; void toast.offsetWidth; toast.style.animation = ""; toastTimer = .9;
}

function updateHud() {
  playerScore.textContent = String(match.player); aiScore.textContent = String(match.ai);
  const second = serveAttempt === 2 ? " · SECOND" : "";
  serveIndicator.textContent = `${match.server === "player" ? "YOUR" : "RIVAL"} SERVE${second}`;
}

function positionServeBall() {
  const server = match.server === "player" ? player : rival;
  server.x = match.pointsPlayed % 2 === 0 ? -1.5 : 1.5; server.targetX = server.x;
  ball.x = server.x + (match.server === "player" ? .28 : -.28); ball.y = 1.25; ball.z = match.server === "player" ? .15 : COURT_LENGTH - .15;
  ball.vx = ball.vy = ball.vz = 0; ball.moving = false; ball.trail = []; ball.bounces = 0; ball.lastHit = match.server; ball.isServe = true;
}

function prepareServe(resetAttempt = true) {
  if (resetAttempt) serveAttempt = 1;
  retryServe = false;
  phase = "preServe"; phaseTime = 0; pendingShot = null; aiActionAt = match.server === "ai" ? .72 : 0;
  positionServeBall(); updateHud();
  if (match.server === "player") { promptTitle.textContent = "TAP TO TOSS"; promptSub.textContent = "then swipe at the top"; shotPrompt.classList.remove("hidden"); }
  else { promptTitle.textContent = "GET READY"; promptSub.textContent = "swipe to return"; shotPrompt.classList.remove("hidden"); }
}

function startMatch() {
  match = { player: 0, ai: 0, server: "player", pointsPlayed: 0 };
  player.x = player.targetX = 0; rival.x = rival.targetX = 0; rallyHits = 0; particles.length = 0;
  menuScreen.classList.add("hidden"); howScreen.classList.add("hidden"); pauseScreen.classList.add("hidden"); resultScreen.classList.add("hidden");
  scoreboard.classList.remove("hidden"); $("#pauseButton").classList.remove("hidden");
  prepareServe(); playTone(330, .12, "triangle", .04);
}

function returnToMenu() {
  phase = "menu"; menuScreen.classList.remove("hidden"); howScreen.classList.add("hidden"); pauseScreen.classList.add("hidden"); resultScreen.classList.add("hidden"); scoreboard.classList.add("hidden"); shotPrompt.classList.add("hidden");
  $("#pauseButton").classList.add("hidden");
  positionServeBall(); ball.moving = false;
}

function toss(side: Side) {
  phase = "toss"; phaseTime = 0; ball.moving = true; ball.vx = 0; ball.vz = 0; ball.vy = 6.25; ball.lastHit = side; ball.trail = [];
  if (side === "player") { promptTitle.textContent = "SWIPE TO SERVE"; promptSub.textContent = "hit near the top"; }
  else aiActionAt = .57 + Math.random() * .12;
  playTone(250, .06, "sine", .025);
}

function contactQuality(side: Side) {
  const athlete = side === "player" ? player : rival;
  const idealZ = side === "player" ? 1.15 : COURT_LENGTH - 1.15;
  const reach = 1.25;
  const zQuality = clamp(1 - Math.abs(ball.z - idealZ) / 2.2, 0, 1);
  const xQuality = clamp(1 - Math.abs(ball.x - athlete.x) / reach, 0, 1);
  const heightQuality = clamp(1 - Math.abs(ball.y - 1.15) / 2.4, .25, 1);
  return zQuality * .45 + xQuality * .35 + heightQuality * .2;
}

function launchShot(side: Side, intent: ShotIntent, serving = false, accuracy = 1) {
  const baselineInset = lerp(8.3, 2.4, intent.power);
  const serviceDepth = lerp(4.4, 5.9, intent.power);
  let targetZ = side === "player" ? COURT_LENGTH - baselineInset : baselineInset;
  if (serving) targetZ = side === "player" ? NET_Z + serviceDepth : NET_Z - serviceDepth;
  const error = (Math.random() - .5) * (1 - accuracy) * 3.4;
  const targetX = intent.aim * 4.05 + error;
  const trajectory = calculateTrajectory(
    { x: ball.x, y: ball.y, z: ball.z },
    { x: targetX, y: BALL_RADIUS, z: targetZ },
    intent.power,
    intent.spin,
    serving,
  );
  ball.vx = trajectory.vx;
  ball.vz = trajectory.vz;
  ball.vy = trajectory.vy;
  ball.gravity = trajectory.gravity;
  ball.spin = intent.spin; ball.lastHit = side; ball.bounces = 0; ball.isServe = serving; ball.moving = true; ball.trail = [];
  phase = "rally"; phaseTime = 0; rallyHits++; pendingShot = null; shotPrompt.classList.add("hidden");
  const athlete = side === "player" ? player : rival; athlete.swing = 1;
  burst(ball.x, ball.y, ball.z, intent.kind === "slice" ? "#f6f0de" : "#e8ff43", 11);
  playTone(serving ? 145 : 175 + intent.power * 55, .09, "triangle", .085); shake = 4 + intent.power * 3;
  if (side === "player") showToast(intent.kind.toUpperCase());
}

function serveFault() {
  ball.moving = false; ball.trail = [];
  shotPrompt.classList.add("hidden");
  if (serveAttempt === 1) {
    serveAttempt = 2; retryServe = true; showToast("FAULT"); playTone(90, .2, "sawtooth", .04);
    phase = "pointOver"; phaseTime = 0;
  } else {
    showToast("DOUBLE FAULT"); awardCurrentPoint(match.server === "player" ? "ai" : "player");
  }
}

function awardCurrentPoint(winner: Side, label?: string) {
  if (phase === "pointOver" || phase === "matchOver") return;
  match = awardPoint(match, winner); updateHud(); ball.moving = false; pendingShot = null; phase = "pointOver"; phaseTime = 0;
  shotPrompt.classList.add("hidden");
  retryServe = false;
  showToast(label ?? (winner === "player" ? "YOUR POINT" : "RIVAL POINT"));
  playTone(winner === "player" ? 520 : 110, .28, winner === "player" ? "triangle" : "sawtooth", .05);
}

function finishMatch(winner: Side) {
  phase = "matchOver"; resultScreen.classList.remove("hidden"); shotPrompt.classList.add("hidden");
  $("#resultEyebrow").textContent = winner === "player" ? "MATCH COMPLETE" : "KEEP SWINGING";
  $("#resultTitle").textContent = winner === "player" ? "YOU WIN." : "RIVAL WINS.";
  $("#resultScore").textContent = `${match.player} — ${match.ai}`;
}

function tryPlayerShot(intent: ShotIntent) {
  if (phase === "toss" && match.server === "player") {
    const quality = clamp(1 - Math.abs(ball.y - 3.05) / 2.2, .35, 1);
    if (ball.y < 1.65) { showToast("TOO EARLY"); serveFault(); return; }
    launchShot("player", intent, true, quality); return;
  }
  if (phase !== "rally" || ball.lastHit !== "ai" || ball.vz >= 0) return;
  const quality = contactQuality("player");
  if (ball.z < 4.6 && ball.z > -.7 && ball.y < 3.2 && Math.abs(ball.x - player.x) < 1.45) launchShot("player", intent, false, clamp(.58 + quality * .42, 0, 1));
  else { pendingShot = { intent, expires: performance.now() + 850 }; promptTitle.textContent = "SHOT READY"; promptSub.textContent = intent.kind.toLowerCase(); shotPrompt.classList.remove("hidden"); }
}

function aiShot(serving = false) {
  const config = DIFFICULTIES[difficulty];
  const makesError = Math.random() < config.errorRate;
  const aim = clamp((Math.random() < .55 ? -player.x / SINGLES_HALF : Math.random() * 2 - 1) + (Math.random() - .5) * (1 - config.accuracy), -1.18, 1.18);
  const spin = Math.random() < .68 ? .35 + Math.random() * .5 : -(Math.random() * .65);
  const intent: ShotIntent = { aim: makesError ? aim * 1.8 : aim, power: clamp(config.power * (.75 + Math.random() * .22), .55, 1), spin, kind: spin > .12 ? "topspin" : spin < -.12 ? "slice" : "flat" };
  launchShot("ai", intent, serving, makesError ? .08 : config.accuracy);
}

function updateBall(dt: number) {
  if (!ball.moving) return;
  const previousZ = ball.z;
  if (phase === "toss") {
    ball.vy -= 9.8 * dt; ball.y += ball.vy * dt;
    if (ball.y <= 1.15 && ball.vy < 0) { ball.y = 1.15; ball.moving = false; serveFault(); }
    return;
  }

  ball.vy -= ball.gravity * dt; ball.x += ball.vx * dt; ball.y += ball.vy * dt; ball.z += ball.vz * dt;
  ball.trail.push({ x: ball.x, y: ball.y, z: ball.z, life: 1 });
  if (ball.trail.length > 20) ball.trail.shift();
  ball.trail.forEach(point => point.life -= dt * 1.7);

  const crossedNet = (previousZ < NET_Z && ball.z >= NET_Z) || (previousZ > NET_Z && ball.z <= NET_Z);
  if (crossedNet && ball.y < 1.02) {
    burst(ball.x, ball.y, NET_Z, "#f6f0de", 8); playTone(72, .14, "square", .035);
    if (ball.isServe) serveFault(); else awardCurrentPoint(ball.lastHit === "player" ? "ai" : "player", "INTO THE NET");
    return;
  }

  if (ball.y <= BALL_RADIUS && ball.vy < 0) {
    ball.y = BALL_RADIUS;
    const legalCourt = pointInCourt(ball.x, ball.z);
    const correctSide = ball.lastHit === "player" ? ball.z > NET_Z : ball.z < NET_Z;
    const legalServe = !ball.isServe || (ball.lastHit === "player" ? ball.z <= NET_Z + 6.4 : ball.z >= NET_Z - 6.4);
    if (!legalCourt || !correctSide || !legalServe) {
      burst(ball.x, 0, ball.z, "#f6f0de", 8);
      if (ball.isServe) serveFault(); else awardCurrentPoint(ball.lastHit === "player" ? "ai" : "player", "OUT");
      return;
    }
    ball.bounces++; ball.isServe = false;
    ball.vy = Math.abs(ball.vy) * (ball.spin < 0 ? .48 : ball.spin > 0 ? .66 : .58);
    ball.vz *= ball.spin > 0 ? .9 : ball.spin < 0 ? .76 : .84;
    ball.vx *= .83;
    burst(ball.x, 0, ball.z, "#f3c99c", 6); playTone(105, .045, "sine", .035);
    if (ball.bounces >= 2) { awardCurrentPoint(ball.lastHit, "DOUBLE BOUNCE"); return; }
  }

  if (ball.z < -4.8 || ball.z > COURT_LENGTH + 4.8) awardCurrentPoint(ball.lastHit);
}

function updateAthletes(dt: number) {
  const config = DIFFICULTIES[difficulty];
  if (phase === "rally") {
    if (ball.lastHit === "ai" && ball.vz < 0) player.targetX = clamp(ball.x + ball.vx * .12, -4.4, 4.4);
    else player.targetX *= .98;
    if (ball.lastHit === "player" && ball.vz > 0) rival.targetX = clamp(ball.x + ball.vx * config.reaction, -4.35, 4.35);
    else rival.targetX *= .985;
  }
  const move = (athlete: Athlete, speed: number) => {
    const delta = athlete.targetX - athlete.x;
    const desiredVelocity = clamp(delta * 6.5, -speed, speed);
    athlete.vx = lerp(athlete.vx, desiredVelocity, 1 - Math.exp(-dt * 14));
    athlete.x += athlete.vx * dt;
    if (Math.abs(delta) < .012 && Math.abs(athlete.vx) < .08) { athlete.x = athlete.targetX; athlete.vx = 0; }
    athlete.swing = Math.max(0, athlete.swing - dt * 3.4);
  };
  move(player, 7.2); move(rival, config.speed);

  if (phase === "rally" && ball.lastHit === "player" && ball.vz > 0 && ball.z > COURT_LENGTH - 4.5 && ball.z < COURT_LENGTH + .5 && ball.y < 3.1 && Math.abs(ball.x - rival.x) < 1.35) aiShot(false);
  if (phase === "rally" && ball.lastHit === "ai" && ball.vz < 0 && pendingShot && performance.now() < pendingShot.expires && ball.z < 4.6 && ball.z > -.7 && ball.y < 3.2 && Math.abs(ball.x - player.x) < 1.45) tryPlayerShot(pendingShot.intent);
  if (pendingShot && performance.now() >= pendingShot.expires) { pendingShot = null; shotPrompt.classList.add("hidden"); }
  if (phase === "rally" && ball.lastHit === "ai" && ball.vz < 0 && ball.z < 7 && !pendingShot) { promptTitle.textContent = "SWIPE NOW"; promptSub.textContent = "up topspin · down slice"; shotPrompt.classList.remove("hidden"); }
}

function updateParticles(dt: number) {
  for (let i = particles.length - 1; i >= 0; i--) { const p = particles[i]; p.life -= dt * 1.4; p.vy -= 5 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; if (p.life <= 0) particles.splice(i, 1); }
}

function update(dt: number) {
  if (phase === "paused" || phase === "menu" || phase === "matchOver") { updateParticles(dt); return; }
  phaseTime += dt; shake = Math.max(0, shake - dt * 18);
  if (toastTimer > 0) { toastTimer -= dt; if (toastTimer <= 0) toast.classList.add("hidden"); }

  if (phase === "preServe" && match.server === "ai" && phaseTime >= aiActionAt) toss("ai");
  if (phase === "toss" && match.server === "ai" && phaseTime >= aiActionAt && ball.moving) aiShot(true);
  if (phase === "pointOver" && phaseTime > 1.45) {
    const winner = matchWinner(match);
    if (winner) finishMatch(winner);
    else if (retryServe) prepareServe(false);
    else prepareServe(true);
  }
  updateBall(dt); updateAthletes(dt); updateParticles(dt);
}

function frame(now: number) {
  const elapsed = Math.min((now - lastTime) / 1000, .05);
  lastTime = now;
  accumulator += elapsed;
  const fixedStep = 1 / 90;
  let steps = 0;
  while (accumulator >= fixedStep && steps < 5) { update(fixedStep); accumulator -= fixedStep; steps++; }
  if (steps === 5) accumulator = 0;
  render(); requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function eventPoint(event: PointerEvent) { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; }
canvas.addEventListener("pointerdown", event => {
  if (phase === "menu" || phase === "paused" || phase === "matchOver" || phase === "pointOver") return;
  audioContext?.resume();
  const point = eventPoint(event); pointer = { id: event.pointerId, start: point, current: point, startTime: performance.now(), dragging: false };
  try { canvas.setPointerCapture(event.pointerId); } catch { /* Some synthetic and interrupted pointers cannot be captured. */ }
});
canvas.addEventListener("pointermove", event => {
  if (!pointer || pointer.id !== event.pointerId) return; pointer.current = eventPoint(event); pointer.dragging = Math.hypot(pointer.current.x - pointer.start.x, pointer.current.y - pointer.start.y) > 8;
});
canvas.addEventListener("pointerup", event => {
  if (!pointer || pointer.id !== event.pointerId) return;
  const end = eventPoint(event); const gesture = { start: pointer.start, end, durationMs: performance.now() - pointer.startTime }; const wasDrag = pointer.dragging; pointer = null;
  if (phase === "preServe" && match.server === "player" && !wasDrag) toss("player");
  else if (wasDrag || phase === "toss" || phase === "rally") tryPlayerShot(classifySwipe(gesture));
});
canvas.addEventListener("pointercancel", () => { pointer = null; });

$("#playButton").addEventListener("click", startMatch);
$("#againButton").addEventListener("click", startMatch);
$("#restartButton").addEventListener("click", startMatch);
$("#menuButton").addEventListener("click", returnToMenu);
$("#homeButton").addEventListener("click", () => { if (phase !== "menu") returnToMenu(); });
$("#howButton").addEventListener("click", () => howScreen.classList.remove("hidden"));
$("#gotItButton").addEventListener("click", () => howScreen.classList.add("hidden"));
$("#pauseButton").addEventListener("click", () => {
  if (phase === "menu" || phase === "matchOver") return;
  if (phase === "paused") { phase = previousPhase; pauseScreen.classList.add("hidden"); lastTime = performance.now(); }
  else { previousPhase = phase; phase = "paused"; pauseScreen.classList.remove("hidden"); }
});
$("#resumeButton").addEventListener("click", () => { phase = previousPhase; pauseScreen.classList.add("hidden"); lastTime = performance.now(); });
$("#soundButton").addEventListener("click", event => { soundEnabled = !soundEnabled; (event.currentTarget as HTMLButtonElement).textContent = soundEnabled ? "♪" : "×"; if (soundEnabled) playTone(420, .08, "sine", .03); });
document.querySelectorAll<HTMLButtonElement>("[data-difficulty]").forEach(button => button.addEventListener("click", () => {
  difficulty = button.dataset.difficulty as Difficulty; document.querySelectorAll("[data-difficulty]").forEach(item => item.classList.toggle("active", item === button)); playTone(310, .06, "triangle", .03);
}));
document.addEventListener("visibilitychange", () => { if (document.hidden && phase !== "menu" && phase !== "matchOver" && phase !== "paused") { previousPhase = phase; phase = "paused"; pauseScreen.classList.remove("hidden"); } });
window.addEventListener("keydown", event => { if (event.key === "Escape") $("#pauseButton").click(); });

positionServeBall();
