// Drawing pieces, layers and whole pictures onto canvases. Everything here works in drawing
// coordinates: one unit is one pixel of the finished picture.

import { makeCanvas } from "./util.js";
import { docBox, PAPERS } from "./doc.js";
import { drawInk, sprite } from "./ink.js";

// Brush presets. Each new stroke copies its settings, so later changes never alter old lines.
// mode: "hard" = solid line whose width follows pressure, "dab" = soft round stamps, "flat" = even ink.
// taper: the line thins in and out at its ends. thin: with a mouse, the line thins a little when you move fast.
export const BRUSHES = {
  pencil:      { label: "Pencil",      mode: "hard", size: 3,  opacity: 0.9,  hardness: 1,    flow: 1,    smoothing: 0.1,  pressureSize: true,  pressureOpacity: true,  taper: true,  thin: true },
  pen:         { label: "Ink pen",     mode: "hard", size: 6,  opacity: 1,    hardness: 1,    flow: 1,    smoothing: 0.45, pressureSize: true,  pressureOpacity: false, taper: true,  thin: true },
  brush:       { label: "Soft brush",  mode: "dab",  size: 28, opacity: 0.9,  hardness: 0.4,  flow: 1,    smoothing: 0.3,  pressureSize: true,  pressureOpacity: false, taper: true,  thin: false },
  marker:      { label: "Marker",      mode: "flat", size: 18, opacity: 0.6,  hardness: 1,    flow: 1,    smoothing: 0.3,  pressureSize: false, pressureOpacity: false, taper: false, thin: false },
  highlighter: { label: "Highlighter", mode: "flat", size: 30, opacity: 0.4,  hardness: 1,    flow: 1,    smoothing: 0.4,  pressureSize: false, pressureOpacity: false, taper: false, thin: false },
  airbrush:    { label: "Airbrush",    mode: "dab",  size: 70, opacity: 0.8,  hardness: 0,    flow: 0.1,  smoothing: 0.2,  pressureSize: false, pressureOpacity: true,  taper: false, thin: false },
};
export const FONTS = {
  sans: '"Atkinson Hyperlegible", "Segoe UI", sans-serif',
  display: '"Bricolage Grotesque", "Segoe UI", sans-serif',
  hand: '"Caveat", "Segoe Print", cursive',
  serif: 'Georgia, "Times New Roman", serif',
  mono: '"IBM Plex Mono", Consolas, monospace',
};
export const fontCss = p => `${p.italic ? "italic " : ""}${p.bold ? 700 : 400} ${p.size}px ${FONTS[p.font] || FONTS.sans}`;
export const paperColor = doc => PAPERS[doc.paper] || PAPERS.white;

// ---------- pictures (assets) ----------
const images = new Map(), sources = new Map();   // sources: the picture each cached image was made from
let onImageReady = () => {};
export const setImageReadyHandler = fn => { onImageReady = fn; };
export function getImage(doc, id) {
  let im = images.get(id);
  const url = doc.assets[id];
  if (!im || (url && sources.get(id) !== url)) {   // a different picture under the same name (another tab's): load it afresh
    if (!url) return null;
    im = new Image(); im.onload = () => onImageReady(id); im.src = url; images.set(id, im); sources.set(id, url);
  }
  return im.complete && im.naturalWidth ? im : null;
}
export async function preloadAssets(doc) {
  await Promise.all(Object.keys(doc.assets).map(id => new Promise(res => {
    const im = getImage(doc, id); if (im) return res();
    const el = images.get(id); if (!el) return res();
    el.addEventListener("load", res, { once: true }); el.addEventListener("error", res, { once: true });
  })));
}
export const forgetImages = () => { images.clear(); sources.clear(); };

// ---------- brush helpers (lines drawn before the new ink; new lines use ink.js) ----------
const sizeAt = (p, pr) => p.size * (p.pressureSize ? 0.3 + pr * 1.4 : 1);
const alphaAt = (p, pr) => (p.pressureOpacity ? Math.min(1, 0.25 + pr * 1.5) : 1);

