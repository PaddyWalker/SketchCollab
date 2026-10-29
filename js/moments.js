// Moments: what you said, together with what you did on the drawing while saying it.
// Also builds the saved pictures and the written notes Claude reads.

import { fmt, makeCanvas, colourName, listWords, where, unionBox, isTranslate, scaleOf } from "./util.js";
import { replay, docBox, touchedIds } from "./doc.js";
import { renderComposite, renderPiece, drawPointing, BRUSHES } from "./render.js";

// Layer housekeeping (hide, lock, rename, opacity, reorder) isn't part of the story.
// The pictures a review tab starts with are what the agent built, not something done in the session.
const isAction = ev => !ev.build && (ev.type !== "layer" || ev.op === "add" || ev.op === "delete");
const t0 = ev => ev.t0 ?? 0, t1 = ev => ev.t1 ?? ev.t0 ?? 0;

// People usually say a thing and draw it a second or two later, so words go to the burst that is
// under way when they start, or to the next burst if it starts soon and this one has been going a while.
const GAP = 1500, MAX_BURST = 9000, AHEAD = 6000, SETTLED = 2000;
export function bursts(doc) {
  const out = [];
  doc.events.forEach((ev, i) => {
    if (!isAction(ev)) return;
    const b = out[out.length - 1];
    if (b && t0(ev) - b.end <= GAP && t0(ev) - b.start <= MAX_BURST) { b.evs.push(ev); b.i1 = i; b.end = Math.max(b.end, t1(ev)); }
    else out.push({ start: t0(ev), end: t1(ev), i0: i, i1: i, evs: [ev], segs: [] });
  });
  return out;
}
export function buildMoments(doc) {
  const ms = bursts(doc);
  const segs = [...doc.speech].sort((a, b) => a.t0 - b.t0);
  for (const g of segs) {
    const active = ms.find(b => b.evs.length && g.t0 >= b.start - 500 && g.t0 <= b.end + 1000);
    const next = ms.find(b => b.evs.length && b.start > g.t0 && b.start - g.t0 <= AHEAD);
    let home = active || next;
    if (active && next && next !== active && g.t0 - active.start > SETTLED) home = next;
    if (home) home.segs.push(g);
    else ms.push({ start: g.t0, end: g.t1, evs: [], segs: [g], i0: null, i1: null });
  }
  ms.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const m of ms) {
    const prev = merged[merged.length - 1];
    if (prev && !prev.evs.length && !m.evs.length) { prev.segs.push(...m.segs); prev.end = Math.max(prev.end, m.end); }
    else merged.push(m);
  }
  // Talk-only moments show the drawing as it stood then.
  for (const m of merged) if (m.i0 === null) { let k = 0; doc.events.forEach((ev, i) => { if (t0(ev) <= m.start) k = i + 1; }); m.upto = k; }
  return merged;
}
export function momentRange(m) {
  const a = Math.min(m.start, ...m.segs.map(s => s.t0)), b = Math.max(m.end, ...m.segs.map(s => s.t0));
  return a === b ? fmt(a) : `${fmt(a)} – ${fmt(b)}`;
}
export const momentText = m => m.segs.map(s => `${s.by ? s.by + ": " : ""}${s.src === "typed" ? `(typed) ${s.text}` : s.text}`).join(" ");

