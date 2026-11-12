"""Checks for the shared API logic. Run with: python3 -m unittest discover tests"""

import os
import sys
import unittest

# Small limits so the tests are quick; set before the module reads them.
os.environ.update({"RATE_PER_MINUTE": "2", "RATE_PER_DAY": "3", "DAILY_CAP": "4"})
for key in ("UPSTASH_REDIS_REST_URL", "KV_REST_API_URL", "VERCEL"):
    os.environ.pop(key, None)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "api"))
import _core as core  # noqa: E402


class ParseReply(unittest.TestCase):
    def test_zone_abbreviation_overrides_a_wrong_guess(self):
        reply = '{"events":[{"label":"Launch","local":"2026-11-12T10:00","zone":"PT","tz":"America/Vancouver"}],"meeting":null}'
        self.assertEqual(core.parse_reply(reply)["events"][0]["tz"], "America/Los_Angeles")

    def test_thinking_text_and_bad_events_are_dropped(self):
        reply = '<think>hmm {"x":1}</think>{"events":[{"local":"tomorrow","tz":"UTC"}],"meeting":null}'
        self.assertEqual(core.parse_reply(reply), {"events": [], "meeting": None})

    def test_meeting_is_cleaned_up(self):
        reply = '{"events":[],"meeting":{"label":"Call","zones":["Asia/Tokyo","Tokyo"],"from":"2026-11-16","minutes":999}}'
        meeting = core.parse_reply(reply)["meeting"]
        self.assertEqual(meeting["zones"], ["Asia/Tokyo"])
        self.assertEqual(meeting["minutes"], 240)

    def test_reply_without_json_is_an_error(self):
        with self.assertRaises(ValueError):
            core.parse_reply("Sorry, I can't help with that.")


class MemoryLimits(unittest.TestCase):
    def test_per_minute_then_daily_cap(self):
        limiter = core.MemoryLimiter()
        self.assertIsNone(limiter.check("a"))
        self.assertIsNone(limiter.check("a"))
        self.assertIn("wait", limiter.check("a")[0])   # 3rd in a minute
        self.assertIsNone(limiter.check("b"))
        self.assertIsNone(limiter.check("b"))
        self.assertIn("demo", limiter.check("c")[0])   # 5th overall: daily cap


class RedisLimits(unittest.TestCase):
    """The Redis limiter against a tiny fake of Upstash's pipeline API."""

    def make(self):
        limiter = core.RedisLimiter("https://example.upstash.io", "token")
        store = {}

        def pipeline(*commands):
            out = []
            for cmd in commands:
                if cmd[0] == "INCR":
                    store[cmd[1]] = store.get(cmd[1], 0) + 1
                    out.append(store[cmd[1]])
                else:
                    out.append(1)
            return out

        limiter.pipeline = pipeline
        return limiter, store

    def test_visitor_over_limit_does_not_use_up_the_shared_cap(self):
        limiter, store = self.make()
        self.assertIsNone(limiter.check("a"))
        self.assertIsNone(limiter.check("a"))
        self.assertIsNotNone(limiter.check("a"))
        cap = [v for k, v in store.items() if k.startswith("rl:cap:")]
        self.assertEqual(cap, [2])

    def test_falls_back_to_memory_when_redis_is_down(self):
        limiter = core.RedisLimiter("https://example.upstash.io", "token")

        def down(*commands):
            raise TimeoutError("no route")

        limiter.pipeline = down
        self.assertIsNone(limiter.check("a"))


class Requests(unittest.TestCase):
    def test_other_websites_are_refused(self):
        status, payload, _ = core.extract({"Origin": "https://elsewhere.example", "Host": "astrolabe.example"},
                                          lambda n: b"{}", "1.2.3.4")
        self.assertEqual(status, 403)


if __name__ == "__main__":
    unittest.main()
