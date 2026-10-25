"use client";

import { useEffect, useState } from "react";

// A scripted loop of the console: calls land as red incidents, the suggested assignments are approved,
// and teams head out by road, water and air. Colours mirror FloodMap.tsx and ROUTE_COLOR in router.ts.
type Pt = [number, number];
type Mode = "road" | "water" | "air";

const LOOP = 12;
const SUGGEST_AT = 4.2;
const APPROVE_AT = 5.2;
const DEPART_AT = 5.8;
const ROUTE_COLOR: Record<Mode, string> = { road: "#7c3aed", water: "#facc15", air: "#7c3aed" };

// Ground plane: u runs across, v runs toward the viewer. A pinhole projection tilts it like the console's 3D view.
function project([u, v]: Pt, h = 0): Pt {
  const s = 1 / (1.6 - (0.6 * v) / 400);
  return [280 + (u - 280) * s, -551 + 931 * s - h * s];
}
const polygon = (list: Pt[], h = 0) => list.map((p) => project(p, h).map((n) => n.toFixed(1)).join(",")).join(" ");

function hash(a: number, b: number) {
  const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return n - Math.floor(n);
}
function riverV(u: number) {
  return 205 + 38 * Math.sin(u / 140) - 0.06 * (u - 280);
}
function depthAt(u: number, v: number) {
  const reach = 105 + 28 * Math.sin(u / 85 + 1) + 16 * Math.sin(u / 33);
  return (1 - Math.abs(v - riverV(u)) / reach) * 6 + (hash(u, v) - 0.5) * 0.8;
}

const RAMP: [number, number[]][] = [[0, [159, 216, 245]], [1, [79, 179, 232]], [3, [31, 127, 196]], [6, [23, 74, 143]]];
function depthColor(d: number) {
  const i = Math.max(0, RAMP.findIndex(([stop]) => stop >= d) - 1);
  const [[a, ca], [b, cb]] = d >= 6 ? [RAMP[2], RAMP[3]] : [RAMP[i], RAMP[i + 1]];
  const f = Math.min(1, (d - a) / (b - a));
  return `rgb(${ca.map((c, k) => Math.round(c + (cb[k] - c) * f)).join(",")})`;
}

const INCIDENTS: { at: Pt; appear: number; label: string; team?: number; ring?: { r: number; label?: string } }[] = [
  { at: [150, 210], appear: 0.5, label: "CRITICAL · 3 people", team: 0, ring: { r: 46, label: "Caller: knee-deep" } },
  { at: [300, 170], appear: 1.3, label: "5 people", team: 3, ring: { r: 40 } },
  { at: [420, 232], appear: 2.1, label: "CRITICAL · 2 people", team: 1, ring: { r: 54, label: "Caller: waist-deep" } },
  { at: [90, 320], appear: 2.9, label: "1 person", team: 2 },
  { at: [530, 160], appear: 8.4, label: "? people" },
];

const TEAMS: { name: string; legs: { mode: Mode; pts: Pt[] }[]; travel: number; eta: number; left?: boolean }[] = [
  { name: "Swift Water Boat 1", travel: 3.6, eta: 3, legs: [{ mode: "road", pts: [[-60, 90], [100, 90]] }, { mode: "water", pts: [[100, 90], [120, 150], [150, 210]] }] },
  { name: "High-Water Truck 5", travel: 3, eta: 6, left: true, legs: [{ mode: "road", pts: [[380, 392], [380, 250], [420, 232]] }] },
  { name: "Helicopter Rescue 2", travel: 2.4, eta: 1, legs: [{ mode: "air", pts: [[10, 375], [90, 320]] }] },
  { name: "Swift Water Boat 2", travel: 3.4, eta: 4, legs: [{ mode: "road", pts: [[720, 90], [340, 90], [330, 150]] }, { mode: "water", pts: [[330, 150], [300, 170]] }] },
];

const ROADS: Pt[][] = [
  [[-300, 82], [900, 82], [900, 98], [-300, 98]],
  [[-300, 340], [900, 340], [900, 350], [-300, 350]],
  [[374, -60], [386, -60], [386, 400], [374, 400]],
];
const onRoad = (u: number, v: number, w: number, d: number) =>
  (v < 102 && v + d > 78) || (v < 354 && v + d > 336) || (u < 390 && u + w > 370);