// ---------- describing a moment in words ----------
const shapeWord = { rect: "rectangle", ellipse: "ellipse", line: "line", arrow: "arrow" };
function flatten(evs) { const out = []; for (const e of evs) e.type === "batch" ? out.push(...flatten(e.events)) : out.push(e); return out; }
// In a team session, say who did what: "Rachel: Drew 2 lines… Paddy: Moved a piece…".
export function describe(m, doc, before, after) {
  const by = [...new Set(m.evs.map(e => e.by).filter(Boolean))];
  if (!by.length) return describeAll(m, doc, before, after);
  const parts = by.map(b => `${b}: ${describeAll({ ...m, evs: m.evs.filter(e => e.by === b) }, doc, before, after)}`);
  const unnamed = m.evs.filter(e => !e.by);
  if (unnamed.length) parts.unshift(describeAll({ ...m, evs: unnamed }, doc, before, after));
  return parts.join(" ");
}
function describeAll(m, doc, before, after) {
  if (!m.evs.length) return "Nothing changed on the drawing during this part.";
  const W = after.size.w, H = after.size.h, out = [];
  const evs = flatten(m.evs), added = [];
  for (const e of evs) if (e.type === "add") added.push(e.piece); else if (e.type === "addMany" && !e.paste) added.push(...e.pieces);
  const boxOf = ps => ps.reduce((b, p) => unionBox(b, docBox(after.pieces.get(p.id) || p)), null);
  for (const e of evs) if (e.type === "addMany" && e.paste) out.push(`Pasted ${e.pieces.length === 1 ? "a copy of a piece" : `copies of ${e.pieces.length} pieces`}, ${where(boxOf(e.pieces), W, H)}.`);
  const strokes = added.filter(p => p.kind === "stroke" && !p.snapped), snapped = added.filter(p => p.kind === "stroke" && p.snapped);
  if (strokes.length) {
    const tools = listWords(strokes.map(p => (BRUSHES[p.brush]?.label || "pen").toLowerCase()));
    out.push(`Drew ${strokes.length} line${strokes.length > 1 ? "s" : ""} (${tools}) in ${listWords(strokes.map(p => colourName(p.color)))}, ${where(boxOf(strokes), W, H)}.`);
  }
  // Lines that snapped into a clean shape when the pen was held still at the end.
  if (snapped.length) {
    const counts = new Map();
    for (const p of snapped) { const k = `${p.snapped}|${colourName(p.color)}`; counts.set(k, (counts.get(k) || 0) + 1); }
    const plural = name => { const w = name.replace(/^an? /, ""); return / with /.test(w) ? w.replace(/^(\S+)/, "$1s") : w + "s"; };
    const parts = [...counts].map(([k, n]) => { const [name, col] = k.split("|"); return n === 1 ? `${name} in ${col}` : `${n} ${plural(name)} in ${col}`; });
    out.push(`Drew ${listWords(parts)} (snapped clean), ${where(boxOf(snapped), W, H)}.`);
  }
  const shapes = added.filter(p => p.kind === "shape");
  if (shapes.length) out.push(`Drew ${listWords(shapes.map(p => `a ${colourName(p.color)} ${shapeWord[p.shape]}${p.fill ? ` filled ${colourName(p.fill)}` : ""}`))}, ${where(boxOf(shapes), W, H)}.`);
  for (const p of added.filter(p => p.kind === "text")) out.push(`Wrote “${p.text}” in ${colourName(p.color)}, ${where(boxOf([p]), W, H)}.`);
  for (const p of added.filter(p => p.kind === "image")) {
    if (p.source === "bucket") out.push(`Filled an area with ${colourName(p.fillColor)}, ${where(boxOf([p]), W, H)}.`);
    else if (p.source === "paste") out.push(`Pasted a copy, ${where(boxOf([p]), W, H)}.`);
    else out.push(`Added a picture${p.name ? ` (“${p.name}”)` : ""}, ${where(boxOf([p]), W, H)}.`);
  }
  for (const p of added.filter(p => p.kind === "gradient")) out.push(`Added a ${colourName(p.c0)}-to-${colourName(p.c1)} gradient, ${where(boxOf([p]), W, H)}.`);
  for (const e of evs) {
    if (e.type === "erase") { const b = boxOf_pts(e.stroke.pts); out.push(`Erased part of ${e.targets.length === 1 ? "a piece" : e.targets.length + " pieces"}, ${where(b, W, H)}.`); }
    else if (e.type === "cut") out.push(`Cut out part of ${e.cuts.length === 1 ? "a piece" : e.cuts.length + " pieces"}${e.cuts.some(c => c.copy) ? " as a copy" : ""}.`);
    else if (e.type === "tf") {
      const ps = e.ids.map(id => after.pieces.get(id)).filter(Boolean), was = e.ids.map(id => before.pieces.get(id)).filter(Boolean);
      const n = e.ids.length === 1 ? "a piece" : `${e.ids.length} pieces`;
      const from = was.length ? where(was.reduce((b, p) => unionBox(b, docBox(p)), null), W, H) : "";
      const to = where(ps.reduce((b, p) => unionBox(b, docBox(p)), null), W, H);
      if (isTranslate(e.m)) out.push(from && from !== to ? `Moved ${n} from ${from.replace(/^(at|on|in) the /, "the ")} to ${to.replace(/^(at|on|in) the /, "the ")}.` : `Moved ${n}, ${to}.`);
      else out.push(`${scaleOf(e.m) >= 1 ? "Enlarged" : "Shrank"} ${n}, ${to}.`);
    }
    else if (e.type === "delete") out.push(`Deleted ${e.ids.length === 1 ? "a piece" : e.ids.length + " pieces"}.`);
    else if (e.type === "text") out.push(`Changed some text to “${e.props.text}”.`);
    else if (e.type === "setLayer") out.push(`Moved ${e.ids.length === 1 ? "a piece" : e.ids.length + " pieces"} to the layer “${after.layers.find(l => l.id === e.layer)?.name || "?"}”.`);
    else if (e.type === "order") out.push(`Brought ${e.ids.length === 1 ? "a piece" : e.ids.length + " pieces"} ${e.dir === "back" || e.dir === "down" ? "behind others" : "in front of others"}.`);
    else if (e.type === "layer" && e.op === "add") out.push(`Added a layer “${e.name}”.`);
    else if (e.type === "layer" && e.op === "delete") out.push(`Deleted a layer.`);
    else if (e.type === "canvas") out.push(`Changed the drawing size to ${e.w} × ${e.h}.`);
  }
  const points = evs.filter(e => e.type === "point" && e.pts.length);
  if (points.length) {
    const spots = [...new Set(points.map(p => { const e = p.pts[p.pts.length - 1]; return where({ x0: e[0], x1: e[0], y0: e[1], y1: e[1] }, W, H); }))];
    out.push(`Pointed ${points.length === 1 ? "once" : points.length + " times"}, ${spots.join(" and ")}.`);
  }
  return out.join(" ") || "Small changes only.";
}
function boxOf_pts(pts) { let b = null; for (const p of pts) b = unionBox(b, { x0: p[0], y0: p[1], x1: p[0], y1: p[1] }); return b; }

