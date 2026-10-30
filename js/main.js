// SketchCollab: the app. Tools, the canvas view, layers, the timeline, playback, saving.

import { $, I, mul, applyM, inv, translate, scaleAbout, scaleOf, makeCanvas, boxOfPoints, unionBox, padBox, interBox, boxesTouch, transformBox, pointInPoly, ellipsePoly, fmt, hexToRgb, rgbToHex, sleep, clamp } from "./util.js";
import { newDoc, newId, initialState, apply, replay, docBox, hitTest, samplePoints, toLocal } from "./doc.js";
import { BRUSHES, FONTS, fontCss, paperColor, getImage, preloadAssets, forgetImages, setImageReadyHandler, renderPiece, renderLayer, renderComposite, drawGrid, drawEraserPts, drawShape, drawPointing, measureText } from "./render.js";
import { OneEuro, SpeedPressure, drawInk, tidy, detectShape, shapePoints } from "./ink.js";
import { TeamLink, throttle } from "./team.js";
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
  help: "light", feel: "normal", penSeen: false,   // Drawing help level; pen pressure feel (shown once a pen is used)
};
const settings = loadSettings();
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (s) {
      const brushes = {};
      for (const k in defaults.brushes) brushes[k] = { ...defaults.brushes[k], ...(s.brushes?.[k] || {}), mode: defaults.brushes[k].mode, label: defaults.brushes[k].label, blend: defaults.brushes[k].blend, taper: defaults.brushes[k].taper, thin: defaults.brushes[k].thin };
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
// Pages: each tab can have several, and everyone looks at one at a time (in a team, each person their own).
let curPage = "pg0";
const onPage = L => (L.page || "pg0") === curPage;
const shown = L => L.visible && onPage(L);
const pageLayers = () => state.layers.filter(onPage);
const pad2 = n => String(n).padStart(2, "0");

// ---------------------------------------------------------------- view
const vp = $("viewport"), view = $("view"), vctx = view.getContext("2d", { desynchronized: true });   // asks for a low-latency canvas (a hint)
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

// While you draw, only the area around the line (and the brush circle) is redrawn each frame.
let raf = 0, fullFrame = true, liveDirty = false, lastCursorBox = null;
function requestRender() { fullFrame = true; if (!raf) raf = requestAnimationFrame(draw); }
function requestLive() { liveDirty = true; if (!raf) raf = requestAnimationFrame(draw); }
function cursorBox() {
  if (!hoverPos || pb || spaceDown || (settings.tool !== "brush" && settings.tool !== "eraser")) return null;
  const r = (settings.tool === "eraser" ? settings.eraserSize : settings.brushes[settings.brush].size) / 2 + 3 / V.z;
  return { x0: hoverPos[0] - r, y0: hoverPos[1] - r, x1: hoverPos[0] + r, y1: hoverPos[1] + r };
}
function draw() {
  raf = 0;
  if (Math.abs(vp.clientWidth - V.w) > 1 || Math.abs(vp.clientHeight - V.h) > 1) { resizeView(); return; }   // a missed resize
  let clip = null;
  if (liveDirty) { liveDirty = false; const box = live ? renderLive() : null; if (!fullFrame) clip = box; }
  if (!fullFrame && !clip) return;
  const cb = cursorBox();
  if (clip) clip = unionBox(clip, unionBox(cb, lastCursorBox));
  lastCursorBox = cb; fullFrame = false;
  const c = vctx, d = V.dpr, { w, h } = state.size;
  c.setTransform(1, 0, 0, 1, 0, 0);
  if (clip) {
    const x0 = Math.floor((clip.x0 * V.z + V.x) * d) - 2, y0 = Math.floor((clip.y0 * V.z + V.y) * d) - 2;
    const x1 = Math.ceil((clip.x1 * V.z + V.x) * d) + 2, y1 = Math.ceil((clip.y1 * V.z + V.y) * d) + 2;
    c.save(); c.beginPath(); c.rect(x0, y0, x1 - x0, y1 - y0); c.clip(); c.clearRect(x0, y0, x1 - x0, y1 - y0);
  } else c.clearRect(0, 0, view.width, view.height);
  c.setTransform(d * V.z, 0, 0, d * V.z, d * V.x, d * V.y);
  c.save(); c.shadowColor = "rgba(0,0,0,.28)"; c.shadowBlur = 18; c.shadowOffsetY = 3;
  c.fillStyle = paperColor(doc); c.fillRect(0, 0, w, h); c.restore();
  c.save(); c.beginPath(); c.rect(0, 0, w, h); c.clip();
  if (doc.grid) drawGrid(c, doc, state.size, V.z);
  c.imageSmoothingEnabled = true; c.imageSmoothingQuality = V.z < 1 ? "high" : "low";
  if (pb) drawPlayback(c);
  else {
    for (const L of state.layers) {
      if (!shown(L)) continue;
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
    if (team) for (const lv of team.lives.values()) if (lv.props && lv.pts.length && (lv.page || "pg0") === curPage) drawInk(c, lv.props, lv.pts, false);   // others' lines as they draw them, on this page
  }
  c.restore();
  drawOverlay(c);
  if (clip) c.restore();
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
  ev.page ||= curPage;
  if (team) { ev.id ||= newId(doc, "e"); ev.who = team.id; ev.by = team.name; }
  doc.events.push(ev);
  if (ev.type !== "point") { redoStack = []; speech.step(1000); }   // while not talking, each action moves the clock on a little
  afterApply(apply(state, ev));
  if (team) teamSendEvent(ev);
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
  if (res.layersChanged) { fixPage(); renderLayers(); renderPages(); }
  pruneSelection(); updateZoomLabel(); requestRender();
}
function rebuild() {
  state = replay(doc);
  fixPage();
  sel = blankSel(); hiddenIds = null; floating = null;
  redrawAll(); renderLayers(); renderPages(); renderOptions(); updateZoomLabel();
}
// The page shown still exists and the active layer is on it (after an undo, a page deleted by someone else, a reload).
function fixPage() {
  if (!state.pages.some(p => p.id === curPage)) curPage = state.pages[0].id;
  if (!state.order[activeLayer] || !onPage(layerOf(activeLayer))) activeLayer = pageLayers().at(-1)?.id || state.layers.at(-1).id;
}
// In a team session, undo only takes back your own changes.
const mine = e => !team || (e.who ?? "h") === team.id;
function undo() {
  if (pb) stopPlayback();
  interruptGesture();
  for (let i = doc.events.length - 1; i >= 0; i--) {
    const e = doc.events[i];
    if (e.type === "point" || e.build || !mine(e)) continue;   // a review's pictures from the agent stay
    redoStack.push(doc.events.splice(i, 1)[0]); rebuild(); changed();
    if (team) { team.pending.delete(e.id); team.link.send({ t: "remove", id: e.id }); }
    return;
  }
  if (team) toast("Nothing of yours left to undo.", 1800);
}
function redo() {
  if (pb) stopPlayback();
  interruptGesture();
  const ev = redoStack.pop(); if (!ev) return;
  doc.events.push(ev); afterApply(apply(state, ev));
  if (team) teamSendEvent(ev);
  changed();
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
    if (!L || !shown(L) || L.locked) continue;
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
// Smoothing runs on screen pixels, so it feels the same at any zoom. Points are stored in drawing units as
// [x, y, pressure, session time, ms since the line started].
const r1 = v => Math.round(v * 10) / 10;
const HOLD_MS = 550, HOLD_STILL = 3, HOLD_ESCAPE = 12;   // hold still this long (screen px) to snap; move this far to undo it
function startLive(props, c) {
  stopLive();
  ensureLayerCanvases();
  const x = liveCanvas.getContext("2d"); x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
  live = {
    layer: activeLayer, props, pts: [], filter: new OneEuro(props.smoothing), speed: new SpeedPressure(),
    ts0: c.ts, lastTs: c.ts, handled: performance.now(), raw: { sx: c.sx, sy: c.sy, pr: c.pressure, t: c.t }, lastS: null, predicted: [],
    anchor: { sx: c.sx, sy: c.sy, ms: performance.now() }, screenLen: 0, held: null, lastBox: null,
  };
  pushInk(c.sx, c.sy, c.pressure, c.ts, c.t);
  requestLive(); requestAnimationFrame(liveLoop);
  live.timer = setInterval(liveTick, 50);   // also checks for a hold when frames are slow
}
function pushInk(sx, sy, pr, ts, t) {
  const L = live;
  ts = Math.max(ts, L.pushTs ?? ts); L.pushTs = ts;   // the filters need time to only move forward
  const f = L.filter.next(sx, sy, ts);
  const p = L.props.pen ? pr : L.props.thin && L.props.pressureSize ? L.speed.next(sx, sy, ts) : 0.5;
  if (L.lastS && Math.hypot(f.x - L.lastS.x, f.y - L.lastS.y) < 0.5) return false;
  L.lastS = { x: f.x, y: f.y };
  L.pts.push([r1((f.x - V.x) / V.z), r1((f.y - V.y) / V.z), Math.round(p * 100) / 100, t, Math.round(ts - L.ts0)]);
  return true;
}
function liveAdd(c) {
  const L = live;
  L.screenLen += Math.hypot(c.sx - L.raw.sx, c.sy - L.raw.sy);
  L.raw = { sx: c.sx, sy: c.sy, pr: c.pressure, t: c.t }; L.lastTs = Math.max(L.lastTs, c.ts); L.handled = performance.now();
  pushInk(c.sx, c.sy, c.pressure, L.lastTs, c.t);
  if (L.held) {   // moved on: keep the line as drawn, and start timing a new hold from here
    if (Math.hypot(c.sx - L.held.sx, c.sy - L.held.sy) > HOLD_ESCAPE) { L.held = null; L.anchor = { sx: c.sx, sy: c.sy, ms: performance.now() }; }
  }
  else if (Math.hypot(c.sx - L.anchor.sx, c.sy - L.anchor.sy) > HOLD_STILL) L.anchor = { sx: c.sx, sy: c.sy, ms: performance.now() };
  requestLive();
  if (team) sendLive();
}
// Every frame while drawing: let the line catch up when the pen pauses, and snap after a hold.
function liveLoop() {
  if (!live) return;
  liveTick();
  requestAnimationFrame(liveLoop);
}
function liveTick() {
  const L = live; if (!L) return;
  const now = performance.now();
  // The pen has paused: let the line catch up. Timed from the last event handled, on the events' own clock.
  if (now - L.handled > 25) {
    L.predicted = [];
    const ts = L.lastTs + Math.max(0, now - L.handled - 16);   // a little behind, so the next real event is never "older"
    if (pushInk(L.raw.sx, L.raw.sy, L.raw.pr, ts, speech.now())) requestLive();
  }
  if (!L.held && settings.help !== "off" && now - L.anchor.ms > HOLD_MS && L.screenLen > 30) {
    const shape = detectShape(L.pts);
    if (shape) {
      L.held = { sx: L.raw.sx, sy: L.raw.sy, shape, pts: shapePoints(shape, L.pts, Math.max(0.8, 2 / V.z), L.props.pen) };
      toast(`Snapped to ${shape.name}. Move on before you lift to keep your own line.`, 2200);
      requestLive();
    } else L.anchor.ms = Infinity;   // nothing to snap to: don't keep checking until the pen moves again
  }
}
// Draw the line so far onto the live layer. Returns the area that changed, for a partial redraw.
function renderLive() {
  const L = live, x = liveCanvas.getContext("2d");
  x.setTransform(1, 0, 0, 1, 0, 0);
  if (L.lastBox) x.clearRect(Math.floor(L.lastBox.x0), Math.floor(L.lastBox.y0), Math.ceil(L.lastBox.x1 - L.lastBox.x0) + 2, Math.ceil(L.lastBox.y1 - L.lastBox.y0) + 2);
  let pts = L.held ? L.held.pts : L.pts;
  if (!L.held && L.predicted.length) pts = pts.concat(L.predicted);
  if (!pts.length) return L.lastBox;
  const props = L.held && L.held.shape.closed ? { ...L.props, taper: false } : L.props;
  drawInk(x, props, pts, false);
  const b = padBox(boxOfPoints(pts), L.props.size * 1.2 + 3);
  const changed = unionBox(b, L.lastBox); L.lastBox = b;
  return changed;
}
// End the line where the pen is now, as if it had been lifted.
function finishLive() {
  const L = live; if (!L) return;
  endLive({ sx: L.raw.sx, sy: L.raw.sy, x: (L.raw.sx - V.x) / V.z, y: (L.raw.sy - V.y) / V.z, t: speech.now(), ts: L.lastTs });
}
function stopLive() {
  if (live) { clearInterval(live.timer); if (team && live.sentProps) team.link.send({ t: "liveEnd" }, false); }
  live = null;
  liveCanvas?.getContext("2d").clearRect(0, 0, liveCanvas.width, liveCanvas.height);
}
function endLive(c) {
  const L = live;
  // Catch up to where the pen actually stopped, like Photoshop's "catch-up on stroke end".
  if (L.lastS && !L.held) {
    const dx = c.sx - L.lastS.x, dy = c.sy - L.lastS.y;
    if (Math.hypot(dx, dy) > 0.5) for (let k = 1; k <= 4; k++) {
      const pr = L.pts.length ? L.pts[L.pts.length - 1][2] : 0.5;
      L.pts.push([r1((L.lastS.x + dx * k / 4 - V.x) / V.z), r1((L.lastS.y + dy * k / 4 - V.y) / V.z), pr, c.t, Math.round(c.ts - L.ts0)]);
    }
  }
  let pts = L.pts, props = L.props;
  if (L.held) { pts = L.held.pts; props = { ...props, snapped: L.held.shape.name, ...(L.held.shape.closed ? { taper: false } : {}) }; }
  else if (settings.help === "strong" && pts.length > 3) pts = tidy(pts, 6 / V.z);   // Strong help: smooth out the last wobbles
  stopLive();
  if (!pts.length) return requestRender();
  commit({ type: "add", piece: { ...props, id: newId(doc), layer: L.layer, pts, tf: [...I], clips: [], masks: [], erasers: [] }, t0: pts[0][3], t1: speech.now() });
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
  // The pipette from Lucide (lucide.dev, ISC licence): a squeeze bulb, a collar and a thin glass tube.
  eyedrop: '<path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/>',
  point: '<path d="M5 3l14 8-6 2-2 6z"/>',
  hand: '<path d="M8 12.5V6a1.5 1.5 0 013 0v5V4.5a1.5 1.5 0 013 0V11V6a1.5 1.5 0 013 0v7.5c0 4-2.7 6.5-6 6.5-2.5 0-4-1-5.6-3.4L4.1 13.9a1.5 1.5 0 012.4-1.8z"/>',
  zoom: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M8 10.5h5M10.5 8v5"/>',
  import: '<rect x="3" y="5" width="15" height="13" rx="2"/><circle cx="8" cy="10" r="1.6"/><path d="M18 14l-4-4-7 8"/><path d="M19 2v6M16 5h6"/>',
};
// The tools come in groups, each with a short name above it ("group" entries).
const TOOLS = [
  { group: "Select" },
  { id: "move", key: "v", label: "Move and select (V)" },
  { id: "marquee", key: "m", label: "Marquee select, rectangle or ellipse (M)" },
  { id: "lasso", key: "l", label: "Lasso select (L)" },
  { id: "quick", key: "w", label: "Quick select: grab a whole drawing, or a colour area of a photo (W)" },
  { group: "Draw and paint" },
  { id: "brush", key: "b", label: "Brush and pencil (B)" },
  { id: "eraser", key: "e", label: "Eraser (E)" },
  { id: "bucket", key: "g", label: "Paint bucket (G)" },
  { id: "gradient", key: "G", label: "Gradient (Shift+G)" },
  { id: "shape", key: "u", label: "Shapes: rectangle, ellipse, line, arrow (U)" },
  { id: "text", key: "t", label: "Text (T)" },
  { id: "eyedrop", key: "i", label: "Eyedropper: pick a colour from the drawing (I)" },
  { group: "Point and view" },
  { id: "point", key: "p", label: "Point: press and drag to show what you mean. With a mouse or pen, resting on something while you talk also points (P)" },
  { id: "hand", key: "h", label: "Hand: move around the drawing (H, or hold Space)" },
  { id: "zoom", key: "z", label: "Zoom: click to zoom in, Alt-click to zoom out (Z)" },
];
function buildToolbar() {
  const nav = $("tools"); nav.textContent = "";
  for (const t of TOOLS) {
    if (t.group) { nav.append(el("div", { className: "tgroup", textContent: t.group })); continue; }
    const b = el("button", { className: "tool", title: t.label, type: "button" });
    b.dataset.tool = t.id; b.setAttribute("aria-label", t.label); b.innerHTML = `<svg viewBox="0 0 24 24">${ICON[t.id]}</svg>`;
    b.onclick = () => setTool(t.id);
    nav.append(b);
  }
  nav.append(el("div", { className: "tgroup", textContent: "Pictures and colours" }));
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
  if (live) { finishLive(); gesture = null; }   // a tool key pressed mid-line (a pen's shortcut button, say) keeps the line
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
      const smoothing = settings.help === "strong" ? b.smoothing + (1 - b.smoothing) * 0.55 : b.smoothing;   // Strong help steadies the line more
      const pen = c.ptype === "pen";
      startLive({
        kind: "stroke", v: 2, brush: settings.brush, mode: b.mode, size: b.size, opacity: b.opacity, hardness: b.hardness, flow: b.flow,
        smoothing, pressureSize: b.pressureSize, pressureOpacity: b.pressureOpacity, blend: b.blend || null, color: settings.primary,
        taper: !!b.taper, thin: !!b.thin, pen, gamma: pen ? { light: 0.6, normal: 1, firm: 1.6 }[settings.feel] || 1 : 1,
      }, c);
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
      if (h?.k === "r") { drag = { type: "rotate", cx: (sb.x0 + sb.x1) / 2, cy: (sb.y0 + sb.y1) / 2, a0: Math.atan2(c.y - (sb.y0 + sb.y1) / 2, c.x - (sb.x0 + sb.x1) / 2), base: pieceAngle(), t0: c.t, lifted: false }; return; }
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
      else if (drag.type === "rotate") floating.m = rotateMatrix(drag, c);
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
            if (!shown(L) || L.locked) continue;
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
      if (settings.bucketAll) src = renderComposite(state, doc, { page: curPage });
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
      const d = renderComposite(state, doc, { page: curPage }).getContext("2d").getImageData(x, y, 1, 1).data;
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
// The cursor for each handle: a turning arrow on the rotate handle; on the corners, the diagonal that points the way
// that corner pulls (top-left and bottom-right one way, top-right and bottom-left the other).
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M18.5 9A7 7 0 1 0 19 14" stroke="#fff" stroke-width="4.5"/><path d="M19.5 4v5h-5" stroke="#fff" stroke-width="4.5"/><path d="M18.5 9A7 7 0 1 0 19 14" stroke="#111" stroke-width="2"/><path d="M19.5 4v5h-5" stroke="#111" stroke-width="2"/></g></svg>')}") 12 12, grab`;
function handleCursor(h) {
  if (h.k === "r") return ROTATE_CURSOR;
  if (h.k === "x") return "ew-resize";
  if (h.k === "y") return "ns-resize";
  return (h.x - h.ax) * (h.y - h.ay) > 0 ? "nwse-resize" : "nesw-resize";
}
// The rotate handle sits a little above the top middle, at the same distance on screen at any zoom.
function rotateHandle(sb) { return { x: (sb.x0 + sb.x1) / 2, y: sb.y0 - 26 / V.z, k: "r" }; }
function handleAt(sb, sx, sy) {
  if (settings.tool !== "move") return null;
  const r = rotateHandle(sb), [rx, ry] = toScreen(r.x, r.y);
  if (Math.hypot(rx - sx, ry - sy) <= 9) return r;
  for (const h of handlePoints(sb)) { const [hx, hy] = toScreen(h.x, h.y); if (Math.abs(hx - sx) <= 7 && Math.abs(hy - sy) <= 7) return h; }
  return null;
}
function scaleMatrix(d, c) {
  const h = d.h;
  let sx = h.k === "y" ? 1 : (c.x - h.ax) / ((h.x - h.ax) || 1);
  let sy = h.k === "x" ? 1 : (c.y - h.ay) / ((h.y - h.ay) || 1);
  if (h.k === "c" && c.shift) { const s = Math.abs(sx) > Math.abs(sy) ? sx : sy; sx = sy = s; }   // Shift keeps the shape
  const fix = v => Math.sign(v || 1) * Math.max(0.02, Math.abs(v));
  return scaleAbout(fix(sx), fix(sy), h.ax, h.ay);
}
// How far the selection is turned now (the first piece's angle), so Shift snaps to true 45° steps.
function pieceAngle() { const p = state.pieces.get([...sel.ids][0]); return p ? Math.atan2(p.tf[1], p.tf[0]) : 0; }
function rotateMatrix(d, c) {
  let a = Math.atan2(c.y - d.cy, c.x - d.cx) - d.a0;
  if (c.shift) { const step = Math.PI / 4; a = Math.round((d.base + a) / step) * step - d.base; }   // Shift: 45°, 90° and so on
  const cos = Math.cos(a), sin = Math.sin(a);
  return mul(translate(d.cx, d.cy), mul([cos, sin, -sin, cos, 0, 0], translate(-d.cx, -d.cy)));
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
        if (!floating || drag?.type === "rotate") {
          const r = rotateHandle(sb0), mx = (sb.x0 + sb.x1) / 2;
          const rx = floating ? (drag.cx + (r.x - drag.cx) * floating.m[0] + (r.y - drag.cy) * floating.m[2]) : r.x;
          const ry = floating ? (drag.cy + (r.x - drag.cx) * floating.m[1] + (r.y - drag.cy) * floating.m[3]) : r.y;
          if (!floating) { c.beginPath(); c.moveTo(mx, sb.y0); c.lineTo(rx, ry); c.stroke(); }
          c.beginPath(); c.arc(rx, ry, 5.5 * px, 0, Math.PI * 2); c.fill(); c.stroke();
        }
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
  if (team) drawCursors(c, px);
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
  return { x, y, sx: e.clientX - r.left, sy: e.clientY - r.top, pressure: e.pointerType === "pen" ? (e.pressure || 0.5) : 0.5, t: speech.now(), ts: e.timeStamp, ptype: e.pointerType, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey };
}
view.addEventListener("pointerdown", e => {
  if (pb) stopPlayback();
  if (editing && settings.tool !== "text") commitText();
  try { view.setPointerCapture(e.pointerId); } catch (_) {}
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
  if (e.pointerType === "pen" && !settings.penSeen) { settings.penSeen = true; saveSettings(); renderOptions(); }   // show Pressure feel from now on
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
    // Draw a few predicted points ahead of the pen in the preview only, run through a copy of the smoothing.
    if (live && !live.held && e.getPredictedEvents) {
      const f = live.filter.clone(), pr = live.pts.length ? live.pts[live.pts.length - 1][2] : 0.5;
      live.predicted = e.getPredictedEvents().map(ev => {
        const q = ctxOf(ev), s = f.next(q.sx, q.sy, q.ts);
        return [(s.x - V.x) / V.z, (s.y - V.y) / V.z, live.props.pen ? q.pressure : pr, q.t, Math.round(q.ts - live.ts0)];
      });
    }
    return;
  }
  if (!gesture && !e.buttons) hoverPoint(c);
  if (team) sendCursor(c.x, c.y);
  if (settings.tool === "move") {
    if (drag?.type === "scale" || drag?.type === "rotate") return;   // keep the handle's cursor for the whole drag
    const sb = selectionBox(); const h = sb && handleAt(sb, c.sx, c.sy);
    view.style.cursor = h ? handleCursor(h) : sb && c.x >= sb.x0 && c.x <= sb.x1 && c.y >= sb.y0 && c.y <= sb.y1 ? "move" : "default";
  }
  if (settings.tool === "brush" || settings.tool === "eraser") requestRender();
});
function endPointer(e, cancel) {
  pointers.delete(e.pointerId);
  if (gesture?.type === "pinch") { if (pointers.size < 2) gesture = pointers.size ? { type: "idle" } : null; return; }
  if (gesture?.type === "idle") { if (!pointers.size) gesture = null; return; }
  if (gesture?.type === "pan" && gesture.id === e.pointerId) { gesture = null; updateCursor(); return; }
  if (gesture?.type === "tool" && gesture.id === e.pointerId) {
    gesture = null;
    if (cancel && live) { stopLive(); requestRender(); return; }
    tools[settings.tool].up?.(ctxOf(e));
  }
}
view.addEventListener("pointerup", e => endPointer(e, false));
view.addEventListener("pointercancel", e => endPointer(e, true));
view.addEventListener("pointerleave", () => { hoverPos = null; clearTimeout(dwellTimer); hover = []; requestRender(); if (team) sendCursor(null, null); });
view.addEventListener("contextmenu", e => e.preventDefault());
function cancelToolGesture() {
  if (live) stopLive();
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
// For a group of buttons: a label would pass clicks on its words through to the first button.
function optGroup(text, ...kids) { const s = el("span", { className: "opt" }); s.append(text, ...kids); return s; }
function slider(text, min, max, step, value, onInput, show = v => v) {
  const out = el("output", { textContent: show(value) });
  const inp = el("input", { type: "range", min, max, step, value });
  inp.oninput = () => { onInput(+inp.value); out.textContent = show(+inp.value); };
  inp.onchange = saveSettings;
  return optLabel(text, inp, out);
}
function seg(items, value, onPick) {
  const s = el("div", { className: "seg" });
  for (const [v, label, title] of items) { const b = el("button", { type: "button", textContent: label, title: title || "" }); b.setAttribute("aria-pressed", String(v === value)); b.onclick = () => { onPick(v); saveSettings(); renderOptions(); }; s.append(b); }
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
    o.append(optGroup("Drawing help", seg([
      ["off", "Off", "No snapping or tidying: just your Smoothing setting. For full control."],
      ["light", "Light", "Hold still at the end of a line to snap it into a clean line, circle, box or triangle."],
      ["strong", "Strong", "Extra smoothing, snapping, and each line tidied after you lift. Good for a mouse or a shaky hand."],
    ], settings.help, v => { settings.help = v; })));
    o.append(slider("Size", 1, 300, 1, b.size, v => { b.size = v; requestRender(); }));
    o.append(slider("Opacity", 0.05, 1, 0.05, b.opacity, v => { b.opacity = v; }, pct));
    o.append(slider("Smoothing", 0, 1, 0.05, b.smoothing, v => { b.smoothing = v; }, pct));
    if (b.mode === "dab") o.append(slider("Softness", 0, 1, 0.05, 1 - b.hardness, v => { b.hardness = 1 - v; }, pct));
    if (b.mode === "dab") o.append(slider("Flow", 0.02, 1, 0.02, b.flow, v => { b.flow = v; }, pct));
    o.append(check("Pen pressure: size", b.pressureSize, v => { b.pressureSize = v; }), check("opacity", b.pressureOpacity, v => { b.pressureOpacity = v; }));
    if (settings.penSeen) o.append(optGroup("Pressure feel", seg([
      ["light", "Light", "For a light touch: thick lines come easily."],
      ["normal", "Normal", "Even response."],
      ["firm", "Firm", "For a heavy hand: press harder for thick lines."],
    ], settings.feel, v => { settings.feel = v; })));
    o.append(swatchRow(), hint(settings.help === "off" ? "Alt-click picks a colour. [ and ] change size." : "Hold at the end of a line to snap it. Alt-click picks a colour."));
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
      [...pageLayers()].reverse().forEach(L => s.append(el("option", { value: L.id, textContent: L.name })));
      s.onchange = () => { if (!s.value) return; ensureCut(); commit({ type: "setLayer", ids: [...sel.ids], layer: s.value }); setActiveLayer(s.value); renderOptions(); };
      o.append(optLabel("", s));
      o.append(btn("Duplicate", () => { copySelection(); pastePieces(); }), btn("Delete", deleteSelection), btn("Deselect", clearSelection));
      o.append(hint("Drag to move. Handles resize (Shift keeps the shape). The round handle on top rotates (Shift snaps to 45°). Arrow keys nudge."));
    } else o.append(hint("Click anything to select it, Shift-click to add, or drag a box around things. Then drag to move, use the handles to resize, or the round handle to rotate."));
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
  for (const L of [...pageLayers()].reverse()) {
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
$("layerAdd").onclick = () => { const id = newId(doc, "l"); commit({ type: "layer", op: "add", id, name: nextLayerName(), above: activeLayer, page: curPage }); activeLayer = id; renderLayers(); };
$("layerUp").onclick = () => commit({ type: "layer", op: "move", id: activeLayer, dir: 1 });
$("layerDown").onclick = () => commit({ type: "layer", op: "move", id: activeLayer, dir: -1 });
$("layerDel").onclick = () => { if (pageLayers().length < 2) return toast("A page needs at least one layer."); commit({ type: "layer", op: "delete", id: activeLayer }); toast("Layer deleted. Ctrl+Z brings it back.", 2500); };

// ---------------------------------------------------------------- timeline panel
const PLAY = '<svg viewBox="0 0 12 12"><path d="M3 1.5l7.5 4.5L3 10.5z"/></svg>';
let tlTimer = null;
function renderTimelineSoon() { clearTimeout(tlTimer); tlTimer = setTimeout(renderTimeline, 120); }
function renderTimeline() {
  renderDelVoice();
  if (document.activeElement?.closest?.(".txt")) return;   // don't redraw a line someone is editing
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
    // In a team session you can fix your own lines (the host can fix anyone's).
    const canEdit = !team || team.host || seg.who === team.id;
    const p = el("p", { className: "txt", spellcheck: true });
    if (seg.by) { const w = el("span", { className: "who" }), dot = el("i"); dot.style.background = seg.color || "#5a6373"; w.append(dot, seg.by); p.append(w); }
    const words = el("span", { textContent: seg.text }); p.append(words);
    if (canEdit) words.contentEditable = "true";
    words.onblur = () => {
      const v = words.textContent.trim(); if (!v) { words.textContent = seg.text; return; }
      if (v !== seg.text) { seg.text = v; changed(); if (team && seg.id) team.link.send({ t: "speechEdit", id: seg.id, text: v }); }
    };
    words.onkeydown = e => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); words.blur(); } };
    body.append(p);
    const meta = el("div", { className: "meta" }), m = changes.get(seg), n = m ? m.evs.filter(e => e.type !== "point").length : 0;
    if (n) meta.append(el("span", { className: "chip ink", textContent: `goes with ${n} change${n > 1 ? "s" : ""}` }));
    if (m && m.evs.some(e => e.type === "point")) meta.append(el("span", { className: "chip", textContent: "pointed" }));
    if (seg.src === "typed") meta.append(el("span", { className: "chip", textContent: "typed" }));
    if (meta.childNodes.length) body.append(meta);
    const del = el("button", { className: "del", type: "button", title: "Delete this line", textContent: "×" });
    del.setAttribute("aria-label", "Delete this line");
    del.onclick = () => { doc.speech.splice(doc.speech.indexOf(seg), 1); changed(); if (team && seg.id) team.link.send({ t: "speechDel", id: seg.id }); };
    if (!canEdit) del.hidden = true;
    li.append(play, time, body, del); ol.append(li);
  });
  if (!pb) ol.scrollTop = ol.scrollHeight;
}
function addSegment(seg) {
  seg.page ||= curPage;
  if (team) { seg.id ||= newId(doc, "s"); seg.who = team.id; seg.by = team.name; seg.color = team.color; team.link.send({ t: "speech", seg }); }
  insertSegment(seg);
}
function insertSegment(seg) {
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
$("title").oninput = () => { doc.title = $("title").value; changed(); teamMeta(); const t = tabOf(curTab); if (t) { t.title = doc.title; renderTabs(); } };

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
// Deletes this tab's voice recordings, after a second click. The words in What you said stay.
let delVoiceArmed = 0;
function renderDelVoice() { const b = $("delVoice"); b.hidden = isGuestPage || !!team || !doc.audio.length; b.classList.remove("armed"); }
$("delVoice").onclick = () => {
  if (team || !doc.audio.length) return;
  if (performance.now() - delVoiceArmed > 3000) {
    delVoiceArmed = performance.now(); $("delVoice").classList.add("armed");
    toast(`Click the bin again to delete ${doc.audio.length} voice recording${doc.audio.length === 1 ? "" : "s"} from this tab. The words stay.`, 3000);
    return;
  }
  stopPlayback(); doc.audio = []; audioBlobs = new Map(); delVoiceArmed = 0;
  changed(); saveDraft(); renderDelVoice();
  toast("Voice recordings deleted from this tab. Copies in sessions you already saved or sent stay in the sessions folder.", 6000);
};
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
  const startPage = queue[0]?.page || curPage;
  if (startPage !== curPage && st.pages.some(p => p.id === startPage)) setPage(startPage, true);
  pb = { from, to, st, queue, qi: 0, pending: [], marks: [], comp: renderComposite(st, doc, { paper: false, page: curPage }), wall: performance.now(), T: from, audios: [] };
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
    if (ev.page && ev.page !== curPage && pb.st.pages.some(p => p.id === ev.page)) { setPage(ev.page, true); dirtyComp = true; }   // follow the action to its page
    if (ev.type === "add" && ev.piece.kind === "stroke" && (ev.t1 ?? 0) > T) pb.pending.push(ev);
    else if (ev.type === "point") pb.marks.push(ev);
    else { apply(pb.st, ev); dirtyComp = true; }
  }
  flush(T);
  if (dirtyComp) pb.comp = renderComposite(pb.st, doc, { paper: false, page: curPage });
  $("playTime").textContent = `${fmt(T)} / ${fmt(pb.to)}`;
  $("playProg").value = clamp((T - pb.from) / Math.max(1, pb.to - pb.from), 0, 1);
  document.querySelectorAll("#timeline li[data-t]").forEach(li => li.classList.toggle("playing", +li.dataset.t <= T && +li.dataset.t >= pb.from));
  requestRender();
  if (T >= pb.to) { stopPlayback(); return; }
  pb.raf = requestAnimationFrame(tickPlayback);
}
function drawPlayback(c) {
  c.drawImage(pb.comp, 0, 0);
  for (const ev of pb.pending) { const L = pb.st.layers.find(l => l.id === ev.piece.layer); if (!L || (L.visible && onPage(L))) renderPiece(c, ev.piece, doc, pb.st.size, { limitT: pb.T, alpha: L?.opacity ?? 1 }); }
  for (const ev of pb.marks) { if ((ev.page || "pg0") !== curPage) continue; const age = pb.T - (ev.t1 ?? ev.t0); if (age < 1600) { c.save(); c.globalAlpha = 1 - age / 1600; drawPointing(c, ev.pts.filter(q => q[3] === undefined || q[3] <= pb.T)); c.restore(); } }
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
  const map = { off: ["Mic off", ""], on: ["Listening", "live"], blocked: ["Mic blocked", "warn"], none: ["No speech-to-text here", "warn"], error: ["Words not coming through: restarting", "warn"], silent: ["Mic sends no sound", "warn"] };
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
    onLog: entry => { if (doc !== target) return; (doc.sttLog ||= []).push(team ? { ...entry, by: team.name } : entry); if (doc.sttLog.length > 500) doc.sttLog.shift(); },
    onAudio: ({ t0, dur, blob }) => {
      if (doc !== target) return;
      const id = newId(doc, "a"), meta = { id, t0, dur, type: blob.type, ...(team ? { who: team.id, by: team.name } : {}) };
      doc.audio.push(meta); blobs.set(id, blob); changed();
      if (team) uploadAudio(meta, blob);   // so everyone can play back what you said
    },
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
  teamMeta();
  $("pageDlg").hidden = true; changed(); requestRender(); updateZoomLabel();
};
function applyTheme() {
  const t = settings.theme;
  if (t === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  $("theme").textContent = { auto: "Auto", light: "Light", dark: "Dark" }[t];
  $("theme").title = `Theme: ${{ auto: "follows Windows", light: "light", dark: "dark" }[t]}. Click to change.`;
}
$("theme").onclick = () => { settings.theme = { auto: "light", light: "dark", dark: "auto" }[settings.theme]; saveSettings(); applyTheme(); };

// ---------------------------------------------------------------- tabs: several sketches open at once (IndexedDB)
// Each tab keeps its own drawing, words and voice under "tab:<id>", and "tabs" holds the list. A review tab
// is made from what an agent built and points back to the sketch it came from.
const idb = () => new Promise((res, rej) => { const r = indexedDB.open("sketchtalk", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function idbDo(mode, fn) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction("kv", mode), st = tx.objectStore("kv"), req = fn(st); tx.oncomplete = () => res(req?.result); tx.onerror = () => rej(tx.error); }); }
const TABS_KEY = "tabs";
let tabs = [], curTab = null, draftTimer, tabBusy = false, teamStarting = false;
const tabOf = id => tabs.find(t => t.id === id);
const newTabId = () => "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const readTab = async id => { try { return await idbDo("readonly", st => st.get("tab:" + id)); } catch (_) { return null; } };
function tabInfo(t, d) { Object.assign(t, { title: d.title || "", kind: d.kind || "sketch", round: d.review?.round, parent: d.review?.parentTab, item: d.review?.itemId, session: d.sentAs, status: d.goalsState }); }
function changed() {
  dirty = true; renderTimelineSoon();
  if (isGuestPage) return;   // guests' work lives in the host's session, not in a tab here
  clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 1200);
}
async function saveTabs() { try { await idbDo("readwrite", st => st.put({ list: tabs, active: curTab }, TABS_KEY)); } catch (_) {} }
async function saveDraft() {
  if (!curTab || isGuestPage) return;
  const t = tabOf(curTab); if (t) { tabInfo(t, doc); renderTabs(); }
  try { await idbDo("readwrite", st => { st.put({ doc, clock: speech.now(), audio: [...audioBlobs], activeLayer, page: curPage }, "tab:" + curTab); st.put({ list: tabs, active: curTab }, TABS_KEY); }); } catch (_) {}
}
async function openTabs() {
  let updated = false;
  try { updated = sessionStorage.getItem(RELOAD_KEY) === "1"; sessionStorage.removeItem(RELOAD_KEY); } catch (_) {}
  let meta = null;
  try { meta = await idbDo("readonly", st => st.get(TABS_KEY)); } catch (_) {}
  if (meta?.list?.length) { tabs = meta.list; curTab = tabOf(meta.active) ? meta.active : tabs[0].id; }
  else {
    // The first time with tabs: the sketch from before becomes the first tab.
    let old = null;
    try { old = await idbDo("readonly", st => st.get("draft")); } catch (_) {}
    curTab = newTabId(); tabs = [{ id: curTab, title: "", kind: "sketch" }];
    if (old?.doc) { tabInfo(tabs[0], old.doc); try { await idbDo("readwrite", st => { st.put(old, "tab:" + curTab); st.delete("draft"); }); } catch (_) {} }
    await saveTabs();
  }
  const rec = await readTab(curTab);
  if (rec?.doc) await loadDraft(rec);
  delete tabOf(curTab).fresh;
  renderTabs(); renderGoals();
  if (updated) toast("Updated to the latest version. Your sketches are just as you left them.", 4000);
}
async function loadDraft(d) {
  if (speech.isRunning()) await stopRec();
  stopPlayback(); if (editing) commitText(); cancelToolGesture();
  doc = d.doc; speech.setClock(d.clock || 0); audioBlobs = new Map(d.audio || []); activeLayer = d.activeLayer || "l0"; curPage = d.page || "pg0";
  redoStack = []; maskData.clear();
  forgetImages(); await preloadAssets(doc);
  rebuild(); fit(); renderTimeline(); renderPages();
  $("title").value = doc.title || ""; $("clock").textContent = fmt(speech.now()); $("hint").hidden = hasContent();
  dirty = false;
}
async function switchTab(id) {
  if (id === curTab || !tabOf(id)) return;
  if (teamStarting) return toast("Wait a moment: the team session is still starting.", 4000);
  if ($("save").disabled || tabBusy) return;   // halfway through a save, or a build arriving
  if (speech.isRunning()) { await stopRec(); await sleep(500); }   // the last words can arrive just after
  if (team && !isGuestPage) stepAway();   // the session carries on without the host until they come back to its tab
  stopPlayback(); if (editing) commitText(); cancelToolGesture();
  clearTimeout(draftTimer); await saveDraft();
  const rec = await readTab(id);
  curTab = id; delete tabOf(id).fresh;
  await loadDraft(rec?.doc ? rec : { doc: newDoc() });
  if (awayTeam && awayTeam.tab === id) { const info = awayTeam; awayTeam = null; beginTeam(info); toast("Back in the team session.", 3000); }
  saveTabs(); renderTabs(); renderGoals(); renderPeople();
}
// A new tab goes to the end, or for a review, just after the sketch (and earlier reviews) it belongs to.
async function newTab(d = newDoc(), { activeLayer: al = "l0", focus = true } = {}) {
  const t = { id: newTabId() }; tabInfo(t, d);
  let at = tabs.length;
  if (t.parent && tabOf(t.parent)) { at = tabs.indexOf(tabOf(t.parent)) + 1; while (at < tabs.length && tabs[at].parent === t.parent) at++; }
  tabs.splice(at, 0, t);
  if (!focus) t.fresh = true;
  try { await idbDo("readwrite", st => { st.put({ doc: d, clock: 0, audio: [], activeLayer: al }, "tab:" + t.id); st.put({ list: tabs, active: curTab }, TABS_KEY); }); } catch (_) {}
  if (focus) await switchTab(t.id); else renderTabs();
  return t.id;
}
async function closeTab(id) {
  if ((team && id === curTab) || awayTeam?.tab === id) return toast("End the team session before closing its tab.", 5000);
  if (id === curTab) {
    const i = tabs.findIndex(t => t.id === id), next = tabs[i + 1] || tabs[i - 1];
    if (next) await switchTab(next.id); else await newTab();
    if (curTab === id) return;   // the switch didn't happen
  }
  tabs = tabs.filter(t => t.id !== id);
  for (const t of tabs) if (t.parent === id) t.parent = null;
  try { await idbDo("readwrite", st => { st.delete("tab:" + id); st.put({ list: tabs, active: curTab }, TABS_KEY); }); } catch (_) {}
  renderTabs();
}
const STATUS_TEXT = { draft: "Goals to check", building: "Building", built: "Built", review: "To review", changes: "Changes sent", approved: "Approved" };
function tabLabel(t) { return t.title || (t.kind === "review" ? `Build ${t.round || 1}` : t.kind === "sheet" ? `Turnaround ${t.round || 1}` : "Untitled sketch"); }
// Double-click a tab to rename it: the name is the sketch's title, so it's the same as typing in the name box.
function renameTab(t, go) {
  if (isGuestPage) return;
  const name = go.querySelector(".tname"), i = el("input", { className: "tren", value: t.title || "", maxLength: 40, placeholder: tabLabel(t) });
  name.textContent = ""; name.append(i); i.focus(); i.select();
  i.onclick = e => e.stopPropagation();
  let done = false;
  const finish = async ok => {
    if (done) return; done = true;
    const v = i.value.trim();
    if (ok && v !== (t.title || "")) {
      if (t.id === curTab) { doc.title = v; $("title").value = v; t.title = v; changed(); teamMeta(); }
      else { await editTab(t, d => { d.title = v; }); delete t.fresh; saveTabs(); }   // a rename isn't news: no red dot
    }
    renderTabs();
  };
  i.onkeydown = e => { e.stopPropagation(); if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); };
  i.onblur = () => finish(true);
}
function renderTabs() {
  const box = $("tabs"); box.hidden = isGuestPage; if (isGuestPage) return;
  box.textContent = "";
  for (const t of tabs) {
    const b = el("div", { className: "tab" + (t.id === curTab ? " on" : "") + (t.kind === "review" || t.kind === "sheet" ? " review" : "") + (t.fresh ? " fresh" : ""), role: "tab" });
    b.setAttribute("aria-selected", String(t.id === curTab));
    const parent = t.parent && tabOf(t.parent);
    const go = el("button", { type: "button", className: "tgo", title: parent ? `A build of “${tabLabel(parent)}”` : tabLabel(t) });
    if (t.kind === "review" || t.kind === "sheet") go.append(el("span", { className: "tkind", textContent: "↳" }));
    go.append(el("span", { className: "tname", textContent: tabLabel(t) }));
    if (team?.tab === t.id || awayTeam?.tab === t.id) go.append(el("span", { className: "tstat s-team", textContent: awayTeam ? "Team, you're away" : "Team" }));
    else if (STATUS_TEXT[t.status]) go.append(el("span", { className: "tstat s-" + t.status, textContent: STATUS_TEXT[t.status] }));
    go.onclick = () => switchTab(t.id);
    go.title += " (double-click to rename)";
    go.ondblclick = e => { e.preventDefault(); renameTab(t, go); };
    const x = el("button", { type: "button", className: "tx", title: "Close this tab", textContent: "×" });
    let armedAt = 0;
    x.onclick = e => {
      e.stopPropagation();
      const empty = t.id === curTab ? !hasContent() : false;
      if (!empty && performance.now() - armedAt > 2500) { armedAt = performance.now(); x.textContent = "Close?"; x.classList.add("armed"); setTimeout(() => { x.textContent = "×"; x.classList.remove("armed"); }, 2500); return; }
      closeTab(t.id);
    };
    b.append(go, x); box.append(b);
  }
  const add = el("button", { type: "button", className: "tadd", title: "New sketch in a new tab", textContent: "+ New" });
  add.onclick = () => newTab();
  box.append(add);
}
window.addEventListener("beforeunload", e => { if (reloading || isGuestPage) return; if (dirty && hasContent()) { saveDraft(); e.preventDefault(); e.returnValue = ""; } });

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
  const busy = speech.isRunning() || gesture || live || editing || pb || !$("pageDlg").hidden || $("save").disabled || !$("teamDlg").hidden || !$("joinDlg").hidden;
  if (busy) {
    if (!updateWaiting) { updateWaiting = true; toast("A new version of SketchCollab is ready. It loads as soon as you finish what you're doing.", 6000); }
    return;
  }
  reloading = true;
  clearTimeout(draftTimer);
  await saveDraft();
  try { sessionStorage.setItem(RELOAD_KEY, "1"); } catch (_) {}
  location.reload();
}
setInterval(checkForUpdate, 2000);

