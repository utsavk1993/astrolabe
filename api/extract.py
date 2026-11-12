"""Vercel function for POST /api/extract. The logic is in _core.py, shared with server.py."""

import json
import os
import sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _core as core  # noqa: E402


def send_json(h, status, payload, retry_after=None):
    body = json.dumps(payload).encode()
    h.send_response(status)
    if retry_after:
        h.send_header("Retry-After", str(retry_after))
    h.send_header("Content-Type", "application/json")
    h.send_header("Cache-Control", "no-store")
    h.send_header("Content-Length", str(len(body)))
    h.end_headers()
    h.wfile.write(body)


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        ip = self.client_address[0] if self.client_address else ""
        send_json(self, *core.extract(self.headers, self.rfile.read, ip))