// The states either side of a moment.
export function momentStates(doc, m) {
  if (m.i0 === null) { const s = replay(doc, m.upto); return { before: s, after: s }; }
  return { before: replay(doc, m.i0), after: replay(doc, m.i1 + 1) };
}

// ---------- pictures ----------
export const CAP = 170;
export function tileSize(size) { const k = Math.min(1200 / size.w, 900 / size.h); return { w: Math.round(size.w * k), h: Math.round(size.h * k) }; }
function wrapLines(ctx, text, maxW, maxLines) {
  const words = text.split(/\s+/).filter(Boolean), lines = []; let line = "";
  for (const w of words) {
    const t = line ? line + " " + w : w;
    if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; if (lines.length === maxLines) break; } else line = t;
  }
  if (lines.length < maxLines && line) lines.push(line);
  else if (lines.length === maxLines) { let l = lines[maxLines - 1]; while (ctx.measureText(l + " …").width > maxW && l.includes(" ")) l = l.slice(0, l.lastIndexOf(" ")); lines[maxLines - 1] = l + " …"; }
  return lines;
}
export function momentCanvas(doc, m, n, total) {
  const { after } = momentStates(doc, m);
  const touched = new Set(); m.evs.forEach(e => touchedIds(e, touched));
  const fade = flatten(m.evs).some(e => e.type !== "point");   // a moment of only pointing shows the drawing as it is
  // Everything else faded; what changed drawn on top at full strength with a glow, whatever its layer's opacity.
  const big = renderComposite(after, doc, { pieceOpts: p => !fade ? {} : touched.has(p.id) ? { alpha: 0 } : { alpha: 0.3 } });
  const bx = big.getContext("2d");
  if (fade) for (const L of after.layers) if (L.visible) for (const id of after.order[L.id]) if (touched.has(id)) renderPiece(bx, after.pieces.get(id), doc, after.size, { glow: "rgba(255, 194, 26, 1)" });
  for (const e of flatten(m.evs)) if (e.type === "point") drawPointing(bx, e.pts);
  const t = tileSize(after.size), wide = Math.max(t.w, 900);
  const out = makeCanvas(wide, t.h + CAP), x = out.getContext("2d");
  x.fillStyle = "#e9ecf2"; x.fillRect(0, 0, wide, t.h);
  x.drawImage(big, (wide - t.w) / 2, 0, t.w, t.h);
  x.fillStyle = "#1f2430"; x.fillRect(0, t.h, wide, CAP);
  x.fillStyle = "#ffc21a"; x.font = '500 24px "IBM Plex Mono", Consolas, monospace';
  x.fillText(`MOMENT ${n} OF ${total}  ·  ${momentRange(m)}`, 28, t.h + 40);
  x.fillStyle = "#ffffff"; x.font = '400 27px "Atkinson Hyperlegible", "Segoe UI", sans-serif';
  const said = momentText(m);
  wrapLines(x, said ? `“${said}”` : "Drawing, no words.", wide - 56, 3).forEach((l, i) => x.fillText(l, 28, t.h + 82 + i * 33));
  return out;
}
export const STORY_MAX = 48;
export function storyboardCanvas(doc, state, moments, imgs, lengthMs) {
  const G = 16, cols = 2, TW = 700, HEAD = 110;
  const shown = imgs.slice(0, STORY_MAX);
  const th = im => Math.round(TW * im.height / im.width);
  const rowsH = []; for (let i = 0; i < shown.length; i += cols) rowsH.push(Math.max(...shown.slice(i, i + cols).map(th)));
  const FW = cols * TW + G, FH = Math.round(Math.min(FW * state.size.h / state.size.w, 1400)), FWd = Math.round(FH * state.size.w / state.size.h);
  const c = makeCanvas(FW + 2 * G, HEAD + FH + G + rowsH.reduce((a, b) => a + b + G, 0) + G + (imgs.length > STORY_MAX ? 50 : 0));
  const x = c.getContext("2d");
  x.fillStyle = "#e9ecf2"; x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = "#1a1e27"; x.font = '800 40px "Bricolage Grotesque", "Segoe UI", sans-serif';
  x.fillText(doc.title ? `SketchCollab: ${doc.title}` : "SketchCollab session", G, 52);
  x.font = '400 22px "Atkinson Hyperlegible", "Segoe UI", sans-serif'; x.fillStyle = "#5a6373";
  x.fillText(`${new Date(doc.created).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}  ·  ${fmt(lengthMs)} long  ·  ${moments.length} moments  ·  Glowing = changed in that moment; pink arrows and rings = pointing.`, G, 88);
  x.drawImage(renderComposite(state, doc), G + (FW - FWd) / 2, HEAD, FWd, FH);
  let y = HEAD + FH + G;
  rowsH.forEach((rh, r) => {
    shown.slice(r * cols, r * cols + cols).forEach((im, k) => x.drawImage(im, G + k * (TW + G), y, TW, th(im)));
    y += rh + G;
  });
  if (imgs.length > STORY_MAX) { x.fillStyle = "#1a1e27"; x.fillText(`${imgs.length - STORY_MAX} more moments are in the session folder.`, G, c.height - 24); }
  return c;
}

