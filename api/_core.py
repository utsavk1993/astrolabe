"""Astrolabe's AI endpoint logic, shared by the local server (server.py) and the Vercel
functions (api/extract.py, api/health.py), so both behave exactly the same.

It sends a dropped image or pasted text to NVIDIA's free Nemotron API and returns the times
found, or the cities and day of a meeting to plan (the browser then works out the slot).
It also enforces the rate limits that protect the free API quota.

Standard library only; no pip install.
"""

import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import defaultdict, deque
from urllib.parse import urlparse

API_BASE = "https://integrate.api.nvidia.com/v1"
DEFAULT_MODEL = "nvidia/nemotron-3.5-super-vl-120b-a12b"
# Vercel caps request bodies at 4.5 MB; screenshots are downscaled in the browser first.
MAX_BODY = 4 * 1024 * 1024
ON_VERCEL = os.environ.get("VERCEL") == "1"


def env_int(name, default):
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


# Read at import time: server.py loads .env before importing this module.
API_KEY = os.environ.get("NVIDIA_API_KEY", "")
MODEL = os.environ.get("NVIDIA_MODEL", DEFAULT_MODEL)
# Nemotron "thinks" before answering by default: ~45 s per request on the free tier.
# Off, it answers in a few seconds; zone abbreviations are then resolved in code (ZONE_WORDS).
THINKING = os.environ.get("NVIDIA_THINKING", "0") == "1"

# --- Rate limits -------------------------------------------------------------------
# A public demo with a free API key needs limits, or one visitor (or a script) can use up
# the whole quota. Only requests that pass validation are counted.
PER_MINUTE = env_int("RATE_PER_MINUTE", 6)     # per visitor
PER_DAY = env_int("RATE_PER_DAY", 40)          # per visitor
DAILY_CAP = env_int("DAILY_CAP", 500)          # for everyone together, resets at midnight UTC
MAX_CONCURRENT = env_int("MAX_CONCURRENT", 3)  # AI requests in flight at once (per server)
# Behind a load balancer every request seems to come from the balancer; the visitor's
# address is then in a forwarding header. Vercel always sets those, so trust them there;
# elsewhere only when told to, because anyone can send them directly.
TRUST_PROXY = ON_VERCEL or os.environ.get("TRUST_PROXY", "0") == "1"
# Sites allowed to call /api/extract from a browser (comma-separated origins). Empty
# means "only this site itself", checked against the Host header.
ALLOWED_ORIGINS = {o.strip().rstrip("/") for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()}
# Shared counters for serverless hosts, where each request may run on a fresh copy of the
# function and in-memory counts would not add up. Upstash Redis from the Vercel Marketplace
# sets one of these pairs.
REDIS_URL = os.environ.get("UPSTASH_REDIS_REST_URL") or os.environ.get("KV_REST_API_URL", "")
REDIS_TOKEN = os.environ.get("UPSTASH_REDIS_REST_TOKEN") or os.environ.get("KV_REST_API_TOKEN", "")

DAY_LIMIT_MSG = "You've reached today's limit for this demo. Please come back tomorrow."
CAP_MSG = "The demo has reached today's limit. Please come back tomorrow."


def minute_msg(wait):
    return f"That's a lot of reads in a row. Please wait {wait} seconds and try again."


class MemoryLimiter:
    """Sliding windows per visitor, plus a shared daily cap, kept in memory. Right for a
    single long-running server such as server.py."""

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
                return (CAP_MSG, 86400 - int(now % 86400))
            m, d = self.minute[visitor], self.day[visitor]
            while m and now - m[0] >= 60:
                m.popleft()
            while d and now - d[0] >= 86400:
                d.popleft()
            if len(d) >= PER_DAY:
                return (DAY_LIMIT_MSG, int(86400 - (now - d[0])) + 1)
            if len(m) >= PER_MINUTE:
                wait = int(60 - (now - m[0])) + 1
                return (minute_msg(wait), wait)
            m.append(now)
            d.append(now)
            self.cap_count += 1
            return None


