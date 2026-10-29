// Small shared helpers: matrices, geometry, colours, time.

export const $ = id => document.getElementById(id);

// 2D affine matrices in canvas order [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f.
export const I = [1, 0, 0, 1, 0, 0];
export const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
export const applyM = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export const inv = m => {
  const d = m[0] * m[3] - m[1] * m[2] || 1e-9;
  return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d];
};
export const translate = (dx, dy) => [1, 0, 0, 1, dx, dy];
export const scaleAbout = (sx, sy, cx, cy) => [sx, 0, 0, sy, cx - sx * cx, cy - sy * cy];
export const scaleOf = m => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
export const isTranslate = m => Math.abs(m[0] - 1) < 1e-6 && Math.abs(m[3] - 1) < 1e-6 && Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6;

export function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}

// Boxes are {x0, y0, x1, y1}.
export function boxOfPoints(pts) {
  if (!pts.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  return { x0, y0, x1, y1 };
}
export const padBox = (b, n) => b && { x0: b.x0 - n, y0: b.y0 - n, x1: b.x1 + n, y1: b.y1 + n };
export function unionBox(a, b) {
  if (!a) return b; if (!b) return a;
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}
export function interBox(a, b) {
  if (!a || !b) return null;
  const r = { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
  return r.x1 > r.x0 && r.y1 > r.y0 ? r : null;
}
export const boxesTouch = (a, b, gap = 0) => a && b && a.x0 - gap <= b.x1 && b.x0 - gap <= a.x1 && a.y0 - gap <= b.y1 && b.y0 - gap <= a.y1;
export function transformBox(m, b) {
  if (!b) return null;
  return boxOfPoints([applyM(m, b.x0, b.y0), applyM(m, b.x1, b.y0), applyM(m, b.x0, b.y1), applyM(m, b.x1, b.y1)]);
}
export const boxCorners = b => [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]];

export function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
export function ellipsePoly(b, n = 72) {
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, rx = (b.x1 - b.x0) / 2, ry = (b.y1 - b.y0) / 2, out = [];
  for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; out.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]); }
  return out;
}

export function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
  const p = n => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
}

// Colours
export function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map(c => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgbToHex = (r, g, b) => "#" + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, "0")).join("");
const NAMED = [
  ["black", [25, 28, 36]], ["white", [255, 255, 255]], ["grey", [128, 128, 128]], ["light grey", [200, 200, 200]],
  ["dark grey", [70, 70, 70]], ["red", [212, 50, 45]], ["dark red", [125, 20, 25]], ["orange", [235, 135, 40]],
  ["yellow", [245, 205, 40]], ["green", [40, 150, 80]], ["dark green", [25, 85, 40]], ["light green", [145, 210, 120]],
  ["blue", [40, 100, 215]], ["light blue", [125, 185, 240]], ["navy", [25, 35, 95]], ["purple", [125, 60, 180]],
  ["pink", [235, 115, 170]], ["brown", [115, 70, 35]], ["tan", [210, 180, 140]], ["teal", [30, 150, 150]],
];
export function colourName(hex) {
  if (!hex) return "no colour";
  const [r, g, b] = hexToRgb(hex);
  let best = NAMED[0][0], bd = Infinity;
  for (const [name, [R, G, B]] of NAMED) { const d = (r - R) ** 2 * 0.3 + (g - G) ** 2 * 0.59 + (b - B) ** 2 * 0.11; if (d < bd) { bd = d; best = name; } }
  return best;
}
export function listWords(words) {
  const w = [...new Set(words)];
  return w.length > 1 ? w.slice(0, -1).join(", ") + " and " + w[w.length - 1] : (w[0] || "");
}

// Where a box sits on a W×H drawing, in words.
export function where(b, W, H) {
  if (!b) return "";
  if ((b.x1 - b.x0) > W * 0.6 && (b.y1 - b.y0) > H * 0.6) return "across most of the drawing";
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const col = cx < W / 3 ? "left" : cx < 2 * W / 3 ? "middle" : "right";
  const row = cy < H / 3 ? "top" : cy < 2 * H / 3 ? "middle" : "bottom";
  if (row === "middle" && col === "middle") return "in the middle";
  if (row === "middle") return `on the ${col}`;
  if (col === "middle") return `at the ${row}`;
  return `at the ${row} ${col}`;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
