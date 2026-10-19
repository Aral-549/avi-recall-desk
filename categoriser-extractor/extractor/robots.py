"""robots.txt check, cached per origin for 24 h."""

from __future__ import annotations

import time
from urllib.parse import urlsplit
from urllib.robotparser import RobotFileParser

import httpx

from .fetch import guarded_get

ROBOTS_TTL_S = 24 * 3600
ROBOTS_MAX_BYTES = 512 * 1024
AGENT = "avi-categoriser"


class RobotsCache:
    def __init__(self, clock=time.time):
        self._clock = clock
        self._entries: dict[str, tuple[float, RobotFileParser | bool]] = {}

    def _load(self, client: httpx.Client, origin: str) -> RobotFileParser | bool:
        result = guarded_get(client, f"{origin}/robots.txt", max_bytes=ROBOTS_MAX_BYTES)
        if result.status == "ok":
            parser = RobotFileParser()
            parser.parse(result.body.decode(result.encoding, errors="replace").splitlines())
            return parser
        if result.http_status in (401, 403):
            return False  # access to robots.txt denied: treat as disallow-all
        if 400 <= result.http_status < 500:
            return True  # no robots.txt: allow-all
        return False  # unreachable / 5xx / blocked: fail closed

    def allowed(self, client: httpx.Client, url: str) -> bool:
        parts = urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        now = self._clock()
        entry = self._entries.get(origin)
        if entry is None or now - entry[0] > ROBOTS_TTL_S:
            entry = (now, self._load(client, origin))
            self._entries[origin] = entry
        rules = entry[1]
        if isinstance(rules, bool):
            return rules
        return rules.can_fetch(AGENT, url)