class RedisLimiter:
    """The same limits with counters in Upstash Redis (over its REST API, so no extra
    packages), shared by every copy of the function. Fixed one-minute and one-day windows.
    If Redis can't be reached, it falls back to the in-memory limiter rather than failing."""

    def __init__(self, url, token):
        self.url, self.token = url.rstrip("/"), token
        self.fallback = MemoryLimiter()

    def pipeline(self, *commands):
        req = urllib.request.Request(
            f"{self.url}/pipeline", data=json.dumps(commands).encode(), method="POST",
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as res:
            return [item.get("result") for item in json.load(res)]

    def check(self, visitor):
        now = int(time.time())
        minute, day = now // 60, now // 86400
        until_tomorrow = 86400 - now % 86400
        try:
            # The visitor's own counters first: a visitor who is over their limit never
            # touches the shared cap.
            m, _, d, _ = self.pipeline(
                ["INCR", f"rl:m:{visitor}:{minute}"], ["EXPIRE", f"rl:m:{visitor}:{minute}", 120],
                ["INCR", f"rl:d:{visitor}:{day}"], ["EXPIRE", f"rl:d:{visitor}:{day}", 90000])
            if d > PER_DAY:
                return (DAY_LIMIT_MSG, until_tomorrow)
            if m > PER_MINUTE:
                wait = 60 - now % 60
                return (minute_msg(wait), wait)
            cap, _ = self.pipeline(["INCR", f"rl:cap:{day}"], ["EXPIRE", f"rl:cap:{day}", 90000])
            if cap > DAILY_CAP:
                return (CAP_MSG, until_tomorrow)
            return None
        except (urllib.error.URLError, TimeoutError, ValueError, TypeError) as err:
            print(f"Rate limit store unreachable, using in-memory limits: {err}", file=sys.stderr)
            return self.fallback.check(visitor)


limiter = RedisLimiter(REDIS_URL, REDIS_TOKEN) if REDIS_URL and REDIS_TOKEN else MemoryLimiter()
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


# --- Requests ----------------------------------------------------------------------

def health():
    return {"ok": True, "configured": bool(API_KEY), "model": MODEL}


def visitor_of(headers, client_ip):
    if TRUST_PROXY:
        real = headers.get("X-Real-IP") or headers.get("X-Forwarded-For", "")
        if real:
            return real.split(",")[0].strip()
    return client_ip


def origin_allowed(headers):
    # Browsers always send Origin on a cross-site POST, so this stops other websites from
    # using the endpoint through their visitors. (Scripts can fake it; the rate limits are
    # what stop those.)
    origin = headers.get("Origin")
    if not origin:
        return True
    if ALLOWED_ORIGINS:
        return origin.rstrip("/") in ALLOWED_ORIGINS
    return urlparse(origin).netloc == headers.get("Host", "")


def extract(headers, read_body, client_ip):
    """Handles POST /api/extract. read_body(n) returns the request body.
    Returns (status, payload, retry_after_seconds_or_None)."""
    if not origin_allowed(headers):
        return 403, {"error": "This server only answers requests from its own site."}, None
    if not API_KEY:
        where = "the project's environment variables" if ON_VERCEL else ".env"
        return 503, {"error": f"No NVIDIA_API_KEY in {where}."}, None
    try:
        length = int(headers.get("Content-Length", 0))
    except ValueError:
        length = 0
    if length > MAX_BODY:
        return 413, {"error": "That file is too large."}, None
    try:
        req = json.loads(read_body(length) or b"{}")
        text = str(req.get("text", ""))[:8000]
        image = req.get("image") or None
        if image and not str(image).startswith("data:image/"):
            return 400, {"error": "Expected an image."}, None
        if not text and not image:
            return 400, {"error": "Nothing to read."}, None
        limited = limiter.check(visitor_of(headers, client_ip))
        if limited:
            return 429, {"error": limited[0]}, limited[1]
        if not in_flight.acquire(blocking=False):
            return 503, {"error": "Busy right now. Try again in a few seconds."}, 5
        try:
            result = call_nemotron(text, image, str(req.get("now", "")), str(req.get("tz", "UTC")))
        finally:
            in_flight.release()
        return 200, result, None
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace")[:300]
        print(f"NVIDIA API error {err.code}: {detail}", file=sys.stderr)
        msg = {401: "NVIDIA rejected the API key.", 403: "NVIDIA rejected the API key.",
               404: f"Model {MODEL} isn't available on your NVIDIA account.",
               429: "Too many reads in a row. Wait a minute and try again.",
               503: "Busy right now. Try again in a minute."}
        return 502, {"error": msg.get(err.code, f"NVIDIA API error {err.code}.")}, None
    except (urllib.error.URLError, TimeoutError) as err:
        print(f"NVIDIA API unreachable: {err}", file=sys.stderr)
        return 504, {"error": "Couldn't reach the reader. Check your connection."}, None
    except (ValueError, KeyError, TypeError, json.JSONDecodeError) as err:
        print(f"Bad request or model reply: {err}", file=sys.stderr)
        return 502, {"error": "The model's answer couldn't be read. Try again."}, None
