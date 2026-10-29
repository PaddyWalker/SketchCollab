// SketchCollab: the app. Tools, the canvas view, layers, the timeline, playback, saving.

import { $, I, mul, applyM, inv, translate, scaleAbout, scaleOf, makeCanvas, boxOfPoints, unionBox, padBox, interBox, boxesTouch, transformBox, pointInPoly, ellipsePoly, fmt, hexToRgb, rgbToHex, sleep, clamp } from "./util.js";
import { newDoc, newId, initialState, apply, replay, docBox, hitTest, samplePoints, toLocal } from "./doc.js";
import { BRUSHES, FONTS, fontCss, paperColor, getImage, preloadAssets, forgetImages, setImageReadyHandler, renderPiece, renderLayer, renderComposite, drawGrid, drawStrokePts, drawEraserPts, drawShape, drawPointing, measureText } from "./render.js";
import * as speech from "./speech.js";
import { buildMoments, momentCanvas, storyboardCanvas, wordsText, momentText } from "./moments.js";

// ---------------------------------------------------------------- state
let doc = newDoc(), state = initialState(doc);
let redoStack = [], activeLayer = "l0", dirty = false;
const layerCanvas = new Map();
let hiddenIds = null;              // pieces lifted off their layer while being moved or edited
let floating = null;               // { canvas, m } the lifted pieces, drawn on top while dragging
let eraseWork = null;              // { layer, canvas } a copy of a layer being erased
let live = null;                   // stroke being drawn
let liveCanvas = null;
let preview = null;                // what the current tool wants drawn on top (shape, marquee, lasso...)
let sel = blankSel();
let audioBlobs = new Map();
let pb = null;                     // playback
let clipboard = null;              // copied pieces

const SETTINGS_KEY = "sketchtalk.settings.v2";   // storage names kept from when the app was called Sketch Talk, so settings and drafts carry over
const defaults = {
  tool: "brush", brush: "pen", brushes: JSON.parse(JSON.stringify(BRUSHES)), primary: "#1f2430", secondary: "#ffffff",
  eraserSize: 30, shape: "rect", shapeWidth: 6, shapeFill: false, font: "sans", fontSize: 48, bold: false, italic: false,
  bucketTol: 32, bucketAll: true, gradType: "linear", wandTol: 40, marquee: "rect", theme: "auto", keepPlaying: false,
};
const settings = loadSettings();
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (s) {
      const brushes = {};
      for (const k in defaults.brushes) brushes[k] = { ...defaults.brushes[k], ...(s.brushes?.[k] || {}), mode: defaults.brushes[k].mode, label: defaults.brushes[k].label, blend: defaults.brushes[k].blend };
      return { ...defaults, ...s, brushes, brush: defaults.brushes[s.brush] ? s.brush : defaults.brush };
    }
  } catch (_) {}
  return JSON.parse(JSON.stringify(defaults));
}
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {} }
try { localStorage.removeItem("sketchtalk.draft"); } catch (_) {}   // the old version's draft

// ---------------------------------------------------------------- small UI helpers
const toastEl = $("toast"); let toastTimer;
function toast(msg, ms = 4000) { toastEl.textContent = msg; toastEl.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms); }
function armed(btn, label, action) {
  let timer = null; const original = btn.textContent;
  btn.addEventListener("click", () => {
    if (timer) { clearTimeout(timer); timer = null; btn.textContent = original; btn.classList.remove("armed"); action(); return; }
    btn.textContent = label; btn.classList.add("armed");
    timer = setTimeout(() => { timer = null; btn.textContent = original; btn.classList.remove("armed"); }, 3000);
  });
}
const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); e.append(...kids); return e; };
const typing = t => t && t.closest && t.closest("input, textarea, select, [contenteditable=true], [contenteditable='']");
const layerOf = id => state.layers.find(l => l.id === id);
const pad2 = n => String(n).padStart(2, "0");

// ---------------------------------------------------------------- view
const vp = $("viewport"), view = $("view"), vctx = view.getContext("2d");
const V = { z: 1, x: 0, y: 0, w: 1, h: 1, dpr: 1, fitted: false };
function resizeView() {
  const r = vp.getBoundingClientRect();
  V.dpr = window.devicePixelRatio || 1; V.w = r.width; V.h = r.height;
  view.width = Math.max(1, Math.round(r.width * V.dpr)); view.height = Math.max(1, Math.round(r.height * V.dpr));
  if (!V.fitted) fit();
  requestRender(); positionTextEditor();
}
new ResizeObserver(resizeView).observe(vp);
window.addEventListener("resize", resizeView);
document.addEventListener("visibilitychange", () => { if (!document.hidden) resizeView(); });
function fit() {
  if (V.w < 120 || V.h < 120) { V.fitted = false; return; }   // not laid out yet; fit on the next resize
  V.fitted = true;
  const { w, h } = state.size;
  V.z = clamp(Math.min((V.w - 48) / w, (V.h - 48) / h), 0.03, 8);
  V.x = (V.w - w * V.z) / 2; V.y = (V.h - h * V.z) / 2;
  updateZoomLabel(); requestRender(); positionTextEditor();
}
function zoomAt(f, sx = V.w / 2, sy = V.h / 2) {
  const z = clamp(V.z * f, 0.03, 16), k = z / V.z;
  V.x = sx - (sx - V.x) * k; V.y = sy - (sy - V.y) * k; V.z = z;
  updateZoomLabel(); requestRender(); positionTextEditor();
}
function zoomTo(z) { zoomAt(z / V.z); }
function updateZoomLabel() { $("zoomLabel").textContent = Math.round(V.z * 100) + "%"; $("pageBtn").textContent = `${state.size.w} × ${state.size.h}`; }
function toDoc(cx, cy) { const r = vp.getBoundingClientRect(); return [(cx - r.left - V.x) / V.z, (cy - r.top - V.y) / V.z]; }
const toScreen = (x, y) => [x * V.z + V.x, y * V.z + V.y];
$("zoomIn").onclick = () => zoomAt(1.25); $("zoomOut").onclick = () => zoomAt(0.8); $("zoomFit").onclick = fit;

let raf = 0;
function requestRender() { if (!raf) raf = requestAnimationFrame(draw); }
function draw() {
  raf = 0;
  if (Math.abs(vp.clientWidth - V.w) > 1 || Math.abs(vp.clientHeight - V.h) > 1) { resizeView(); return; }   // a missed resize
  const c = vctx, d = V.dpr, { w, h } = state.size;
  c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, view.width, view.height);
  c.setTransform(d * V.z, 0, 0, d * V.z, d * V.x, d * V.y);
  c.save(); c.shadowColor = "rgba(0,0,0,.28)"; c.shadowBlur = 18; c.shadowOffsetY = 3;
  c.fillStyle = paperColor(doc); c.fillRect(0, 0, w, h); c.restore();
  c.save(); c.beginPath(); c.rect(0, 0, w, h); c.clip();
  if (doc.grid) drawGrid(c, doc, state.size, V.z);
  c.imageSmoothingEnabled = true; c.imageSmoothingQuality = V.z < 1 ? "high" : "low";
  if (pb) drawPlayback(c);
  else {
    for (const L of state.layers) {
      if (!L.visible) continue;
      c.globalAlpha = L.opacity;
      const cv = eraseWork && eraseWork.layer === L.id ? eraseWork.canvas : layerCanvas.get(L.id);
      if (cv) c.drawImage(cv, 0, 0);
      if (live && live.layer === L.id) {
        c.globalAlpha = L.opacity * live.props.opacity;
        if (live.props.blend) c.globalCompositeOperation = live.props.blend;
        c.drawImage(liveCanvas, 0, 0); c.globalCompositeOperation = "source-over";
      }
      c.globalAlpha = 1;
    }
    if (floating) { c.save(); c.transform(...floating.m); c.drawImage(floating.canvas, 0, 0); c.restore(); }
  }
  c.restore();
  drawOverlay(c);
}

// ---------------------------------------------------------------- layers on screen
function ensureLayerCanvases() {
  const { w, h } = state.size;
  for (const L of state.layers) {
    const cv = layerCanvas.get(L.id);
    if (!cv || cv.width !== w || cv.height !== h) layerCanvas.set(L.id, makeCanvas(w, h));
  }
  for (const id of [...layerCanvas.keys()]) if (!state.order[id]) layerCanvas.delete(id);
  if (!liveCanvas || liveCanvas.width !== w || liveCanvas.height !== h) liveCanvas = makeCanvas(w, h);
}
function redrawLayer(id) { const cv = layerCanvas.get(id); if (cv) renderLayer(cv.getContext("2d"), state, id, doc, { hidden: hiddenIds }); }
function redrawAll() { ensureLayerCanvases(); state.layers.forEach(L => redrawLayer(L.id)); requestRender(); }
setImageReadyHandler(() => { redrawAll(); });

// ---------------------------------------------------------------- events, undo
function commit(ev) {
  if (ev.t0 === undefined) ev.t0 = speech.now();
  doc.events.push(ev);
  if (ev.type !== "point") { redoStack = []; speech.step(1000); }   // while not talking, each action moves the clock on a little
  afterApply(apply(state, ev));
  changed();
}
// Undo or redo in the middle of a drag would pull the piece out from under the mouse, so finish that first.
function interruptGesture() {
  if (editing) commitText();
  if (gesture || drag || live || floating || eraseWork) cancelToolGesture();
}
function afterApply(res) {
  if (res.sizeChanged || res.layersChanged) ensureLayerCanvases();
  if (res.sizeChanged) { redrawAll(); fit(); }
  else if (res.append && res.layers.size === 1 && !hiddenIds) {
    const cv = layerCanvas.get(res.append.layer), p = state.pieces.get(res.append.id);
    if (cv && p) { const x = cv.getContext("2d"); x.setTransform(1, 0, 0, 1, 0, 0); renderPiece(x, p, doc, state.size); }
  } else res.layers.forEach(redrawLayer);
  if (res.layersChanged) { if (!state.order[activeLayer]) activeLayer = state.layers[state.layers.length - 1].id; renderLayers(); }
  pruneSelection(); updateZoomLabel(); requestRender();
}
function rebuild() {
  state = replay(doc);
  if (!state.order[activeLayer]) activeLayer = state.layers[state.layers.length - 1].id;
  sel = blankSel(); hiddenIds = null; floating = null;
  redrawAll(); renderLayers(); renderOptions(); updateZoomLabel();
}
function undo() {
  if (pb) stopPlayback();
  interruptGesture();
  for (let i = doc.events.length - 1; i >= 0; i--) {
    if (doc.events[i].type !== "point") { redoStack.push(doc.events.splice(i, 1)[0]); rebuild(); changed(); return; }
  }
}
function redo() {
  if (pb) stopPlayback();
  interruptGesture();
  const ev = redoStack.pop(); if (!ev) return;
  doc.events.push(ev); afterApply(apply(state, ev)); changed();
}

