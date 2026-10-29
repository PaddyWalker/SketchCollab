// Ink: how new freehand lines are smoothed, shaped and drawn.
// - Smoothing uses the 1€ filter, which smooths a lot when you move slowly and hardly at all when fast.
// - Each line is drawn as one smooth filled outline, so there are no corners or beads, with tapered ends.
// - With a mouse, the line thins a little when you move fast (a stand-in for pen pressure).
// - Holding still at the end of a line can snap it into a clean shape.
// Points are [x, y, pressure, session time, ms since the stroke started].

import { makeCanvas, hexToRgb } from "./util.js";

const clamp01 = v => Math.max(0, Math.min(1, v));

// ---------- smoothing while you draw ----------
// The 1€ filter (Casiez, Roussel and Vogel, CHI 2012), run on screen pixels so it feels the same at any zoom.
export class OneEuro {
  constructor(smoothing) {
    this.off = smoothing < 0.02;
    this.minCut = 8 * Math.pow(0.04, smoothing);   // Hz: 8 at 0%, about 1.9 at 45%, 0.3 at 100%
    this.beta = 0.02 * (1 - 0.8 * smoothing);      // how fast the cut-off rises with speed (per px/s); more smoothing keeps fast lines steadier too
    this.dCut = 1;
    this.x = null;
  }
  static alpha(cut, dt) { const tau = 1 / (2 * Math.PI * cut); return 1 / (1 + tau / dt); }
  next(x, y, ms) {
    if (this.x === null || this.off) { this.x = x; this.y = y; this.rx = x; this.ry = y; this.ms = ms; this.dx = this.dx || 0; this.dy = this.dy || 0; return { x, y }; }
    const dt = Math.max(1, ms - this.ms) / 1000;
    const ad = OneEuro.alpha(this.dCut, dt);
    this.dx = ad * ((x - this.rx) / dt) + (1 - ad) * this.dx;
    this.dy = ad * ((y - this.ry) / dt) + (1 - ad) * this.dy;
    const a = OneEuro.alpha(this.minCut + this.beta * Math.hypot(this.dx, this.dy), dt);
    this.x = a * x + (1 - a) * this.x; this.y = a * y + (1 - a) * this.y;
    this.rx = x; this.ry = y; this.ms = ms;
    return { x: this.x, y: this.y };
  }
  clone() { return Object.assign(Object.create(OneEuro.prototype), this); }
}

// A stand-in for pressure when there's no pen: moving fast makes the line a little thinner.
// Returns a value stored like pressure, where 0.5 means the normal width.
export class SpeedPressure {
  constructor() { this.v = 0; this.last = null; }
  next(x, y, ms) {
    if (this.last) {
      const dt = Math.max(1, ms - this.last.ms), inst = Math.hypot(x - this.last.x, y - this.last.y) / dt;
      this.v += (inst - this.v) * (1 - Math.exp(-dt / 40));
    }
    this.last = { x, y, ms };
    const factor = 1.2 - 0.6 * Math.min(1, this.v / 1.6);   // 1.2× when still, 0.6× at 1600 px/s
    return (factor - 0.25) / 1.5;
  }
}

// ---------- widths and opacity ----------
// Width multiplier for a point: pen pressure through the chosen pressure feel, or the mouse stand-in.
export const widthFactor = (p, pr) => !p.pressureSize ? 1 : 0.25 + 1.5 * (p.pen ? Math.pow(clamp01(pr), p.gamma || 1) : pr);
// Only a real pen changes how dark a line is.
export const alphaFactor = (p, pr) => p.pen && p.pressureOpacity ? Math.min(1, 0.25 + 1.5 * Math.pow(clamp01(pr), p.gamma || 1)) : 1;

