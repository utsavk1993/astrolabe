#!/usr/bin/env python3
"""Astrolabe local server.

Serves the site and adds one endpoint, POST /api/extract, which sends a dropped image or
pasted text to NVIDIA's free Nemotron API and returns the times it found, or the cities and
day of a meeting to plan (the browser then works out the slot).

Why a server at all: NVIDIA's API can't be called straight from a web page (the browser
blocks it), and the API key must not sit in page code. This keeps the key on your machine.

Run:   python3 server.py        then open http://localhost:8000
Needs: a .env file next to this one with NVIDIA_API_KEY=nvapi-...  (see .env.example)
Standard library only; no pip install.
"""

import json
import os
import re
import sys
import threading
import time
from collections import defaultdict, deque
from urllib.parse import urlparse
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
API_BASE = "https://integrate.api.nvidia.com/v1"
DEFAULT_MODEL = "nvidia/nemotron-3.5-super-vl-120b-a12b"
# Nemotron "thinks" before answering by default: ~45 s per request on the free tier.
# Off, it answers in ~1 s; zone abbreviations are then resolved in code (ZONE_WORDS).
THINKING = os.environ.get("NVIDIA_THINKING", "0") == "1"
MAX_BODY = 8 * 1024 * 1024  # dropped images are downscaled in the browser first
# Only files the site needs are served; never .env or this script.
SERVABLE = {".html", ".css", ".js", ".svg", ".png", ".ico", ".gif"}


def load_env():
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_env()
API_KEY = os.environ.get("NVIDIA_API_KEY", "")
MODEL = os.environ.get("NVIDIA_MODEL", DEFAULT_MODEL)
PORT = int(os.environ.get("PORT", "8000"))
# Localhost by default. A cloud host needs HOST=0.0.0.0 so its load balancer can reach it.
HOST = os.environ.get("HOST", "127.0.0.1")


def env_int(name, default):
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


# --- Rate limits -------------------------------------------------------------------
# A public demo with a free API key needs limits, or one visitor (or a script) can use up
# the whole quota. All limits count only requests that actually reach the AI.
PER_MINUTE = env_int("RATE_PER_MINUTE", 6)     # per visitor
PER_DAY = env_int("RATE_PER_DAY", 40)          # per visitor
DAILY_CAP = env_int("DAILY_CAP", 500)          # for everyone together, resets at midnight UTC
MAX_CONCURRENT = env_int("MAX_CONCURRENT", 3)  # AI requests in flight at once
# Behind a cloud load balancer every request seems to come from the balancer itself; the
# visitor's address is then in X-Forwarded-For. Only trust that header when told to,
# because anyone can send it directly.
TRUST_PROXY = os.environ.get("TRUST_PROXY", "0") == "1"
# Sites allowed to call /api/extract from a browser (comma-separated origins). Empty
# means "only this site itself", checked against the Host header.
ALLOWED_ORIGINS = {o.strip().rstrip("/") for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()}


class RateLimiter:
    """Sliding windows per visitor, plus a shared daily cap. Kept in memory: fine for a
    single server; several servers behind one balancer would each keep their own count."""

    def __init__(self):
        self.lock = threading.Lock()
        self.minute = defaultdict(deque)
        self.day = defaultdict(deque)
        self.cap_day = None
        self.cap_count = 0

    def check(self, visitor):
        """Returns None if allowed (and counts it), else (message, retry_after_seconds)."""
        now = time.time()
        today = time.strftime("%Y-%m-%d", time.gmtime(now))
        with self.lock:
            if self.cap_day != today:
                self.cap_day, self.cap_count = today, 0
                self.minute.clear()
                self.day.clear()
            if self.cap_count >= DAILY_CAP:
                wait = 86400 - int(now % 86400)
                return ("The demo has reached today's limit. Please come back tomorrow.", wait)
            m, d = self.minute[visitor], self.day[visitor]
            while m and now - m[0] >= 60:
                m.popleft()
            while d and now - d[0] >= 86400:
                d.popleft()
            if len(d) >= PER_DAY:
                return ("You've reached today's limit for this demo. Please come back tomorrow.",
                        int(86400 - (now - d[0])) + 1)
            if len(m) >= PER_MINUTE:
                wait = int(60 - (now - m[0])) + 1
                return (f"That's a lot of reads in a row. Please wait {wait} seconds and try again.", wait)
            m.append(now)
            d.append(now)
            self.cap_count += 1
            return None


limiter = RateLimiter()
in_flight = threading.BoundedSemaphore(MAX_CONCURRENT)