// ---------------------------------------------------------------- selection
function blankSel() { return { ids: new Set(), pending: [], region: null, tint: null }; }
function clearSelection() { sel = blankSel(); renderOptions(); requestRender(); }
function pruneSelection() { for (const id of [...sel.ids]) if (!state.pieces.has(id)) sel.ids.delete(id); sel.pending = sel.pending.filter(pc => state.pieces.has(pc.src)); }
const hasSelection = () => sel.ids.size > 0 || sel.pending.length > 0;
function clipBox(clip, p) { return clip.type === "poly" ? boxOfPoints(clip.pts) : transformBox(p.tf, { x0: clip.x, y0: clip.y, x1: clip.x + clip.w, y1: clip.y + clip.h }); }
function selectionBox() {
  let b = null;
  for (const id of sel.ids) { const p = state.pieces.get(id); if (p) b = unionBox(b, docBox(p)); }
  for (const pc of sel.pending) { const p = state.pieces.get(pc.src); if (p) b = unionBox(b, interBox(docBox(p), clipBox(pc.clip, p))); }
  return b;
}
// Turn a part-selection (lasso over a photo, etc.) into real pieces before moving or deleting it.
function ensureCut() {
  if (!sel.pending.length) return;
  const cuts = sel.pending.map(pc => ({ src: pc.src, newId: newId(doc), clip: pc.clip }));
  sel.pending = []; sel.tint = null; sel.region = null;
  commit({ type: "cut", cuts });
  cuts.forEach(c => sel.ids.add(c.newId));
}
function selectedPieces() { return [...sel.ids].map(id => state.pieces.get(id)).filter(Boolean); }
// The active layer is checked first, so a see-through fill on a layer above doesn't get in the way.
function topHit(x, y) {
  const tol = 6 / V.z, act = layerOf(activeLayer);
  const order = [act, ...[...state.layers].reverse().filter(L => L !== act)];
  for (const L of order) {
    if (!L || !L.visible || L.locked) continue;
    const ids = state.order[L.id];
    for (let i = ids.length - 1; i >= 0; i--) { const p = state.pieces.get(ids[i]); if (p && hitTest(p, x, y, tol) && bitmapHit(p, x, y)) return p; }
  }
  return null;
}
// Pieces cut out with the quick-select wand only count where their cut-out shape actually is.
const maskData = new Map();
function maskAlpha(c, lx, ly) {
  let d = maskData.get(c.asset);
  if (!d) {
    const im = getImage(doc, c.asset); if (!im) return 255;
    const cv = makeCanvas(im.naturalWidth, im.naturalHeight), x = cv.getContext("2d"); x.drawImage(im, 0, 0);
    d = { w: cv.width, h: cv.height, data: x.getImageData(0, 0, cv.width, cv.height).data }; maskData.set(c.asset, d);
  }
  const u = Math.floor((lx - c.x) / c.w * d.w), v = Math.floor((ly - c.y) / c.h * d.h);
  return u < 0 || v < 0 || u >= d.w || v >= d.h ? 0 : d.data[(v * d.w + u) * 4 + 3];
}
function bitmapHit(p, x, y) {
  const bm = c => c.type === "bitmap";
  if (!p.clips.some(bm) && !p.masks.some(bm)) return true;
  const [lx, ly] = applyM(inv(p.tf), x, y);
  if (p.clips.some(c => bm(c) && maskAlpha(c, lx, ly) < 128)) return false;
  if (p.masks.some(c => bm(c) && maskAlpha(c, lx, ly) >= 128)) return false;
  return true;
}
function canDraw() {
  const L = layerOf(activeLayer);
  if (!L) return false;
  if (!L.visible) { toast(`“${L.name}” is hidden. Show it with the eye button, or pick another layer.`); return false; }
  if (L.locked) { toast(`“${L.name}” is locked. Unlock it with the lock button, or pick another layer.`); return false; }
  return true;
}
function setActiveLayer(id) { if (activeLayer !== id) { activeLayer = id; renderLayers(); } }
function deleteSelection() {
  if (!hasSelection()) return;
  ensureCut();
  const ids = [...sel.ids]; if (ids.length) commit({ type: "delete", ids });
  clearSelection();
}
function lift() {
  ensureCut();
  const ids = [...sel.ids]; if (!ids.length) return false;
  hiddenIds = new Set(ids);
  const layers = new Set(selectedPieces().map(p => p.layer)); layers.forEach(redrawLayer);
  const cv = makeCanvas(state.size.w, state.size.h), x = cv.getContext("2d");
  for (const L of state.layers) {
    if (!L.visible) continue;
    for (const id of state.order[L.id]) if (hiddenIds.has(id)) renderPiece(x, state.pieces.get(id), doc, state.size, { alpha: L.opacity });
  }
  floating = { canvas: cv, m: I, layers };
  return true;
}
function drop(m, t0) {
  const ids = [...hiddenIds], layers = floating.layers;
  hiddenIds = null; floating = null;
  if (m) commit({ type: "tf", ids, m, t0, t1: speech.now() });
  else layers.forEach(redrawLayer);
  requestRender();
}

// ---------------------------------------------------------------- live strokes
function startLive(props, c) {
  ensureLayerCanvases();
  const x = liveCanvas.getContext("2d"); x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
  live = { layer: activeLayer, props, pts: [[r1(c.x), r1(c.y), c.pressure, c.t]], sm: [c.x, c.y], carry: { left: 0 }, drawn: 0 };
  liveDraw(true);
}
const r1 = v => Math.round(v * 10) / 10;
function liveAdd(c) {
  const k = 1 - (live.props.smoothing || 0) * 0.85;
  live.sm[0] += (c.x - live.sm[0]) * k; live.sm[1] += (c.y - live.sm[1]) * k;
  const last = live.pts[live.pts.length - 1];
  if (Math.hypot(live.sm[0] - last[0], live.sm[1] - last[1]) < 0.7 / Math.max(V.z, 0.5)) return;
  live.pts.push([r1(live.sm[0]), r1(live.sm[1]), c.pressure, c.t]);
  liveDraw();
}
function liveDraw(first) {
  const x = liveCanvas.getContext("2d"), p = { ...live.props };
  x.setTransform(1, 0, 0, 1, 0, 0);
  if (p.mode === "flat") { x.clearRect(0, 0, liveCanvas.width, liveCanvas.height); drawStrokePts(x, p, live.pts); }
  else { const from = first ? 0 : Math.max(0, live.drawn - 1); drawStrokePts(x, p, live.pts.slice(from), live.carry); live.drawn = live.pts.length; }
  requestRender();
}
function endLive(c) {
  const last = live.pts[live.pts.length - 1];
  if (Math.hypot(c.x - last[0], c.y - last[1]) > 0.7) { live.pts.push([r1(c.x), r1(c.y), c.pressure, c.t]); liveDraw(); }
  const L = live; live = null;
  liveCanvas.getContext("2d").clearRect(0, 0, liveCanvas.width, liveCanvas.height);
  commit({ type: "add", piece: { ...L.props, id: newId(doc), layer: L.layer, pts: L.pts, tf: [...I], clips: [], masks: [], erasers: [] }, t0: L.pts[0][3], t1: speech.now() });
  lastStrokeEnd = { wall: performance.now(), x: c.x, y: c.y }; lastPoint = null;
}