// ---------- the written notes ----------
export function wordsText(doc, state, moments, lengthMs, files) {
  const L = [];
  const evs = flatten(doc.events);
  L.push(`# ${doc.title ? "SketchCollab: " + doc.title : "SketchCollab session"}`, "");
  L.push(`${new Date(doc.created).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })} · ${fmt(lengthMs)} long · ${moments.length} moments · drawing ${state.size.w} × ${state.size.h} on ${doc.paper} paper · ${state.layers.length} layer${state.layers.length > 1 ? "s" : ""} · ${evs.filter(e => e.type === "point").length} pointing gestures`, "");
  if (doc.team?.length) L.push(`A team session with ${doc.team.map(p => p.host ? `${p.name} (host)` : p.name).join(", ")}. Each line says who said or did it.`, "");
  L.push("Each moment is something said (or typed) together with what was done on the drawing while saying it.");
  if (files) {
    L.push("In the moment pictures, things changed during that moment glow yellow, everything else is faded, and pointing is a pink dashed arrow (a ring for a tap).", "");
    L.push("![Final drawing](final.png)", "", "Every moment on one page: storyboard.png. Each layer on its own: layers/.", "");
    if (doc.audio.length) L.push("Voice recordings of the session are in audio/ (times in session.json).", "");
  } else L.push("");
  goalsText(doc, L);
  L.push("## Layers", "");
  [...state.layers].reverse().forEach((l, i) => L.push(`- ${l.name}${l.visible ? "" : " (hidden)"}${l.opacity < 1 ? ` (${Math.round(l.opacity * 100)}% opacity)` : ""}: ${state.order[l.id].length} piece${state.order[l.id].length === 1 ? "" : "s"}${files ? `, layers/${String(state.layers.length - i).padStart(2, "0")}.png` : ""}`));
  L.push("", "## Moments", "");
  moments.forEach((m, i) => {
    const { before, after } = momentStates(doc, m);
    L.push(`### ${i + 1} · ${momentRange(m)}`);
    m.segs.forEach(s => L.push(`**${s.by ? `${s.by} ${s.src === "typed" ? "typed" : "said"}` : s.src === "typed" ? "Typed" : "Said"}:** “${s.text}”`, ""));
    L.push(`**On the drawing:** ${describe(m, doc, before, after)}`, "");
    if (files) L.push(`![Moment ${i + 1}](moments/${String(i + 1).padStart(2, "0")}.png)`, "");
  });
  L.push("## Timeline", "", "Exact order of words and drawing. Speech times are when the words were picked up, often a second after they started.", "");
  const lines = [];
  doc.speech.forEach(s => lines.push({ t: s.t0, line: `${s.by ? s.by + " " : ""}${s.src === "typed" ? "typed" : "said"} “${s.text}”` }));
  moments.forEach((m, i) => { if (m.evs.length) { const { before, after } = momentStates(doc, m); lines.push({ t: m.start, line: `drawing: ${describe(m, doc, before, after)} (moment ${i + 1})` }); } });
  lines.sort((a, b) => a.t - b.t).forEach(e => L.push(`- \`${fmt(e.t)}\` ${e.line}`));
  return L.join("\n");
}

