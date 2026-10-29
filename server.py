"""SketchCollab local server.

Serves the app on http://localhost:8765/ and saves finished sessions into the
"sessions" folder next to this file, so Claude can read them from disk.

Team sessions: the host starts one from the app. The server then opens a secure
link with Cloudflare's free quick tunnel (tools/cloudflared.exe) so up to 10
people can join with a join code. Everyone's drawing, words and voice pass
through here, over one WebSocket per person.

Run:  python server.py        (start.bat does this for you)
It listens on 127.0.0.1 only. Through the secure link, guests can reach only the
app's own page and scripts and the team connection: never saved sessions, never
saving, and never any other file. Everything a guest sends is checked and limited.
"""

import base64
import hashlib
import json
import os
import queue
import re
import secrets
import shutil
import socket
import struct
import subprocess
import sys
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

PORT = 8765
ROOT = Path(__file__).resolve().parent
SESSIONS = ROOT / "sessions"
INBOX = ROOT / "inbox"                 # where agents leave results and goal drafts for the app to pick up
REQUEST_KINDS = ("sketch", "build", "changes", "approved")
IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
CLOUDFLARED = ROOT / "tools" / "cloudflared.exe"
LOCAL_HOSTS = {f"localhost:{PORT}", f"127.0.0.1:{PORT}"}
ALLOWED_ORIGINS = {f"http://localhost:{PORT}", f"http://127.0.0.1:{PORT}"}
SENT_LOG = SESSIONS / "_sent.log"      # one line per "Send to Claude"; Claude watches this file
MAX_BODY = 600 * 1024 * 1024           # a long saved session with photos and voice
MAX_WS_MESSAGE = 12 * 1024 * 1024      # one message from a guest (a pasted photo fits)
MAX_MEMBERS = 10
MAX_EVENTS, MAX_SPEECH, MAX_LAYERS = 20000, 5000, 100
MEMBER_ASSET_BYTES, MEMBER_AUDIO_BYTES, AUDIO_UPLOAD = 40 * 2**20, 60 * 2**20, 25 * 2**20
MEMBER_EVENT_BYTES = 30 * 2**20        # one guest's drawing and words, all together
ROOM_GUEST_BYTES = 400 * 2**20         # everything all guests together may leave in this computer's memory
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
FILE_RE = re.compile(r"^((moments|layers|assets|audio)/)?[A-Za-z0-9_-][A-Za-z0-9_.-]{0,79}$")
ID_RE = re.compile(r"^[A-Za-z0-9_]{1,60}$")
ASSET_RE = re.compile(r"^data:image/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$")
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
AUDIO_TYPES = {"audio/webm", "audio/mp4", "audio/ogg"}
EVENT_TYPES = {"add", "addMany", "batch", "erase", "tf", "delete", "cut", "text", "setLayer", "order", "layer", "canvas", "point"}
COLORS = ["#2563d6", "#d43d33", "#23935a", "#e5892a", "#7b4bc4", "#e56aa6", "#0f8f8f", "#a35a1f", "#5a6373", "#c9a400"]
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
APP_FILES = {"/": "index.html", "/index.html": "index.html"}
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".woff2": "font/woff2"}