// ---------------------------------------------------------------- tools
const ICON = {
  move: '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
  marquee: '<rect x="4" y="5" width="16" height="14" stroke-dasharray="3 2.4"/>',
  lasso: '<path d="M7 15c-3-2-2.5-8 5-8.5s9 3.5 6.5 6.5-8 3-11.5 2"/><path d="M7 15c-1.5 1.5-.5 4.5 2 4.5"/>',
  quick: '<path d="M4 20L14 10"/><path d="M15 3v3M13.5 4.5h3M19 7v2M18 8h2M17 12v2M16 13h2"/>',
  brush: '<path d="M19 3l2 2-9.5 9.5-2-2z"/><path d="M9.5 12.5c-2.5 0-4 1.8-4 4 0 1.2-.7 2.2-2.5 2.8 3.6 1.4 8.5.4 8.5-4.8"/>',
  eraser: '<path d="M8 20h12"/><path d="M4 15l9-10 7 6-8 9H8z"/>',
  bucket: '<path d="M4 11l7-7 8 8-7 7z"/><path d="M4 11h15"/><path d="M20 15c0 2 1.5 3 1.5 4.5a1.5 1.5 0 01-3 0c0-1.5 1.5-2.5 1.5-4.5"/>',
  gradient: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 4v16M12 4v16" stroke-opacity=".6"/><path d="M16 4v16" stroke-opacity=".3"/>',
  shape: '<rect x="3.5" y="10" width="9" height="9" rx="1"/><circle cx="16.5" cy="8" r="4.5"/>',
  text: '<path d="M5 7V4h14v3M12 4v16M9 20h6"/>',
  eyedrop: '<path d="M14.5 4.5l5 5-2 2-5-5z"/><path d="M13 8l-8 8v3h3l8-8"/>',
  point: '<path d="M5 3l14 8-6 2-2 6z"/>',
  hand: '<path d="M8 12.5V6a1.5 1.5 0 013 0v5V4.5a1.5 1.5 0 013 0V11V6a1.5 1.5 0 013 0v7.5c0 4-2.7 6.5-6 6.5-2.5 0-4-1-5.6-3.4L4.1 13.9a1.5 1.5 0 012.4-1.8z"/>',
  zoom: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M8 10.5h5M10.5 8v5"/>',
  import: '<rect x="3" y="5" width="15" height="13" rx="2"/><circle cx="8" cy="10" r="1.6"/><path d="M18 14l-4-4-7 8"/><path d="M19 2v6M16 5h6"/>',
};
const TOOLS = [
  { id: "move", key: "v", label: "Move and select (V)" },
  { id: "marquee", key: "m", label: "Marquee select, rectangle or ellipse (M)" },
  { id: "lasso", key: "l", label: "Lasso select (L)" },
  { id: "quick", key: "w", label: "Quick select: grab a whole drawing, or a colour area of a photo (W)" },
  "sep",
  { id: "brush", key: "b", label: "Brush and pencil (B)" },
  { id: "eraser", key: "e", label: "Eraser (E)" },
  { id: "bucket", key: "g", label: "Paint bucket (G)" },
  { id: "gradient", key: "G", label: "Gradient (Shift+G)" },
  { id: "shape", key: "u", label: "Shapes: rectangle, ellipse, line, arrow (U)" },
  { id: "text", key: "t", label: "Text (T)" },
  { id: "eyedrop", key: "i", label: "Eyedropper: pick a colour from the drawing (I)" },
  "sep",
  { id: "point", key: "p", label: "Point: press and drag to show what you mean. With a mouse or pen, resting on something while you talk also points (P)" },
  { id: "hand", key: "h", label: "Hand: move around the drawing (H, or hold Space)" },
  { id: "zoom", key: "z", label: "Zoom: click to zoom in, Alt-click to zoom out (Z)" },
];
function buildToolbar() {
  const nav = $("tools"); nav.textContent = "";
  for (const t of TOOLS) {
    if (t === "sep") { nav.append(el("div", { className: "tsep" })); continue; }
    const b = el("button", { className: "tool", title: t.label, type: "button" });
    b.dataset.tool = t.id; b.setAttribute("aria-label", t.label); b.innerHTML = `<svg viewBox="0 0 24 24">${ICON[t.id]}</svg>`;
    b.onclick = () => setTool(t.id);
    nav.append(b);
  }
  nav.append(el("div", { className: "tsep" }));
  const imp = el("button", { className: "tool", title: "Bring in pictures: JPG, PNG, GIF, WebP, BMP, SVG, AVIF (you can also paste or drop them)", type: "button" });
  imp.setAttribute("aria-label", "Import pictures"); imp.innerHTML = `<svg viewBox="0 0 24 24">${ICON.import}</svg>`; imp.onclick = () => $("importInput").click();
  nav.append(imp);
  const colors = el("div", { className: "colors" });
  colors.innerHTML = `<button id="primary" title="Main colour (click to change)"></button><button id="secondary" title="Second colour, for fills and gradients (click to change)"></button><button id="swap" title="Swap colours (X)">⇄</button><input type="color" id="primaryInput" tabindex="-1"><input type="color" id="secondaryInput" tabindex="-1">`;
  nav.append(colors);
  $("primary").onclick = () => $("primaryInput").click();
  $("secondary").onclick = () => $("secondaryInput").click();
  $("primaryInput").oninput = e => setColor("primary", e.target.value);
  $("secondaryInput").oninput = e => setColor("secondary", e.target.value);
  $("swap").onclick = swapColors;
  paintColors();
}
function paintColors() {
  $("primary").style.background = settings.primary; $("secondary").style.background = settings.secondary;
  $("primaryInput").value = settings.primary; $("secondaryInput").value = settings.secondary;
}
function setColor(which, v) { settings[which] = v; paintColors(); saveSettings(); }
function swapColors() { [settings.primary, settings.secondary] = [settings.secondary, settings.primary]; paintColors(); saveSettings(); }
function setTool(id) {
  if (settings.tool === id) return renderOptions();
  if (editing) commitText();
  settings.tool = id; saveSettings();
  document.querySelectorAll(".tool[data-tool]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.tool === id)));
  preview = null; renderOptions(); updateCursor(); requestRender();
}
function updateCursor() {
  const t = settings.tool;
  view.style.cursor = spaceDown || t === "hand" ? "grab" : t === "zoom" ? "zoom-in" : t === "text" ? "text" : t === "move" ? "default" : "crosshair";
}

// Each tool: down(c), move(c), up(c). c = { x, y, pressure, t, shift, alt, ctrl, sx, sy (screen) }.
let drag = null;
const tools = {
  brush: {
    down(c) {
      if (c.alt) return tools.eyedrop.down(c);
      if (!canDraw()) return;
      const b = settings.brushes[settings.brush];
      startLive({ kind: "stroke", brush: settings.brush, mode: b.mode, size: b.size, opacity: b.opacity, hardness: b.hardness, flow: b.flow, smoothing: b.smoothing, pressureSize: b.pressureSize, pressureOpacity: b.pressureOpacity, blend: b.blend || null, color: settings.primary }, c);
    },
    move(c) { if (live) liveAdd(c); },
    up(c) { if (live) endLive(c); },
  },
  eraser: {
    down(c) {
      if (!canDraw()) return;
      const src = layerCanvas.get(activeLayer), cv = makeCanvas(src.width, src.height);
      cv.getContext("2d").drawImage(src, 0, 0);
      eraseWork = { layer: activeLayer, canvas: cv, pts: [[c.x, c.y, c.pressure]], t0: c.t };
      const x = cv.getContext("2d"); x.globalCompositeOperation = "destination-out"; drawEraserPts(x, { size: settings.eraserSize }, eraseWork.pts);
      requestRender();
    },
    move(c) {
      if (!eraseWork) return;
      const pts = eraseWork.pts, last = pts[pts.length - 1];
      if (Math.hypot(c.x - last[0], c.y - last[1]) < 1) return;
      pts.push([r1(c.x), r1(c.y), c.pressure]);
      const x = eraseWork.canvas.getContext("2d"); x.globalCompositeOperation = "destination-out";
      drawEraserPts(x, { size: settings.eraserSize }, pts.slice(-2)); requestRender();
    },
    up() {
      if (!eraseWork) return;
      const E = eraseWork, box = padBox(boxOfPoints(E.pts), settings.eraserSize);
      const targets = state.order[E.layer].filter(id => boxesTouch(docBox(state.pieces.get(id)), box));
      eraseWork = null;
      if (targets.length) commit({ type: "erase", stroke: { pts: E.pts, size: settings.eraserSize, pressureSize: false }, targets, t0: E.t0, t1: speech.now() });
      else requestRender();
    },
  },
  move: {
    down(c) {
      const sb = selectionBox(), h = sb && handleAt(sb, c.sx, c.sy);
      if (h) { drag = { type: "scale", h, sb, x0: c.x, y0: c.y, t0: c.t, lifted: false }; return; }
      if (sb && c.x >= sb.x0 && c.x <= sb.x1 && c.y >= sb.y0 && c.y <= sb.y1 && !c.shift) { drag = { type: "move", x0: c.x, y0: c.y, sx0: c.sx, sy0: c.sy, t0: c.t, lifted: false }; return; }
      const hit = topHit(c.x, c.y);
      if (hit) {
        if (c.shift) { sel.ids.has(hit.id) ? sel.ids.delete(hit.id) : sel.ids.add(hit.id); }
        else { sel = blankSel(); sel.ids.add(hit.id); }
        setActiveLayer(hit.layer); renderOptions(); requestRender();
        if (sel.ids.has(hit.id)) drag = { type: "move", x0: c.x, y0: c.y, sx0: c.sx, sy0: c.sy, t0: c.t, lifted: false };
        return;
      }
      if (!c.shift) clearSelection();
      drag = { type: "band", x0: c.x, y0: c.y, x1: c.x, y1: c.y, add: c.shift };
    },
    move(c) {
      if (!drag) return;
      if (drag.type === "band") { drag.x1 = c.x; drag.y1 = c.y; preview = { kind: "band", b: normBox(drag) }; requestRender(); return; }
      if (!drag.lifted) {
        if (Math.hypot(c.sx - (drag.sx0 ?? c.sx), c.sy - (drag.sy0 ?? c.sy)) < 3 && drag.type === "move") return;
        if (!lift()) { drag = null; return; }
        drag.lifted = true;
        if (drag.type === "scale") drag.sb = selectionBox() || drag.sb;
      }
      if (drag.type === "move") { let dx = c.x - drag.x0, dy = c.y - drag.y0; if (c.shift) Math.abs(dx) > Math.abs(dy) ? dy = 0 : dx = 0; floating.m = translate(dx, dy); }
      else floating.m = scaleMatrix(drag, c);
      requestRender();
    },
    up() {
      if (!drag) return;
      if (drag.type === "band") {
        preview = null;
        const b = normBox(drag);
        if ((b.x1 - b.x0) * V.z > 4 || (b.y1 - b.y0) * V.z > 4) {
          if (!drag.add) sel = blankSel();
          for (const L of state.layers) {
            if (!L.visible || L.locked) continue;
            for (const id of state.order[L.id]) { const bb = docBox(state.pieces.get(id)); if (bb && bb.x0 >= b.x0 && bb.x1 <= b.x1 && bb.y0 >= b.y0 && bb.y1 <= b.y1) sel.ids.add(id); }
          }
          renderOptions();
        }
        requestRender();
      } else if (drag.lifted) drop(floating.m, drag.t0);
      drag = null;
    },
  },
  marquee: {
    down(c) { drag = { x0: c.x, y0: c.y, x1: c.x, y1: c.y, add: c.shift }; },
    move(c) {
      if (!drag) return;
      drag.x1 = c.x; drag.y1 = c.y;
      if (c.shift) { const s = Math.max(Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0)); drag.x1 = drag.x0 + Math.sign(drag.x1 - drag.x0 || 1) * s; drag.y1 = drag.y0 + Math.sign(drag.y1 - drag.y0 || 1) * s; }
      const b = normBox(drag); preview = { kind: "region", pts: settings.marquee === "ellipse" ? ellipsePoly(b) : boxCorners(b) }; requestRender();
    },
    up() {
      if (!drag) return;
      const b = normBox(drag); preview = null;
      if ((b.x1 - b.x0) * V.z < 4 && (b.y1 - b.y0) * V.z < 4) clearSelection();
      else selectRegion(settings.marquee === "ellipse" ? ellipsePoly(b) : boxCorners(b), drag.add);
      drag = null;
    },
  },
  lasso: {
    down(c) { drag = { pts: [[c.x, c.y]], add: c.shift }; },
    move(c) {
      if (!drag) return;
      const l = drag.pts[drag.pts.length - 1];
      if (Math.hypot(c.x - l[0], c.y - l[1]) * V.z > 2) drag.pts.push([c.x, c.y]);
      preview = { kind: "region", pts: drag.pts, open: true }; requestRender();
    },
    up() {
      if (!drag) return;
      preview = null;
      if (drag.pts.length < 3) clearSelection(); else selectRegion(drag.pts, drag.add);
      drag = null;
    },
  },
  quick: {
    down(c) {
      const hit = topHit(c.x, c.y);
      if (!hit) { if (!c.shift) clearSelection(); return; }
      if (!c.shift) sel = blankSel();
      setActiveLayer(hit.layer);
      if (hit.kind === "image" && hit.source !== "bucket") magicWand(hit, c);
      else for (const id of connected(hit)) sel.ids.add(id);
      renderOptions(); requestRender();
    },
  },
  bucket: {
    down(c) {
      if (!canDraw()) return;
      const { w, h } = state.size, x = Math.floor(c.x), y = Math.floor(c.y);
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      let src;
      if (settings.bucketAll) src = renderComposite(state, doc);
      else { src = makeCanvas(w, h); renderLayer(src.getContext("2d"), state, activeLayer, doc); }
      const data = src.getContext("2d").getImageData(0, 0, w, h).data;
      const mask = dilate(floodMask(data, w, h, x, y, settings.bucketTol), w, h, 2);
      const area = maskToCanvas(mask, w, h, settings.primary);
      if (!area) return;
      const asset = addAsset(area.canvas.toDataURL("image/png"));
      commit({ type: "add", piece: { kind: "image", source: "bucket", fillColor: settings.primary, asset, x: area.x, y: area.y, w: area.w, h: area.h, id: newId(doc), layer: activeLayer, tf: [...I], clips: [], masks: [], erasers: [] }, t0: c.t });
    },
  },
  gradient: {
    down(c) { if (!canDraw()) return; drag = { x0: c.x, y0: c.y, x1: c.x, y1: c.y, t0: c.t }; },
    move(c) { if (!drag) return; drag.x1 = c.x; drag.y1 = c.y; preview = { kind: "line", ...drag }; requestRender(); },
    up() {
      if (!drag) return;
      preview = null;
      const d = drag; drag = null;
      if (Math.hypot(d.x1 - d.x0, d.y1 - d.y0) * V.z < 4) return requestRender();
      const area = sel.region?.type === "poly" ? sel.region.pts : boxCorners({ x0: 0, y0: 0, x1: state.size.w, y1: state.size.h });
      commit({ type: "add", piece: { kind: "gradient", gtype: settings.gradType, gx0: d.x0, gy0: d.y0, gx1: d.x1, gy1: d.y1, c0: settings.primary, c1: settings.secondary, area, id: newId(doc), layer: activeLayer, tf: [...I], clips: [], masks: [], erasers: [] }, t0: d.t0, t1: speech.now() });
    },
  },
  shape: {
    down(c) { if (!canDraw()) return; drag = { x0: c.x, y0: c.y, x1: c.x, y1: c.y, t0: c.t }; },
    move(c) {
      if (!drag) return;
      let x1 = c.x, y1 = c.y;
      if (c.shift) {
        const dx = x1 - drag.x0, dy = y1 - drag.y0;
        if (settings.shape === "line" || settings.shape === "arrow") { const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4, r = Math.hypot(dx, dy); x1 = drag.x0 + Math.cos(a) * r; y1 = drag.y0 + Math.sin(a) * r; }
        else { const s = Math.max(Math.abs(dx), Math.abs(dy)); x1 = drag.x0 + Math.sign(dx || 1) * s; y1 = drag.y0 + Math.sign(dy || 1) * s; }
      }
      drag.x1 = x1; drag.y1 = y1; preview = { kind: "shape", piece: shapePiece(drag) }; requestRender();
    },
    up() {
      if (!drag) return;
      preview = null;
      const d = drag; drag = null;
      if (Math.hypot(d.x1 - d.x0, d.y1 - d.y0) * V.z < 4) return requestRender();
      commit({ type: "add", piece: { ...shapePiece(d), id: newId(doc), layer: activeLayer, tf: [...I], clips: [], masks: [], erasers: [] }, t0: d.t0, t1: speech.now() });
    },
  },
  text: {
    down(c) {
      if (editing) { commitText(); return; }
      const hit = topHit(c.x, c.y);
      if (hit && hit.kind === "text") { setActiveLayer(hit.layer); openTextEditor(hit.x, hit.y, hit); }
      else if (canDraw()) openTextEditor(c.x, c.y - settings.fontSize * 0.6, null);
    },
  },
  eyedrop: {
    down(c) {
      const x = Math.floor(c.x), y = Math.floor(c.y);
      if (x < 0 || y < 0 || x >= state.size.w || y >= state.size.h) return;
      const d = renderComposite(state, doc).getContext("2d").getImageData(x, y, 1, 1).data;
      setColor("primary", rgbToHex(d[0], d[1], d[2]));
      toast(`Picked ${rgbToHex(d[0], d[1], d[2])}.`, 1800);
    },
  },
  point: {
    down(c) { drag = { pts: [[r1(c.x), r1(c.y), 0.5, c.t]], t0: c.t }; preview = { kind: "trail", pts: drag.pts }; requestRender(); },
    move(c) { if (!drag) return; const l = drag.pts[drag.pts.length - 1]; if (Math.hypot(c.x - l[0], c.y - l[1]) * V.z > 2) drag.pts.push([r1(c.x), r1(c.y), 0.5, c.t]); preview = { kind: "trail", pts: drag.pts }; requestRender(); },
    up(c) {
      if (!drag) return;
      const d = drag; drag = null; preview = null;
      commit({ type: "point", pts: d.pts, t0: d.t0, t1: speech.now() });
      pulse(c.x, c.y);
    },
  },
  zoom: { down(c) { zoomAt(c.alt ? 0.7 : 1.4, c.sx, c.sy); } },
  hand: {},
};
const boxCorners = b => [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]];
const normBox = d => ({ x0: Math.min(d.x0, d.x1), y0: Math.min(d.y0, d.y1), x1: Math.max(d.x0, d.x1), y1: Math.max(d.y0, d.y1) });
function shapePiece(d) { return { kind: "shape", shape: settings.shape, x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1, color: settings.primary, width: settings.shapeWidth, fill: settings.shapeFill && (settings.shape === "rect" || settings.shape === "ellipse") ? settings.secondary : null }; }