// ---------------------------------------------------------------- save, send, copy
let server = null;
async function checkServer() {
  try {
    const r = await fetch("/api/ping", { cache: "no-store" });
    if (r.ok) {
      server = await r.json();
      $("saveHint").textContent = server.host ? `Saves go to ${server.folder}` : "You're a guest: the host saves the session and sends it to Claude.";
      $("invite").hidden = !server.host || !server.tunnelReady;
      applyRoleUI();
      return;
    }
  } catch (_) {}
  $("saveHint").textContent = "Opened without start.bat, so Save downloads the files instead, and Send to Claude isn't available.";
}
const hasContent = () => doc.events.length > 0 || doc.speech.length > 0;
async function settle() {
  if (team) doc.team = team.members.map(m => ({ name: m.name, host: m.host }));   // who took part, for the notes
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
// The pictures an event uses (imported photos, fills, cut-out shapes).
function eventAssets(ev, used = new Set()) {
  if (ev.type === "batch") ev.events.forEach(e => eventAssets(e, used));
  const ps = ev.type === "add" ? [ev.piece] : ev.type === "addMany" ? ev.pieces : [];
  for (const p of ps) { if (p.asset) used.add(p.asset); for (const c of [...(p.clips || []), ...(p.masks || [])]) if (c.asset) used.add(c.asset); }
  if (ev.type === "cut") ev.cuts.forEach(c => { if (c.clip.asset) used.add(c.clip.asset); });
  return used;
}
function usedAssets() {
  const used = new Set();
  doc.events.forEach(ev => eventAssets(ev, used));
  return [...used].filter(id => doc.assets[id]);
}
async function exportSession(send, request = null) {
  if (!hasContent()) { toast("Draw or say something first."); return false; }
  if (send && !server) return void toast("Send to Claude needs the app opened with start.bat (the desktop shortcut).", 7000);
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
      dirty = false; return true;
    }
    const files = [{ path: "transcript.md", text: wordsText(doc, state, moments, len, true) }];
    files.push({ path: "final.png", base64: b64(allPagesCanvas()) }, { path: "storyboard.png", base64: b64(story) });
    if (state.pages.length > 1) state.pages.forEach((P, i) => files.push({ path: `pages/${pad2(i + 1)}.png`, base64: b64(renderComposite(state, doc, { page: P.id })) }));
    imgs.forEach((c, i) => files.push({ path: `moments/${pad2(i + 1)}.png`, base64: b64(c) }));
    state.layers.forEach((L, i) => { const cv = makeCanvas(state.size.w, state.size.h); renderLayer(cv.getContext("2d"), state, L.id, doc); files.push({ path: `layers/${pad2(i + 1)}.png`, base64: b64(cv) }); });
    const assets = {};
    for (const id of usedAssets()) { const url = doc.assets[id], path = `assets/${id}.${extOf(url)}`; assets[id] = path; files.push({ path, base64: url.split(",")[1] }); }
    const audio = [];
    if (team) { await Promise.all(doc.audio.map(a => fetchAudio(a.id))); }   // everyone's voice, not just yours
    for (const a of doc.audio) { const blob = audioBlobs.get(a.id); if (!blob) continue; const path = `audio/${a.id}.${/mp4/.test(a.type) ? "m4a" : "webm"}`; audio.push({ ...a, file: path }); files.push({ path, base64: await blobB64(blob) }); }
    const meta = { ...doc, assets, audio, length_ms: len, layers: state.layers.map((L, i) => ({ ...L, file: `layers/${pad2(i + 1)}.png`, pieces: state.order[L.id].length })), size: state.size };
    files.push({ path: "session.json", text: JSON.stringify(meta) });
    const r = await fetch("/api/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, files, send: !!send, request: send ? request || { kind: "sketch", goals: goalsOf().map(g => g.text) } : undefined }) });
    const res = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(res.error || "the save was refused");
    dirty = false;
    if (send) { doc.sentAs = name; saveDraft(); }
    if (request) return true;   // the caller says what happened
    toast(send ? "Sent to Claude. If your chat with Claude is open, it picks this up in a few seconds." : `Saved to ${res.folder}.`, 8000);
  } catch (e) {
    toast("Couldn't save: " + e.message + ". Is the SketchCollab window from start.bat still open?", 9000);
    return false;
  } finally { buttons.forEach(b => b.disabled = false); label.textContent = old; }
}
function download(name, href) { const a = el("a", { href, download: name }); document.body.append(a); a.click(); a.remove(); }
$("save").onclick = () => exportSession(false);
$("send").onclick = () => doc.kind === "review" || doc.kind === "sheet" ? sendReview("changes") : exportSession(true);
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

