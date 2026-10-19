"""FastAPI app: POST /extract {url}, GET /health. Never returns 5xx for an extraction failure."""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import FastAPI
from pydantic import BaseModel, Field

from .cache import DiskCache
from .fetch import guarded_get
from .netguard import BlockedAddress, GuardedTransport, validate_url
from .parse import parse_html, parse_plain
from .robots import RobotsCache

VERSION = "1.0.0"
HTML_TYPES = {"text/html", "application/xhtml+xml"}
log = logging.getLogger("categoriser-extractor")


class ExtractRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _result(status: str, bytes_read: int = 0, **fields) -> dict:
    return {"status": status, "fetchedAt": _now_iso(), "bytes": bytes_read, **{k: v for k, v in fields.items() if v}}


def load_fixtures(directory: Path) -> dict[str, dict]:
    fixtures: dict[str, dict] = {}
    for path in sorted(directory.glob("*.json")):
        try:
            entry = json.loads(path.read_text("utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(entry, dict) and isinstance(entry.get("url"), str) and isinstance(entry.get("result"), dict):
            fixtures[entry["url"]] = entry["result"]
    return fixtures


class Extractor:
    def __init__(
        self,
        *,
        transport: httpx.BaseTransport | None = None,
        cache_dir: Path = Path(".cache"),
        clock=time.time,
    ):
        self._client = httpx.Client(transport=transport or GuardedTransport(), trust_env=False, follow_redirects=False)
        self._cache = DiskCache(cache_dir, clock)
        self._robots = RobotsCache(clock)

    def extract(self, url: str) -> dict:
        try:
            validate_url(url)
        except BlockedAddress:
            return _result("blocked")

        cached = self._cache.get(url)
        if cached is not None:
            return cached

        if not self._robots.allowed(self._client, url):
            return _result("blocked")

        fetched = guarded_get(self._client, url)
        if fetched.status != "ok":
            result = _result(fetched.status, fetched.bytes)
        elif fetched.content_type in HTML_TYPES or fetched.content_type == "":
            result = _result("ok", fetched.bytes, **parse_html(fetched.body, fetched.final_url, fetched.encoding))
        elif fetched.content_type == "text/plain":
            result = _result("ok", fetched.bytes, **parse_plain(fetched.body, fetched.encoding))
        else:
            result = _result("skipped", fetched.bytes)

        log.info(
            "extract status=%s bytes=%d truncated=%s reason=%s",
            result["status"], fetched.bytes, fetched.truncated, fetched.reason,
        )
        self._cache.put(url, result)
        return result


def create_app(
    *,
    mock: bool = False,
    fixtures_dir: Path = Path("fixtures"),
    extractor: Extractor | None = None,
) -> FastAPI:
    app = FastAPI(title="categoriser-extractor", version=VERSION, docs_url=None, redoc_url=None, openapi_url=None)
    fixtures = load_fixtures(fixtures_dir) if mock else {}
    live = None if mock else (extractor or Extractor())

    @app.get("/health")
    def health() -> dict:
        return {"ok": True, "mode": "mock" if mock else "live", "version": VERSION, "fixtures": len(fixtures)}

    @app.post("/extract")
    def extract(request: ExtractRequest) -> dict:
        if mock:
            fixture = fixtures.get(request.url)
            if fixture is None:
                return _result("not_found")
            return {"fetchedAt": _now_iso(), "bytes": 0, **fixture}
        try:
            return live.extract(request.url)
        except Exception:  # noqa: BLE001 - extraction must never surface as a 5xx
            log.exception("extract crashed")
            return _result("error")

    return app
