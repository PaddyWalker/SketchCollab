// The drawing is a list of events. The current picture is what you get by playing them in order,
// which is what makes exact playback, undo and the moment pictures possible.
//
// A piece is one thing on a layer: a stroke, shape, text, picture, fill or gradient. Each piece has a
// transform (tf), optional clips (keep only inside) and masks (cut away), and erasers (strokes that
// rub parts out). Clips, masks and erasers are stored in the piece's own coordinates, so they move
// with it.

import { I, mul, applyM, inv, scaleOf, translate, boxOfPoints, padBox, interBox, transformBox, pointInPoly, distToSeg } from "./util.js";

export const DEFAULT_SIZE = { w: 2000, h: 1250 };
export const PAPERS = { white: "#ffffff", grey: "#e8eaee", dark: "#1d2027" };

export function newDoc(size = DEFAULT_SIZE) {
  return {
    app: "SketchCollab", version: 2, created: new Date().toISOString(), title: "",
    size0: { ...size }, paper: "white", grid: true,
    events: [], speech: [], audio: [], assets: {}, nextId: 1,
  };
}
export const newId = (doc, prefix = "p") => prefix + doc.nextId++;

export function initialState(doc) {
  return {
    size: { ...doc.size0 },
    layers: [{ id: "l0", name: "Layer 1", visible: true, locked: false, opacity: 1 }],
    pieces: new Map(),
    order: { l0: [] },
  };
}

function clonePiece(p) {
  return { ...p, tf: [...(p.tf || I)], clips: [...(p.clips || [])], masks: [...(p.masks || [])], erasers: [...(p.erasers || [])] };
}
export function toLocal(clip, p) {
  if (clip.type === "poly") { const m = inv(p.tf); return { type: "poly", pts: clip.pts.map(q => applyM(m, q[0], q[1])) }; }
  return clip;   // bitmap clips are made in the piece's own coordinates
}
function removeFromOrder(state, id) {
  for (const k in state.order) { const a = state.order[k], i = a.indexOf(id); if (i >= 0) { a.splice(i, 1); return k; } }
  return null;
}

