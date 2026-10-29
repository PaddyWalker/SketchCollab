// The live connection for a team session: one WebSocket to the host's SketchCollab server.
// It reconnects by itself, queues changes made while offline, and keeps the link alive through the secure link.

export class TeamLink {
  constructor(token, { onMessage, onStatus }) {
    this.token = token; this.onMessage = onMessage; this.onStatus = onStatus;
    this.queue = []; this.closed = false; this.ws = null; this.retry = 0;
    this.connect();
    this.pinger = setInterval(() => this.send({ t: "ping" }, false), 20000);   // the secure link drops quiet connections
  }
  connect() {
    if (this.closed) return;
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/team/ws?token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; this.ready = false; this.onStatus?.("online"); };   // ready once the server's hello has been handled
    ws.onmessage = e => { let msg; try { msg = JSON.parse(e.data); } catch (_) { return; } this.onMessage(msg); };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.onStatus?.("offline");
      if (!this.closed) setTimeout(() => this.connect(), Math.min(8000, 1000 * 2 ** this.retry++));
    };
  }
  // queue = true for changes that must arrive (drawing, words); false for things that only matter right now (cursors).
  // Until the server's hello is handled, changes wait in the queue, so they always arrive in order.
  send(msg, queue = true) {
    const s = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === 1 && (this.ready || msg.t === "ping")) this.ws.send(s);
    else if (queue) this.queue.push(s);
  }
  flush() { this.ready = true; const q = this.queue; this.queue = []; for (const s of q) this.ws.send(s); }
  get online() { return !!this.ws && this.ws.readyState === 1; }
  close() { this.closed = true; clearInterval(this.pinger); try { this.ws?.close(); } catch (_) {} }
}

// Short-lived things sent many times a second are limited to this rate.
export function throttle(fn, ms) {
  let last = 0, timer = null, args = null;
  return (...a) => {
    args = a;
    const wait = ms - (performance.now() - last);
    if (wait <= 0) { last = performance.now(); fn(...args); }
    else if (!timer) timer = setTimeout(() => { timer = null; last = performance.now(); fn(...args); }, wait);
  };
}