// Transform handles, in screen space so they stay the same size at any zoom.
function handlePoints(sb) {
  const mx = (sb.x0 + sb.x1) / 2, my = (sb.y0 + sb.y1) / 2;
  return [
    { x: sb.x0, y: sb.y0, ax: sb.x1, ay: sb.y1, k: "c" }, { x: sb.x1, y: sb.y0, ax: sb.x0, ay: sb.y1, k: "c" },
    { x: sb.x1, y: sb.y1, ax: sb.x0, ay: sb.y0, k: "c" }, { x: sb.x0, y: sb.y1, ax: sb.x1, ay: sb.y0, k: "c" },
    { x: mx, y: sb.y0, ax: mx, ay: sb.y1, k: "y" }, { x: mx, y: sb.y1, ax: mx, ay: sb.y0, k: "y" },
    { x: sb.x0, y: my, ax: sb.x1, ay: my, k: "x" }, { x: sb.x1, y: my, ax: sb.x0, ay: my, k: "x" },
  ];
}
function handleAt(sb, sx, sy) {
  if (settings.tool !== "move") return null;
  for (const h of handlePoints(sb)) { const [hx, hy] = toScreen(h.x, h.y); if (Math.abs(hx - sx) <= 7 && Math.abs(hy - sy) <= 7) return h; }
  return null;
}
function scaleMatrix(d, c) {
  const h = d.h;
  let sx = h.k === "y" ? 1 : (c.x - h.ax) / ((h.x - h.ax) || 1);
  let sy = h.k === "x" ? 1 : (c.y - h.ay) / ((h.y - h.ay) || 1);
  if (h.k === "c" && !c.shift) { const s = Math.abs(sx) > Math.abs(sy) ? sx : sy; sx = sy = s; }
  const fix = v => Math.sign(v || 1) * Math.max(0.02, Math.abs(v));
  return scaleAbout(fix(sx), fix(sy), h.ax, h.ay);
}

// Marquee and lasso: whole pieces inside are selected; pieces partly inside are cut when moved or deleted.
function selectRegion(poly, add) {
  if (!add) sel = blankSel();
  const L = layerOf(activeLayer);
  if (!L.visible || L.locked) { toast(`Selections work on the active layer, and “${L.name}” is ${L.locked ? "locked" : "hidden"}.`); return; }
  for (const id of state.order[activeLayer]) {
    const p = state.pieces.get(id), pts = samplePoints(p);
    const inside = pts.filter(q => pointInPoly(q[0], q[1], poly)).length;
    if (inside === pts.length && pts.length) sel.ids.add(id);
    else if (inside > 0) sel.pending.push({ src: id, clip: { type: "poly", pts: poly } });
    else if (p.kind !== "stroke") { const b = docBox(p); if (b && poly.some(q => q[0] >= b.x0 && q[0] <= b.x1 && q[1] >= b.y0 && q[1] <= b.y1)) sel.pending.push({ src: id, clip: { type: "poly", pts: poly } }); }
  }
  sel.region = { type: "poly", pts: poly };
  renderOptions(); requestRender();
}
function connected(start) {
  const ids = state.order[start.layer], boxes = new Map(ids.map(id => [id, padBox(docBox(state.pieces.get(id)), 4)]));
  const out = new Set([start.id]), queue = [start.id];
  while (queue.length) {
    const b = boxes.get(queue.pop());
    for (const id of ids) if (!out.has(id) && boxesTouch(b, boxes.get(id))) { out.add(id); queue.push(id); }
  }
  return out;
}
function floodMask(d, w, h, sx, sy, tol) {
  const m = new Uint8Array(w * h), j0 = (sy * w + sx) * 4;
  const r0 = d[j0], g0 = d[j0 + 1], b0 = d[j0 + 2], a0 = d[j0 + 3];
  const ok = i => { const j = i * 4; return Math.max(Math.abs(d[j] - r0), Math.abs(d[j + 1] - g0), Math.abs(d[j + 2] - b0), Math.abs(d[j + 3] - a0)) <= tol; };
  const st = [sx, sy];
  while (st.length) {
    const y = st.pop(); let x = st.pop();
    while (x >= 0 && !m[y * w + x] && ok(y * w + x)) x--;
    x++;
    let up = false, dn = false;
    while (x < w && !m[y * w + x] && ok(y * w + x)) {
      m[y * w + x] = 1;
      if (y > 0) { const k = (y - 1) * w + x; if (!m[k] && ok(k)) { if (!up) { st.push(x, y - 1); up = true; } } else up = false; }
      if (y < h - 1) { const k = (y + 1) * w + x; if (!m[k] && ok(k)) { if (!dn) { st.push(x, y + 1); dn = true; } } else dn = false; }
      x++;
    }
  }
  return m;
}
function dilate(m, w, h, r) {
  let a = m;
  for (let pass = 0; pass < r; pass++) {
    const b = new Uint8Array(a);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (a[y * w + x]) continue;
      if ((x > 0 && a[y * w + x - 1]) || (x < w - 1 && a[y * w + x + 1]) || (y > 0 && a[(y - 1) * w + x]) || (y < h - 1 && a[(y + 1) * w + x])) b[y * w + x] = 1;
    }
    a = b;
  }
  return a;
}
function maskToCanvas(m, w, h, color) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, cv = makeCanvas(cw, ch), x = cv.getContext("2d"), img = x.createImageData(cw, ch);
  const [r, g, b] = hexToRgb(color);
  for (let y = 0; y < ch; y++) for (let xx = 0; xx < cw; xx++) if (m[(y + y0) * w + xx + x0]) { const j = (y * cw + xx) * 4; img.data[j] = r; img.data[j + 1] = g; img.data[j + 2] = b; img.data[j + 3] = 255; }
  x.putImageData(img, 0, 0);
  return { canvas: cv, x: x0, y: y0, w: cw, h: ch };
}
function magicWand(p, c) {
  const im = getImage(doc, p.asset); if (!im) return;
  const [lx, ly] = applyM(inv(p.tf), c.x, c.y);
  const k = Math.min(1, 1500 / Math.max(im.naturalWidth, im.naturalHeight));
  const w = Math.max(1, Math.round(im.naturalWidth * k)), h = Math.max(1, Math.round(im.naturalHeight * k));
  const u = Math.floor((lx - p.x) / p.w * w), v = Math.floor((ly - p.y) / p.h * h);
  if (u < 0 || v < 0 || u >= w || v >= h) return;
  const cv = makeCanvas(w, h), x = cv.getContext("2d"); x.drawImage(im, 0, 0, w, h);
  const mask = dilate(floodMask(x.getImageData(0, 0, w, h).data, w, h, u, v, settings.wandTol), w, h, 1);
  const full = makeCanvas(w, h), fx = full.getContext("2d"), img = fx.createImageData(w, h);
  for (let i = 0; i < mask.length; i++) if (mask[i]) { img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255; img.data[i * 4 + 3] = 255; }
  fx.putImageData(img, 0, 0);
  const asset = addAsset(full.toDataURL("image/png"));
  sel.pending.push({ src: p.id, clip: { type: "bitmap", asset, x: p.x, y: p.y, w: p.w, h: p.h } });
  const tint = makeCanvas(w, h), tx = tint.getContext("2d");
  tx.drawImage(full, 0, 0); tx.globalCompositeOperation = "source-in"; tx.fillStyle = "rgba(39, 71, 201, .45)"; tx.fillRect(0, 0, w, h);
  sel.tint = { canvas: tint, tf: p.tf, x: p.x, y: p.y, w: p.w, h: p.h };
}
function addAsset(dataUrl) { const id = newId(doc, "a"); doc.assets[id] = dataUrl; getImage(doc, id); return id; }

// ---------------------------------------------------------------- text editing
const te = $("textEditor");
let editing = null;
function openTextEditor(x, y, piece) {
  editing = { id: piece?.id || null, x, y, tf: piece ? piece.tf : I, style: piece ? { font: piece.font, size: piece.size, bold: piece.bold, italic: piece.italic, color: piece.color } : { font: settings.font, size: settings.fontSize, bold: settings.bold, italic: settings.italic, color: settings.primary }, layer: piece?.layer || activeLayer, t0: speech.now() };
  te.value = piece ? piece.text : "";
  if (piece) { hiddenIds = new Set([piece.id]); redrawLayer(piece.layer); requestRender(); }
  te.hidden = false; positionTextEditor();
  te.focus(); requestAnimationFrame(() => te.focus());
}
function positionTextEditor() {
  if (!editing) return;
  const [dx, dy] = applyM(editing.tf, editing.x, editing.y), [sx, sy] = toScreen(dx, dy), k = V.z * scaleOf(editing.tf);
  const s = { ...editing.style, size: editing.style.size * k, text: te.value || " " };
  const m = measureText(s);
  Object.assign(te.style, { left: sx + "px", top: sy + "px", font: fontCss(s), color: editing.style.color, width: m.w + s.size + "px", height: m.h + s.size * 0.3 + "px" });
}
te.addEventListener("input", positionTextEditor);
te.addEventListener("keydown", e => {
  e.stopPropagation();
  if (e.key === "Escape") { te.value = editing?.id ? te.value : ""; commitText(); }
  else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitText(); }
});
te.addEventListener("blur", () => { if (editing) commitText(); });
function commitText() {
  if (!editing) return;
  const E = editing; editing = null;
  const text = te.value.replace(/\s+$/, "");
  te.hidden = true;
  const restore = () => { if (hiddenIds) { const L = state.pieces.get(E.id)?.layer; hiddenIds = null; if (L) redrawLayer(L); } };
  if (E.id) {
    const p = state.pieces.get(E.id);
    restore();
    if (!text) commit({ type: "delete", ids: [E.id] });
    else if (p && text !== p.text) { const m = measureText({ ...p, text }); commit({ type: "text", id: E.id, props: { text, w: m.w, h: m.h }, t0: E.t0 }); }
  } else if (text) {
    const m = measureText({ ...E.style, text });
    commit({ type: "add", piece: { kind: "text", text, x: E.x, y: E.y, w: m.w, h: m.h, ...E.style, id: newId(doc), layer: E.layer, tf: [...I], clips: [], masks: [], erasers: [] }, t0: E.t0, t1: speech.now() });
  }
  requestRender();
}

// ---------------------------------------------------------------- overlay
function drawOverlay(c) {
  const px = 1 / V.z;
  const ants = (pathFn, close = true) => {
    c.save(); c.lineWidth = 1.5 * px; c.strokeStyle = "#fff"; c.beginPath(); pathFn(); if (close) c.closePath(); c.stroke();
    c.setLineDash([5 * px, 4 * px]); c.strokeStyle = "#1a1e27"; c.stroke(); c.restore();
  };
  const poly = (pts, close = true) => ants(() => pts.forEach((q, i) => i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1])), close);
  if (!pb) {
    if (sel.tint) { c.save(); c.transform(...sel.tint.tf); c.drawImage(sel.tint.canvas, sel.tint.x, sel.tint.y, sel.tint.w, sel.tint.h); c.restore(); }
    if (sel.region && !floating) poly(sel.region.pts);
    const sb0 = selectionBox();
    if (sb0) {
      const sb = floating ? transformBox(floating.m, sb0) : sb0;
      c.save(); c.strokeStyle = "#2747c9"; c.lineWidth = 1.5 * px; c.strokeRect(sb.x0, sb.y0, sb.x1 - sb.x0, sb.y1 - sb.y0);
      if (settings.tool === "move") {
        c.fillStyle = "#fff";
        for (const h of handlePoints(sb)) { c.fillRect(h.x - 4.5 * px, h.y - 4.5 * px, 9 * px, 9 * px); c.strokeRect(h.x - 4.5 * px, h.y - 4.5 * px, 9 * px, 9 * px); }
      }
      c.restore();
    }
  }
  if (preview) {
    if (preview.kind === "band") { c.save(); c.fillStyle = "rgba(39,71,201,.08)"; const b = preview.b; c.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); c.restore(); poly(boxCorners(preview.b)); }
    else if (preview.kind === "region") poly(preview.pts, !preview.open);
    else if (preview.kind === "shape") { c.save(); drawShape(c, preview.piece); c.restore(); }
    else if (preview.kind === "line") {
      c.save(); c.strokeStyle = "#2747c9"; c.lineWidth = 2 * px; c.setLineDash([6 * px, 4 * px]);
      c.beginPath(); c.moveTo(preview.x0, preview.y0); c.lineTo(preview.x1, preview.y1); c.stroke();
      c.setLineDash([]); c.fillStyle = settings.primary; c.beginPath(); c.arc(preview.x0, preview.y0, 6 * px, 0, 7); c.fill(); c.stroke();
      c.fillStyle = settings.secondary; c.beginPath(); c.arc(preview.x1, preview.y1, 6 * px, 0, 7); c.fill(); c.stroke(); c.restore();
    } else if (preview.kind === "trail") {
      c.save(); c.strokeStyle = c.fillStyle = "rgba(214,51,108,.75)"; c.lineWidth = 8 * px; c.lineCap = c.lineJoin = "round";
      c.beginPath(); preview.pts.forEach((q, i) => i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1])); c.stroke();
      const e = preview.pts[preview.pts.length - 1]; c.beginPath(); c.arc(e[0], e[1], 12 * px, 0, 7); c.fill(); c.restore();
    }
  }
  const t = performance.now();
  for (let i = pulses.length - 1; i >= 0; i--) {
    const a = (t - pulses[i].t) / 600; if (a >= 1) { pulses.splice(i, 1); continue; }
    c.save(); c.strokeStyle = `rgba(214,51,108,${1 - a})`; c.lineWidth = 4 * px;
    c.beginPath(); c.arc(pulses[i].x, pulses[i].y, (14 + a * 26) * px, 0, 7); c.stroke(); c.restore();
  }
  if (pulses.length) requestRender();
  if (hoverPos && !pb && (settings.tool === "brush" || settings.tool === "eraser") && !spaceDown) {
    const r = (settings.tool === "eraser" ? settings.eraserSize : settings.brushes[settings.brush].size) / 2;
    if (r * V.z > 3) { c.save(); c.lineWidth = px; c.strokeStyle = "rgba(255,255,255,.9)"; c.beginPath(); c.arc(hoverPos[0], hoverPos[1], r, 0, 7); c.stroke(); c.strokeStyle = "rgba(0,0,0,.7)"; c.setLineDash([3 * px, 3 * px]); c.stroke(); c.restore(); }
  }
}