// Apply one event. Returns which layers changed, and `append` when a piece was only added on top
// (so the layer can be drawn on instead of redrawn).
export function apply(state, ev) {
  const out = { layers: new Set(), append: null, layersChanged: false, sizeChanged: false };
  const touch = id => { const p = state.pieces.get(id); if (p) out.layers.add(p.layer); return p; };
  switch (ev.type) {
    case "add": {
      const p = clonePiece(ev.piece);
      if (!state.order[p.layer]) break;
      state.pieces.set(p.id, p); state.order[p.layer].push(p.id);
      out.layers.add(p.layer); out.append = { layer: p.layer, id: p.id };
      break;
    }
    case "addMany":
      for (const q of ev.pieces) { const p = clonePiece(q); if (!state.order[p.layer]) continue; state.pieces.set(p.id, p); state.order[p.layer].push(p.id); out.layers.add(p.layer); }
      break;
    case "batch":
      for (const sub of ev.events) {
        const r = apply(state, sub);
        r.layers.forEach(l => out.layers.add(l));
        out.layersChanged ||= r.layersChanged; out.sizeChanged ||= r.sizeChanged;
      }
      break;
    case "erase":
      for (const id of ev.targets) {
        const p = touch(id); if (!p) continue;
        const m = inv(p.tf), k = 1 / scaleOf(p.tf);
        p.erasers = [...p.erasers, { pts: ev.stroke.pts.map(q => { const [x, y] = applyM(m, q[0], q[1]); return [x, y, q[2]]; }), size: ev.stroke.size * k, pressureSize: ev.stroke.pressureSize }];
      }
      break;
    case "tf":
      for (const id of ev.ids) { const p = touch(id); if (p) p.tf = mul(ev.m, p.tf); }
      break;
    case "delete":
      for (const id of ev.ids) { touch(id); state.pieces.delete(id); removeFromOrder(state, id); }
      break;
    case "cut":
      for (const c of ev.cuts) {
        const p = touch(c.src); if (!p) continue;
        const clip = toLocal(c.clip, p), np = clonePiece(p);
        np.id = c.newId; np.clips.push(clip);
        if (!c.copy) p.masks = [...p.masks, clip];
        state.pieces.set(np.id, np);
        const a = state.order[p.layer]; a.splice(a.indexOf(p.id) + 1, 0, np.id);
      }
      break;
    case "text": {
      const p = touch(ev.id); if (p) { Object.assign(p, ev.props); boxCache.delete(p); }
      break;
    }
    case "setLayer":
      if (!state.order[ev.layer]) break;
      for (const id of ev.ids) { const p = touch(id); if (!p) continue; removeFromOrder(state, id); p.layer = ev.layer; state.order[ev.layer].push(id); }
      out.layers.add(ev.layer);
      break;
    case "order":
      for (const id of ev.dir === "back" || ev.dir === "down" ? [...ev.ids].reverse() : ev.ids) {
        const p = touch(id); if (!p) continue;
        const a = state.order[p.layer], i = a.indexOf(id); a.splice(i, 1);
        const j = ev.dir === "front" ? a.length : ev.dir === "back" ? 0 : ev.dir === "up" ? Math.min(a.length, i + 1) : Math.max(0, i - 1);
        a.splice(j, 0, id);
      }
      break;
    case "layer": applyLayer(state, ev, out); break;
    case "canvas": {
      const dx = ev.anchor === "center" ? (ev.w - state.size.w) / 2 : 0, dy = ev.anchor === "center" ? (ev.h - state.size.h) / 2 : 0;
      state.size = { w: ev.w, h: ev.h };
      if (dx || dy) for (const p of state.pieces.values()) p.tf = mul(translate(dx, dy), p.tf);
      out.sizeChanged = true;
      break;
    }
    // "point" events only matter for the timeline.
  }
  return out;
}

function applyLayer(state, ev, out) {
  const L = state.layers, i = L.findIndex(l => l.id === ev.id);
  out.layersChanged = true;
  switch (ev.op) {
    case "add": {
      const at = ev.above ? L.findIndex(l => l.id === ev.above) + 1 : L.length;
      L.splice(at > 0 ? at : L.length, 0, { id: ev.id, name: ev.name, visible: true, locked: false, opacity: 1 });
      state.order[ev.id] = [];
      break;
    }
    case "delete":
      if (i < 0 || L.length < 2) break;
      for (const id of state.order[ev.id]) state.pieces.delete(id);
      delete state.order[ev.id]; L.splice(i, 1);
      break;
    case "rename": if (i >= 0) L[i].name = ev.name; break;
    case "visible": if (i >= 0) L[i].visible = ev.value; break;
    case "lock": if (i >= 0) L[i].locked = ev.value; break;
    case "opacity": if (i >= 0) L[i].opacity = ev.value; break;
    case "move": {
      const j = i + ev.dir;
      if (i >= 0 && j >= 0 && j < L.length) { const [l] = L.splice(i, 1); L.splice(j, 0, l); }
      break;
    }
  }
}

export function replay(doc, upto = doc.events.length) {
  const s = initialState(doc);
  for (let i = 0; i < upto; i++) apply(s, doc.events[i]);
  return s;
}