// Draw stroke points (already limited to what should show). `carry` continues dab spacing for live drawing.
export function drawStrokePts(ctx, p, pts, carry = { left: 0 }) {
  if (!pts.length) return carry;
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  if (p.mode === "flat") {
    ctx.strokeStyle = p.color; ctx.lineWidth = p.size;
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    if (pts.length === 1) ctx.lineTo(pts[0][0] + 0.1, pts[0][1]);
    ctx.stroke();
  } else if (p.mode === "hard") {
    ctx.strokeStyle = ctx.fillStyle = p.color;
    if (pts.length === 1) { ctx.globalAlpha = alphaAt(p, pts[0][2]); ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], sizeAt(p, pts[0][2]) / 2, 0, 7); ctx.fill(); }
    for (let i = 1; i < pts.length; i++) {
      const pr = (pts[i - 1][2] + pts[i][2]) / 2;
      ctx.globalAlpha = alphaAt(p, pr); ctx.lineWidth = sizeAt(p, pr);
      ctx.beginPath(); ctx.moveTo(pts[i - 1][0], pts[i - 1][1]); ctx.lineTo(pts[i][0], pts[i][1]); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  } else {
    const spr = sprite(p.color, p.hardness ?? 0.5);
    const dab = (x, y, pr) => { const r = Math.max(0.5, sizeAt(p, pr) / 2); ctx.globalAlpha = (p.flow ?? 1) * alphaAt(p, pr); ctx.drawImage(spr, x - r, y - r, r * 2, r * 2); };
    if (pts.length === 1 || carry.first !== false) { dab(pts[0][0], pts[0][1], pts[0][2]); carry.first = false; }
    let left = carry.left;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const sp = Math.max(0.5, sizeAt(p, b[2]) / 2 * ((p.flow ?? 1) < 0.5 ? 0.15 : 0.22));
      let pos = left;
      while (pos <= d) { const t = d ? pos / d : 0; dab(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t); pos += sp; }
      left = pos - d;
    }
    carry.left = left; ctx.globalAlpha = 1;
  }
  return carry;
}
export function drawEraserPts(ctx, e, pts = e.pts) {
  if (!pts.length) return;
  ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = ctx.fillStyle = "#000";
  const w = pr => e.size * (e.pressureSize ? 0.3 + pr * 1.4 : 1);
  if (pts.length === 1) { ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], w(pts[0][2]) / 2, 0, 7); ctx.fill(); }
  for (let i = 1; i < pts.length; i++) {
    ctx.lineWidth = w((pts[i - 1][2] + pts[i][2]) / 2);
    ctx.beginPath(); ctx.moveTo(pts[i - 1][0], pts[i - 1][1]); ctx.lineTo(pts[i][0], pts[i][1]); ctx.stroke();
  }
}
export function drawShape(ctx, p) {
  const x0 = Math.min(p.x0, p.x1), y0 = Math.min(p.y0, p.y1), w = Math.abs(p.x1 - p.x0), h = Math.abs(p.y1 - p.y0);
  ctx.lineWidth = p.width; ctx.strokeStyle = p.color; ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.beginPath();
  if (p.shape === "rect") ctx.rect(x0, y0, w, h);
  else if (p.shape === "ellipse") ctx.ellipse(x0 + w / 2, y0 + h / 2, Math.max(0.5, w / 2), Math.max(0.5, h / 2), 0, 0, Math.PI * 2);
  else { ctx.moveTo(p.x0, p.y0); ctx.lineTo(p.x1, p.y1); }
  if (p.fill && (p.shape === "rect" || p.shape === "ellipse")) { ctx.fillStyle = p.fill; ctx.fill(); }
  if (p.width > 0) ctx.stroke();
  if (p.shape === "arrow") {
    const a = Math.atan2(p.y1 - p.y0, p.x1 - p.x0), s = Math.max(14, p.width * 3.5);
    ctx.fillStyle = p.color; ctx.beginPath(); ctx.moveTo(p.x1 + Math.cos(a) * s * 0.2, p.y1 + Math.sin(a) * s * 0.2);
    ctx.lineTo(p.x1 + Math.cos(a + 2.6) * s, p.y1 + Math.sin(a + 2.6) * s); ctx.lineTo(p.x1 + Math.cos(a - 2.6) * s, p.y1 + Math.sin(a - 2.6) * s);
    ctx.closePath(); ctx.fill();
  }
}
export function textLines(p) { return String(p.text).split("\n"); }
export function measureText(p) {
  const c = measureText.c ||= makeCanvas(1, 1).getContext("2d");
  c.font = fontCss(p);
  const lines = textLines(p);
  return { w: Math.max(4, ...lines.map(l => c.measureText(l).width)) + 2, h: lines.length * p.size * 1.25 };
}
function drawText(ctx, p) {
  ctx.font = fontCss(p); ctx.fillStyle = p.color; ctx.textBaseline = "top";
  textLines(p).forEach((l, i) => ctx.fillText(l, p.x, p.y + i * p.size * 1.25 + p.size * 0.1));
}
function drawGradient(ctx, p) {
  let g;
  if (p.gtype === "radial") g = ctx.createRadialGradient(p.gx0, p.gy0, 0, p.gx0, p.gy0, Math.max(1, Math.hypot(p.gx1 - p.gx0, p.gy1 - p.gy0)));
  else g = ctx.createLinearGradient(p.gx0, p.gy0, p.gx1, p.gy1);
  g.addColorStop(0, p.c0); g.addColorStop(1, p.c1);
  ctx.fillStyle = g; ctx.beginPath(); p.area.forEach((q, i) => i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])); ctx.closePath(); ctx.fill();
}
function drawRegion(ctx, doc, c) {
  if (c.type === "poly") { ctx.beginPath(); c.pts.forEach((q, i) => i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])); ctx.closePath(); ctx.fill(); }
  else { const im = getImage(doc, c.asset); if (im) ctx.drawImage(im, c.x, c.y, c.w, c.h); }
}
function drawContent(ctx, p, doc, limitT) {
  switch (p.kind) {
    case "stroke": {
      const pts = limitT < Infinity ? p.pts.filter(q => q[3] <= limitT) : p.pts;
      if (p.v === 2) drawInk(ctx, p, pts, pts.length === p.pts.length);   // new ink; older lines keep their original look
      else drawStrokePts(ctx, p, pts);
      break;
    }
    case "shape": drawShape(ctx, p); break;
    case "text": drawText(ctx, p); break;
    case "image": { const im = getImage(doc, p.asset); if (im) ctx.drawImage(im, p.x, p.y, p.w, p.h); break; }
    case "gradient": drawGradient(ctx, p); break;
  }
}