// ---------------------------------------------------------------- pointer input
const pointers = new Map();
let gesture = null, spaceDown = false, hoverPos = null;
function ctxOf(e) {
  const [x, y] = toDoc(e.clientX, e.clientY), r = vp.getBoundingClientRect();
  return { x, y, sx: e.clientX - r.left, sy: e.clientY - r.top, pressure: e.pointerType === "pen" ? (e.pressure || 0.5) : 0.5, t: speech.now(), shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey };
}
view.addEventListener("pointerdown", e => {
  if (pb) stopPlayback();
  if (editing && settings.tool !== "text") commitText();
  try { view.setPointerCapture(e.pointerId); } catch (_) {}
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
  $("hint").hidden = true;
  if (e.pointerType === "touch" && pointers.size === 2) {
    cancelToolGesture();
    const [a, b] = [...pointers.values()];
    gesture = { type: "pinch", d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    return;
  }
  if (gesture) return;
  if (e.button === 1 || spaceDown || settings.tool === "hand") { gesture = { type: "pan", sx: e.clientX, sy: e.clientY, vx: V.x, vy: V.y, id: e.pointerId }; view.style.cursor = "grabbing"; e.preventDefault(); return; }
  if (e.pointerType === "mouse" && e.button !== 0) return;
  clearTimeout(dwellTimer); hover = [];
  e.preventDefault();   // keeps the click from pulling focus away (for example out of a new text box)
  gesture = { type: "tool", id: e.pointerId };
  const tool = tools[settings.tool];
  tool.down?.(ctxOf(e));
});
view.addEventListener("pointermove", e => {
  const c = ctxOf(e);
  hoverPos = [c.x, c.y];
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
  if (gesture?.type === "pinch") {
    const [a, b] = [...pointers.values()]; if (!b) return;
    const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, r = vp.getBoundingClientRect();
    V.x += cx - gesture.cx; V.y += cy - gesture.cy;
    zoomAt(d / gesture.d, cx - r.left, cy - r.top);
    gesture.d = d; gesture.cx = cx; gesture.cy = cy; return;
  }
  if (gesture?.type === "pan") { V.x = gesture.vx + e.clientX - gesture.sx; V.y = gesture.vy + e.clientY - gesture.sy; requestRender(); positionTextEditor(); return; }
  if (gesture?.type === "tool" && gesture.id === e.pointerId) {
    const tool = tools[settings.tool];
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of evs.length ? evs : [e]) tool.move?.(ctxOf(ev));
    return;
  }
  if (!gesture && !e.buttons) hoverPoint(c);
  if (settings.tool === "move") { const sb = selectionBox(); const h = sb && handleAt(sb, c.sx, c.sy); view.style.cursor = h ? (h.k === "x" ? "ew-resize" : h.k === "y" ? "ns-resize" : "nwse-resize") : sb && c.x >= sb.x0 && c.x <= sb.x1 && c.y >= sb.y0 && c.y <= sb.y1 ? "move" : "default"; }
  if (settings.tool === "brush" || settings.tool === "eraser") requestRender();
});
function endPointer(e, cancel) {
  pointers.delete(e.pointerId);
  if (gesture?.type === "pinch") { if (pointers.size < 2) gesture = pointers.size ? { type: "idle" } : null; return; }
  if (gesture?.type === "idle") { if (!pointers.size) gesture = null; return; }
  if (gesture?.type === "pan" && gesture.id === e.pointerId) { gesture = null; updateCursor(); return; }
  if (gesture?.type === "tool" && gesture.id === e.pointerId) {
    gesture = null;
    if (cancel && live) { live = null; liveCanvas.getContext("2d").clearRect(0, 0, liveCanvas.width, liveCanvas.height); requestRender(); return; }
    tools[settings.tool].up?.(ctxOf(e));
  }
}
view.addEventListener("pointerup", e => endPointer(e, false));
view.addEventListener("pointercancel", e => endPointer(e, true));
view.addEventListener("pointerleave", () => { hoverPos = null; clearTimeout(dwellTimer); hover = []; requestRender(); });
view.addEventListener("contextmenu", e => e.preventDefault());
function cancelToolGesture() {
  if (live) { live = null; liveCanvas.getContext("2d").clearRect(0, 0, liveCanvas.width, liveCanvas.height); }
  if (eraseWork) eraseWork = null;
  if (floating) drop(null);
  drag = null; preview = null; gesture = null; requestRender();
}
vp.addEventListener("wheel", e => {
  e.preventDefault();
  const r = vp.getBoundingClientRect();
  if (e.shiftKey && !e.ctrlKey) { V.x -= e.deltaY || e.deltaX; requestRender(); positionTextEditor(); return; }
  zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

// Pointing by resting the mouse or pen on something while talking.
const DWELL = 450, TRAIL_MS = 700;
let hover = [], dwellTimer = null, lastPoint = null, lastStrokeEnd = { wall: -1e9, x: 0, y: 0 };
const pulses = [];
function hoverPoint(c) {
  if (!speech.isRunning() || pb) return;
  hover.push([c.x, c.y, c.t]);
  hover = hover.filter(h => c.t - h[2] <= TRAIL_MS);
  clearTimeout(dwellTimer);
  dwellTimer = setTimeout(() => dwelled(c.x, c.y), DWELL);
}
function dwelled(x, y) {
  if (!speech.isRunning() || gesture || pb) return;
  const trail = hover; hover = [];
  let moved = 0;
  for (let i = 1; i < trail.length; i++) moved += Math.hypot(trail[i][0] - trail[i - 1][0], trail[i][1] - trail[i - 1][1]);
  if (moved * V.z < 30) return;                                                                 // a jiggle, not a gesture
  if (lastPoint && Math.hypot(x - lastPoint[0], y - lastPoint[1]) * V.z < 45) return;          // still on the same spot
  if (performance.now() - lastStrokeEnd.wall < 1000 && Math.hypot(x - lastStrokeEnd.x, y - lastStrokeEnd.y) * V.z < 60) return;
  const t = speech.now() - DWELL;
  commit({ type: "point", pts: trail.map(h => [r1(h[0]), r1(h[1]), 0.5, h[2]]), t0: t, t1: t });
  lastPoint = [x, y]; pulse(x, y);
}
function pulse(x, y) { pulses.push({ x, y, t: performance.now() }); requestRender(); }

// ---------------------------------------------------------------- keyboard
document.addEventListener("keydown", e => {
  if (typing(e.target)) return;
  const k = e.key, ctrl = e.ctrlKey || e.metaKey;
  if (k === " ") { if (!spaceDown) { spaceDown = true; updateCursor(); } e.preventDefault(); return; }
  if (ctrl) {
    const lk = k.toLowerCase();
    if (lk === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (lk === "y") { e.preventDefault(); redo(); }
    else if (lk === "c") { if (hasSelection()) { e.preventDefault(); copySelection(); } }
    else if (lk === "x") { if (hasSelection()) { e.preventDefault(); copySelection(); deleteSelection(); } }
    else if (lk === "a") { e.preventDefault(); sel = blankSel(); state.order[activeLayer].forEach(id => sel.ids.add(id)); setTool("move"); renderOptions(); requestRender(); }
    else if (lk === "d") { e.preventDefault(); clearSelection(); }
    else if (k === "0") { e.preventDefault(); fit(); }
    else if (k === "1") { e.preventDefault(); zoomTo(1); }
    else if (k === "=" || k === "+") { e.preventDefault(); zoomAt(1.25); }
    else if (k === "-") { e.preventDefault(); zoomAt(0.8); }
    return;
  }
  if (e.altKey) return;
  if (k === "Escape") { if (pb) stopPlayback(); else if (drag || live) cancelToolGesture(); else clearSelection(); return; }
  if (k === "Delete" || k === "Backspace") { if (hasSelection()) { e.preventDefault(); deleteSelection(); } return; }
  if (k.startsWith("Arrow") && hasSelection()) {
    e.preventDefault();
    ensureCut();
    const s = e.shiftKey ? 10 : 1, dx = k === "ArrowLeft" ? -s : k === "ArrowRight" ? s : 0, dy = k === "ArrowUp" ? -s : k === "ArrowDown" ? s : 0;
    commit({ type: "tf", ids: [...sel.ids], m: translate(dx, dy) });
    return;
  }
  if (k === "[" || k === "]") { const f = k === "]" ? 1.2 : 1 / 1.2; if (settings.tool === "eraser") settings.eraserSize = clamp(Math.round(settings.eraserSize * f), 2, 400); else { const b = settings.brushes[settings.brush]; b.size = clamp(Math.round(b.size * f * 10) / 10, 1, 400); } saveSettings(); renderOptions(); requestRender(); return; }
  if (k === "x") { swapColors(); return; }
  if (k === "d") { setColor("primary", doc.paper === "dark" ? "#f4f6fa" : "#1f2430"); setColor("secondary", doc.paper === "dark" ? "#1d2027" : "#ffffff"); return; }
  if (k === "r") { $("rec").click(); return; }
  const key = e.shiftKey ? k.toUpperCase() : k.toLowerCase();
  const t = TOOLS.find(t => t !== "sep" && t.key === key);
  if (t) setTool(t.id);
});
document.addEventListener("keyup", e => { if (e.key === " ") { spaceDown = false; updateCursor(); } });

// ---------------------------------------------------------------- copy, paste, import
function copySelection() {
  const out = [];
  for (const p of selectedPieces()) out.push(JSON.parse(JSON.stringify(p)));
  for (const pc of sel.pending) { const p = state.pieces.get(pc.src); if (!p) continue; const q = JSON.parse(JSON.stringify(p)); q.clips = [...q.clips, toLocal(pc.clip, p)]; out.push(q); }
  // Pictures travel with the copy, so it still pastes after New or into a restored sketch.
  const assets = {};
  for (const q of out) for (const id of [q.asset, ...q.clips.map(c => c.asset), ...q.masks.map(c => c.asset)]) if (id && doc.assets[id]) assets[id] = doc.assets[id];
  clipboard = { pieces: out, assets };
  toast(`Copied ${out.length === 1 ? "1 piece" : out.length + " pieces"}. Paste with Ctrl+V.`, 1800);
}
function pastePieces() {
  if (!clipboard?.pieces.length || !canDraw()) return;
  const remap = {};
  for (const [id, url] of Object.entries(clipboard.assets)) remap[id] = doc.assets[id] === url ? id : addAsset(url);
  const fix = c => (c.asset && remap[c.asset] ? { ...c, asset: remap[c.asset] } : c);
  const pieces = clipboard.pieces.map(p => {
    const q = JSON.parse(JSON.stringify(p));
    return { ...fix(q), clips: q.clips.map(fix), masks: q.masks.map(fix), id: newId(doc), layer: activeLayer, tf: mul(translate(24, 24), p.tf) };
  });
  commit({ type: "addMany", pieces, paste: true });
  sel = blankSel(); pieces.forEach(p => sel.ids.add(p.id)); setTool("move"); renderOptions(); requestRender();
}
document.addEventListener("paste", async e => {
  if (typing(e.target)) return;
  const items = [...(e.clipboardData?.items || [])].filter(i => i.kind === "file" && i.type.startsWith("image/"));
  if (items.length) { e.preventDefault(); for (const it of items) await importFile(it.getAsFile(), "Pasted picture"); return; }
  if (clipboard) { e.preventDefault(); pastePieces(); }
});
$("importInput").addEventListener("change", async e => { for (const f of e.target.files) await importFile(f); e.target.value = ""; });
vp.addEventListener("dragover", e => { e.preventDefault(); });
vp.addEventListener("drop", async e => {
  e.preventDefault();
  const at = toDoc(e.clientX, e.clientY);
  for (const f of e.dataTransfer.files) await importFile(f, null, at);
});
const readAsDataURL = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(f); });
const loadImg = src => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
async function importFile(f, name, at) {
  if (!f) return;
  const fname = (name || f.name || "Picture").replace(/\.[a-z0-9]+$/i, "").slice(0, 40);
  if (/hei[cf]/i.test(f.type) || /\.hei[cf]$/i.test(f.name || "")) { toast("Chrome can't open iPhone HEIC photos. Save it as JPG first (on the iPhone: Settings, Camera, Formats, Most Compatible).", 9000); return; }
  if (!/^image\//.test(f.type) && !/\.(svg|bmp|ico|avif)$/i.test(f.name || "")) { toast(`“${f.name}” isn't a picture this app can open.`); return; }
  if (!canDraw() && !layerOf(activeLayer)) return;
  let url;
  try { url = await readAsDataURL(f); } catch (_) { return toast(`Couldn't read “${f.name}”.`); }
  let im;
  try { im = await loadImg(url); } catch (_) { return toast(`“${f.name || "That picture"}” couldn't be opened. Try saving it as PNG or JPG.`); }
  let w = im.naturalWidth || 1200, h = im.naturalHeight || 900;
  const big = Math.max(w, h) > 4096, svg = /svg/.test(f.type);
  if (big || svg || f.size > 3e6) {
    const k = Math.min(1, 4096 / Math.max(w, h)); w = Math.round(w * k); h = Math.round(h * k);
    const cv = makeCanvas(w, h); cv.getContext("2d").drawImage(im, 0, 0, w, h);
    url = /jpe?g/.test(f.type) ? cv.toDataURL("image/jpeg", 0.92) : cv.toDataURL("image/png");
  }
  const asset = addAsset(url);
  const k = Math.min(1, state.size.w * 0.9 / w, state.size.h * 0.9 / h), pw = w * k, ph = h * k;
  const cx = at ? at[0] : state.size.w / 2, cy = at ? at[1] : state.size.h / 2;
  const lid = newId(doc, "l"), pid = newId(doc);
  commit({ type: "batch", events: [
    { type: "layer", op: "add", id: lid, name: fname || "Picture", above: activeLayer },
    { type: "add", piece: { kind: "image", source: "import", name: fname, asset, x: 0, y: 0, w: pw, h: ph, tf: translate(cx - pw / 2, cy - ph / 2), id: pid, layer: lid, clips: [], masks: [], erasers: [] } },
  ] });
  activeLayer = lid; sel = blankSel(); sel.ids.add(pid);
  renderLayers(); renderOptions(); requestRender(); $("hint").hidden = true;
  toast(`Added “${fname}” on its own layer. Drag it with the Move tool, or draw over it on another layer.`, 5000);
}

// ---------------------------------------------------------------- options bar
function optLabel(text, ...kids) { const l = el("label", { className: "opt" }); l.append(text, ...kids); return l; }
function slider(text, min, max, step, value, onInput, show = v => v) {
  const out = el("output", { textContent: show(value) });
  const inp = el("input", { type: "range", min, max, step, value });
  inp.oninput = () => { onInput(+inp.value); out.textContent = show(+inp.value); };
  inp.onchange = saveSettings;
  return optLabel(text, inp, out);
}
function seg(items, value, onPick) {
  const s = el("div", { className: "seg" });
  for (const [v, label] of items) { const b = el("button", { type: "button", textContent: label }); b.setAttribute("aria-pressed", String(v === value)); b.onclick = () => { onPick(v); saveSettings(); renderOptions(); }; s.append(b); }
  return s;
}
function check(text, value, onChange) { const i = el("input", { type: "checkbox", checked: value }); i.onchange = () => { onChange(i.checked); saveSettings(); }; return optLabel(i, " " + text); }
function swatchRow() {
  const s = el("div", { className: "sws" });
  for (const c of ["#1f2430", "#ffffff", "#8a8f99", "#d43d33", "#e5892a", "#f2c230", "#23935a", "#2563d6", "#7b4bc4", "#e56aa6", "#7a4a2a"]) {
    const b = el("button", { className: "sw", type: "button", title: c }); b.style.background = c; b.onclick = () => setColor("primary", c); s.append(b);
  }
  return s;
}
const hint = text => el("span", { className: "hintline", textContent: text });
const pct = v => Math.round(v * 100) + "%";
function renderOptions() {
  const o = $("options"); o.textContent = "";
  const t = settings.tool;
  if (t === "brush") {
    const b = settings.brushes[settings.brush];
    o.append(seg(Object.entries(settings.brushes).map(([k, v]) => [k, v.label]), settings.brush, v => { settings.brush = v; }));
    o.append(slider("Size", 1, 300, 1, b.size, v => { b.size = v; requestRender(); }));
    o.append(slider("Opacity", 0.05, 1, 0.05, b.opacity, v => { b.opacity = v; }, pct));
    if (b.mode === "dab") o.append(slider("Softness", 0, 1, 0.05, 1 - b.hardness, v => { b.hardness = 1 - v; }, pct));
    if (b.mode === "dab") o.append(slider("Flow", 0.02, 1, 0.02, b.flow, v => { b.flow = v; }, pct));
    o.append(slider("Smoothing", 0, 1, 0.05, b.smoothing, v => { b.smoothing = v; }, pct));
    o.append(check("Pen pressure: size", b.pressureSize, v => { b.pressureSize = v; }), check("opacity", b.pressureOpacity, v => { b.pressureOpacity = v; }));
    o.append(swatchRow(), hint("Alt-click picks a colour. [ and ] change size."));
  } else if (t === "eraser") {
    o.append(slider("Size", 2, 400, 1, settings.eraserSize, v => { settings.eraserSize = v; requestRender(); }), hint("Erases on the active layer only."));
  } else if (t === "move") {
    if (hasSelection()) {
      const n = sel.ids.size + sel.pending.length;
      o.append(el("span", { className: "opt", innerHTML: `<b>${n} selected</b>` }));
      const btn = (label, fn) => { const b = el("button", { className: "btn", type: "button", textContent: label }); b.onclick = fn; return b; };
      o.append(btn("Bring to front", () => { ensureCut(); commit({ type: "order", ids: [...sel.ids], dir: "front" }); }));
      o.append(btn("Send to back", () => { ensureCut(); commit({ type: "order", ids: [...sel.ids], dir: "back" }); }));
      const s = el("select"); s.append(el("option", { value: "", textContent: "Move to layer…" }));
      [...state.layers].reverse().forEach(L => s.append(el("option", { value: L.id, textContent: L.name })));
      s.onchange = () => { if (!s.value) return; ensureCut(); commit({ type: "setLayer", ids: [...sel.ids], layer: s.value }); setActiveLayer(s.value); renderOptions(); };
      o.append(optLabel("", s));
      o.append(btn("Duplicate", () => { copySelection(); pastePieces(); }), btn("Delete", deleteSelection), btn("Deselect", clearSelection));
      o.append(hint("Drag to move. Corner handles resize (Shift for free resize). Arrow keys nudge."));
    } else o.append(hint("Click anything to select it, Shift-click to add, or drag a box around things. Then drag to move or use the handles to resize."));
  } else if (t === "marquee") {
    o.append(seg([["rect", "Rectangle"], ["ellipse", "Ellipse"]], settings.marquee, v => { settings.marquee = v; }), hint("Drag over the active layer. Shift adds to the selection. Parts of photos or drawings inside are cut out when you move or delete them."));
  } else if (t === "lasso") {
    o.append(hint("Draw around what you want on the active layer. Shift adds. Then use Move (V) to drag it, or Delete to remove it."));
  } else if (t === "quick") {
    o.append(slider("Photo tolerance", 2, 120, 1, settings.wandTol, v => { settings.wandTol = v; }), hint("Click a drawing to grab the whole connected piece. Click a photo to select an area of similar colour. Shift adds."));
  } else if (t === "bucket") {
    o.append(slider("Tolerance", 0, 150, 1, settings.bucketTol, v => { settings.bucketTol = v; }), check("Use all layers to find edges", settings.bucketAll, v => { settings.bucketAll = v; }), swatchRow());
  } else if (t === "gradient") {
    o.append(seg([["linear", "Linear"], ["radial", "Radial"]], settings.gradType, v => { settings.gradType = v; }), hint("Drag from the main colour to the second colour. Fills the marquee or lasso area if there is one, otherwise the whole drawing."));
  } else if (t === "shape") {
    o.append(seg([["rect", "Rectangle"], ["ellipse", "Ellipse"], ["line", "Line"], ["arrow", "Arrow"]], settings.shape, v => { settings.shape = v; }));
    o.append(slider("Line", 0, 60, 1, settings.shapeWidth, v => { settings.shapeWidth = v; }));
    o.append(check("Fill with second colour", settings.shapeFill, v => { settings.shapeFill = v; }), swatchRow(), hint("Shift keeps it square, round or straight."));
  } else if (t === "text") {
    const f = el("select"); for (const [k, label] of [["sans", "Clear"], ["display", "Bold display"], ["hand", "Handwriting"], ["serif", "Serif"], ["mono", "Typewriter"]]) f.append(el("option", { value: k, textContent: label, selected: settings.font === k }));
    f.onchange = () => { settings.font = f.value; saveSettings(); };
    o.append(optLabel("Font", f), slider("Size", 8, 300, 1, settings.fontSize, v => { settings.fontSize = v; }));
    o.append(check("Bold", settings.bold, v => { settings.bold = v; }), check("Italic", settings.italic, v => { settings.italic = v; }), swatchRow(), hint("Click to type; click away or Ctrl+Enter to finish. Click existing text to edit it."));
  } else if (t === "eyedrop") o.append(hint("Click the drawing to pick that colour as your main colour."));
  else if (t === "point") o.append(hint("Press and drag to the thing you mean. With a mouse or pen you can also just rest on it for a moment while you talk."));
  else if (t === "hand") o.append(hint("Drag to move around. The mouse wheel zooms; Space or the middle button pans from any tool."));
  else if (t === "zoom") o.append(hint("Click to zoom in, Alt-click to zoom out. Ctrl+0 fits the drawing, Ctrl+1 shows it at 100%."));
}

// ---------------------------------------------------------------- layers panel
const EYE = '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const LOCK = '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></svg>';
function renderLayers() {
  const ol = $("layerList"); ol.textContent = "";
  for (const L of [...state.layers].reverse()) {
    const li = el("li", { className: "lrow" + (L.id === activeLayer ? " active" : "") });
    const eye = el("button", { className: "ib", type: "button", title: L.visible ? "Hide layer" : "Show layer", innerHTML: EYE });
    if (!L.visible) eye.firstChild.classList.add("off");
    eye.onclick = () => commit({ type: "layer", op: "visible", id: L.id, value: !L.visible });
    const name = el("span", { className: "name", textContent: L.name, title: "Click to use this layer; double-click to rename" });
    name.onclick = () => setActiveLayer(L.id);
    name.ondblclick = () => {
      const i = el("input", { value: L.name, maxLength: 40 }); name.textContent = ""; name.append(i); i.focus(); i.select();
      const done = ok => { const v = i.value.trim(); if (ok && v && v !== L.name) commit({ type: "layer", op: "rename", id: L.id, name: v }); else renderLayers(); };
      i.onkeydown = e => { e.stopPropagation(); if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); };
      i.onblur = () => done(true);
    };
    const lock = el("button", { className: "ib", type: "button", title: L.locked ? "Unlock layer" : "Lock layer", innerHTML: LOCK });
    if (!L.locked) lock.firstChild.classList.add("off");
    lock.onclick = () => commit({ type: "layer", op: "lock", id: L.id, value: !L.locked });
    li.append(eye, name, lock);
    if (L.id === activeLayer) {
      const row = el("div", { className: "opacity" });
      const out = el("output", { textContent: pct(L.opacity) });
      const r = el("input", { type: "range", min: 0, max: 1, step: 0.05, value: L.opacity });
      r.oninput = () => { L.opacity = +r.value; out.textContent = pct(L.opacity); requestRender(); };
      r.onchange = () => commit({ type: "layer", op: "opacity", id: L.id, value: +r.value });
      row.append("Opacity", r, out); li.append(row);
    }
    ol.append(li);
  }
}
function nextLayerName() { const n = state.layers.map(l => +(/^Layer (\d+)$/.exec(l.name)?.[1] || 0)); return `Layer ${Math.max(state.layers.length, ...n) + 1}`; }
$("layerAdd").onclick = () => { const id = newId(doc, "l"); commit({ type: "layer", op: "add", id, name: nextLayerName(), above: activeLayer }); activeLayer = id; renderLayers(); };
$("layerUp").onclick = () => commit({ type: "layer", op: "move", id: activeLayer, dir: 1 });
$("layerDown").onclick = () => commit({ type: "layer", op: "move", id: activeLayer, dir: -1 });
$("layerDel").onclick = () => { if (state.layers.length < 2) return toast("A drawing needs at least one layer."); commit({ type: "layer", op: "delete", id: activeLayer }); toast("Layer deleted. Ctrl+Z brings it back.", 2500); };

// ---------------------------------------------------------------- timeline panel
const PLAY = '<svg viewBox="0 0 12 12"><path d="M3 1.5l7.5 4.5L3 10.5z"/></svg>';
let tlTimer = null;
function renderTimelineSoon() { clearTimeout(tlTimer); tlTimer = setTimeout(renderTimeline, 120); }
function renderTimeline() {
  if (document.activeElement?.classList?.contains("txt")) return;
  const ol = $("timeline"); ol.textContent = "";
  if (!doc.speech.length) {
    ol.append(el("li", { className: "empty", innerHTML: "<b>Nothing yet.</b> Press <b>Start talking</b> (or R) and explain your idea while you draw. Your words show up here, lined up with what you draw. Press ▶ on a line to watch and hear that part again. Click a line to fix a word." }));
    return;
  }
  const changes = new Map();
  for (const m of buildMoments(doc)) for (const g of m.segs) changes.set(g, m);
  doc.speech.forEach(seg => {
    const li = el("li"); li.dataset.t = seg.t0;
    const play = el("button", { className: "play", type: "button", title: "Play back this part", innerHTML: PLAY });
    play.onclick = () => playSeg(seg);
    const time = el("time", { textContent: fmt(seg.t0) });
    const body = el("div"); body.style.minWidth = "0";
    const p = el("p", { className: "txt", textContent: seg.text, spellcheck: true }); p.contentEditable = "true";
    p.onblur = () => { const v = p.textContent.trim(); if (!v) { p.textContent = seg.text; return; } if (v !== seg.text) { seg.text = v; changed(); } };
    p.onkeydown = e => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); p.blur(); } };
    body.append(p);
    const meta = el("div", { className: "meta" }), m = changes.get(seg), n = m ? m.evs.filter(e => e.type !== "point").length : 0;
    if (n) meta.append(el("span", { className: "chip ink", textContent: `goes with ${n} change${n > 1 ? "s" : ""}` }));
    if (m && m.evs.some(e => e.type === "point")) meta.append(el("span", { className: "chip", textContent: "pointed" }));
    if (seg.src === "typed") meta.append(el("span", { className: "chip", textContent: "typed" }));
    if (meta.childNodes.length) body.append(meta);
    const del = el("button", { className: "del", type: "button", title: "Delete this line", textContent: "×" });
    del.setAttribute("aria-label", "Delete this line");
    del.onclick = () => { doc.speech.splice(doc.speech.indexOf(seg), 1); changed(); };
    li.append(play, time, body, del); ol.append(li);
  });
  if (!pb) ol.scrollTop = ol.scrollHeight;
}
function addSegment(seg) {
  let i = doc.speech.length; while (i > 0 && doc.speech[i - 1].t0 > seg.t0) i--;
  doc.speech.splice(i, 0, seg); changed();
}
$("noteForm").onsubmit = e => {
  e.preventDefault();
  const v = $("note").value.trim(); if (!v) return;
  speech.step(1500);   // while not talking, a note goes with what you draw next, not what came before
  const t = speech.now(); addSegment({ t0: t, t1: t, text: v, src: "typed" }); $("note").value = "";
  speech.step(3000);
};
$("title").oninput = () => { doc.title = $("title").value; changed(); };