// ---------------------------------------------------------------- goals, builds and reviews
// The loop: a sketch gets a list of goals (yours, or drafted by Claude from what you said and drew). Build it
// sends the sketch and the goals to Claude, who has an agent build it. The agent leaves pictures and a goal-by-goal
// report in the inbox, and they open here as a review tab. You mark each goal, draw and talk over the pictures,
// then Send back for changes (the next build opens as another tab) or Approve.
const AGENT_STATUS = { done: "Done", partly: "Partly", "not yet": "Not yet" };
const gid = () => "g" + Math.random().toString(36).slice(2, 8);
const goalsOf = () => (doc.goals ||= []);
function goalsChanged() { changed(); renderGoals(); }
function renderGoals() {
  if (document.activeElement?.matches?.("#goalList .gtext, #goalList .gcomment")) { document.activeElement.addEventListener("blur", () => setTimeout(renderGoals, 0), { once: true }); return; }   // you're typing in a goal: wait
  const box = $("goals"); box.hidden = isGuestPage; if (isGuestPage) return;
  const sheet = doc.kind === "sheet", review = doc.kind === "review" || sheet, goals = sheet ? [] : goalsOf(), st = doc.goalsState;
  box.classList.toggle("collapsed", !!settings.goalsShut && !review && st !== "draft");
  $("goalsTitle").textContent = sheet ? "Turnaround sheet" : review ? "Check the build" : "Goals for the build";
  $("goalsCount").textContent = sheet ? "" : review ? `${goals.filter(g => g.verdict).length} of ${goals.length} checked` : goals.length ? String(goals.length) : "";
  const note = $("goalsNote"); note.textContent = "";
  if (sheet) {
    note.append(el("p", { className: "muted", textContent: st === "changes" ? "Your notes on the turnaround were sent back for changes."
      : `Build ${doc.review?.round || 1} from every side, plus the top and the bottom. Draw on anything that's off and talk it through, then press Send back for changes. Mark the goals in the build's own tab.` }));
  } else if (review) {
    const r = doc.review || {};
    if (r.summary) note.append(el("p", { className: "gsum", textContent: r.summary }));
    if (r.built?.length) { const ul = el("ul", { className: "gbuilt" }); r.built.forEach(b => ul.append(el("li", { textContent: b }))); note.append(ul); }
    if (r.notes) note.append(el("p", { className: "gsum muted", textContent: r.notes }));
    note.append(el("p", { className: "muted", textContent: st === "changes" ? "Sent back for changes. The next build opens in a new tab beside this one." : st === "approved" ? "You approved this build." : "Mark each goal, then draw on the pictures and talk through anything that's off. Your marks go on the “Your notes” layer." }));
  } else {
    note.append(el("p", { className: "muted", textContent:
      st === "draft" ? "Claude drafted these from your sketch. Change, remove or add any, then press Build it."
      : st === "building" ? "Building now. The results open in a new tab beside this one."
      : st === "built" ? "A build is back: it's in the tab beside this one."
      : goals.length ? "Press Build it when the list says what the build must get right."
      : "List what the build must get right. Or press Send to Claude, and Claude drafts this list from your sketch for you to check." }));
  }
  const ol = $("goalList"); ol.textContent = "";
  goals.forEach((g, i) => {
    const li = el("li", { className: "goal" + (g.verdict ? " v-" + g.verdict : "") });
    const txt = el("span", { className: "gtext", textContent: g.text });
    if (!review) {
      txt.contentEditable = "true"; txt.spellcheck = true;
      txt.onkeydown = e => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); txt.blur(); } };
      txt.onblur = () => { const t = txt.textContent.trim(); if (!t) goals.splice(i, 1); else g.text = t; goalsChanged(); };
    }
    const head = el("div", { className: "ghead" }, el("b", { className: "gnum", textContent: i + 1 + "." }), txt);
    if (!review) {
      if (g.from === "claude" && st === "draft") head.append(el("span", { className: "chip", textContent: "Claude" }));
      const del = el("button", { type: "button", className: "del", title: "Remove this goal", textContent: "×" });
      del.onclick = () => { goals.splice(i, 1); goalsChanged(); };
      head.append(del);
    }
    li.append(head);
    if (review) {
      if (g.agent?.status || g.agent?.note) {
        const a = el("div", { className: "gagent" });
        if (g.agent.status) a.append(el("span", { className: "chip a-" + g.agent.status.replace(" ", "-"), textContent: "Agent: " + (AGENT_STATUS[g.agent.status] || g.agent.status) }));
        if (g.agent.note) a.append(" " + g.agent.note);
        li.append(a);
      }
      const row = el("div", { className: "gverdict" });
      for (const [v, label] of [["good", "Good"], ["change", "Needs a change"]]) {
        const b = el("button", { type: "button", className: "vbtn", textContent: label });
        b.setAttribute("aria-pressed", String(g.verdict === v));
        b.onclick = () => { g.verdict = g.verdict === v ? null : v; goalsChanged(); if (g.verdict === "change") setTimeout(() => ol.children[i]?.querySelector("input")?.focus(), 0); };
        row.append(b);
      }
      li.append(row);
      if (g.verdict === "change") {
        const inp = el("input", { className: "gcomment", placeholder: "What should change? (or just say it and draw it)", value: g.comment || "" });
        inp.onkeydown = e => e.stopPropagation();
        inp.oninput = () => { g.comment = inp.value; changed(); };
        li.append(inp);
      }
    }
    ol.append(li);
  });
  $("goalForm").hidden = review;
  const act = $("goalActions"); act.textContent = "";
  if (sheet) {
    const back = el("button", { type: "button", className: "btn primary", textContent: "Send back for changes" });
    back.onclick = () => sendReview("changes");
    act.append(back);
  } else if (review) {
    const back = el("button", { type: "button", className: "btn primary", textContent: "Send back for changes" });
    back.onclick = () => sendReview("changes");
    const ok = el("button", { type: "button", className: "btn", textContent: "Approve" });
    ok.onclick = () => sendReview("approved");
    act.append(back, ok);
  } else {
    const b = el("button", { type: "button", className: "btn primary", textContent: st === "building" ? "Build again" : "Build it", disabled: !goals.length });
    b.title = "Send the sketch and these goals to Claude to build";
    b.onclick = buildIt;
    // Asked once per sketch: whether each build also comes back with a turnaround sheet in its own tab.
    doc.turnaround ??= settings.turnaround ?? true;
    const ta = el("label", { className: "opt gturn", title: "Pictures of the build from every side (8 views), plus from above and below, on one sheet in a tab of its own" });
    const cb = el("input", { type: "checkbox", checked: doc.turnaround });
    cb.onchange = () => { doc.turnaround = settings.turnaround = cb.checked; saveSettings(); changed(); };
    ta.append(cb, " Also send a turnaround sheet: every side, top and bottom");
    act.append(ta, b);
  }
  $("send").textContent = review ? "Send back" : "Send to Claude";
  $("send").title = review ? "Send your review back to Claude for changes" : "Save and hand it straight to Claude";
}
$("goalsHead").onclick = () => { if (doc.kind === "review" || doc.kind === "sheet") return; settings.goalsShut = !settings.goalsShut; saveSettings(); renderGoals(); };
$("goalForm").onsubmit = e => {
  e.preventDefault();
  const t = $("goalInput").value.trim(); if (!t) return;
  goalsOf().push({ id: gid(), text: t.slice(0, 500), from: "you" }); $("goalInput").value = "";
  goalsChanged();
};
$("goalInput").addEventListener("keydown", e => e.stopPropagation());
async function buildIt() {
  const goals = goalsOf().filter(g => g.text.trim());
  if (!goals.length) return toast("Add at least one goal first.");
  const ok = await exportSession(true, { kind: "build", goals: goals.map(g => g.text), turnaround: doc.turnaround !== false });
  if (ok) { doc.goalsState = "building"; goalsChanged(); toast("Sent to Claude to build. The results open in a new tab beside this one.", 8000); }
}
async function sendReview(kind) {
  if (doc.kind !== "review" && doc.kind !== "sheet") return;
  const goals = doc.kind === "sheet" ? [] : goalsOf();
  if (kind === "changes" && !goals.some(g => g.verdict === "change") && !doc.speech.length && !doc.events.some(e => !e.build && e.type !== "point")) {
    return toast("Mark a goal “Needs a change”, or draw and talk over the pictures, so Claude knows what to fix.", 7000);
  }
  const r = doc.review || {};
  const ok = await exportSession(true, { kind, build_of: r.session, round: r.round || 1, item: r.itemId, turnaround: r.turnaround !== false,
    ...(doc.kind === "sheet" ? { from: "turnaround sheet" } : {}),
    goals: goals.map(g => ({ text: g.text, agent: g.agent || null, verdict: g.verdict || null, comment: g.comment || "" })) });
  if (ok) {
    doc.goalsState = kind; goalsChanged();
    toast(kind === "approved" ? "Approved. Claude has been told the build is right." : "Sent back to Claude. The next build opens in a new tab.", 8000);
  }
}