// ---------- boxes and hit tests ----------
const boxCache = new WeakMap();
export function localBox(p) {
  let b = boxCache.get(p);
  if (b !== undefined) return b;
  switch (p.kind) {
    case "stroke": b = padBox(boxOfPoints(p.pts), p.size * (p.pressureSize ? 0.9 : 0.55) + 2); break;
    case "shape": b = padBox(boxOfPoints([[p.x0, p.y0], [p.x1, p.y1]]), p.width * (p.shape === "arrow" ? 4 : 1) + 2); break;
    case "text": case "image": b = { x0: p.x, y0: p.y, x1: p.x + p.w, y1: p.y + p.h }; break;
    case "gradient": b = boxOfPoints(p.area); break;
    default: b = null;
  }
  for (const c of p.clips || []) b = interBox(b, c.type === "poly" ? boxOfPoints(c.pts) : { x0: c.x, y0: c.y, x1: c.x + c.w, y1: c.y + c.h });
  boxCache.set(p, b);
  return b;
}
export const docBox = p => transformBox(p.tf, localBox(p));

export function hitTest(p, x, y, tol) {
  const [lx, ly] = applyM(inv(p.tf), x, y), t = tol / scaleOf(p.tf);
  const b = localBox(p);
  if (!b || lx < b.x0 - t || lx > b.x1 + t || ly < b.y0 - t || ly > b.y1 + t) return false;
  for (const c of p.clips) if (c.type === "poly" && !pointInPoly(lx, ly, c.pts)) return false;
  for (const c of p.masks) if (c.type === "poly" && pointInPoly(lx, ly, c.pts)) return false;
  switch (p.kind) {
    case "stroke": {
      const r = p.size * (p.pressureSize ? 0.8 : 0.5) + t, q = p.pts;
      if (q.length === 1) return Math.hypot(lx - q[0][0], ly - q[0][1]) <= r;
      for (let i = 1; i < q.length; i++) if (distToSeg(lx, ly, q[i - 1][0], q[i - 1][1], q[i][0], q[i][1]) <= r) return true;
      return false;
    }
    case "shape": {
      const r = p.width / 2 + t;
      if (p.shape === "line" || p.shape === "arrow") return distToSeg(lx, ly, p.x0, p.y0, p.x1, p.y1) <= r;
      const x0 = Math.min(p.x0, p.x1), x1 = Math.max(p.x0, p.x1), y0 = Math.min(p.y0, p.y1), y1 = Math.max(p.y0, p.y1);
      if (p.shape === "rect") {
        const inside = lx >= x0 && lx <= x1 && ly >= y0 && ly <= y1;
        if (p.fill && inside) return true;
        return inside ? Math.min(lx - x0, x1 - lx, ly - y0, y1 - ly) <= r : true;
      }
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.max(1, (x1 - x0) / 2), ry = Math.max(1, (y1 - y0) / 2);
      const d = Math.hypot((lx - cx) / rx, (ly - cy) / ry);
      return p.fill ? d <= 1 + r / Math.min(rx, ry) : Math.abs(d - 1) * Math.min(rx, ry) <= r;
    }
    default: return true;
  }
}

// Points to test whether a piece is inside a selection area.
export function samplePoints(p) {
  if (p.kind === "stroke") {
    const step = Math.max(1, Math.floor(p.pts.length / 60));
    return p.pts.filter((_, i) => i % step === 0).map(q => applyM(p.tf, q[0], q[1]));
  }
  const b = localBox(p); if (!b) return [];
  const xs = [b.x0, (b.x0 + b.x1) / 2, b.x1], ys = [b.y0, (b.y0 + b.y1) / 2, b.y1], out = [];
  for (const x of xs) for (const y of ys) out.push(applyM(p.tf, x, y));
  return out;
}

// Everything an event touched, for the moment pictures.
export function touchedIds(ev, acc = new Set()) {
  switch (ev.type) {
    case "add": acc.add(ev.piece.id); break;
    case "addMany": ev.pieces.forEach(p => acc.add(p.id)); break;
    case "batch": ev.events.forEach(e => touchedIds(e, acc)); break;
    case "erase": ev.targets.forEach(id => acc.add(id)); break;
    case "tf": case "setLayer": case "order": case "delete": ev.ids.forEach(id => acc.add(id)); break;
    case "cut": ev.cuts.forEach(c => acc.add(c.newId)); break;
    case "text": acc.add(ev.id); break;
  }
  return acc;
}