// ---------------------------------------------------------------- playback
// Play starts at the line you pressed (the drawing so far is already shown). It stops when that line's
// drawing is done and before the next line's words, or with "Keep playing" on, it carries on to the end.
const sessionEnd = () => Math.max(speech.now(), ...doc.events.map(e => e.t1 ?? e.t0 ?? 0), ...doc.speech.map(s => s.t1));
function playSeg(seg) {
  const from = Math.max(0, seg.t0 - 300);
  if (settings.keepPlaying) return playRange(from, sessionEnd() + 500);
  const m = buildMoments(doc).find(m => m.segs.includes(seg));
  let to = Math.max(seg.t1, m && m.evs.length ? m.end : 0) + 400;
  const next = doc.speech.find(s => s.t0 > seg.t0);
  // A line's end time can run late (speech-to-text finishes it after the next one starts), so the next line's start wins.
  if (next) to = Math.min(to, Math.max(from + 1500, next.t0 - 150));
  playRange(from, to);
}
$("playAll").onclick = () => {
  const end = sessionEnd();
  if (end <= 0) return toast("Nothing to play yet. Press Start talking, then draw.");
  playRange(0, end + 500);
};
function paintKeepPlaying() {
  const b = $("keepPlaying");
  b.setAttribute("aria-pressed", String(!!settings.keepPlaying));
  b.title = settings.keepPlaying ? "Keep playing is on: ▶ on a line plays from there to the end. Click to turn off." : "Keep playing is off: ▶ on a line plays just that line. Click to play on from there to the end.";
}
$("keepPlaying").onclick = () => { settings.keepPlaying = !settings.keepPlaying; saveSettings(); paintKeepPlaying(); toast(settings.keepPlaying ? "Keep playing on: ▶ plays from that line to the end." : "Keep playing off: ▶ plays just that line.", 2500); };
paintKeepPlaying();
function playRange(from, to) {
  stopPlayback();
  if (speech.isRunning()) { toast("Stop talking first, then play it back."); return; }
  if (editing) commitText();
  const st = initialState(doc);
  for (const ev of doc.events) if ((ev.t0 ?? 0) < from) apply(st, ev);
  const queue = doc.events.filter(ev => (ev.t0 ?? 0) >= from).sort((a, b) => (a.t0 ?? 0) - (b.t0 ?? 0));
  pb = { from, to, st, queue, qi: 0, pending: [], marks: [], comp: renderComposite(st, doc, { paper: false }), wall: performance.now(), T: from, audios: [] };
  for (const a of doc.audio) if (audioBlobs.has(a.id) && a.t0 < to && a.t0 + a.dur > from) {
    const url = URL.createObjectURL(audioBlobs.get(a.id));
    pb.audios.push({ a, url, au: new Audio(url), started: false });
  }
  $("playbar").hidden = false; $("hint").hidden = true;
  tickPlayback();
}
function tickPlayback() {
  if (!pb) return;
  const T = pb.from + (performance.now() - pb.wall);
  pb.T = T;
  for (const x of pb.audios) if (!x.started && T >= x.a.t0) {   // each stretch of talking starts when the playhead reaches it
    x.started = true;
    const off = (T - x.a.t0) / 1000;
    if (off < x.a.dur / 1000) { x.au.currentTime = off; x.au.play().catch(() => {}); }
  }
  let dirtyComp = false;
  // Strokes still being drawn are finished before anything that happened after them.
  const flush = limit => { pb.pending = pb.pending.filter(ev => { if ((ev.t1 ?? 0) <= limit) { apply(pb.st, ev); dirtyComp = true; return false; } return true; }); };
  while (pb.qi < pb.queue.length && (pb.queue[pb.qi].t0 ?? 0) <= T) {
    const ev = pb.queue[pb.qi++];
    flush(ev.t0 ?? 0);
    if (ev.type === "add" && ev.piece.kind === "stroke" && (ev.t1 ?? 0) > T) pb.pending.push(ev);
    else if (ev.type === "point") pb.marks.push(ev);
    else { apply(pb.st, ev); dirtyComp = true; }
  }
  flush(T);
  if (dirtyComp) pb.comp = renderComposite(pb.st, doc, { paper: false });
  $("playTime").textContent = `${fmt(T)} / ${fmt(pb.to)}`;
  $("playProg").value = clamp((T - pb.from) / Math.max(1, pb.to - pb.from), 0, 1);
  document.querySelectorAll("#timeline li[data-t]").forEach(li => li.classList.toggle("playing", +li.dataset.t <= T && +li.dataset.t >= pb.from));
  requestRender();
  if (T >= pb.to) { stopPlayback(); return; }
  pb.raf = requestAnimationFrame(tickPlayback);
}
function drawPlayback(c) {
  c.drawImage(pb.comp, 0, 0);
  for (const ev of pb.pending) { const L = pb.st.layers.find(l => l.id === ev.piece.layer); if (!L || L.visible) renderPiece(c, ev.piece, doc, pb.st.size, { limitT: pb.T, alpha: L?.opacity ?? 1 }); }
  for (const ev of pb.marks) { const age = pb.T - (ev.t1 ?? ev.t0); if (age < 1600) { c.save(); c.globalAlpha = 1 - age / 1600; drawPointing(c, ev.pts.filter(q => q[3] === undefined || q[3] <= pb.T)); c.restore(); } }
}
function stopPlayback() {
  if (!pb) return;
  cancelAnimationFrame(pb.raf);
  for (const x of pb.audios) { x.au.pause(); URL.revokeObjectURL(x.url); }
  pb = null; $("playbar").hidden = true;
  document.querySelectorAll("#timeline li.playing").forEach(li => li.classList.remove("playing"));
  requestRender();
}
$("playStop").onclick = stopPlayback;

