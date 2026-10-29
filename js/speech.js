// The session clock, speech-to-text, and recording your voice for playback.
// The clock runs while you are talking. While you aren't, it steps forward a little with each thing you
// do, so drawing and typed notes still come in order and in separate moments.

let base = 0, since = null;
export const now = () => Math.round(base + (since !== null ? performance.now() - since : 0));
export const isRunning = () => since !== null;
export function setClock(ms) { base = ms; since = null; }
export function step(ms) { if (since === null) base += ms; }
const PAUSE = 3000;   // gap between talking and not talking, so neither steals the other's moments

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const hasSpeech = !!SR;

let cb = {}, rec = null, starts = {}, micBlocked = false, failTimes = [];
let gen = 0, audio = null;   // gen: which Start press the audio belongs to

export function start(callbacks) {
  cb = callbacks;
  if (base > 0) base += PAUSE;
  since = performance.now();
  gen++;
  startSpeech(); startAudio(gen);
}
// Resolves once the last audio has been handed over, so nothing arrives late.
export function stop() {
  const end = now();
  base = end + PAUSE; since = null;
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
    failTimes = [];
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
    if (e.error === "not-allowed" || e.error === "service-not-allowed") { micBlocked = true; cb.onMic?.("blocked"); cb.onToast?.("The microphone is blocked for this page. Click the mic icon in the address bar, allow it, then reload.", 8000); }
    else if (e.error === "audio-capture") { cb.onMic?.("error"); cb.onToast?.("No microphone was found. Check one is plugged in and turned on in Windows sound settings.", 8000); }
    else if (e.error === "network") { failTimes.push(Date.now()); cb.onToast?.("Speech-to-text needs an internet connection. Retrying…"); }
  };
  r.onend = () => {
    cb.onInterim?.("");
    failTimes = failTimes.filter(t => Date.now() - t < 15000);
    if (rec === r && isRunning() && !micBlocked && failTimes.length < 4) setTimeout(() => { if (rec === r && isRunning()) try { r.start(); } catch (_) {} }, 250);   // Chrome stops after a silence
    else if (rec === r && isRunning() && failTimes.length >= 4) { cb.onMic?.("error"); cb.onToast?.("Speech-to-text keeps failing, so the timer runs without it. Type notes, or stop and start again.", 9000); }
  };
  try { r.start(); } catch (_) {}
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