// What an agent leaves in the inbox. Checked every few seconds while the app is open on this computer.
let tabsReady = false, inboxBusy = false;
const taken = new Set();
// Only one SketchCollab window takes builds from the inbox, so two open windows don't both make a tab for one.
let inboxOwner = !navigator.locks;
navigator.locks?.request("sketchcollab-inbox", lock => { inboxOwner = true; return new Promise(() => {}); });   // held while this window is open
async function checkInbox() {
  if (!tabsReady || !inboxOwner || !server?.host || isGuestPage || inboxBusy) return;
  inboxBusy = true;
  try {
    const r = await fetch("/api/inbox", { cache: "no-store" }); if (!r.ok) return;
    for (const it of (await r.json()).items || []) {
      if (taken.has(it.id)) continue;
      taken.add(it.id);
      try { await takeInboxItem(it.id); } catch (e) { console.warn("inbox item", it.id, e); }
    }
  } catch (_) {} finally { inboxBusy = false; }
}
setInterval(checkInbox, 3000);
const inboxDone = id => fetch(`/api/inbox/${encodeURIComponent(id)}/done`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
// Change a tab's saved sketch, whether it's the open one or not.
async function editTab(t, fn) {
  if (t.id === curTab) { fn(doc); goalsChanged(); return; }
  tabBusy = true;   // a switch now would load the old copy
  try {
    const rec = await readTab(t.id); if (!rec?.doc) return;
    fn(rec.doc); tabInfo(t, rec.doc); t.fresh = true;
    try { await idbDo("readwrite", st => { st.put(rec, "tab:" + t.id); st.put({ list: tabs, active: curTab }, TABS_KEY); }); } catch (_) {}
  } finally { tabBusy = false; }
  renderTabs();
}
async function takeInboxItem(id) {
  if (tabs.some(t => t.item === id)) return inboxDone(id);   // already open
  const r = await fetch(`/api/inbox/${encodeURIComponent(id)}`, { cache: "no-store" }); if (!r.ok) return;
  const item = await r.json();
  const from = tabs.find(t => t.session && t.session === item.session);
  if (item.kind === "goals") {
    if (!from) { toast(`Claude drafted goals for a sketch that isn't open any more (${item.session}).`, 6000); return inboxDone(id); }
    const drafted = (item.goals || []).map(g => String(typeof g === "string" ? g : g?.text || "").trim().slice(0, 500)).filter(Boolean).slice(0, 40);
    await editTab(from, d => {
      const mine = (d.goals || []).filter(g => g.from !== "claude"), have = new Set(mine.map(g => g.text.toLowerCase()));
      d.goals = [...mine, ...drafted.filter(t => !have.has(t.toLowerCase())).map(text => ({ id: gid(), text, from: "claude" }))];
      d.goalsState = "draft";
    });
    toast(`Claude drafted ${drafted.length} goal${drafted.length === 1 ? "" : "s"} for “${tabLabel(from)}”. Check them under Goals, then press Build it.`, 9000);
    if (from.id === curTab) { settings.goalsShut = false; renderGoals(); }
    return inboxDone(id);
  }
  if (item.kind === "sheet") {   // a turnaround sheet on its own, for a build that's already open
    const root = from ? (from.kind !== "sketch" && from.parent && tabOf(from.parent) ? tabOf(from.parent) : from) : null;
    if (!item.sheet?.data) { toast("A turnaround sheet came back without its picture.", 6000); return inboxDone(id); }
    await newTab(await sheetDoc(item, root, item.round || 1), { activeLayer: "l1", focus: false });
    toast(`The turnaround sheet for build ${item.round || 1} is in a new tab.`, 7000);
    return inboxDone(id);
  }
  if (item.kind === "review") {
    if (!item.images?.length) { toast("A build came back without any pictures, so there's nothing to review yet.", 6000); return inboxDone(id); }
    const root = from ? (from.kind === "review" && from.parent && tabOf(from.parent) ? tabOf(from.parent) : from) : null;
    const round = item.round || (root ? tabs.filter(t => t.parent === root.id).length + 1 : 1);
    const rootDoc = root?.id === curTab ? doc : root ? (await readTab(root.id))?.doc : null;
    const { d, notesLayer } = await reviewDoc(item, root, round, rootDoc?.goals);
    d.review.turnaround = rootDoc?.turnaround !== false;
    if (root) await editTab(root, x => { x.goalsState = "built"; });
    if (from && from !== root) await editTab(from, x => { x.goalsState = x.goalsState === "approved" ? x.goalsState : "changes"; });
    const idle = !speech.isRunning() && !gesture && !live && !editing && !pb && !$("save").disabled && !team && !teamStarting && $("teamDlg").hidden;
    const focus = idle && (curTab === from?.id || curTab === root?.id || !hasContent());
    await newTab(d, { activeLayer: notesLayer, focus });
    if (item.sheet?.data) { try { await newTab(await sheetDoc(item, root, round), { activeLayer: "l1", focus: false }); } catch (e) { console.warn("turnaround sheet", e); } }
    toast(focus ? `Build ${round} is back. Check each goal on the right, draw on the pictures and talk, then Send back or Approve.`
      : `Build ${round} of “${root ? tabLabel(root) : item.title || "your sketch"}” is back, in a new tab.`, 9000);
    return inboxDone(id);
  }
  toast("Something arrived in the inbox that this version doesn't understand.", 5000);
  return inboxDone(id);
}
// The review tab: the build's pictures, each with its caption, on a locked layer, and an empty layer above for your marks.
function wrapLines(text, style, width) {
  const out = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    for (const w of para.split(/\s+/)) {
      const tryLine = line ? line + " " + w : w;
      if (line && measureText({ ...style, text: tryLine }).w > width) { out.push(line); line = w; } else line = tryLine;
    }
    out.push(line);
  }
  return out.slice(0, 3).join("\n");
}
async function reviewDoc(item, root, round, parentGoals) {
  const imgs = [];
  for (const im of item.images.slice(0, 12)) { try { const e = await loadImg(im.data); imgs.push({ ...im, w: e.naturalWidth || 800, h: e.naturalHeight || 600 }); } catch (_) {} }
  if (!imgs.length) throw new Error("no pictures could be opened");
  const cols = imgs.length === 1 ? 1 : imgs.length <= 4 ? 2 : 3, rows = Math.ceil(imgs.length / cols);
  const CW = imgs.length === 1 ? 1600 : 1000, CH = imgs.length === 1 ? 1100 : 720, GAP = 60, CAP = 120, TOP = 130;
  const W = Math.min(4096, cols * CW + (cols + 1) * GAP), H = Math.min(4096, TOP + rows * (CH + CAP + GAP));
  const d = newDoc({ w: W, h: H });
  d.idPrefix = "b" + Date.now().toString(36).slice(-5) + "_";   // names no other tab uses
  d.kind = "review";
  d.title = (item.title || `Build ${round}${root ? " of " + tabLabel(root) : ""}`).slice(0, 40);
  d.review = { parentTab: root?.id || null, session: item.session || null, round, itemId: item.id, summary: String(item.summary || "").slice(0, 4000),
    built: (item.built || []).map(String).slice(0, 30), notes: String(item.notes || "").slice(0, 2000) };
  const agentGoals = (item.goals || []).map(g => typeof g === "string" ? { text: g } : g).filter(g => g?.text);
  const src = agentGoals.length ? agentGoals : (parentGoals || []).map(g => ({ text: g.text }));
  d.goals = src.slice(0, 40).map(g => ({ id: gid(), text: String(g.text).slice(0, 500), agent: g.status || g.note ? { status: String(g.status || "").toLowerCase(), note: String(g.note || "").slice(0, 600) } : null, verdict: null, comment: "" }));
  d.goalsState = "review";
  const ink = "#1f2430", pieces = [], base = { tf: [...I], clips: [], masks: [], erasers: [], layer: "l0" };
  const title = { kind: "text", font: "display", size: 56, bold: true, italic: false, color: ink, text: `Build ${round}${root ? ` of “${tabLabel(root)}”` : ""}` };
  pieces.push({ ...title, ...measureText(title), x: GAP, y: 40, id: newId(d), ...base });
  imgs.forEach((im, i) => {
    const c = i % cols, r = Math.floor(i / cols), x0 = GAP + c * (CW + GAP), y0 = TOP + r * (CH + CAP + GAP);
    const k = Math.min(CW / im.w, CH / im.h), w = im.w * k, h = im.h * k;
    const asset = newId(d, "a"); d.assets[asset] = im.data;
    pieces.push({ kind: "image", source: "build", name: (im.caption || im.name || "Picture").slice(0, 40), asset, x: 0, y: 0, w, h, ...base, tf: translate(x0 + (CW - w) / 2, y0 + (CH - h) / 2), id: newId(d) });
    if (im.caption) {
      const s = { kind: "text", font: "sans", size: 30, bold: false, italic: false, color: ink };
      const text = `${i + 1}. ${wrapLines(im.caption, s, CW - 50)}`, cap = { ...s, text };
      pieces.push({ ...cap, ...measureText(cap), x: x0, y: y0 + CH + 16, id: newId(d), ...base });
    }
  });
  const notesLayer = newId(d, "l");
  d.events.push(
    { type: "layer", op: "rename", id: "l0", name: "What was built", t0: 0, build: true },
    { type: "addMany", pieces, t0: 0, build: true },
    { type: "layer", op: "lock", id: "l0", value: true, t0: 0, build: true },
    { type: "layer", op: "add", id: notesLayer, name: "Your notes", above: "l0", t0: 0, build: true },
  );
  return { d, notesLayer };
}