// ---------------------------------------------------------------- talking
const recBtn = $("rec"), micPill = $("mic");
let tickTimer = null;
function setMic(s) {
  const map = { off: ["Mic off", ""], on: ["Listening", "live"], blocked: ["Mic blocked", "warn"], none: ["No speech-to-text here", "warn"], error: ["Speech-to-text stopped", "warn"] };
  const [label, cls] = map[s]; micPill.textContent = label; micPill.className = "pill " + cls;
}
function startRec() {
  if (pb) stopPlayback();
  const target = doc, blobs = audioBlobs;   // late words or audio only ever go to the sketch they were recorded for
  speech.start({
    onSegment: s => { if (doc === target) addSegment(s); },
    onInterim: t => { $("interim").textContent = t ? t + " …" : ""; },
    onMic: setMic,
    onToast: toast,
    onAudio: ({ t0, dur, blob }) => { if (doc !== target) return; const id = newId(doc, "a"); doc.audio.push({ id, t0, dur, type: blob.type }); blobs.set(id, blob); changed(); },
  });
  recBtn.classList.add("on"); $("recLabel").textContent = "Stop";
  clearInterval(tickTimer); tickTimer = setInterval(() => { $("clock").textContent = fmt(speech.now()); }, 250);
}
function stopRec() {
  const done = speech.stop(); clearInterval(tickTimer);
  recBtn.classList.remove("on"); $("recLabel").textContent = "Start talking"; $("clock").textContent = fmt(speech.now());
  return done;
}
recBtn.onclick = () => speech.isRunning() ? stopRec() : startRec();