const nearIncident = (u: number, v: number) => INCIDENTS.some(({ at }) => Math.hypot(at[0] - u, at[1] - v) < 34);

const FLOOD_CELLS: { pts: string; fill: string }[] = [];
for (let u = -240; u < 800; u += 20) {
  for (let v = -60; v < 400; v += 20) {
    const d = depthAt(u + 10, v + 10);
    if (d > 0) FLOOD_CELLS.push({ pts: polygon([[u, v], [u + 20, v], [u + 20, v + 20], [u, v + 20]]), fill: depthColor(d) });
  }
}

const BUILDINGS: { x: number; y: number; w: number; d: number; h: number }[] = [];
for (let u = -200; u < 760; u += 36) {
  for (let v = -40; v < 400; v += 34) {
    if (hash(u, v) < 0.45) continue;
    const w = 12 + hash(v, u) * 16, d = 10 + hash(u + 1, v) * 14;
    const x = u + hash(u, v + 1) * (36 - w), y = v + hash(u + 2, v) * (34 - d);
    if (onRoad(x, y, w, d) || nearIncident(x + w / 2, y + d / 2)) continue;
    BUILDINGS.push({ x, y, w, d, h: 4 + hash(u, v + 3) ** 2 * (depthAt(x, y) > 3 ? 10 : 28) });
  }
}
BUILDINGS.sort((a, b) => a.y + a.d - (b.y + b.d));

// Built once: the frame loop re-renders only the markers, so this element is reused as-is.
const GROUND = (
  <g>
    {ROADS.map((r, i) => <polygon key={i} points={polygon(r)} fill="#2a2e34" />)}
    <g opacity=".62">{FLOOD_CELLS.map((c, i) => <polygon key={i} points={c.pts} fill={c.fill} stroke={c.fill} strokeWidth=".6" />)}</g>
    {BUILDINGS.map(({ x, y, w, d, h }, i) => {
      const side = x + w < 280 ? [[x + w, y], [x + w, y + d]] : x > 280 ? [[x, y], [x, y + d]] : null;
      return (
        <g key={i}>
          {side && <polygon points={`${polygon(side as Pt[])} ${polygon([...side].reverse() as Pt[], h)}`} fill="#23272c" />}
          <polygon points={`${polygon([[x, y + d], [x + w, y + d]])} ${polygon([[x + w, y + d], [x, y + d]], h)}`} fill="#1c1f23" />
          <polygon points={polygon([[x, y], [x + w, y], [x + w, y + d], [x, y + d]], h)} fill="#2c3036" />
        </g>
      );
    })}
  </g>
);

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeOut = (x: number) => 1 - (1 - x) ** 3;
const popIn = (x: number) => (x >= 1 ? 1 : 1 + 2.4 * (x - 1) ** 3 + 1.4 * (x - 1) ** 2);

// Trims a team's legs to the first `f` of their combined length.
function trimLegs(legs: { mode: Mode; pts: Pt[] }[], f: number) {
  const seg = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const total = legs.reduce((sum, l) => sum + l.pts.slice(1).reduce((s, p, i) => s + seg(l.pts[i], p), 0), 0);
  let left = total * f;
  const out: { mode: Mode; pts: Pt[] }[] = [];
  for (const leg of legs) {
    const pts: Pt[] = [leg.pts[0]];
    for (let i = 1; i < leg.pts.length && left > 0; i++) {
      const len = seg(leg.pts[i - 1], leg.pts[i]);
      const k = Math.min(1, left / len);
      const [a, b] = [leg.pts[i - 1], leg.pts[i]];
      pts.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]);
      left -= len;
    }
    if (pts.length > 1) out.push({ mode: leg.mode, pts });
  }
  return out;
}

function ringPoints([cu, cv]: Pt, r: number) {
  return polygon(Array.from({ length: 40 }, (_, i): Pt => [cu + r * Math.cos((i / 40) * Math.PI * 2), cv + r * Math.sin((i / 40) * Math.PI * 2)]));
}