// A turnaround sheet: one picture of the build from every side, top and bottom, in a tab of its own beside the build.
async function sheetDoc(item, root, round) {
  const im = await loadImg(item.sheet.data);
  const GAP = 60, TOP = 60, k = Math.min(1, (4096 - 2 * GAP) / im.naturalWidth, (4096 - TOP - GAP) / im.naturalHeight);   // the sheet carries its own title
  const w = Math.round(im.naturalWidth * k), h = Math.round(im.naturalHeight * k);
  const d = newDoc({ w: w + 2 * GAP, h: h + TOP + GAP });
  d.idPrefix = "t" + Date.now().toString(36).slice(-5) + "_";
  d.kind = "sheet";
  d.title = `Turnaround ${round}${root ? " of " + tabLabel(root) : ""}`.slice(0, 40);
  d.review = { parentTab: root?.id || null, session: item.session || null, round, itemId: item.id };
  d.goalsState = "review";
  const base = { tf: [...I], clips: [], masks: [], erasers: [], layer: "l0" };
  const asset = newId(d, "a"); d.assets[asset] = item.sheet.data;
  const pieces = [{ kind: "image", source: "build", name: (item.sheet.caption || "Turnaround sheet").slice(0, 40), asset, x: 0, y: 0, w, h, ...base, tf: translate(GAP, TOP), id: newId(d) }];
  d.events.push(
    { type: "layer", op: "rename", id: "l0", name: "Turnaround", t0: 0, build: true },
    { type: "addMany", pieces, t0: 0, build: true },
    { type: "layer", op: "lock", id: "l0", value: true, t0: 0, build: true },
    { type: "layer", op: "add", id: "l1", name: "Your notes", above: "l0", t0: 0, build: true },
  );
  return d;
}