// The goals for the build, or in a review tab, the agent's report and what was decided about each goal.
const AGENT = { done: "done", partly: "partly done", "not yet": "not done yet" };
function goalsText(doc, L) {
  const goals = doc.goals || [];
  if (doc.kind === "review") {
    const r = doc.review || {};
    L.push(`## Review of build ${r.round || 1}${r.session ? ` (a build of session ${r.session})` : ""}`, "");
    L.push("The layer “What was built” holds the agent's pictures of the build. Anything drawn on “Your notes” and everything said is the review: marks on a picture point at what to change there.", "");
    if (r.summary) L.push("**The agent's summary:** " + r.summary, "");
    if (r.built?.length) { L.push("**Built:**"); r.built.forEach(b => L.push(`- ${b}`)); L.push(""); }
    if (goals.length) {
      L.push("### Goal by goal", "");
      goals.forEach((g, i) => {
        const parts = [];
        if (g.agent?.status) parts.push(`agent says ${AGENT[g.agent.status] || g.agent.status}${g.agent.note ? ` (${g.agent.note})` : ""}`);
        parts.push(g.verdict === "good" ? "**reviewer: good**" : g.verdict === "change" ? `**reviewer: needs a change**${g.comment ? `: “${g.comment}”` : ""}` : "reviewer: not marked");
        L.push(`${i + 1}. ${g.text} · ${parts.join(" · ")}`);
      });
      L.push("");
    }
    if (doc.goalsState === "approved") L.push("**The reviewer approved this build.**", "");
    return;
  }
  if (!goals.length) return;
  L.push(doc.goalsState === "draft" ? "## Goals for the build (drafted, not yet confirmed)" : "## Goals for the build", "");
  goals.forEach((g, i) => L.push(`${i + 1}. ${g.text}`));
  L.push("");
}
