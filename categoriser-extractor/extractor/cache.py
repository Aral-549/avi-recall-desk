"""On-disk result cache: .cache/<sha256(url)>.json, TTL 7 days. Only terminal results are cached."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
from pathlib import Path

CACHE_TTL_S = 7 * 24 * 3600
CACHEABLE = {"ok", "not_found"}


class DiskCache:
    def __init__(self, root: Path, clock=time.time):
        self._root = root
        self._clock = clock

    def _path(self, url: str) -> Path:
        return self._root / f"{hashlib.sha256(url.encode('utf-8')).hexdigest()}.json"

    def get(self, url: str) -> dict | None:
        path = self._path(url)
        try:
            entry = json.loads(path.read_text("utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(entry, dict) or entry.get("url") != url:
            return None
        if self._clock() - float(entry.get("cachedAt", 0)) > CACHE_TTL_S:
            return None
        result = entry.get("result")
        return result if isinstance(result, dict) else None

    def put(self, url: str, result: dict) -> None:
        if result.get("status") not in CACHEABLE:
            return
        self._root.mkdir(parents=True, exist_ok=True)
        payload = json.dumps({"url": url, "cachedAt": self._clock(), "result": result})
        fd, tmp = tempfile.mkstemp(dir=self._root, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
            os.replace(tmp, self._path(url))
        except OSError:
            try:
                os.unlink(tmp)
            except OSError:
                pass