SYSTEM_PROMPT = """You read dates and times from images and text so a world clock can show them,
and you recognise requests to find a meeting time across cities.

Return ONLY a JSON object, no prose, no code fences:
{"events": [{"label": string, "local": "YYYY-MM-DDTHH:MM", "zone": string, "tz": string}],
 "meeting": null or {"label": string, "zones": [string], "from": "YYYY-MM-DD", "minutes": number}}

Events (specific times written in the source):
- "local" is the wall-clock time exactly as written in the source, in 24-hour form.
- "zone" is the time zone exactly as written in the source ("PT", "IST", "London time"),
  or "" if none is written.
- "tz" is the IANA time zone the source time is written in (e.g. "America/Los_Angeles" for
  PT/PST/PDT, "Europe/London" for UK time, "Asia/Kolkata" for IST). If the source names a
  city or airport, use that city's zone. If no zone is stated or implied, use the user's zone.
- Resolve relative dates ("tomorrow", "Thursday", "next week") against the user's current
  date. A weekday with no date means its next occurrence (today counts if the time is still ahead).
- A missing year means the next occurrence of that date.
- "label" is 1-4 words naming what happens ("Product launch", "Departs SFO", "Standup").
- Several times (a flight's departure and arrival, an agenda) give several events, in order.

Meeting (the user asks to find, plan or schedule a time with people in other places, and
gives no specific time, e.g. "call with Tokyo and London next week", "when can I meet the
Berlin team tomorrow?"):
- Set "meeting" and leave "events" empty.
- "zones": the IANA zone of every place named ("Asia/Tokyo", "Europe/London"). Not the user's own.
- "from": the first day to consider, as YYYY-MM-DD. "next week" means next Monday; no day
  given means today.
- "minutes": the meeting length if stated, otherwise 60.
- "label": 2-6 words, e.g. "Call with Tokyo and London".

Otherwise "meeting" is null. No date or time anywhere and no meeting request:
{"events": [], "meeting": null}. Never invent a time."""


def call_nemotron(text, image, now, user_tz):
    content = [{
        "type": "text",
        "text": f"User's current time: {now} in time zone {user_tz}.\n\n"
                + (f"Text:\n{text}" if text else "Find the dates and times in this image."),
    }]
    if image:
        content.append({"type": "image_url", "image_url": {"url": image}})

    body = json.dumps({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": content},
        ],
        "temperature": 0,
        "max_tokens": 4096,
        "chat_template_kwargs": {"enable_thinking": THINKING},
    }).encode()
    req = urllib.request.Request(
        f"{API_BASE}/chat/completions", data=body, method="POST",
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json",
                 "Accept": "application/json"},
    )
    # NVIDIA's free tier sometimes answers 503 ("content safety screening is temporarily
    # unavailable") when busy. Those clear within seconds, so retry twice with a pause.
    for pause in (2, 4, None):
        try:
            with urllib.request.urlopen(req, timeout=90) as res:
                data = json.load(res)
            break
        except urllib.error.HTTPError as err:
            if err.code != 503 or pause is None:
                raise
            time.sleep(pause)
    reply = data["choices"][0]["message"].get("content") or ""
    return parse_reply(reply)


# Written zone → IANA zone. Checked in code because the fast (non-thinking) model sometimes
# swaps in the user's own zone. Note "PT" is Los Angeles: Vancouver no longer matches it.
ZONE_WORDS = {
    "PT": "America/Los_Angeles", "PST": "America/Los_Angeles", "PDT": "America/Los_Angeles",
    "PACIFIC": "America/Los_Angeles", "MT": "America/Denver", "MST": "America/Denver",
    "MDT": "America/Denver", "CT": "America/Chicago", "CST": "America/Chicago",
    "CDT": "America/Chicago", "ET": "America/New_York", "EST": "America/New_York",
    "EDT": "America/New_York", "EASTERN": "America/New_York", "UTC": "UTC", "GMT": "Europe/London",
    "BST": "Europe/London", "UK": "Europe/London", "CET": "Europe/Paris", "CEST": "Europe/Paris",
    "IST": "Asia/Kolkata", "SGT": "Asia/Singapore", "JST": "Asia/Tokyo", "KST": "Asia/Seoul",
    "HKT": "Asia/Hong_Kong", "AEST": "Australia/Sydney", "AEDT": "Australia/Sydney",
    "GST": "Asia/Dubai", "UAE": "Asia/Dubai",
}


def resolve_zone(zone, tz):
    word = re.sub(r"[^A-Z]", "", zone.upper().replace("TIME", ""))
    return ZONE_WORDS.get(word, tz)


