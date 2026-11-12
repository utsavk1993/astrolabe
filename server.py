#!/usr/bin/env python3
"""Astrolabe local server.

Serves the site and the two API routes (/api/health and /api/extract) for running it on
your own machine. The API logic lives in api/_core.py, which the Vercel functions use too.

Why a server at all: NVIDIA's API can't be called straight from a web page (the browser
blocks it), and the API key must not sit in page code. This keeps the key on your machine.

Run:   python3 server.py        then open http://localhost:8000
Needs: a .env file next to this one with NVIDIA_API_KEY=nvapi-...  (see .env.example)
Standard library only; no pip install.
"""

import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
# Only files the site needs are served; never .env or the Python source.
SERVABLE = {".html", ".css", ".js", ".svg", ".png", ".ico", ".gif"}


def load_env():
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


# .env must be loaded before the shared module reads its settings.
load_env()
sys.path.insert(0, str(ROOT / "api"))
import _core as core  # noqa: E402

PORT = int(os.environ.get("PORT", "8000"))
# Localhost by default: this server holds your API key. HOST=0.0.0.0 to serve beyond it.
HOST = os.environ.get("HOST", "127.0.0.1")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # Always pick up edits while developing.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, status, payload, retry_after=None):
        body = json.dumps(payload).encode()
        self.send_response(status)
        if retry_after:
            self.send_header("Retry-After", str(retry_after))
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/health":
            return self.send_json(200, core.health())
        if path.startswith("/api/") or (path not in ("/", "/index.html") and Path(path).suffix not in SERVABLE):
            return self.send_error(404)
        super().do_GET()

    def do_POST(self):
        if self.path != "/api/extract":
            return self.send_error(404)
        self.send_json(*core.extract(self.headers, self.rfile.read, self.client_address[0]))

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    if not core.API_KEY:
        print("Note: no NVIDIA_API_KEY in .env, so the AI features are off. The clock still works.")
    print(f"Astrolabe on http://localhost:{PORT}  (model: {core.MODEL}, thinking {'on' if core.THINKING else 'off'})")
    store = "Redis" if isinstance(core.limiter, core.RedisLimiter) else "memory"
    print(f"Limits: {core.PER_MINUTE}/min and {core.PER_DAY}/day per visitor, {core.DAILY_CAP}/day in total, "
          f"{core.MAX_CONCURRENT} at once (counted in {store})")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