// The finished drawing: one page as it is, or every page side by side with its name.
function allPagesCanvas() {
  if (state.pages.length < 2) return renderComposite(state, doc);
  const { w, h } = state.size, G = 40, HEAD = 70, cols = Math.min(state.pages.length, 3), rows = Math.ceil(state.pages.length / cols);
  const k = Math.min(1, 4096 / (cols * (w + G) + G), 4096 / (rows * (h + HEAD + G) + G));
  const c = makeCanvas(Math.round((cols * (w + G) + G) * k), Math.round((rows * (h + HEAD + G) + G) * k)), x = c.getContext("2d");
  x.scale(k, k); x.fillStyle = "#e9ecf2"; x.fillRect(0, 0, c.width / k, c.height / k);
  state.pages.forEach((P, i) => {
    const cx = G + (i % cols) * (w + G), cy = G + Math.floor(i / cols) * (h + HEAD + G);
    x.fillStyle = "#1a1e27"; x.font = '800 44px "Bricolage Grotesque", "Segoe UI", sans-serif'; x.fillText(P.name, cx, cy + 48);
    x.drawImage(renderComposite(state, doc, { page: P.id }), cx, cy + HEAD);
  });
  return c;
}
// ---------------------------------------------------------------- pages inside a tab
// Each page is its own sheet of paper. Everything drawn, pointed at and said is marked with its page, so the notes
// for Claude say where each part happened, and people in a team session can split up across pages.
function setPage(id, quiet = false) {
  if (!state.pages.some(p => p.id === id) || id === curPage) return;
  if (!quiet) { stopPlayback(); if (editing) commitText(); cancelToolGesture(); }
  curPage = id; sel = blankSel(); fixPage();
  renderLayers(); renderOptions(); renderPages(); renderPeople(); requestRender();
  if (team) team.link.send({ t: "cursor", x: null, y: null, page: curPage }, false);   // tell the others where you are
  if (!quiet) changed();
}
function renderPages() {
  const bar = $("pagebar"); bar.textContent = "";
  for (const P of state.pages) {
    const b = el("button", { type: "button", className: "pg" + (P.id === curPage ? " on" : ""), title: "Click to open; double-click to rename" });
    b.append(P.name);
    if (team) for (const m of team.members) {   // a dot for each person on that page
      const pg = m.id === team.id ? curPage : team.pageOf.get(m.id);
      if (m.online && (pg || "pg0") === P.id) { const d = el("i", { title: m.name }); d.style.background = m.color; b.append(d); }
    }
    b.onclick = () => setPage(P.id);
    b.ondblclick = () => {
      const i = el("input", { value: P.name, maxLength: 40 }); b.textContent = ""; b.append(i); i.focus(); i.select();
      const done = ok => { const v = i.value.trim(); if (ok && v && v !== P.name) commit({ type: "page", op: "rename", page: P.id, name: v }); else renderPages(); };
      i.onkeydown = e => { e.stopPropagation(); if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); };
      i.onblur = () => done(true);
    };
    bar.append(b);
  }
  const add = el("button", { type: "button", className: "pg add", title: "Add a page: another sheet of paper in this tab", textContent: "+ Page" });
  add.onclick = () => {
    const page = newId(doc, "g"), layer = newId(doc, "l"), name = `Page ${state.pages.length + 1}`;
    commit({ type: "page", op: "add", page, layer, layerName: "Layer 1", name });
    setPage(page);
  };
  bar.append(add);
  if (state.pages.length > 1) {
    const del = el("button", { type: "button", className: "pg", title: "Delete this page and everything on it (Ctrl+Z brings it back)", textContent: "Delete page" });
    let armed = 0;
    del.onclick = () => {
      if (performance.now() - armed > 2500) { armed = performance.now(); del.textContent = "Delete page?"; setTimeout(() => { del.textContent = "Delete page"; }, 2500); return; }
      commit({ type: "page", op: "delete", page: curPage }); toast("Page deleted. Ctrl+Z brings it back.", 3000);
    };
    bar.append(del);
  }
  const clear = el("button", { type: "button", className: "pg", title: "Clear everything drawn on this page (Ctrl+Z brings it back). The words stay.", textContent: "Clear page" });
  let armedClear = 0;
  clear.onclick = () => {
    const ids = pageLayers().flatMap(L => state.order[L.id]);
    if (!ids.length) return toast("This page is already clear.", 2000);
    if (performance.now() - armedClear > 2500) { armedClear = performance.now(); clear.textContent = "Clear page?"; setTimeout(() => { clear.textContent = "Clear page"; }, 2500); return; }
    sel = blankSel();
    commit({ type: "delete", ids, cleared: true }); toast("Page cleared. Ctrl+Z brings it back.", 3000);
  };
  bar.append(clear);
}