// ---------- one piece ----------
let scratch = null;
function getScratch(w, h) {
  if (!scratch || scratch.width !== w || scratch.height !== h) scratch = makeCanvas(w, h);
  return scratch;
}
// Draw piece p onto dst (a context whose current transform maps drawing coordinates).
// opts: alpha, glow (colour), limitT (only stroke points up to this time), size {w,h}.
export function renderPiece(dst, p, doc, size, opts = {}) {
  const bb = docBox(p); if (!bb) return;
  const x0 = Math.max(0, Math.floor(bb.x0) - 2), y0 = Math.max(0, Math.floor(bb.y0) - 2);
  const x1 = Math.min(size.w, Math.ceil(bb.x1) + 2), y1 = Math.min(size.h, Math.ceil(bb.y1) + 2);
  if (x1 <= x0 || y1 <= y0) return;
  const sc = getScratch(size.w, size.h), s = sc.getContext("2d");
  s.setTransform(1, 0, 0, 1, 0, 0); s.globalAlpha = 1; s.globalCompositeOperation = "source-over";
  s.clearRect(x0, y0, x1 - x0, y1 - y0);
  s.save(); s.beginPath(); s.rect(x0, y0, x1 - x0, y1 - y0); s.clip();
  s.setTransform(...p.tf);
  drawContent(s, p, doc, opts.limitT ?? Infinity);
  s.globalAlpha = 1;
  s.globalCompositeOperation = "destination-in"; for (const c of p.clips) { s.fillStyle = "#000"; drawRegion(s, doc, c); }
  s.globalCompositeOperation = "destination-out"; for (const c of p.masks) { s.fillStyle = "#000"; drawRegion(s, doc, c); }
  for (const e of p.erasers) drawEraserPts(s, e);
  s.restore();
  dst.save();
  dst.globalAlpha = (opts.alpha ?? 1) * (p.opacity ?? 1);
  if (p.blend) dst.globalCompositeOperation = p.blend;
  if (opts.glow) { dst.shadowColor = opts.glow; dst.shadowBlur = 24; dst.drawImage(sc, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0); dst.shadowBlur = 0; dst.shadowColor = "transparent"; }
  dst.drawImage(sc, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
  dst.restore();
}

// ---------- layers and whole pictures ----------
export function renderLayer(ctx, state, layerId, doc, opts = {}) {
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  for (const id of state.order[layerId] || []) {
    if (opts.hidden?.has(id)) continue;
    const p = state.pieces.get(id); if (!p) continue;
    renderPiece(ctx, p, doc, state.size, opts.pieceOpts ? opts.pieceOpts(p) : {});
  }
}
let layerTmp = null;
// The whole picture as one canvas. opts.paper (default true), opts.pieceOpts(piece) for fading and glows,
// opts.page for just one page (layers of other pages are left out).
export function renderComposite(state, doc, opts = {}) {
  const { w, h } = state.size, out = makeCanvas(w, h), x = out.getContext("2d");
  if (opts.paper !== false) { x.fillStyle = paperColor(doc); x.fillRect(0, 0, w, h); }
  if (!layerTmp || layerTmp.width !== w || layerTmp.height !== h) layerTmp = makeCanvas(w, h);
  const lx = layerTmp.getContext("2d");
  for (const L of state.layers) {
    if (!L.visible && !opts.allLayers) continue;
    if (opts.page && (L.page || "pg0") !== opts.page) continue;
    renderLayer(lx, state, L.id, doc, opts);
    x.globalAlpha = L.opacity; x.drawImage(layerTmp, 0, 0); x.globalAlpha = 1;
  }
  return out;
}
export function drawGrid(ctx, doc, size, zoom) {
  const step = 50, r = Math.max(1, 1.6 / Math.max(zoom, 0.3));
  ctx.fillStyle = doc.paper === "dark" ? "rgba(255,255,255,.12)" : "rgba(40,50,70,.13)";
  for (let x = step; x < size.w; x += step) for (let y = step; y < size.h; y += step) ctx.fillRect(x - r / 2, y - r / 2, r, r);
}

// Pointing marks for the saved pictures: a dashed arrow along the path, or a ring for a tap.
export function drawPointing(c, pts) {
  if (!pts.length) return;
  c.save(); c.strokeStyle = c.fillStyle = "#d6336c"; c.lineWidth = 6; c.lineCap = "round"; c.lineJoin = "round";
  const e = pts[pts.length - 1];
  let k = pts.length - 1; while (k > 0 && Math.hypot(pts[k][0] - e[0], pts[k][1] - e[1]) < 30) k--;
  if (k === pts.length - 1 || Math.hypot(pts[0][0] - e[0], pts[0][1] - e[1]) < 20) {
    c.beginPath(); c.arc(e[0], e[1], 26, 0, 7); c.stroke(); c.beginPath(); c.arc(e[0], e[1], 7, 0, 7); c.fill();
  } else {
    c.setLineDash([18, 12]); c.beginPath(); c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    c.stroke(); c.setLineDash([]);
    const a = Math.atan2(e[1] - pts[k][1], e[0] - pts[k][0]);
    c.beginPath(); c.moveTo(e[0] + Math.cos(a) * 10, e[1] + Math.sin(a) * 10);
    c.lineTo(e[0] + Math.cos(a + 2.6) * 30, e[1] + Math.sin(a + 2.6) * 30);
    c.lineTo(e[0] + Math.cos(a - 2.6) * 30, e[1] + Math.sin(a - 2.6) * 30); c.closePath(); c.fill();
  }
  c.restore();
}