const lerpPt = (a, b, k) => a.map((v, i) => v + ((b[i] ?? v) - v) * k);
export function resample(pts, step) {
  if (pts.length < 2) return pts.map(q => q.slice());
  const out = [pts[0].slice()];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (d === 0) continue;
    let pos = step - carry;
    while (pos <= d) { out.push(lerpPt(a, b, pos / d)); pos += step; }
    carry = d - (pos - step);
  }
  const l = pts[pts.length - 1], o = out[out.length - 1];
  if (Math.hypot(l[0] - o[0], l[1] - o[1]) > step * 0.2) out.push(l.slice());
  return out;
}
function widthsFor(p, pts, complete) {
  const n = pts.length, ws = new Float32Array(n);
  for (let i = 0; i < n; i++) ws[i] = p.size * widthFactor(p, pts[i][2]);
  for (let pass = 0; pass < 3; pass++) for (let i = 1; i < n - 1; i++) ws[i] = (ws[i - 1] + 2 * ws[i] + ws[i + 1]) / 4;
  if (p.taper && n > 2) {
    const cum = new Float32Array(n);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    // A fixed taper length, so ink already drawn doesn't change as the line grows; short lines and dots taper
    // less, so a tap stays a round dot.
    const total = cum[n - 1], T = p.size * (p.pen ? 3 : 7), depth = clamp01((total - p.size) / (2 * p.size));
    if (depth > 0) for (let i = 0; i < n; i++) {
      const fs = Math.sin(Math.min(1, cum[i] / T) * Math.PI / 2);
      const fe = complete ? Math.sin(Math.min(1, (total - cum[i]) / T) * Math.PI / 2) : 1;   // the end tapers once you lift
      ws[i] *= 1 - 0.85 * depth * (1 - Math.min(fs, fe));
    }
  }
  return ws;
}

// ---------- the outline ----------
function sides(pts, ws) {
  const n = pts.length, L = new Array(n), R = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
    const h = Math.max(0.3, ws[i] / 2);
    L[i] = [pts[i][0] - ty * h, pts[i][1] + tx * h]; R[i] = [pts[i][0] + ty * h, pts[i][1] - tx * h];
  }
  return { L, R };
}
// One filled shape from point i0 to i1: curves through the midpoints of each side, round caps at the real ends.
function outlinePath(pts, ws, L, R, i0, i1, capStart, capEnd) {
  const P = new Path2D();
  if (i1 <= i0) { P.arc(pts[i0][0], pts[i0][1], Math.max(0.3, ws[i0] / 2), 0, Math.PI * 2); return P; }
  P.moveTo(L[i0][0], L[i0][1]);
  for (let i = i0 + 1; i < i1; i++) P.quadraticCurveTo(L[i][0], L[i][1], (L[i][0] + L[i + 1][0]) / 2, (L[i][1] + L[i + 1][1]) / 2);
  P.lineTo(L[i1][0], L[i1][1]);
  if (capEnd) { const e = pts[i1], a = Math.atan2(L[i1][1] - e[1], L[i1][0] - e[0]); P.arc(e[0], e[1], Math.max(0.3, ws[i1] / 2), a, a - Math.PI, true); }
  else P.lineTo(R[i1][0], R[i1][1]);
  for (let i = i1 - 1; i > i0; i--) P.quadraticCurveTo(R[i][0], R[i][1], (R[i][0] + R[i - 1][0]) / 2, (R[i][1] + R[i - 1][1]) / 2);
  P.lineTo(R[i0][0], R[i0][1]);
  if (capStart) { const s = pts[i0], a = Math.atan2(R[i0][1] - s[1], R[i0][0] - s[0]); P.arc(s[0], s[1], Math.max(0.3, ws[i0] / 2), a, a - Math.PI, true); }
  P.closePath();
  return P;
}

// Soft round stamps, used by the soft brush and airbrush.
const sprites = new Map();
export function sprite(color, hardness) {
  const key = color + "|" + hardness.toFixed(2);
  let c = sprites.get(key);
  if (c) return c;
  c = makeCanvas(128, 128);
  const x = c.getContext("2d"), [r, g, b] = hexToRgb(color), gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, `rgba(${r},${g},${b},1)`);
  gr.addColorStop(Math.min(0.97, Math.max(0.01, hardness)), `rgba(${r},${g},${b},1)`);
  gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
  x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
  if (sprites.size > 200) sprites.clear();
  sprites.set(key, c);
  return c;
}

