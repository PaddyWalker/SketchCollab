"""SketchCollab local server.

Serves the app on http://localhost:8765/ and saves finished sessions into the
"sessions" folder next to this file, so Claude can read them from disk.

Run:  python server.py        (start.bat does this for you)
Only this computer can reach it: it listens on 127.0.0.1, and saves are only
accepted from the app's own page.
"""

import base64
import json
import re
import shutil
import sys
from datetime import datetime
from urllib.parse import unquote
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = 8765
ROOT = Path(__file__).resolve().parent
SESSIONS = ROOT / "sessions"
ALLOWED_ORIGINS = {f"http://localhost:{PORT}", f"http://127.0.0.1:{PORT}"}
SENT_LOG = SESSIONS / "_sent.log"   # one line per "Send to Claude"; Claude watches this file
MAX_BODY = 600 * 1024 * 1024  # 600 MB, plenty for a long session with photos and voice
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
FILE_RE = re.compile(r"^((moments|layers|assets|audio)/)?[A-Za-z0-9_-][A-Za-z0-9_.-]{0,79}$")


class Handler(SimpleHTTPRequestHandler):
    # Windows can map .js to text/plain, which browsers refuse to run as a module.
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".mjs": "text/javascript"}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("  " + (fmt % args) + "\n")

    def _reply(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] == "/api/ping":
            return self._reply(200, {"ok": True, "folder": str(SESSIONS)})
        if self.path.split("?")[0] == "/api/version":
            # Changes whenever the app's own files change, so an open window can reload itself.
            files = [ROOT / "index.html", *ROOT.glob("js/*.js")]
            return self._reply(200, {"version": max((f.stat().st_mtime_ns for f in files if f.exists()), default=0)})
        # Never serve saved sessions or the server's own files over HTTP.
        path = unquote(self.path.split("?")[0].split("#")[0]).replace("\\", "/").lower()
        if path.startswith("/sessions") or path.endswith((".py", ".ps1", ".bat")):
            return self._reply(404, {"error": "not found"})
        return super().do_GET()

    def do_POST(self):
        if self.path != "/api/save":
            return self._reply(404, {"error": "not found"})
        if self.headers.get("Origin") not in ALLOWED_ORIGINS:
            return self._reply(403, {"error": "saves are only accepted from the SketchCollab page"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self._reply(413, {"error": "session too large"})
        try:
            data = json.loads(self.rfile.read(length))
            name = data["name"]
            files = data["files"]
            if not NAME_RE.match(name):
                raise ValueError("bad session name")
            folder = SESSIONS / name
            for f in files:
                if not FILE_RE.match(f["path"]) or ".." in f["path"]:
                    raise ValueError("bad file name: " + f["path"])
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
                stamp = datetime.now().isoformat(timespec="seconds")
                (folder / "SENT_TO_CLAUDE.txt").write_text(f"Sent {stamp}\n", encoding="utf-8")
                with SENT_LOG.open("a", encoding="utf-8") as log:
                    log.write(f"{stamp} {name}\n")
        except (KeyError, ValueError, TypeError) as e:
            return self._reply(400, {"error": str(e)})
        except OSError as e:
            return self._reply(500, {"error": f"couldn't write the files ({e.strerror or e})"})
        print(f"  {'Sent' if data.get('send') else 'Saved'} session to {folder}")
        return self._reply(200, {"ok": True, "folder": str(folder), "sent": bool(data.get("send"))})


def main():
    SESSIONS.mkdir(exist_ok=True)
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError:
        print(f"SketchCollab is already running on http://localhost:{PORT}/")
        return
    print(f"SketchCollab is running on http://localhost:{PORT}/")
    print(f"Sessions are saved in {SESSIONS}")
    print("Close this window to stop it.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