// ---------------------------------------------------------------- page size, paper, theme
const SIZES = [["Wide", 2000, 1250], ["HD 16:9", 1920, 1080], ["Square", 1600, 1600], ["Phone", 1080, 1920], ["A4 portrait", 1240, 1754], ["A4 landscape", 1754, 1240], ["Letter", 1275, 1650]];
let pagePaper = "white";
$("pageBtn").onclick = () => {
  const box = $("sizePresets"); box.textContent = "";
  for (const [label, w, h] of SIZES) {
    const b = el("button", { type: "button", textContent: `${label} ${w}×${h}` });
    b.setAttribute("aria-pressed", String(w === state.size.w && h === state.size.h));
    b.onclick = () => { $("pageW").value = w; $("pageH").value = h; box.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); };
    box.append(b);
  }
  $("pageW").value = state.size.w; $("pageH").value = state.size.h; $("pageGrid").checked = !!doc.grid;
  pagePaper = doc.paper; paintPaperSeg();
  $("pageDlg").hidden = false; $("pageW").focus();
};
function paintPaperSeg() { document.querySelectorAll("#paperSeg button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.paper === pagePaper))); }
document.querySelectorAll("#paperSeg button").forEach(b => b.onclick = () => { pagePaper = b.dataset.paper; paintPaperSeg(); });
$("pageCancel").onclick = () => { $("pageDlg").hidden = true; };
$("pageDlg").addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") $("pageDlg").hidden = true; });
$("pageForm").onsubmit = e => {
  e.preventDefault();
  const w = clamp(Math.round(+$("pageW").value || state.size.w), 100, 4096), h = clamp(Math.round(+$("pageH").value || state.size.h), 100, 4096);
  if (w !== state.size.w || h !== state.size.h) commit({ type: "canvas", w, h, anchor: $("pageCenter").checked ? "center" : "topleft" });
  if (pagePaper !== doc.paper) {
    const wasDark = doc.paper === "dark"; doc.paper = pagePaper;
    if (pagePaper === "dark" && !wasDark && settings.primary === "#1f2430") setColor("primary", "#f4f6fa");
    if (pagePaper !== "dark" && wasDark && settings.primary === "#f4f6fa") setColor("primary", "#1f2430");
  }
  doc.grid = $("pageGrid").checked;
  $("pageDlg").hidden = true; changed(); requestRender(); updateZoomLabel();
};
function applyTheme() {
  const t = settings.theme;
  if (t === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  $("theme").textContent = { auto: "Auto", light: "Light", dark: "Dark" }[t];
  $("theme").title = `Theme: ${{ auto: "follows Windows", light: "light", dark: "dark" }[t]}. Click to change.`;
}
$("theme").onclick = () => { settings.theme = { auto: "light", light: "dark", dark: "auto" }[settings.theme]; saveSettings(); applyTheme(); };

// ---------------------------------------------------------------- drafts in this browser (IndexedDB)
const idb = () => new Promise((res, rej) => { const r = indexedDB.open("sketchtalk", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function idbDo(mode, fn) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction("kv", mode), st = tx.objectStore("kv"), req = fn(st); tx.oncomplete = () => res(req?.result); tx.onerror = () => rej(tx.error); }); }
let draftTimer, restorePending = false;   // while the "pick it up" question is open, the old draft is kept safe
function changed() {
  dirty = true; renderTimelineSoon();
  clearTimeout(draftTimer); if (!restorePending) draftTimer = setTimeout(saveDraft, 1200);
}
async function saveDraft() {
  try { await idbDo("readwrite", st => st.put({ doc, clock: speech.now(), audio: [...audioBlobs], activeLayer }, "draft")); } catch (_) {}
}
async function offerRestore() {
  let d = null, updated = false;
  try { updated = sessionStorage.getItem(RELOAD_KEY) === "1"; sessionStorage.removeItem(RELOAD_KEY); } catch (_) {}
  try { d = await idbDo("readonly", st => st.get("draft")); } catch (_) {}
  const has = d && d.doc && (d.doc.events.length || d.doc.speech.length);
  if (updated) {   // reloaded for a new version: put the sketch straight back, no question
    if (has) await loadDraft(d);
    toast(has ? "Updated to the latest version. Your sketch is just as you left it." : "Updated to the latest version.", 4000);
    return;
  }
  if (!has) return;
  const when = new Date(d.doc.created).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" });
  $("restoreText").textContent = `You have a sketch from ${when}${d.doc.title ? ` (“${d.doc.title}”)` : ""} that you can pick up again. Picking it up replaces anything drawn since this page opened.`;
  $("restore").hidden = false; restorePending = true;
  $("restoreYes").onclick = async () => { $("restore").hidden = true; restorePending = false; await loadDraft(d); };
  $("restoreNo").onclick = async () => {
    $("restore").hidden = true; restorePending = false;
    try { await idbDo("readwrite", st => st.delete("draft")); } catch (_) {}
    if (hasContent()) saveDraft();
  };
}
async function loadDraft(d) {
  if (speech.isRunning()) await stopRec();
  stopPlayback(); if (editing) commitText();
  doc = d.doc; speech.setClock(d.clock || 0); audioBlobs = new Map(d.audio || []); activeLayer = d.activeLayer || "l0";
  redoStack = []; maskData.clear();
  forgetImages(); await preloadAssets(doc);
  rebuild(); fit(); renderTimeline();
  $("title").value = doc.title || ""; $("clock").textContent = fmt(speech.now()); $("hint").hidden = true;
  dirty = false;
}
armed($("new"), "Sure? Tap again", async () => {
  if (speech.isRunning()) await stopRec();
  stopPlayback(); if (editing) commitText();
  doc = newDoc(); audioBlobs = new Map(); redoStack = []; activeLayer = "l0"; speech.setClock(0); forgetImages(); maskData.clear();
  restorePending = false; $("restore").hidden = true;
  try { await idbDo("readwrite", st => st.delete("draft")); } catch (_) {}
  rebuild(); fit(); renderTimeline();
  $("title").value = ""; $("clock").textContent = "00:00"; $("hint").hidden = false; dirty = false;
  toast("New session started.");
});
window.addEventListener("beforeunload", e => { if (reloading) return; if (dirty && hasContent()) { saveDraft(); e.preventDefault(); e.returnValue = ""; } });

// When Claude finishes an update, the open window reloads itself and keeps the sketch. It waits while
// you're talking, drawing, typing text, playing back, or answering a question on screen.
const RELOAD_KEY = "sketchcollab.reloading";
let appVersion = null, reloading = false, updateWaiting = false;
async function checkForUpdate() {
  if (!server || reloading) return;
  let v;
  try { v = (await (await fetch("/api/version", { cache: "no-store" })).json()).version; } catch (_) { return; }
  if (appVersion === null) { appVersion = v; return; }
  if (v === appVersion) return;
  const busy = speech.isRunning() || gesture || live || editing || pb || restorePending || !$("pageDlg").hidden || $("save").disabled;
  if (busy) {
    if (!updateWaiting) { updateWaiting = true; toast("A new version of SketchCollab is ready. It loads as soon as you finish what you're doing.", 6000); }
    return;
  }
  reloading = true;
  clearTimeout(draftTimer);
  try { if (hasContent()) await saveDraft(); else await idbDo("readwrite", st => st.delete("draft")); } catch (_) {}
  try { sessionStorage.setItem(RELOAD_KEY, "1"); } catch (_) {}
  location.reload();
}
setInterval(checkForUpdate, 2000);

// ---------------------------------------------------------------- save, send, copy
let server = null;
async function checkServer() {
  try { const r = await fetch("/api/ping", { cache: "no-store" }); if (r.ok) { server = await r.json(); $("saveHint").textContent = `Saves go to ${server.folder}`; return; } } catch (_) {}
  $("saveHint").textContent = "Opened without start.bat, so Save downloads the files instead, and Send to Claude isn't available.";
}
const hasContent = () => doc.events.length > 0 || doc.speech.length > 0;
async function settle() {
  if (editing) commitText();
  if (speech.isRunning()) { await stopRec(); await sleep(500); }   // the last words can arrive just after
  stopPlayback();
  try { await document.fonts.ready; } catch (_) {}
  await preloadAssets(doc);
}
function sessionName() {
  const d = new Date(doc.created);
  const slug = (doc.title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}${slug ? "_" + slug : ""}`;
}
const b64 = c => c.toDataURL("image/png").split(",")[1];
const blobB64 = blob => new Promise(res => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.readAsDataURL(blob); });
const extOf = dataUrl => /^data:image\/jpe?g/.test(dataUrl) ? "jpg" : /^data:image\/webp/.test(dataUrl) ? "webp" : /^data:image\/gif/.test(dataUrl) ? "gif" : "png";
function usedAssets() {
  const used = new Set();
  const visit = ev => {
    if (ev.type === "batch") ev.events.forEach(visit);
    const ps = ev.type === "add" ? [ev.piece] : ev.type === "addMany" ? ev.pieces : [];
    for (const p of ps) { if (p.asset) used.add(p.asset); for (const c of [...(p.clips || []), ...(p.masks || [])]) if (c.asset) used.add(c.asset); }
    if (ev.type === "cut") ev.cuts.forEach(c => { if (c.clip.asset) used.add(c.clip.asset); });
  };
  doc.events.forEach(visit);
  return [...used].filter(id => doc.assets[id]);
}
async function exportSession(send) {
  if (!hasContent()) return toast("Draw or say something first.");
  if (send && !server) return toast("Send to Claude needs the app opened with start.bat (the desktop shortcut).", 7000);
  const buttons = [$("save"), $("send")]; buttons.forEach(b => b.disabled = true);
  const label = send ? $("send") : $("save"), old = label.textContent; label.textContent = send ? "Sending…" : "Saving…";
  try {
    await settle();
    const len = speech.now(), moments = buildMoments(doc), imgs = moments.map((m, i) => momentCanvas(doc, m, i + 1, moments.length));
    const story = storyboardCanvas(doc, state, moments, imgs, len), name = sessionName();
    if (!server) {
      download(`${name}_storyboard.png`, story.toDataURL("image/png"));
      download(`${name}_transcript.md`, "data:text/markdown;charset=utf-8," + encodeURIComponent(wordsText(doc, state, moments, len, false)));
      toast("Downloaded the storyboard picture and the notes. Attach them in your chat with Claude.", 8000);
      dirty = false; return;
    }
    const files = [{ path: "transcript.md", text: wordsText(doc, state, moments, len, true) }];
    files.push({ path: "final.png", base64: b64(renderComposite(state, doc)) }, { path: "storyboard.png", base64: b64(story) });
    imgs.forEach((c, i) => files.push({ path: `moments/${pad2(i + 1)}.png`, base64: b64(c) }));
    state.layers.forEach((L, i) => { const cv = makeCanvas(state.size.w, state.size.h); renderLayer(cv.getContext("2d"), state, L.id, doc); files.push({ path: `layers/${pad2(i + 1)}.png`, base64: b64(cv) }); });
    const assets = {};
    for (const id of usedAssets()) { const url = doc.assets[id], path = `assets/${id}.${extOf(url)}`; assets[id] = path; files.push({ path, base64: url.split(",")[1] }); }
    const audio = [];
    for (const a of doc.audio) { const blob = audioBlobs.get(a.id); if (!blob) continue; const path = `audio/${a.id}.${/mp4/.test(a.type) ? "m4a" : "webm"}`; audio.push({ ...a, file: path }); files.push({ path, base64: await blobB64(blob) }); }
    const meta = { ...doc, assets, audio, length_ms: len, layers: state.layers.map((L, i) => ({ ...L, file: `layers/${pad2(i + 1)}.png`, pieces: state.order[L.id].length })), size: state.size };
    files.push({ path: "session.json", text: JSON.stringify(meta) });
    const r = await fetch("/api/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, files, send: !!send }) });
    const res = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(res.error || "the save was refused");
    dirty = false;
    toast(send ? "Sent to Claude. If your chat with Claude is open, it picks this up in a few seconds." : `Saved to ${res.folder}.`, 8000);
  } catch (e) {
    toast("Couldn't save: " + e.message + ". Is the SketchCollab window from start.bat still open?", 9000);
  } finally { buttons.forEach(b => b.disabled = false); label.textContent = old; }
}
function download(name, href) { const a = el("a", { href, download: name }); document.body.append(a); a.click(); a.remove(); }
$("save").onclick = () => exportSession(false);
$("send").onclick = () => exportSession(true);
$("copyPic").onclick = async () => {
  if (!hasContent()) return toast("Draw or say something first.");
  try {
    await settle();
    const moments = buildMoments(doc), imgs = moments.map((m, i) => momentCanvas(doc, m, i + 1, moments.length));
    const blob = await new Promise(r => storyboardCanvas(doc, state, moments, imgs, speech.now()).toBlob(r, "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    toast("Picture copied. Paste it into your chat with Claude, then use Copy words too.");
  } catch (_) { toast("Couldn't copy the picture here. Use Save instead."); }
};
$("copyWords").onclick = async () => {
  if (!hasContent()) return toast("Draw or say something first.");
  await settle();
  try { await navigator.clipboard.writeText(wordsText(doc, state, buildMoments(doc), speech.now(), false)); toast("Words copied. Paste them into your chat with Claude."); }
  catch (_) { toast("Couldn't copy here. Use Save instead."); }
};

// ---------------------------------------------------------------- start
buildToolbar(); applyTheme();
document.querySelectorAll(".tool[data-tool]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.tool === settings.tool)));
setMic(speech.hasSpeech ? "off" : "none");
rebuild(); renderTimeline(); updateCursor(); offerRestore(); checkServer();
document.fonts?.ready.then(() => { redrawAll(); });

// For testing from the browser console.
window.SketchCollab = { get doc() { return doc; }, get state() { return state; }, commit, undo, redo, buildMoments, setTool, get sel() { return sel; }, momentCanvas, wordsText, storyboardCanvas, exportSession, addSegment, fit, get view() { return V; } };