// ---------------------------------------------------------------- team sessions
// The host's app (on this computer) starts a session; guests open the secure link. Everything anyone draws
// or says goes to the host's server, which puts it in order and passes it on to everyone.
const TEAM_KEY = "sketchcollab.team";
const isGuestPage = !["localhost", "127.0.0.1"].includes(location.hostname);
let team = null;   // { id, name, color, token, host, link, members, pending, cursors, lives, shared, url, code }

function beginTeam(info) {
  info.clientNow ||= Date.now();   // when serverNow was true, so the clock is right again after a reload
  if (info.host) info.tab ||= curTab;   // the tab the session is drawn in
  team = { ...info, members: info.members || [], pageOf: new Map(), pending: new Map(), cursors: new Map(), lives: new Map(), shared: new Set(Object.keys(doc.assets)), fails: 0, everOnline: false };
  const skew = info.serverNow - info.clientNow;
  speech.useTeamClock(() => Date.now() + skew - info.startEpoch);
  // A fresh tag on every page load, so ids never repeat even after a reload restarts the numbering.
  doc.idPrefix = `${info.id}${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 4)}_`;
  try { sessionStorage.setItem(TEAM_KEY, JSON.stringify(info)); } catch (_) {}
  team.link = new TeamLink(info.token, { onMessage: onTeamMessage, onStatus: onTeamStatus });
  renderPeople(); applyRoleUI();
}
function onTeamStatus(s) {
  if (!team) return;
  team.online = s === "online";
  if (team.online) { team.everOnline = true; team.fails = 0; }
  else if (!team.everOnline && ++team.fails >= 3) {   // the saved session no longer exists
    endTeamLocal(null);
    if (isGuestPage) showJoin("That session has ended or the link changed. Ask the host for the new link and code.");
    return;
  }
  renderPeople();
}
function onTeamMessage(msg) {
  if (!team) return;
  switch (msg.t) {
    case "hello": {
      const lost = loadTeamState(msg.state, msg.serverNow);
      team.link.flush();
      team.link.send({ t: "cursor", x: null, y: null, page: curPage }, false);   // so everyone knows which page you're on
      for (const ev of lost) teamSendEvent(ev);   // sent just before the connection dropped: send again (duplicates are ignored)
      break;
    }
    case "code": team.code = msg.code; try { sessionStorage.setItem(TEAM_KEY, JSON.stringify({ ...JSON.parse(sessionStorage.getItem(TEAM_KEY)), code: msg.code })); } catch (_) {} renderTeamDlg(); break;
    case "members": team.members = msg.members; renderPeople(); renderTeamDlg(); renderPages(); team.link.send({ t: "cursor", x: null, y: null, page: curPage }, false); break;   // someone joined or left: say where you are
    case "event": onTeamEvent(msg.ev, msg.assets); break;
    case "remove": {
      const i = doc.events.findIndex(e => e.id === msg.id);
      if (i >= 0) { doc.events.splice(i, 1); teamRebuild(); changed(); }
      break;
    }
    case "speech": if (!doc.speech.some(s => s.id === msg.seg.id)) insertSegment(msg.seg); break;
    case "speechEdit": { const s = doc.speech.find(s => s.id === msg.id); if (s) { s.text = msg.text; changed(); } break; }
    case "speechDel": { const i = doc.speech.findIndex(s => s.id === msg.id); if (i >= 0) { doc.speech.splice(i, 1); changed(); } break; }
    case "meta": applyMeta(msg); break;
    case "cursor": team.cursors.set(msg.who, { x: msg.x, y: msg.y, page: msg.page || "pg0", at: performance.now() }); if (team.pageOf.get(msg.who) !== (msg.page || "pg0")) { team.pageOf.set(msg.who, msg.page || "pg0"); renderPages(); renderPeople(); } requestRender(); break;
    case "live": {
      let lv = team.lives.get(msg.who);
      if (msg.reset || !lv) lv = { props: msg.props || lv?.props, pts: [], page: msg.page || lv?.page || "pg0" };
      if (lv.pts.length < 20000) lv.pts.push(...(msg.pts || []).filter(q => Array.isArray(q) && q.length >= 3).slice(0, 20000 - lv.pts.length));
      team.lives.set(msg.who, lv); requestRender();
      break;
    }
    case "liveEnd": team.lives.delete(msg.who); requestRender(); break;
    case "audio": if (!doc.audio.some(a => a.id === msg.meta.id)) { doc.audio.push(msg.meta); changed(); } fetchAudio(msg.meta.id); break;
    case "switched":   // the host moved everyone to another tab; the hello that follows carries it
      team.pending.clear(); team.lives.clear(); team.cursors.clear(); team.loaded = false;
      if (!team.host) { stopPlayback(); if (editing) commitText(); cancelToolGesture(); redoStack = []; clearSelection(); doc.assets = {}; forgetImages(); }   // the new tab brings its own pictures
      toast(msg.title ? `The host moved everyone to “${msg.title}”.` : "The host moved everyone to another drawing.", 6000);
      break;
    case "ended": endTeamLocal("ended"); break;
    case "removed": endTeamLocal("removed"); break;
  }
}
// Everything as the server has it, plus anything of ours still on its way.
function loadTeamState(st, serverNow) {
  const skew = serverNow - Date.now();
  speech.useTeamClock(() => Date.now() + skew - st.startEpoch);
  const have = new Set(st.events.map(e => e.id));
  for (const id of [...team.pending.keys()]) if (have.has(id)) team.pending.delete(id);
  const lost = [...team.pending.values()];
  doc.events = [...st.events, ...lost];
  // The host's earlier recordings that weren't shared stay in the host's own copy only.
  const own = team.host ? doc.audio.filter(a => a.private && !st.audio.some(b => b.id === a.id)) : [];
  doc.speech = st.speech; doc.audio = [...own, ...st.audio];
  for (const [id, url] of Object.entries(st.assets)) { if (safeAsset(url)) doc.assets[id] = url; team.shared.add(id); }
  const b = st.base || {}, first = !team.loaded;
  if (!team.host) { if (b.size0) doc.size0 = b.size0; for (const k of ["paper", "grid", "title", "created"]) if (k in b) doc[k] = b[k]; $("title").value = doc.title || ""; }
  team.members = st.members; team.loaded = true;
  rebuild(); if (first && !team.host) fit();
  renderTimeline(); renderPeople(); renderTeamDlg();
  preloadAssets(doc).then(redrawAll);
  st.audio.forEach(a => fetchAudio(a.id));
  $("hint").hidden = hasContent();
  return lost;
}
// Only real pictures (never links to other websites) are accepted from anyone in the session.
const safeAsset = url => typeof url === "string" && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(url);
function onTeamEvent(ev, assets) {
  for (const [id, url] of Object.entries(assets || {})) { if (!doc.assets[id] && safeAsset(url)) doc.assets[id] = url; team.shared.add(id); }
  if (team.pending.has(ev.id)) { team.pending.delete(ev.id); return; }   // our own, now in its place
  if (doc.events.some(e => e.id === ev.id)) return;
  team.lives.delete(ev.who);
  if (!team.pending.size) {
    doc.events.push(ev);
    try { afterApply(apply(state, ev)); } catch (_) { teamRebuild(); }   // a broken change is skipped, never fatal
  }
  else {   // it reached the server before something of ours: put it first, as everyone else has it
    const first = doc.events.findIndex(e => team.pending.has(e.id));
    doc.events.splice(first < 0 ? doc.events.length : first, 0, ev);
    teamRebuild();
  }
  changed();
}
function teamRebuild() {
  if (floating) { drop(null); drag = null; }
  rebuild();
}
function teamSendEvent(ev) {
  const assets = {};
  for (const id of eventAssets(ev)) if (!team.shared.has(id) && doc.assets[id]) { assets[id] = doc.assets[id]; team.shared.add(id); }
  team.pending.set(ev.id, ev);
  team.link.send({ t: "event", ev, assets });
}
function teamMeta() { if (team) team.link.send({ t: "meta", paper: doc.paper, grid: doc.grid, title: doc.title }); }
function applyMeta(m) {
  if ("paper" in m) doc.paper = m.paper;
  if ("grid" in m) doc.grid = m.grid;
  if ("title" in m && document.activeElement !== $("title")) { doc.title = m.title; $("title").value = m.title || ""; }
  changed(); requestRender();
}
const sendCursor = throttle((x, y) => { if (team) team.link.send({ t: "cursor", x, y, page: curPage }, false); }, 60);
const sendLive = throttle(() => {
  if (!team || !live) return;
  const L = live, from = L.sentN || 0;
  if (from >= L.pts.length && L.sentProps) return;
  team.link.send({ t: "live", pts: L.pts.slice(from), props: L.sentProps ? undefined : L.props, reset: !L.sentProps, page: curPage }, false);
  L.sentProps = true; L.sentN = L.pts.length;
}, 70);
async function uploadAudio(meta, blob, tries = 3) {
  if (!team) return;
  try {
    const r = await fetch(`/api/team/audio?token=${encodeURIComponent(team.token)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...meta, base64: await blobB64(blob) }) });
    if (r.ok) return;
    if (r.status === 400 || r.status === 403) throw new Error("refused");
  } catch (e) { if (e.message === "refused") tries = 1; }
  if (tries > 1) setTimeout(() => uploadAudio(meta, blob, tries - 1), 3000);
  else toast("Your voice recording couldn't be shared with the team. It's still kept here.", 5000);
}
async function fetchAudio(id) {
  if (audioBlobs.has(id) || !team) return;
  try { const r = await fetch(`/api/team/audio/${encodeURIComponent(id)}?token=${encodeURIComponent(team.token)}`); if (r.ok) audioBlobs.set(id, await r.blob()); } catch (_) {}
}
const memberOf = id => team?.members.find(m => m.id === id);
function drawCursors(c, px) {
  const now = performance.now();
  for (const [who, cur] of team.cursors) {
    const m = memberOf(who);
    if (!m || cur.x == null || now - cur.at > 8000 || (cur.page || "pg0") !== curPage) continue;
    c.save(); c.translate(cur.x, cur.y); c.scale(px, px);
    c.fillStyle = m.color; c.strokeStyle = "#fff"; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(0, 0); c.lineTo(0, 17); c.lineTo(4.5, 13); c.lineTo(8, 20); c.lineTo(10.5, 19); c.lineTo(7, 12); c.lineTo(13, 12); c.closePath(); c.fill(); c.stroke();
    c.font = '700 12px "Atkinson Hyperlegible", "Segoe UI", sans-serif';
    const w = c.measureText(m.name).width + 12;
    c.fillRect(12, 18, w, 19); c.fillStyle = "#fff"; c.fillText(m.name, 18, 32);
    c.restore();
  }
}
function renderPeople() {
  const box = $("people"); box.textContent = "";
  box.hidden = !team;
  if (team) for (const m of team.members) {
    const chip = el("span", { className: "person" + (m.online ? "" : " off"), title: m.online ? `${m.name} is here` : `${m.name} has left or lost connection` });
    const dot = el("i"); dot.style.background = m.color; chip.append(dot, m.id === team.id ? `${m.name} (you)` : m.name);
    const pg = m.id === team.id ? curPage : team.pageOf.get(m.id);
    if (state.pages.length > 1 && pg) chip.append(el("small", { textContent: ` · ${state.pages.find(p => p.id === pg)?.name || ""}` }));
    box.append(chip);
  }
  if (team && !team.online) box.append(el("span", { className: "person off", textContent: "Reconnecting…" }));
  $("invite").textContent = isGuestPage ? "Leave" : team || awayTeam ? "Team" : "Invite";
}
// Guests can't save, send or start over: that's the host's job.
function applyRoleUI() {
  for (const id of ["save", "send"]) $(id).hidden = isGuestPage;
  if (isGuestPage) $("invite").hidden = !team;
}
function renderTeamDlg() {
  if ($("teamDlg").hidden) return;
  const T = team || awayTeam;
  $("teamStart").hidden = !!T; $("teamLive").hidden = !T;
  $("teamAway").hidden = !awayTeam;
  if (!T) return;
  $("teamUrl").textContent = T.url || ""; $("teamCode").textContent = T.code || "";
  if (awayTeam) $("teamAwayTab").textContent = `“${tabLabel(tabOf(awayTeam.tab) || {})}”`;
  const ul = $("teamMembers"); ul.textContent = "";
  for (const m of team ? team.members : []) {
    const li = el("li"), dot = el("i", { className: "" });
    dot.style.cssText = `width:10px;height:10px;border-radius:50%;background:${m.color}`;
    li.append(dot, el("span", { textContent: `${m.name}${m.host ? " (host)" : ""}${m.online ? "" : ", away"}` }));
    if (team.host && !m.host) {
      const b = el("button", { className: "btn", type: "button", textContent: "Remove" });
      b.onclick = () => fetch("/api/team/kick", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: m.id }) });
      li.append(b);
    }
    ul.append(li);
  }
}
// The host can look at other tabs during a team session. The session carries on at the server, and guests keep
// drawing; the host's copy catches up with everything from the server on coming back to the team tab.
let awayTeam = null;
function stepAway() {
  let info = null;
  try { info = JSON.parse(sessionStorage.getItem(TEAM_KEY) || "null"); } catch (_) {}
  awayTeam = { ...(info || {}), tab: team.tab };
  team.link.close(); team = null;
  speech.useTeamClock(null);
  applyRoleUI(); renderTeamDlg(); requestRender();
  toast("The team session carries on in its own tab while you look at this one. Go back to the tab marked Team to rejoin.", 7000);
}
function endTeamLocal(reason) {
  awayTeam = null;
  if (!team) return;
  team.link.close(); team = null;
  try { sessionStorage.removeItem(TEAM_KEY); } catch (_) {}
  speech.useTeamClock(null);
  renderPeople(); applyRoleUI(); renderTeamDlg(); requestRender();
  if (reason && isGuestPage) {
    $("endedText").textContent = reason === "removed" ? "The host removed you from the session." : "The host ended the team session. The drawing stays on your screen until you close this page.";
    $("endedDlg").hidden = false;
  }
}
$("endedOk").onclick = () => { $("endedDlg").hidden = true; };
$("invite").onclick = async () => {
  if (isGuestPage) { if (team) { team.link.close(); endTeamLocal(null); toast("You left the session."); } return; }
  $("teamDlg").hidden = false; $("teamErr").hidden = true;
  if (!team) { $("hostName").value = settings.myName || ""; setTimeout(() => $("hostName").focus(), 0); renderShareNote(); }
  renderTeamDlg();
};
// Say plainly what guests will get from this tab. Earlier voice recordings are only shared if the host ticks the box.
function renderShareNote() {
  const voice = doc.audio.filter(a => audioBlobs.has(a.id)).length;
  $("teamShare").textContent = hasContent() || doc.speech.length
    ? "Everyone who joins sees everything already in this tab: the drawing, pictures and every line in What you said. To share none of it, start the session from a new tab (+ New)."
    : "";
  $("shareVoiceRow").hidden = !voice; $("shareVoice").checked = false;
  $("shareVoiceText").textContent = `Also share my ${voice} earlier voice recording${voice === 1 ? "" : "s"} from this tab, so guests can play them back`;
}
$("teamCancel").onclick = $("teamClose").onclick = () => { $("teamDlg").hidden = true; };
$("teamDlg").addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") $("teamDlg").hidden = true; });
// A tab, ready to share: everything gets an id carrying the host's tag, so it can be shared and undone.
function teamBody(name, shareVoice) {
  doc.idPrefix = `h${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 4)}_`;
  for (const e of doc.events) { e.id ||= newId(doc, "e"); e.who ||= "h"; e.by ||= name; }
  for (const s of doc.speech) { s.id ||= newId(doc, "s"); }
  for (const a of doc.audio) if (!shareVoice) a.private = true; else delete a.private;
  const shared = doc.audio.filter(a => !a.private);
  return { shared, body: { name, base: { size0: doc.size0, paper: doc.paper, grid: doc.grid, title: doc.title, created: doc.created }, events: doc.events, speech: doc.speech, assets: doc.assets, audio: shared, clock: speech.now() } };
}
$("teamBack").onclick = () => { $("teamDlg").hidden = true; if (awayTeam) switchTab(awayTeam.tab); };
// Moves the session to the tab open now. The tab being left keeps everything the team did in it, voices included.
$("teamShareHere").onclick = async () => {
  if (!awayTeam || tabBusy) return;
  const btn = $("teamShareHere"); btn.disabled = true; tabBusy = true;
  const info = awayTeam, oldTab = tabOf(info.tab);
  try {
    if (speech.isRunning()) await stopRec();
    const { body } = teamBody(info.name || settings.myName || "Host", false);
    const r = await fetch("/api/team/switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const res = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(res.error || "the server refused");
    if (oldTab) {   // the old team tab: bring it up to date with what the team did, and fetch everyone's voices
      const rec = await readTab(oldTab.id), prev = res.previous;
      if (rec?.doc && prev) {
        const d = rec.doc, blobs = new Map(rec.audio || []);
        d.events = prev.events; d.speech = prev.speech;
        d.audio = [...(d.audio || []).filter(a => a.private && !prev.audio.some(b => b.id === a.id)), ...prev.audio];
        for (const [id, url] of Object.entries(prev.assets || {})) if (safeAsset(url)) d.assets[id] = url;
        d.team = prev.members?.map(m => ({ name: m.name, host: m.host })) || d.team;
        for (const a of prev.audio) if (!blobs.has(a.id)) {
          try { const ar = await fetch(`/api/team/audio/${encodeURIComponent(a.id)}?token=${encodeURIComponent(info.token)}`); if (ar.ok) blobs.set(a.id, await ar.blob()); } catch (_) {}
        }
        rec.audio = [...blobs];
        tabInfo(oldTab, d);
        await idbDo("readwrite", st => st.put(rec, "tab:" + oldTab.id));
      }
    }
    awayTeam = null;
    beginTeam({ ...info, tab: curTab, startEpoch: res.startEpoch, serverNow: res.serverNow, clientNow: Date.now() });
    $("teamDlg").hidden = true; renderTabs();
    toast(`Everyone is in “${tabLabel(tabOf(curTab))}” now. “${oldTab ? tabLabel(oldTab) : "The old tab"}” keeps what was done there.`, 7000);
  } catch (e) {
    toast(`Couldn't move the team to this tab: ${e.message}`, 7000);
  } finally { btn.disabled = false; tabBusy = false; }
};
$("teamGo").onclick = async () => {
  const name = $("hostName").value.trim() || "Host", go = $("teamGo");
  settings.myName = name; saveSettings();
  go.disabled = true; go.textContent = "Making the secure link…"; $("teamErr").hidden = true; teamStarting = true;
  try {
    if (speech.isRunning()) await stopRec();
    const { shared, body } = teamBody(name, $("shareVoice").checked);
    const r = await fetch("/api/team/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const res = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(res.error || "the server refused");
    beginTeam({ id: res.id, name, color: res.color, token: res.token, host: true, startEpoch: res.startEpoch, serverNow: res.serverNow, url: res.url, code: res.code, tab: curTab });
    for (const a of shared) { const b = audioBlobs.get(a.id); if (b) uploadAudio(a, b); }   // so guests can play back earlier talking too, if the host chose to
    renderTeamDlg();
  } catch (e) {
    $("teamErr").textContent = `Couldn't start the team session: ${e.message}`; $("teamErr").hidden = false;
  } finally { go.disabled = false; go.textContent = "Start team session"; teamStarting = false; }
};
$("copyInvite").onclick = async () => {
  const text = `Join my SketchCollab session: ${team?.url}\nJoin code: ${team?.code}\n(Open it in Chrome or Edge and allow the microphone.)`;
  try { await navigator.clipboard.writeText(text); toast("Invite copied. Paste it into a message to your team."); }
  catch (_) { toast("Couldn't copy here. Select the link and code to copy them yourself."); }
};
$("teamEnd").onclick = async () => {
  try { await fetch("/api/team/end", { method: "POST" }); } catch (_) {}
  endTeamLocal(null); $("teamDlg").hidden = true; toast("Team session ended. The drawing and everything said stay here: save or send it to Claude as usual.", 6000);
};
function showJoin(err) {
  $("joinDlg").hidden = false; $("joinName").value ||= settings.myName || "";
  $("joinErr").textContent = err || ""; $("joinErr").hidden = !err;
  setTimeout(() => ($("joinName").value ? $("joinCode") : $("joinName")).focus(), 0);
}
$("joinDlg").addEventListener("keydown", e => e.stopPropagation());
$("joinForm").onsubmit = async e => {
  e.preventDefault();
  const name = $("joinName").value.trim(), code = $("joinCode").value.trim();
  if (!name || !code) return;
  $("joinGo").disabled = true;
  try {
    const r = await fetch("/api/team/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, code }) });
    const res = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(res.error || "Couldn't join.");
    settings.myName = name; saveSettings();
    $("joinDlg").hidden = true;
    beginTeam({ id: res.id, name: res.name, color: res.color, token: res.token, host: false, startEpoch: res.startEpoch, serverNow: res.serverNow });
  } catch (err) { showJoin(err.message); } finally { $("joinGo").disabled = false; }
};
function resumeTeam() {
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(TEAM_KEY) || "null"); } catch (_) {}
  if (saved && !isGuestPage && saved.host) {
    saved.tab ||= curTab;   // a session started before tabs could be left
    if (saved.tab !== curTab && tabOf(saved.tab)) { awayTeam = saved; renderTabs(); renderPeople(); }
    else beginTeam(saved);
  } else if (saved && saved.host === !isGuestPage) beginTeam(saved);
  else if (isGuestPage) showJoin();
}

buildToolbar(); applyTheme();
document.querySelectorAll(".tool[data-tool]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.tool === settings.tool)));
setMic(speech.hasSpeech ? "off" : "none");
rebuild(); renderTimeline(); renderPages(); updateCursor(); checkServer(); applyRoleUI();
if (isGuestPage) { renderTabs(); renderGoals(); resumeTeam(); } else openTabs().then(() => { tabsReady = true; resumeTeam(); checkInbox(); });
document.fonts?.ready.then(() => { redrawAll(); });

// For testing from the browser console.
window.SketchCollab = { get doc() { return doc; }, get state() { return state; }, get team() { return team; }, commit, undo, redo, buildMoments, setTool, get sel() { return sel; }, momentCanvas, wordsText, storyboardCanvas, exportSession, addSegment, fit, get view() { return V; } };
