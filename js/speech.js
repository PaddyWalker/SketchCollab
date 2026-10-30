// The session clock, speech-to-text, and recording your voice for playback.
// The clock runs while you are talking. While you aren't, it steps forward a little with each thing you
// do, so drawing and typed notes still come in order and in separate moments.

let base = 0, since = null;
// In a team session everyone shares one clock that always runs (time since the session began, on the server).
let teamNow = null, talking = false;
export const now = () => teamNow ? Math.round(teamNow()) : Math.round(base + (since !== null ? performance.now() - since : 0));
export const isRunning = () => teamNow ? talking : since !== null;
export function setClock(ms) { base = ms; since = null; }
export function step(ms) { if (!teamNow && since === null) base += ms; }
export function useTeamClock(fn) {
  if (fn) { teamNow = fn; return; }
  if (teamNow) { base = now(); since = talking ? performance.now() : null; teamNow = null; }   // carry on from the team's time
}
const PAUSE = 3000;   // gap between talking and not talking, so neither steals the other's moments

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const hasSpeech = !!SR;

let cb = {}, rec = null, starts = {}, micBlocked = false, failTimes = [];
// Speech-to-text is Chrome's, and it can stop or stall on its own. It's kept going until Stop is pressed: restarted
// after every end, retried after failures (never given up on), and restarted if it goes quiet while the mic hears
// someone. What happened is noted (cb.onLog), so a session shows why any words are missing.
let lastHeard = 0, lastWords = 0, restarts = 0, watchdog = null, level = null;
let gen = 0, audio = null;   // gen: which Start press the audio belongs to

export function start(callbacks) {
  cb = callbacks;
  talking = true;
  if (!teamNow) { if (base > 0) base += PAUSE; since = performance.now(); }
  gen++;
  lastWords = lastHeard = Date.now();
  startSpeech(); startAudio(gen);
  clearInterval(watchdog);
  watchdog = setInterval(checkSpeech, 5000);
}
const log = (e, detail = "") => cb.onLog?.({ t: now(), e, ...(detail ? { detail } : {}) });
// Someone has been talking for a while and no words have come back: speech-to-text has stalled, so restart it.
function checkSpeech() {
  if (!isRunning() || micBlocked) return;
  const quietFor = Date.now() - lastWords;
  if (quietFor > 25000 && Date.now() - lastHeard < 8000) {
    log("stalled", `no words for ${Math.round(quietFor / 1000)}s while the mic heard talking`);
    lastWords = Date.now();
    cb.onMic?.("error");
    restartSpeech();
  }
}
function restartSpeech() {
  const old = rec; rec = null;
  if (old) { old.onend = null; old.onerror = null; old.onresult = null; try { old.abort(); } catch (_) {} }
  restarts++;
  setTimeout(() => { if (isRunning() && !rec) startSpeech(); }, 300);
}
// Resolves once the last audio has been handed over, so nothing arrives late.
export function stop() {
  const end = now();
  talking = false;
  if (!teamNow) { base = end + PAUSE; since = null; }
  clearInterval(watchdog); watchdog = null;
  if (rec) { const r = rec; rec = null; r.onend = () => { cb.onInterim?.(""); if (!micBlocked) cb.onMic?.("off"); }; try { r.stop(); } catch (_) {} }
  cb.onInterim?.("");
  return stopAudio(end);
}

function startSpeech() {
  if (!SR) { cb.onMic?.("none"); cb.onToast?.("This browser has no speech-to-text. Use Chrome or Edge, or type notes (Win+H dictates into the note box).", 8000); return; }
  if (micBlocked) { cb.onMic?.("blocked"); cb.onToast?.("The microphone is blocked for this page. Click the mic icon in the address bar, allow it, then reload.", 8000); return; }
  const r = new SR(); rec = r;
  r.lang = navigator.language || "en-US"; r.continuous = true; r.interimResults = true;
  r.onstart = () => { starts = {}; cb.onMic?.("on"); };
  r.onresult = e => {
    failTimes = []; lastWords = Date.now();
    const interim = [];
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i], txt = res[0].transcript.trim();
      if (starts[i] === undefined) starts[i] = Math.max(0, now() - 700);
      if (res.isFinal) { if (txt && starts[i] !== null) cb.onSegment?.({ t0: starts[i], t1: now(), text: txt, src: "said" }); starts[i] = null; }
      else if (txt) interim.push(txt);
    }
    cb.onInterim?.(interim.join(" "));
  };
  r.onerror = e => {
    if (e.error !== "no-speech") log("error", e.error);
    if (e.error === "not-allowed" || e.error === "service-not-allowed") { micBlocked = true; cb.onMic?.("blocked"); cb.onToast?.("The microphone is blocked for this page. Click the mic icon in the address bar, allow it, then reload.", 8000); }
    else if (e.error === "audio-capture") { cb.onMic?.("error"); cb.onToast?.("No microphone was found. Check one is plugged in and turned on in Windows sound settings.", 8000); }
    else if (e.error === "network") { failTimes.push(Date.now()); cb.onToast?.("Speech-to-text needs an internet connection. Retrying…"); }
  };
  r.onend = () => {
    cb.onInterim?.("");
    failTimes = failTimes.filter(t => Date.now() - t < 15000);
    if (rec !== r || !isRunning() || micBlocked) return;
    // Chrome stops after a silence, or when something goes wrong: start again. After several failures in a row,
    // wait a little longer, but keep trying until Stop is pressed.
    const wait = failTimes.length >= 4 ? 10000 : 250;
    if (failTimes.length >= 4) { cb.onMic?.("error"); log("failing", "retrying in 10s"); }
    setTimeout(() => {
      if (rec !== r || !isRunning()) return;
      try { r.start(); } catch (err) { log("restart failed", String(err?.name || err)); restartSpeech(); }   // a fresh one instead
    }, wait);
  };
  try { r.start(); } catch (err) { log("start failed", String(err?.name || err)); setTimeout(() => { if (rec === r && isRunning()) restartSpeech(); }, 1000); }
}

async function startAudio(myGen) {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch (_) { return; }   // speech-to-text reports mic problems itself
  if (myGen !== gen || !isRunning()) { stream.getTracks().forEach(t => t.stop()); return; }   // stopped or restarted meanwhile
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(m => MediaRecorder.isTypeSupported(m)) || "";
  let recorder;
  try { recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); } catch (_) { stream.getTracks().forEach(t => t.stop()); return; }
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  audio = { recorder, stream, chunks, t0: now(), onDone: cb.onAudio };
  recorder.start(1000);
  try {   // how loud the mic is, a few times a second: talking counts as heard
    const ac = new AudioContext(), an = ac.createAnalyser(), buf = new Uint8Array(512);
    an.fftSize = 512; ac.createMediaStreamSource(stream).connect(an);
    const a = audio;
    level = setInterval(() => {
      if (audio !== a) { clearInterval(level); ac.close(); return; }
      an.getByteTimeDomainData(buf);
      let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      if (peak > 18) lastHeard = Date.now();
    }, 250);
  } catch (_) {}
}
function stopAudio(end) {
  const a = audio; audio = null;
  if (!a) return Promise.resolve();
  return new Promise(res => {
    a.recorder.onstop = () => {
      a.stream.getTracks().forEach(t => t.stop());
      if (a.chunks.length) a.onDone?.({ t0: a.t0, dur: Math.max(0, end - a.t0), blob: new Blob(a.chunks, { type: a.recorder.mimeType || "audio/webm" }) });
      res();
    };
    try { a.recorder.stop(); } catch (_) { a.stream.getTracks().forEach(t => t.stop()); res(); }
  });
}
