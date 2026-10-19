"""HTML -> plain text + metadata using Scrapling's parser. Output never contains markup."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from urllib.parse import urljoin, urlsplit

from scrapling.parser import Selector

MAX_TEXT = 20_000
MAX_TITLE = 500
MAX_DESCRIPTION = 2_000

IGNORED_TAGS = ("script", "style", "noscript", "template", "head", "svg", "iframe", "object", "embed", "canvas")

# C0/C1 controls (minus \n \t), zero-width, bidi overrides, BOM: common prompt-injection hiding spots.
_INVISIBLE = re.compile(r"[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]")
_SPACES = re.compile(r"[ \t\u00a0\u2000-\u200a\u3000]+")
_LANG = re.compile(r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$")


def clean_text(raw: str, limit: int) -> str:
    text = _INVISIBLE.sub("", raw.replace("\r\n", "\n").replace("\r", "\n"))
    lines = (_SPACES.sub(" ", line).strip() for line in text.split("\n"))
    out = "\n".join(line for line in lines if line)
    return out[:limit].rstrip()


def _clean_line(raw: str | None, limit: int) -> str | None:
    if not raw:
        return None
    value = clean_text(raw, limit * 2).replace("\n", " ")[:limit].strip()
    return value or None


def _absolute_https(base: str, raw: str | None) -> str | None:
    if not raw:
        return None
    url = urljoin(base, raw.strip())
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname or parts.username or len(url) > 2048:
        return None
    return url


def _iso(raw: str | None) -> str | None:
    if not raw:
        return None
    value = raw.strip()
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.isoformat()


def parse_html(body: bytes, url: str, encoding: str = "utf-8") -> dict:
    page = Selector(content=body, url=url, encoding=encoding, huge_tree=False)

    def first(*queries: str) -> str | None:
        for query in queries:
            value = page.css(query).get()
            if value and str(value).strip():
                return str(value)
        return None

    title = _clean_line(first("title::text", 'meta[property="og:title"]::attr(content)'), MAX_TITLE)
    description = _clean_line(
        first('meta[name="description"]::attr(content)', 'meta[property="og:description"]::attr(content)'),
        MAX_DESCRIPTION,
    )
    image = _absolute_https(url, first('meta[property="og:image"]::attr(content)', 'meta[name="twitter:image"]::attr(content)'))
    lang = first("html::attr(lang)")
    language = lang.strip() if lang and _LANG.match(lang.strip()) else None
    published = _iso(
        first(
            'meta[property="article:published_time"]::attr(content)',
            'meta[itemprop="datePublished"]::attr(content)',
            "time[datetime]::attr(datetime)",
        )
    )
    body_root = page.css("body").first if page.css("body") else page
    text = clean_text(str(body_root.get_all_text(ignore_tags=IGNORED_TAGS)), MAX_TEXT)

    result: dict = {"text": text}
    for key, value in (
        ("title", title),
        ("description", description),
        ("image", image),
        ("language", language[:16] if language else None),
        ("publishedAt", published),
    ):
        if value:
            result[key] = value
    return result


def parse_plain(body: bytes, encoding: str = "utf-8") -> dict:
    return {"text": clean_text(body.decode(encoding, errors="replace"), MAX_TEXT)}