def parse_reply(reply):
    # Reasoning models may think out loud first; keep only what follows.
    reply = re.sub(r"<think>.*?</think>", "", reply, flags=re.S)
    match = re.search(r"\{.*\}", reply, flags=re.S)
    if not match:
        raise ValueError(f"Model reply had no JSON: {reply[:200]!r}")
    data = json.loads(match.group(0))
    events = data.get("events") or []
    clean = []
    for e in events[:12]:
        local, tz = str(e.get("local", "")), str(e.get("tz", ""))
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", local) and tz:
            tz = resolve_zone(str(e.get("zone", "")), tz)
            clean.append({"label": str(e.get("label", ""))[:40], "local": local, "tz": tz})
    return {"events": clean, "meeting": parse_meeting(data.get("meeting"))}


def parse_meeting(m):
    # The browser checks the zones against its own time zone data; here just tidy the shape.
    if not isinstance(m, dict):
        return None
    zones = [str(z) for z in (m.get("zones") or []) if isinstance(z, str) and "/" in z][:6]
    day = str(m.get("from", ""))
    if not zones or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        return None
    try:
        minutes = int(m.get("minutes") or 60)
    except (TypeError, ValueError):
        minutes = 60
    return {"label": str(m.get("label", ""))[:60], "zones": zones, "from": day,
            "minutes": max(15, min(minutes, 240))}


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
            return self.send_json(200, {"ok": True, "configured": bool(API_KEY), "model": MODEL})
        if path not in ("/", "/index.html") and Path(path).suffix not in SERVABLE:
            return self.send_error(404)
        super().do_GET()

    def visitor(self):
        if TRUST_PROXY:
            forwarded = self.headers.get("X-Forwarded-For", "")
            if forwarded:
                return forwarded.split(",")[0].strip()
        return self.client_address[0]

    def origin_allowed(self):
        # Browsers always send Origin on a cross-site POST, so this stops other websites
        # from using this server through their visitors. (Scripts can fake it; the rate
        # limits are what stop those.)
        origin = self.headers.get("Origin")
        if not origin:
            return True
        if ALLOWED_ORIGINS:
            return origin.rstrip("/") in ALLOWED_ORIGINS
        return urlparse(origin).netloc == self.headers.get("Host", "")

    def do_POST(self):
        if self.path != "/api/extract":
            return self.send_error(404)
        if not self.origin_allowed():
            return self.send_json(403, {"error": "This server only answers requests from its own site."})
        if not API_KEY:
            return self.send_json(503, {"error": "No NVIDIA_API_KEY in .env. Copy .env.example to .env and add your key."})
        length = int(self.headers.get("Content-Length", 0))
        if length > MAX_BODY:
            return self.send_json(413, {"error": "That file is too large."})
        try:
            req = json.loads(self.rfile.read(length))
            text = str(req.get("text", ""))[:8000]
            image = req.get("image") or None
            if image and not str(image).startswith("data:image/"):
                return self.send_json(400, {"error": "Expected an image."})
            if not text and not image:
                return self.send_json(400, {"error": "Nothing to read."})
            limited = limiter.check(self.visitor())
            if limited:
                return self.send_json(429, {"error": limited[0]}, retry_after=limited[1])
            if not in_flight.acquire(blocking=False):
                return self.send_json(503, {"error": "Busy right now. Try again in a few seconds."}, retry_after=5)
            try:
                result = call_nemotron(text, image, str(req.get("now", "")), str(req.get("tz", "UTC")))
            finally:
                in_flight.release()
            self.send_json(200, result)
        except urllib.error.HTTPError as err:
            detail = err.read().decode(errors="replace")[:300]
            print(f"NVIDIA API error {err.code}: {detail}", file=sys.stderr)
            msg = {401: "NVIDIA rejected the API key.", 403: "NVIDIA rejected the API key.",
                   404: f"Model {MODEL} isn't available on your NVIDIA account.",
                   429: "Too many reads in a row. Wait a minute and try again.",
                   503: "Busy right now. Try again in a minute."}
            self.send_json(502, {"error": msg.get(err.code, f"NVIDIA API error {err.code}.")})
        except (urllib.error.URLError, TimeoutError) as err:
            print(f"NVIDIA API unreachable: {err}", file=sys.stderr)
            self.send_json(504, {"error": "Couldn't reach the reader. Check your connection."})
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as err:
            print(f"Bad model reply: {err}", file=sys.stderr)
            self.send_json(502, {"error": "The model's answer couldn't be read. Try again."})

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    if not API_KEY:
        print("Note: no NVIDIA_API_KEY in .env, so drop-to-read is off. The clock still works.")
    print(f"Astrolabe on http://localhost:{PORT}  (model: {MODEL}, thinking {'on' if THINKING else 'off'})")
    print(f"Limits: {PER_MINUTE}/min and {PER_DAY}/day per visitor, {DAILY_CAP}/day in total, "
          f"{MAX_CONCURRENT} at once")
    # Localhost unless HOST says otherwise: this server holds your API key.
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