export default function LandingMap() {
  const [t, setT] = useState(0);

  useEffect(() => {
    // Reduced motion holds the finished scene: teams routed, last call waiting.
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      if (still) return setT(9.9);
      setT(((now - start) / 1000) % LOOP);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const approved = t >= APPROVE_AT;
  const fade = Math.min(1, t / 0.4, (LOOP - t) / 0.7);
  const waiting = INCIDENTS.filter((i) => t >= i.appear && (!approved || i.team == null)).length;
  const routeReveal = easeOut(clamp01((t - APPROVE_AT) / 0.6));

  return (
    <svg viewBox="0 0 560 380" role="img" aria-label="Animated flood map: calls appear as incidents, then approved teams route to them by road, boat and helicopter">
      {GROUND}
      <g opacity={fade}>
        {INCIDENTS.map(({ at, appear, ring }) => ring && t >= appear && (
          <g key={`ring-${appear}`} opacity={clamp01((t - appear) / 0.5)}>
            <polygon points={ringPoints(at, ring.r)} fill="none" stroke="#e3e6ea" strokeWidth="1.2" strokeDasharray="3 3" opacity=".55" />
            {ring.label && <text x={project([at[0], at[1] + ring.r])[0]} y={project([at[0], at[1] + ring.r])[1] + 12} textAnchor="middle" fontSize="10" fontWeight="500" fill="#e3e6ea">{ring.label}</text>}
          </g>
        ))}
        {approved && TEAMS.map((team) => trimLegs(team.legs, routeReveal).map((leg) => (
          <polyline key={`${team.name}-${leg.mode}`} points={polygon(leg.pts)} fill="none" stroke={ROUTE_COLOR[leg.mode]} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" strokeDasharray={leg.mode === "air" ? "5 5" : undefined} opacity=".9" />
        )))}
        {INCIDENTS.map(({ at, appear, label, team }) => {
          if (t < appear) return null;
          const [x, y] = project(at);
          const s = popIn(clamp01((t - appear) / 0.35));
          return (
            <g key={label} transform={`translate(${x} ${y}) scale(${s})`}>
              <circle r="7" fill={approved && team != null ? "#f59e0b" : "#dc2626"} stroke="#fff" strokeWidth="2.2" />
              <text y="-13" textAnchor="middle" fontSize="11" fontWeight="700" fill="#ffd0d0">{label}</text>
            </g>
          );
        })}
        {TEAMS.map((team) => {
          const f = easeOut(clamp01((t - DEPART_AT) / team.travel));
          const moving = f > 0 && f < 1;
          if (f >= 1) return null;
          const legs = trimLegs(team.legs, f);
          const [x, y] = project(f > 0 ? legs.at(-1)!.pts.at(-1)! : team.legs[0].pts[0]);
          const label = moving ? `${team.name} · ETA ${Math.max(1, Math.ceil((1 - f) * team.eta))} min` : team.name;
          return (
            <g key={team.name} transform={`translate(${x} ${y})`}>
              <circle r="5.5" fill={moving ? "#f59e0b" : "#2563eb"} stroke="#0f1113" strokeWidth="2" />
              <text x={team.left ? -10 : 10} y="4" textAnchor={team.left ? "end" : "start"} fontSize="10" fontWeight="500" fill="#bcd6ff">{label}</text>
            </g>
          );
        })}
      </g>
      <g transform="translate(14 12)">
        <rect width="98" height="24" rx="12" fill="#181b1f" stroke="#ffffff1f" />
        <text x="13" y="16" fontSize="10.5" fill="#b3b9c2" stroke="none">River <tspan fill="#eceef1" fontWeight="600">{(10.7 + (1.4 * t) / LOOP).toFixed(1)} ft</tspan></text>
        <rect x="106" width="80" height="24" rx="12" fill="#181b1f" stroke="#ffffff1f" />
        <text x="119" y="16" fontSize="10.5" fill="#b3b9c2" stroke="none"><tspan fill="#eceef1" fontWeight="600">{waiting}</tspan> waiting</text>
      </g>
      {t >= SUGGEST_AT && t < LOOP - 0.7 && (
        <g transform={`translate(280 ${352 + 8 * (1 - easeOut(clamp01((t - SUGGEST_AT) / 0.3)))})`}>
          <rect x="-160" y="-14" width="320" height="26" rx="8" fill={approved ? "#dc2626" : "#20242a"} stroke={approved ? "none" : "#ffffff1f"} />
          <text y="3.5" textAnchor="middle" fontSize="10.5" fontWeight="500" fill="#fff" stroke="none">
            {approved ? "Approved: 4 teams assigned and sent. Callers hear the update." : "Suggested 4 teams · critical 2/2 covered"}
          </text>
        </g>
      )}
    </svg>
  );
}