function geometry(p, pts, complete) {
  if (p.mode === "dab") {
    const rp = resample(pts, Math.max(0.5, p.size / 2 * ((p.flow ?? 1) < 0.5 ? 0.15 : 0.22)));
    const ws = widthsFor(p, rp, complete);
    return { dabs: rp.map((q, i) => [q[0], q[1], Math.max(0.5, ws[i] / 2), (p.flow ?? 1) * alphaFactor(p, q[2])]) };
  }
  const rp = resample(pts, Math.max(0.6, p.size * 0.12));
  const ws = widthsFor(p, rp, complete), n = rp.length;
  const { L, R } = sides(rp, ws);
  if (!(p.pen && p.pressureOpacity) || n < 2) return { parts: [{ path: outlinePath(rp, ws, L, R, 0, n - 1, true, true), alpha: alphaFactor(p, rp[0][2]) }] };
  // A pencil with pen pressure: split the line where its darkness changes, so light and heavy parts both show.
  const parts = [];
  let start = 0, level = Math.round(alphaFactor(p, rp[0][2]) * 10) / 10;
  for (let i = 1; i < n; i++) {
    const a = alphaFactor(p, rp[i][2]);
    if (Math.abs(a - level) > 0.07 || i === n - 1) {
      parts.push({ path: outlinePath(rp, ws, L, R, start, i, start === 0, i === n - 1), alpha: level });
      start = i; level = Math.round(a * 10) / 10;
    }
  }
  return { parts };
}

// Draw a line's points onto ctx (in its own coordinates). complete=false while it's still being drawn.
const cache = new WeakMap();
export function drawInk(ctx, p, pts, complete = true) {
  if (!pts.length) return;
  const useCache = complete && pts === p.pts;
  let g = useCache ? cache.get(pts) : null;
  if (!g) { g = geometry(p, pts, complete); if (useCache) cache.set(pts, g); }
  ctx.save();
  if (g.parts) { ctx.fillStyle = p.color; for (const part of g.parts) { ctx.globalAlpha = part.alpha; ctx.fill(part.path); } }
  else { const spr = sprite(p.color, p.hardness ?? 0.5); for (const [x, y, r, a] of g.dabs) { ctx.globalAlpha = a; ctx.drawImage(spr, x - r, y - r, r * 2, r * 2); } }
  ctx.restore();
}

// ---------- tidy after you lift (Strong help) ----------
export function tidy(pts, step) {
  let a = resample(pts, step);
  for (let pass = 0; pass < 2 && a.length > 2; pass++) {
    const b = [a[0]];
    for (let i = 0; i < a.length - 1; i++) { b.push(lerpPt(a[i], a[i + 1], 0.25)); b.push(lerpPt(a[i], a[i + 1], 0.75)); }
    b.push(a[a.length - 1]); a = b;
  }
  return a.map(q => [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10, Math.round(q[2] * 100) / 100, Math.round(q[3]), Math.round(q[4] ?? 0)]);
}

