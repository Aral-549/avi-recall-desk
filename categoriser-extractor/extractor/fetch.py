"""Guarded HTTP GET: per-hop URL validation, max 3 redirects, 5 s overall deadline, 1 MB streamed cap."""

from __future__ import annotations

import time
from dataclasses import dataclass
from urllib.parse import urljoin

import httpx

from .netguard import BlockedAddress, validate_url

USER_AGENT = "avi-categoriser/1.0"
MAX_REDIRECTS = 3
MAX_BYTES = 1024 * 1024
TIMEOUT_S = 5.0


@dataclass
class FetchResult:
    status: str  # "ok" | "blocked" | "timeout" | "error" | "not_found"
    http_status: int = 0
    final_url: str = ""
    content_type: str = ""
    encoding: str = "utf-8"
    body: bytes = b""
    bytes: int = 0
    truncated: bool = False
    reason: str = ""


def _status_for(code: int) -> str:
    if code in (404, 410):
        return "not_found"
    if code in (401, 403, 451, 429):
        return "blocked"
    return "error"


def guarded_get(
    client: httpx.Client,
    url: str,
    *,
    max_bytes: int = MAX_BYTES,
    timeout_s: float = TIMEOUT_S,
    clock=time.monotonic,
) -> FetchResult:
    deadline = clock() + timeout_s
    current = url
    try:
        for _hop in range(MAX_REDIRECTS + 1):
            validate_url(current)
            remaining = deadline - clock()
            if remaining <= 0:
                return FetchResult("timeout", final_url=current, reason="deadline")
            with client.stream(
                "GET",
                current,
                headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml,text/plain;q=0.8"},
                timeout=httpx.Timeout(remaining),
                follow_redirects=False,
            ) as response:
                if response.is_redirect:
                    location = response.headers.get("location")
                    if not location:
                        return FetchResult("error", response.status_code, current, reason="redirect-without-location")
                    current = urljoin(current, location)
                    continue

                chunks: list[bytes] = []
                total = 0
                truncated = False
                for chunk in response.iter_bytes():
                    if clock() > deadline:
                        return FetchResult("timeout", response.status_code, current, bytes=total, reason="deadline")
                    take = chunk[: max_bytes - total]
                    chunks.append(take)
                    total += len(take)
                    if total >= max_bytes:
                        truncated = True
                        break

                content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                encoding = response.charset_encoding or "utf-8"
                if response.status_code >= 400:
                    return FetchResult(
                        _status_for(response.status_code), response.status_code, current, content_type, encoding,
                        bytes=total, reason=f"http-{response.status_code}",
                    )
                return FetchResult(
                    "ok", response.status_code, current, content_type, encoding, b"".join(chunks), total, truncated
                )
        return FetchResult("blocked", final_url=current, reason="too-many-redirects")
    except BlockedAddress as exc:
        return FetchResult("blocked", final_url=current, reason=str(exc))
    except httpx.TimeoutException:
        return FetchResult("timeout", final_url=current, reason="timeout")
    except (httpx.HTTPError, LookupError, ValueError) as exc:
        return FetchResult("error", final_url=current, reason=type(exc).__name__)