# ---------------------------------------------------------------- the secure link
def _kill_on_close_job():
    """A Windows job that ends cloudflared whenever this server ends, even if its window is just closed."""
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class BASIC(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

        class IO(ctypes.Structure):
            _fields_ = [(n, ctypes.c_uint64) for n in ("ReadOps", "WriteOps", "OtherOps", "ReadBytes", "WriteBytes", "OtherBytes")]

        class EXTENDED(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", BASIC), ("IoInfo", IO), ("ProcessMemoryLimit", ctypes.c_size_t),
                        ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateJobObjectW.restype = wintypes.HANDLE
        k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        job = k32.CreateJobObjectW(None, None)
        info = EXTENDED()
        info.BasicLimitInformation.LimitFlags = 0x2000   # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info))
        return k32, job
    except Exception:
        return None


JOB = _kill_on_close_job()


def kill_stale_tunnels():
    """End any cloudflared left over from an earlier run, so an old link can't still reach this computer."""
    if os.name != "nt":
        return
    path = str(CLOUDFLARED).replace("'", "''")
    cmd = ("Get-CimInstance Win32_Process -Filter \"Name='cloudflared.exe'\" | "
           f"Where-Object {{ $_.ExecutablePath -eq '{path}' }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force }}")
    try:
        subprocess.run(["powershell", "-NoProfile", "-Command", cmd], timeout=20, capture_output=True,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except Exception:
        pass


class Tunnel:
    def __init__(self):
        self.proc = None
        self.url = None
        self.lock = threading.Lock()

    def start(self, wait=40):
        with self.lock:
            if self.proc and self.proc.poll() is None and self.url:
                return self.url
            if not CLOUDFLARED.exists():
                raise RuntimeError("the secure-link program (tools/cloudflared.exe) is missing")
            self.url = None
            self.proc = subprocess.Popen([str(CLOUDFLARED), "tunnel", "--no-autoupdate", "--url", f"http://localhost:{PORT}"],
                                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if JOB:
                try:
                    JOB[0].AssignProcessToJobObject(JOB[1], int(self.proc._handle))
                except Exception:
                    pass
            found, proc = threading.Event(), self.proc

            def read():
                for line in proc.stdout:
                    m = re.search(r"https://(?!api\.)[a-z0-9-]+\.trycloudflare\.com", line)
                    if m and not self.url and proc is self.proc:
                        self.url = m.group(0)
                        found.set()
            threading.Thread(target=read, daemon=True).start()
        if not found.wait(wait):
            self.stop()
            raise RuntimeError("Cloudflare didn't give a link in time. Check the internet connection and try again.")
        return self.url

    def stop(self):
        with self.lock:
            proc, self.proc, self.url = self.proc, None, None
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(5)
            except subprocess.TimeoutExpired:
                proc.kill()


TUNNEL = Tunnel()


# ---------------------------------------------------------------- checking what guests send
def new_ids(ev):
    """The ids an event creates (new pieces, cut-outs, layers)."""
    t, out = ev.get("type"), []
    if t == "add":
        out.append((ev.get("piece") or {}).get("id"))
    elif t == "addMany":
        out += [p.get("id") for p in ev.get("pieces") or [] if isinstance(p, dict)]
    elif t == "cut":
        out += [c.get("newId") for c in ev.get("cuts") or [] if isinstance(c, dict)]
    elif t == "layer" and ev.get("op") == "add":
        out.append(ev.get("id"))
    elif t == "batch":
        for e in ev.get("events") or []:
            if isinstance(e, dict):
                out += new_ids(e)
    return out


def event_ok(ev, depth=0):
    """A light check that an event has the shape the app expects, so one bad message can't break everyone's drawing."""
    if not isinstance(ev, dict) or ev.get("type") not in EVENT_TYPES or depth > 2:
        return False
    t = ev["type"]
    lists = {"addMany": "pieces", "batch": "events", "erase": "targets", "tf": "ids", "delete": "ids", "cut": "cuts", "setLayer": "ids", "order": "ids"}
    if t in lists and not isinstance(ev.get(lists[t]), list):
        return False
    if t == "add" and not isinstance(ev.get("piece"), dict):
        return False
    if t == "tf" and not (isinstance(ev.get("m"), list) and len(ev["m"]) == 6 and all(isinstance(v, (int, float)) for v in ev["m"])):
        return False
    if t == "canvas" and not all(isinstance(ev.get(k), (int, float)) and 100 <= ev[k] <= 4096 for k in ("w", "h")):
        return False
    if t == "batch" and not all(event_ok(e, depth + 1) for e in ev["events"]):
        return False
    for p in ([ev.get("piece")] if t == "add" else ev.get("pieces") or [] if t == "addMany" else []):
        if not isinstance(p, dict) or not isinstance(p.get("tf", []), list):
            return False
    return True


def clean_props(props):
    """Brush settings sent with a live line: only short, plain values, so nobody can send something huge or odd to everyone."""
    out = {}
    for k, v in list(props.items())[:40]:
        if not isinstance(k, str) or len(k) > 30:
            continue
        if isinstance(v, bool):
            out[k] = v
        elif isinstance(v, (int, float)) and v == v:
            out[k] = max(-10000, min(10000, v))
        elif isinstance(v, str) and len(v) <= 40:
            out[k] = v
        elif v is None:
            out[k] = None
    return out


def clean_points(pts):
    return [q[:6] for q in pts[:2000] if isinstance(q, list) and 3 <= len(q) and all(isinstance(v, (int, float)) for v in q[:6])]


# ---------------------------------------------------------------- the team room
class Room:
    """One team session: who's in it and everything drawn and said, in the order the server received it."""

    def __init__(self, base, events, speech, assets, audio, clock_ms):
        self.code = self.new_code()
        self.start_epoch = time.time() * 1000 - clock_ms   # the shared clock carries on from the host's
        self.base = base if isinstance(base, dict) else {}
        self.events = list(events)
        self.speech = list(speech)
        self.assets = {k: v for k, v in dict(assets).items() if isinstance(v, str)}
        self.audio = list(audio)
        self.audio_data = {}                               # id -> (mime, bytes)
        self.members = {}                                  # id -> {id, name, color, token, online, host, ...}
        self.conns = {}                                    # id -> WsConn
        self.lock = threading.RLock()
        self.next_guest = 1
        self.ids = {e.get("id") for e in self.events} | {s.get("id") for s in self.speech}
        for e in self.events:
            self.ids.update(new_ids(e))
        self.fails, self.join_attempts = 0, {}
        self.guest_bytes = 0

    @staticmethod
    def new_code():
        return f"{secrets.randbelow(10**8):08d}"

    def add_member(self, name, host=False):
        with self.lock:
            mid = "h" if host else f"g{self.next_guest}"
            if not host:
                self.next_guest += 1
            names = {m["name"].lower() for m in self.members.values()}
            base, n = (name[:30].strip() or "Guest"), 2
            name = base
            while name.lower() in names:   # every name is different, so the notes never mix two people up
                name, n = f"{base} {n}", n + 1
            used = {m["color"] for m in self.members.values()}
            color = next((c for c in COLORS if c not in used), COLORS[len(self.members) % len(COLORS)])
            m = {"id": mid, "name": name, "color": color, "token": secrets.token_urlsafe(24), "online": False, "host": host,
                 "asset_bytes": 0, "audio_bytes": 0, "event_bytes": 0, "rate": [time.time(), 0, 0]}
            self.members[mid] = m
            return m

    def by_token(self, token):
        with self.lock:
            return next((m for m in self.members.values() if token and secrets.compare_digest(m["token"], token)), None)

    def public_members(self):
        with self.lock:
            return [{k: m[k] for k in ("id", "name", "color", "online", "host")} for m in self.members.values()]

    def snapshot(self):
        with self.lock:
            return json.loads(json.dumps({"base": self.base, "events": self.events, "speech": self.speech, "assets": self.assets,
                                          "audio": self.audio, "members": self.public_members(), "startEpoch": self.start_epoch}))

    def broadcast(self, msg, skip=None, only=None):
        data = json.dumps(msg)
        with self.lock:
            conns = [c for mid, c in self.conns.items() if mid != skip and (only is None or mid == only)]
        for c in conns:
            c.send(data)

    def allowed(self, member, kind):
        """Per-person rate limits: drawing changes and quick updates (cursors, live lines) each get a budget per second."""
        now, r = time.time(), member["rate"]
        if now - r[0] >= 1:
            r[0], r[1], r[2] = now, 0, 0
        i = 1 if kind == "change" else 2
        r[i] += 1
        return r[i] <= (60 if kind == "change" else 80)

    def take_bytes(self, member, kind, n, limit):
        """Counts what a guest leaves in memory here, against their own limit and one for all guests together.
        The host's own work isn't limited. Call with the lock held."""
        if member["host"]:
            return True
        if member[kind] + n > limit or self.guest_bytes + n > ROOM_GUEST_BYTES:
            return False
        member[kind] += n
        self.guest_bytes += n
        return True

    def id_ok(self, member, ident):
        """New ids must carry the sender's own tag and must not exist yet, so nobody can overwrite someone else's work."""
        return (isinstance(ident, str) and ID_RE.match(ident) and re.match(rf"^[a-z]{member['id']}[a-z0-9]*_\d+$", ident)
                and ident not in self.ids)

    def handle(self, member, msg):
        """A message from one person: check it, update the shared record and pass it on to everyone else."""
        t = msg.get("t")
        mid, name = member["id"], member["name"]
        if t in ("cursor", "live", "liveEnd"):   # moment-to-moment only: not stored
            if not self.allowed(member, "quick"):
                return
            out = {"t": t, "who": mid}
            if t == "cursor":
                x, y = msg.get("x"), msg.get("y")
                out.update(x=x if isinstance(x, (int, float)) else None, y=y if isinstance(y, (int, float)) else None)
            elif t == "live":
                pts = msg.get("pts") if isinstance(msg.get("pts"), list) else []
                out.update(pts=clean_points(pts), reset=bool(msg.get("reset")))
                if isinstance(msg.get("props"), dict):
                    out["props"] = clean_props(msg["props"])
            return self.broadcast(out, skip=mid)
        if not self.allowed(member, "change"):
            return
        if t == "event":
            ev = msg.get("ev")
            if not event_ok(ev) or not self.id_ok(member, ev.get("id")) or not all(self.id_ok(member, i) for i in new_ids(ev)):
                return
            assets = msg.get("assets") if isinstance(msg.get("assets"), dict) else {}
            size = len(json.dumps(ev))
            with self.lock:
                if len(self.events) >= MAX_EVENTS or not self.take_bytes(member, "event_bytes", size, MEMBER_EVENT_BYTES):
                    return
                if ev.get("type") == "layer" and ev.get("op") == "add" and sum(1 for e in self.events if e.get("type") == "layer" and e.get("op") == "add") >= MAX_LAYERS:
                    return
                clean = {}
                for aid, url in assets.items():
                    if aid in self.assets or not ID_RE.match(str(aid)) or not isinstance(url, str) or not ASSET_RE.match(url):
                        continue   # never overwrite someone else's picture; only real images
                    if not self.take_bytes(member, "asset_bytes", len(url), MEMBER_ASSET_BYTES):
                        continue
                    clean[aid] = url
                ev["who"], ev["by"] = mid, name
                self.assets.update(clean)
                self.events.append(ev)
                self.ids.add(ev["id"])
                self.ids.update(new_ids(ev))
            self.broadcast({"t": "event", "ev": ev, "assets": clean})   # echoed to the sender too, in order
        elif t == "remove":   # undo: your own changes (the host may remove anything)
            with self.lock:
                ev = next((e for e in self.events if e.get("id") == msg.get("id")), None)
                if not ev or (ev.get("who", "h") != mid and not member["host"]):
                    return
                self.events.remove(ev)
                self.ids.discard(ev.get("id"))   # so a redo can bring it back with the same ids
                self.ids.difference_update(new_ids(ev))
            self.broadcast({"t": "remove", "id": msg.get("id")})
        elif t == "speech":
            seg = msg.get("seg")
            if not isinstance(seg, dict) or not self.id_ok(member, seg.get("id")) or not isinstance(seg.get("text"), str):
                return
            seg = {"id": seg["id"], "t0": seg.get("t0") if isinstance(seg.get("t0"), (int, float)) else 0,
                   "t1": seg.get("t1") if isinstance(seg.get("t1"), (int, float)) else 0, "text": seg["text"][:2000],
                   "src": "typed" if seg.get("src") == "typed" else "said", "who": mid, "by": name, "color": member["color"]}
            with self.lock:
                if len(self.speech) >= MAX_SPEECH or not self.take_bytes(member, "event_bytes", len(seg["text"]) + 200, MEMBER_EVENT_BYTES):
                    return
                self.speech.append(seg)
                self.ids.add(seg["id"])
            self.broadcast({"t": "speech", "seg": seg})   # to everyone, including the sender, so nothing typed offline is lost
        elif t in ("speechEdit", "speechDel"):
            with self.lock:
                seg = next((s for s in self.speech if s.get("id") == msg.get("id")), None)
                if not seg or (seg.get("who") != mid and not member["host"]):
                    return
                if t == "speechEdit":
                    seg["text"] = str(msg.get("text", ""))[:2000]
                else:
                    self.speech.remove(seg)
            self.broadcast({"t": t, "id": msg.get("id"), "text": str(msg.get("text", ""))[:2000]}, skip=mid)
        elif t == "meta":
            out = {"t": "meta"}
            with self.lock:
                if msg.get("paper") in ("white", "grey", "dark"):
                    self.base["paper"] = out["paper"] = msg["paper"]
                if isinstance(msg.get("grid"), bool):
                    self.base["grid"] = out["grid"] = msg["grid"]
                if isinstance(msg.get("title"), str):
                    self.base["title"] = out["title"] = msg["title"][:40]
            self.broadcast(out, skip=mid)


ROOM = None
ROOM_LOCK = threading.Lock()


# ---------------------------------------------------------------- WebSocket (just enough of RFC 6455)
class WsConn:
    """One person's connection. Sending goes through a queue and its own thread, so a slow or stuck
    connection only ever holds itself up, and is dropped when it falls too far behind."""

    MAX_QUEUE = 2000

    def __init__(self, handler):
        self.h = handler
        self.q = queue.Queue()
        self.open = True
        threading.Thread(target=self._writer, daemon=True).start()

    def send(self, data, opcode=1):
        if not self.open:
            return
        if self.q.qsize() > self.MAX_QUEUE:
            return self.close()
        self.q.put((data.encode() if isinstance(data, str) else data, opcode))

    def _writer(self):
        while True:
            item = self.q.get()
            if item is None or not self.open:
                break
            data, opcode = item
            n = len(data)
            head = bytes([0x80 | opcode])
            head += bytes([n]) if n < 126 else (bytes([126]) + struct.pack("!H", n) if n < 65536 else bytes([127]) + struct.pack("!Q", n))
            try:
                self.h.wfile.write(head + data)
                self.h.wfile.flush()
            except OSError:
                break
        self.open = False
        self._shutdown()

    def _shutdown(self):
        try:
            self.h.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    def read_message(self):
        """The next complete text message, or None when the connection closes or misbehaves."""
        parts, total = [], 0
        while True:
            hdr = self.h.rfile.read(2)
            if len(hdr) < 2:
                return None
            fin, op, masked, n = hdr[0] & 0x80, hdr[0] & 0x0F, hdr[1] & 0x80, hdr[1] & 0x7F
            if n == 126:
                n = struct.unpack("!H", self.h.rfile.read(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", self.h.rfile.read(8))[0]
            total += n
            if total > MAX_WS_MESSAGE or not masked:   # browsers always mask; anything else isn't a browser
                return None
            mask = self.h.rfile.read(4)
            data = self.h.rfile.read(n)
            if len(data) < n:
                return None
            if n:
                key = (mask * (n // 4 + 1))[:n]
                data = (int.from_bytes(data, "big") ^ int.from_bytes(key, "big")).to_bytes(n, "big")
            if op == 8:      # close
                return None
            if op == 9:      # ping
                self.send(data, opcode=10)
                continue
            if op == 10:     # pong
                continue
            parts.append(data)
            if fin:
                return b"".join(parts).decode("utf-8", "replace")

    def close(self):
        if not self.open:
            return
        self.open = False
        self.q.put(None)
        self._shutdown()


# ---------------------------------------------------------------- the web server
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("  " + (fmt % args) + "\n")

    def via_tunnel(self):
        return bool(self.headers.get("Cf-Ray") or self.headers.get("Cf-Connecting-Ip")) or self.headers.get("Host") not in LOCAL_HOSTS

    def is_host(self):
        """True only for the app opened on this computer, never for anyone arriving through the secure link."""
        return not self.via_tunnel() and self.client_address[0] == "127.0.0.1"

    def host_post_ok(self):
        """Host-only actions must come from SketchCollab's own page, so no other website can trigger them."""
        return (self.is_host() and self.headers.get("Origin") in ALLOWED_ORIGINS
                and (self.headers.get("Content-Type") or "").startswith("application/json"))

    def _send(self, code, body, ctype, extra=()):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in extra:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _reply(self, code, payload):
        self._send(code, json.dumps(payload).encode(), "application/json")

    def _body(self, limit=MAX_BODY):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > limit:
            raise ValueError("missing or too large")
        return json.loads(self.rfile.read(length))

    def do_HEAD(self):
        self._reply(405, {"error": "not allowed"})

    def do_GET(self):
        if self.via_tunnel() and not ROOM:
            return self._reply(403, {"error": "There's no team session running right now."})
        raw = self.path
        if not raw.startswith("/") or raw.startswith("//"):
            return self._reply(404, {"error": "not found"})
        url = urlsplit(raw)
        path, q = url.path, parse_qs(url.query)
        if path == "/api/ping":
            return self._reply(200, {"ok": True, "folder": str(SESSIONS) if self.is_host() else "", "host": self.is_host(),
                                     "team": bool(ROOM), "tunnelReady": CLOUDFLARED.exists()})
        if path == "/api/version":
            # Changes whenever the app's own files change, so an open window can reload itself.
            files = [ROOT / "index.html", *(ROOT / "js").glob("*.js")]
            return self._reply(200, {"version": max((f.stat().st_mtime_ns for f in files if f.exists()), default=0)})
        if path == "/api/team/ws":
            return self.websocket((q.get("token") or [""])[0])
        if path == "/api/inbox":
            if not self.is_host():
                return self._reply(403, {"error": "host only"})
            return self._reply(200, {"items": inbox_list()})
        if path.startswith("/api/inbox/"):
            if not self.is_host():
                return self._reply(403, {"error": "host only"})
            item = inbox_item(path.rsplit("/", 1)[1])
            return self._reply(200, item) if item else self._reply(404, {"error": "not found"})
        if path.startswith("/api/team/audio/"):
            room = ROOM
            member = room and room.by_token((q.get("token") or [""])[0])
            item = member and room.audio_data.get(path.rsplit("/", 1)[1])
            if not item:
                return self._reply(404, {"error": "not found"})
            mime, data = item
            return self._send(200, data, mime, [("Content-Disposition", "attachment"), ("Content-Security-Policy", "sandbox")])
        # Only the app itself is served: its page and its scripts, read straight from known places.
        name = APP_FILES.get(path)
        if not name and (re.fullmatch(r"/js/[a-z0-9_-]+\.js", path) or re.fullmatch(r"/fonts/[a-z0-9_-]+\.woff2", path)):
            name = path[1:]
        target = ROOT / name if name else None
        if not target or not target.is_file():
            return self._reply(404, {"error": "not found"})
        self._send(200, target.read_bytes(), TYPES[target.suffix])

    def do_POST(self):
        global ROOM
        if self.via_tunnel() and not ROOM:
            return self._reply(403, {"error": "There's no team session running right now."})
        path = urlsplit(self.path).path
        try:
            if path == "/api/save":
                return self.save()
            if path == "/api/team/start":
                if not self.host_post_ok():
                    return self._reply(403, {"error": "only the host can start a team session"})
                data = self._body()
                with ROOM_LOCK:
                    if not ROOM:
                        url = TUNNEL.start()
                        ROOM = Room(data.get("base") or {}, data.get("events") or [], data.get("speech") or [],
                                    data.get("assets") or {}, data.get("audio") or [], float(data.get("clock") or 0))
                        ROOM.add_member(str(data.get("name") or "Host"), host=True)
                        print(f"  Team session started: {url} (code {ROOM.code})")
                    host = ROOM.members["h"]
                    return self._reply(200, {"url": TUNNEL.url, "code": ROOM.code, "id": host["id"], "token": host["token"], "name": host["name"],
                                             "color": host["color"], "startEpoch": ROOM.start_epoch, "serverNow": time.time() * 1000})
            if path == "/api/team/end":
                if not self.host_post_ok():
                    return self._reply(403, {"error": "only the host can end the session"})
                with ROOM_LOCK:
                    room, ROOM = ROOM, None
                    TUNNEL.stop()   # close the link first, so nothing can hold it open
                if room:
                    room.broadcast({"t": "ended"})
                    with room.lock:
                        conns = list(room.conns.values())
                    for c in conns:
                        threading.Timer(1.0, c.close).start()
                print("  Team session ended")
                return self._reply(200, {"ok": True})
            if path == "/api/team/kick":
                room = ROOM
                if not self.host_post_ok() or not room:
                    return self._reply(403, {"error": "only the host can remove people"})
                mid = self._body(10000).get("id")
                with room.lock:
                    m = room.members.pop(mid, None) if mid != "h" else None
                    conn = room.conns.pop(mid, None)
                    if m:
                        room.code = Room.new_code()   # a removed person can't come back with the old code
                if conn:
                    conn.send(json.dumps({"t": "removed"}))
                    threading.Timer(1.0, conn.close).start()
                if m:
                    room.broadcast({"t": "members", "members": room.public_members()})
                    room.broadcast({"t": "code", "code": room.code}, only="h")
                return self._reply(200, {"ok": bool(m), "code": room.code})
            if path == "/api/team/join":
                return self.join()
            if path.startswith("/api/inbox/") and path.endswith("/done"):
                if not self.host_post_ok():
                    return self._reply(403, {"error": "host only"})
                return self._reply(200, {"ok": inbox_done(path.split("/")[3])})
            if path == "/api/team/audio":
                return self.audio_upload()
        except (KeyError, ValueError, TypeError) as e:
            return self._reply(400, {"error": str(e)})
        except RuntimeError as e:
            return self._reply(503, {"error": str(e)})
        return self._reply(404, {"error": "not found"})

    def join(self):
        room = ROOM
        if not room:
            return self._reply(404, {"error": "There's no team session running right now."})
        ip = self.headers.get("Cf-Connecting-Ip") or self.client_address[0]
        now = time.time()
        with room.lock:
            if len(room.join_attempts) > 1000:   # forget old tries, so the list can't grow without end
                room.join_attempts = {k: v for k, v in room.join_attempts.items() if v and now - v[-1] < 60}
            tries = [t for t in room.join_attempts.get(ip, []) if now - t < 60]
            if len(tries) >= 10:
                return self._reply(429, {"error": "Too many tries. Wait a minute, then check the join code."})
            room.join_attempts[ip] = tries + [now]
        data = self._body(10000)
        with room.lock:
            if not secrets.compare_digest(str(data.get("code", "")).strip(), room.code):
                room.fails += 1
                if room.fails >= 30:   # lots of wrong guesses overall: change the code, so guessing can't win
                    room.code, room.fails = Room.new_code(), 0
                    room.broadcast({"t": "code", "code": room.code}, only="h")
                return self._reply(403, {"error": "That join code doesn't match. Check it with the person who invited you."})
            if sum(1 for m in room.members.values() if not m["host"]) >= MAX_MEMBERS - 1:
                return self._reply(409, {"error": "This session is full (10 people)."})
            m = room.add_member(re.sub(r"[\x00-\x1f<>\"']", "", str(data.get("name") or "Guest")).strip() or "Guest")
        room.broadcast({"t": "members", "members": room.public_members()})
        return self._reply(200, {"id": m["id"], "token": m["token"], "color": m["color"], "name": m["name"],
                                 "startEpoch": room.start_epoch, "serverNow": time.time() * 1000})

    def audio_upload(self):
        room = ROOM
        member = room and room.by_token(parse_qs(urlsplit(self.path).query).get("token", [""])[0])
        if not member:
            return self._reply(403, {"error": "not in the session"})
        data = self._body(AUDIO_UPLOAD * 2)
        aid, mime = str(data.get("id", "")), str(data.get("type", "")).split(";")[0].strip().lower()
        raw = base64.b64decode(data["base64"])
        if mime not in AUDIO_TYPES or not ID_RE.match(aid) or len(raw) > AUDIO_UPLOAD:
            return self._reply(400, {"error": "not a voice recording"})
        with room.lock:
            mine = (not member["host"] and re.match(rf"^a{member['id']}[a-z0-9]*_\d+$", aid)) or member["host"]
            existing = next((a for a in room.audio if a.get("id") == aid), None)
            if not mine or (existing and existing.get("who", "h") != member["id"]):
                return self._reply(403, {"error": "not allowed"})
            if not room.take_bytes(member, "audio_bytes", len(raw), MEMBER_AUDIO_BYTES):
                return self._reply(413, {"error": "That's all the voice recording this session can keep for you."})
            room.audio_data[aid] = (mime, raw)
            meta = {"id": aid, "t0": data.get("t0") if isinstance(data.get("t0"), (int, float)) else 0,
                    "dur": data.get("dur") if isinstance(data.get("dur"), (int, float)) else 0, "type": mime, "who": member["id"], "by": member["name"]}
            if existing:
                existing.update(meta)   # the host re-sending an earlier recording doesn't list it twice
            else:
                room.audio.append(meta)
        room.broadcast({"t": "audio", "meta": meta}, skip=member["id"])
        return self._reply(200, {"ok": True})

    def websocket(self, token):
        room = ROOM
        member = room and room.by_token(token)
        key = self.headers.get("Sec-WebSocket-Key")
        if not member or not key or "websocket" not in (self.headers.get("Upgrade") or "").lower():
            return self._reply(403, {"error": "not in the session"})
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        # Written by hand: browsers need "HTTP/1.1" here, and this server otherwise answers as HTTP/1.0.
        self.wfile.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                          f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
        self.wfile.flush()
        self.close_connection = True
        conn = WsConn(self)
        with room.lock:
            old = room.conns.get(member["id"])
            room.conns[member["id"]] = conn
            member["online"] = True
        if old:
            old.close()
        try:
            conn.send(json.dumps({"t": "hello", "you": {k: member[k] for k in ("id", "name", "color", "host")},
                                  "state": room.snapshot(), "serverNow": time.time() * 1000}))
            room.broadcast({"t": "members", "members": room.public_members()}, skip=member["id"])
            while True:
                text = conn.read_message()
                if text is None:
                    break
                try:
                    msg = json.loads(text)
                except ValueError:
                    continue
                if not isinstance(msg, dict):
                    continue
                if msg.get("t") == "ping":
                    conn.send('{"t":"pong"}')
                    continue
                if ROOM is room and member["id"] in room.members:
                    room.handle(member, msg)
        except OSError:
            pass
        finally:
            conn.close()
            with room.lock:
                if room.conns.get(member["id"]) is conn:
                    del room.conns[member["id"]]
                    member["online"] = False
            if ROOM is room:
                room.broadcast({"t": "members", "members": room.public_members()})

    def save(self):
        if not self.is_host() or self.headers.get("Origin") not in ALLOWED_ORIGINS:
            return self._reply(403, {"error": "saves are only accepted from the SketchCollab page on this computer"})
        data = self._body()
        name = data["name"]
        files = data["files"]
        if not NAME_RE.match(name):
            raise ValueError("bad session name")
        folder = SESSIONS / name
        for f in files:
            if not FILE_RE.match(f["path"]) or ".." in f["path"]:
                raise ValueError("bad file name: " + f["path"])
        try:
            folder.mkdir(parents=True, exist_ok=True)
            # A re-save replaces the pictures, so none are left over from the last save.
            for sub in ("moments", "layers", "assets", "audio"):
                shutil.rmtree(folder / sub, ignore_errors=True)
            for f in files:
                target = folder / f["path"]
                target.parent.mkdir(exist_ok=True)
                if "base64" in f:
                    target.write_bytes(base64.b64decode(f["base64"]))
                else:
                    target.write_text(f["text"], encoding="utf-8")
            if data.get("send"):
                # What's being asked: "sketch" (a new idea), "build" (goals confirmed, build it),
                # "changes" (a review with things to fix) or "approved" (the build is right).
                req = data.get("request") if isinstance(data.get("request"), dict) else {}
                kind = req.get("kind") if req.get("kind") in REQUEST_KINDS else "sketch"
                stamp = datetime.now().isoformat(timespec="seconds")
                (folder / "request.json").write_text(json.dumps({**req, "kind": kind, "session": name, "sent": stamp}, indent=2), encoding="utf-8")
                (folder / "SENT_TO_CLAUDE.txt").write_text(f"Sent {stamp} ({kind})\n", encoding="utf-8")
                with SENT_LOG.open("a", encoding="utf-8") as log:
                    log.write(f"{stamp} {name} {kind}\n")
        except OSError as e:
            return self._reply(500, {"error": f"couldn't write the files ({e.strerror or e})"})
        print(f"  {'Sent' if data.get('send') else 'Saved'} session to {folder}")
        return self._reply(200, {"ok": True, "folder": str(folder), "sent": bool(data.get("send"))})


# ---------------------------------------------------------------- the agent inbox
# An agent leaves a folder in inbox/ with an item.json (and any pictures it names). The app picks it up:
# "goals" items ask Paddy to confirm a goal list; "review" items open as a review tab.
def _item_dirs():
    if not INBOX.is_dir():
        return []
    return [d for d in sorted(INBOX.iterdir()) if d.is_dir() and not d.name.startswith("_") and NAME_RE.match(d.name) and (d / "item.json").is_file()]


def inbox_list():
    out = []
    for d in _item_dirs():
        try:
            item = json.loads((d / "item.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        out.append({"id": d.name, "kind": item.get("kind"), "title": item.get("title", ""), "session": item.get("session", ""),
                    "created": int((d / "item.json").stat().st_mtime * 1000)})
    return out


def inbox_item(item_id):
    d = INBOX / item_id
    if not NAME_RE.match(item_id) or not (d / "item.json").is_file():
        return None
    try:
        item = json.loads((d / "item.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    images = []
    for img in item.get("images") or []:
        f = d / str(img.get("file", ""))
        if f.parent != d or f.suffix.lower() not in IMAGE_TYPES or not f.is_file():
            continue   # only pictures inside the item's own folder
        images.append({"caption": str(img.get("caption", ""))[:300], "name": f.name,
                       "data": f"data:{IMAGE_TYPES[f.suffix.lower()]};base64,{base64.b64encode(f.read_bytes()).decode()}"})
    item["images"], item["id"] = images, item_id
    return item


def inbox_done(item_id):
    d = INBOX / item_id
    if not NAME_RE.match(item_id) or item_id.startswith("_") or not d.is_dir():
        return False
    try:
        (INBOX / "_done").mkdir(exist_ok=True)
        d.rename(INBOX / "_done" / f"{item_id}-{time.time_ns()}")
    except OSError:
        return False   # already moved, or in use: the app skips items it has already opened
    return True


class Server(ThreadingHTTPServer):
    daemon_threads = True


def main():
    SESSIONS.mkdir(exist_ok=True)
    INBOX.mkdir(exist_ok=True)
    try:
        server = Server(("127.0.0.1", PORT), Handler)
    except OSError:
        print(f"SketchCollab is already running on http://localhost:{PORT}/")
        return
    kill_stale_tunnels()
    print(f"SketchCollab is running on http://localhost:{PORT}/")
    print(f"Sessions are saved in {SESSIONS}")
    print("Close this window to stop it (and any team session).")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        TUNNEL.stop()


if __name__ == "__main__":
    main()