// ---------- hold to snap ----------
function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const a = pts[0], b = pts[pts.length - 1];
  let idx = -1, dmax = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    const d = Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / l;
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax <= eps) return [a, b];
  return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
}
const turnAt = (p, q, r) => { let t = Math.abs(Math.atan2(r[1] - q[1], r[0] - q[0]) - Math.atan2(q[1] - p[1], q[0] - p[0])); return t > Math.PI ? 2 * Math.PI - t : t; };
// Drop corners that barely turn, so a hand-drawn box doesn't snap with a bump in one side.
function mergeStraight(pts, closed) {
  let a = pts.slice(), changed = true;
  while (changed && a.length > (closed ? 4 : 2)) {
    changed = false;
    for (let i = 1; i < a.length - 1; i++) if (turnAt(a[i - 1], a[i], a[i + 1]) < 0.42) { a.splice(i, 1); changed = true; break; }   // under about 24°
  }
  if (closed && a.length > 4 && turnAt(a[a.length - 2], a[0], a[1]) < 0.42) { a = a.slice(1, -1); a.push(a[0]); }   // the start usually sits partway along a side
  return a;
}
// True when the drawn points stay close to the straight sides between the corners, and every corner really
// turns, so smiles, waves and arcs are never mistaken for straight lines or zig-zags.
function sidesFit(pts, verts, tol) {
  const idx = verts.map(v => pts.indexOf(v));
  if (idx.some(i => i < 0)) return false;
  for (let k = 1; k < idx.length; k++) {
    const a = pts[idx[k - 1]], b = pts[idx[k]], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    for (let i = idx[k - 1]; i <= idx[k]; i++) {
      const p = pts[i];
      if (Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / l > tol * l) return false;
    }
  }
  for (let k = 1; k < verts.length - 1; k++) if (turnAt(verts[k - 1], verts[k], verts[k + 1]) < 0.61) return false;   // corners turn more than about 35°
  return true;
}
// What shape a rough line was meant to be, or null if it doesn't look like one.
export function detectShape(pts) {
  const n = pts.length; if (n < 4) return null;
  const f = pts[0], l = pts[n - 1];
  let len = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    if (i) len += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
    x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
  }
  const w = x1 - x0, h = y1 - y0, diag = Math.hypot(w, h) || 1, chord = Math.hypot(l[0] - f[0], l[1] - f[1]);
  if (len <= 0) return null;
  if (chord / len > 0.98 && sidesFit(pts, [f, l], 0.04)) return { name: "a straight line", verts: [f, l], closed: false };
  if (chord < 0.22 * diag) {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.max(1, w / 2), ry = Math.max(1, h / 2);
    let err = 0; for (const p of pts) err += Math.abs(Math.hypot((p[0] - cx) / rx, (p[1] - cy) / ry) - 1); err /= n;
    const simp = mergeStraight(rdp(pts, diag * 0.08), true), corners = simp.length - 1;
    if (err > 0.11 && corners >= 3 && corners <= 5 && sidesFit(pts, simp, 0.06)) {
      const verts = simp.slice(0, -1);
      let name = corners === 3 ? "a triangle" : corners === 5 ? "a five-sided shape" : "a four-sided shape";
      if (corners === 4 && verts.every((q, i) => Math.abs(turnAt(verts[(i + 3) % 4], q, verts[(i + 1) % 4]) - Math.PI / 2) < 0.35)) name = "a rectangle";
      return { name, verts, closed: true };
    }
    if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.12) { const r = (rx + ry) / 2; return { name: "a circle", ellipse: { cx, cy, rx: r, ry: r }, closed: true }; }
    return { name: "an ellipse", ellipse: { cx, cy, rx, ry }, closed: true };
  }
  const simp = mergeStraight(rdp(pts, diag * 0.05), false);
  if (simp.length >= 3 && simp.length <= 7 && sidesFit(pts, simp, 0.03)) return { name: "a line with corners", verts: simp, closed: false };
  return null;
}
// Points along the clean shape, carrying the line's timing and pressure over from what was drawn.
export function shapePoints(shape, src, step, pen) {
  const g = [];
  if (shape.ellipse) {
    const { cx, cy, rx, ry } = shape.ellipse;
    let area = 0; for (let i = 0; i < src.length; i++) { const a = src[i], b = src[(i + 1) % src.length]; area += a[0] * b[1] - b[0] * a[1]; }
    const dir = area >= 0 ? 1 : -1, a0 = Math.atan2((src[0][1] - cy) / ry, (src[0][0] - cx) / rx);
    const per = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry))), N = Math.max(24, Math.ceil(per / step));
    for (let i = 0; i <= N; i++) { const a = a0 + dir * (i / N) * Math.PI * 2; g.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
  } else {
    const v = shape.closed ? [...shape.verts, shape.verts[0]] : shape.verts;
    for (let k = 1; k < v.length; k++) {
      const a = v[k - 1], b = v[k], m = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
      for (let i = k === 1 ? 0 : 1; i <= m; i++) g.push([a[0] + (b[0] - a[0]) * i / m, a[1] + (b[1] - a[1]) * i / m]);
    }
  }
  const prs = src.map(q => q[2]).sort((a, b) => a - b), pr = pen ? prs[Math.floor(prs.length / 2)] : 0.5;
  const t0 = src[0][3], t1 = src[src.length - 1][3], m0 = src[0][4] ?? 0, m1 = src[src.length - 1][4] ?? 0;
  return g.map((q, i) => { const k = g.length > 1 ? i / (g.length - 1) : 0; return [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10, pr, Math.round(t0 + (t1 - t0) * k), Math.round(m0 + (m1 - m0) * k)]; });
}
