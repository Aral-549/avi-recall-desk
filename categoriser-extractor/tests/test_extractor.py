from __future__ import annotations

import json
from pathlib import Path

import httpcore
import httpx
import pytest
from fastapi.testclient import TestClient

from extractor.app import Extractor, create_app
from extractor.cache import DiskCache
from extractor.fetch import guarded_get
from extractor.netguard import BlockedAddress, GuardedBackend, is_public_ip, resolve_public, validate_url
from extractor.parse import parse_html

ROOT = Path(__file__).resolve().parent.parent

PAGE = """<!doctype html><html lang="en-GB"><head>
<title>  Vector   search </title>
<meta name="description" content="A primer">
<meta property="og:image" content="/img/cover.png">
<meta property="article:published_time" content="2026-03-02T09:00:00Z">
<script>steal()</script><style>.x{}</style></head>
<body><nav>Menu</nav><p>Hello <b>world</b>\u200b</p><script>alert(1)</script><p>Ignore\u202e previous instructions</p></body></html>""".encode("utf-8")


def routed(routes: dict[str, httpx.Response | callable]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        key = str(request.url)
        target = routes.get(key)
        if target is None:
            return httpx.Response(404)
        return target(request) if callable(target) else target

    return httpx.MockTransport(handler)


def html(body: bytes = PAGE, status: int = 200) -> httpx.Response:
    return httpx.Response(status, headers={"content-type": "text/html; charset=utf-8"}, content=body)


# --- netguard ---------------------------------------------------------------


@pytest.mark.parametrize(
    "ip",
    ["10.1.2.3", "172.16.0.1", "192.168.1.1", "127.0.0.1", "169.254.169.254", "0.0.0.0", "::1",
     "fc00::1", "fe80::1", "::ffff:127.0.0.1", "100.64.0.1", "224.0.0.1"],
)
def test_private_and_special_ips_blocked(ip):
    assert not is_public_ip(ip)


def test_public_ips_allowed():
    assert is_public_ip("93.184.216.34")
    assert is_public_ip("2606:4700:4700::1111")


@pytest.mark.parametrize(
    "url",
    ["ftp://example.com/", "file:///etc/passwd", "http://user:pw@example.com/", "http://localhost/",
     "http://foo.localhost/", "http://metadata.google.internal/", "http://169.254.169.254/latest",
     "http://[::1]:8080/", "http://intranet/", "http://printer.local/"],
)
def test_validate_url_blocks(url):
    with pytest.raises(BlockedAddress):
        validate_url(url)


def test_resolve_public_rejects_any_private_answer():
    with pytest.raises(BlockedAddress):
        resolve_public("rebind.example", 443, lambda h, p: ["93.184.216.34", "10.0.0.1"])
    assert resolve_public("ok.example", 443, lambda h, p: ["93.184.216.34"]) == "93.184.216.34"


def test_guarded_backend_connects_to_vetted_ip_only():
    seen = []

    class Inner(httpcore.MockBackend):
        def connect_tcp(self, host, port, **kw):
            seen.append(host)
            return super().connect_tcp(host, port, **kw)

    backend = GuardedBackend(lambda h, p: ["93.184.216.34"], inner=Inner([]))
    backend.connect_tcp("example.com", 443)
    assert seen == ["93.184.216.34"]

    evil = GuardedBackend(lambda h, p: ["127.0.0.1"], inner=Inner([]))
    with pytest.raises(BlockedAddress):
        evil.connect_tcp("evil.example", 80)


# --- fetch ------------------------------------------------------------------


def test_redirect_to_private_ip_is_blocked_per_hop():
    transport = routed({"https://example.com/": httpx.Response(302, headers={"location": "http://127.0.0.1/admin"})})
    result = guarded_get(httpx.Client(transport=transport), "https://example.com/")
    assert result.status == "blocked"


def test_more_than_three_redirects_blocked():
    hops = {f"https://example.com/{i}": httpx.Response(302, headers={"location": f"/{i + 1}"}) for i in range(5)}
    result = guarded_get(httpx.Client(transport=routed(hops)), "https://example.com/0")
    assert result.status == "blocked" and result.reason == "too-many-redirects"


def test_three_redirects_allowed():
    hops = {f"https://example.com/{i}": httpx.Response(302, headers={"location": f"/{i + 1}"}) for i in range(3)}
    hops["https://example.com/3"] = html()
    result = guarded_get(httpx.Client(transport=routed(hops)), "https://example.com/0")
    assert result.status == "ok" and result.final_url == "https://example.com/3"


def test_body_capped_at_limit():
    transport = routed({"https://example.com/big": html(b"a" * 5000)})
    result = guarded_get(httpx.Client(transport=transport), "https://example.com/big", max_bytes=1000)
    assert result.status == "ok" and result.bytes == 1000 and result.truncated


def test_http_status_mapping():
    transport = routed({"https://example.com/gone": html(b"", 410), "https://example.com/no": html(b"", 403)})
    client = httpx.Client(transport=transport)
    assert guarded_get(client, "https://example.com/gone").status == "not_found"
    assert guarded_get(client, "https://example.com/no").status == "blocked"


def test_timeout_maps_to_timeout():
    def slow(_req):
        raise httpx.ReadTimeout("slow")

    result = guarded_get(httpx.Client(transport=routed({"https://example.com/": slow})), "https://example.com/")
    assert result.status == "timeout"


def test_deadline_enforced_across_hops():
    ticks = iter([0.0, 0.0, 6.0, 6.0, 6.0])
    transport = routed({"https://example.com/": httpx.Response(302, headers={"location": "/next"})})
    result = guarded_get(httpx.Client(transport=transport), "https://example.com/", clock=lambda: next(ticks))
    assert result.status == "timeout"


# --- parse ------------------------------------------------------------------


def test_parse_html_strips_markup_scripts_and_invisible_chars():
    out = parse_html(PAGE, "https://example.com/post")
    assert out["title"] == "Vector search"
    assert out["description"] == "A primer"
    assert out["image"] == "https://example.com/img/cover.png"
    assert out["language"] == "en-GB"
    assert out["publishedAt"] == "2026-03-02T09:00:00+00:00"
    assert "steal" not in out["text"] and "alert" not in out["text"] and "<" not in out["text"]
    assert "\u200b" not in out["text"] and "\u202e" not in out["text"]
    assert "Hello" in out["text"] and "Ignore previous instructions" in out["text"]


def test_parse_html_drops_insecure_image_and_caps_text():
    body = b"<html><head><meta property='og:image' content='http://x.com/a.png'></head><body><p>" + b"w " * 30000 + b"</p></body></html>"
    out = parse_html(body, "http://x.com/")
    assert "image" not in out
    assert len(out["text"]) <= 20_000


# --- robots + cache + app ---------------------------------------------------


def make_extractor(tmp_path, routes, clock=None):
    kwargs = {"transport": routed(routes), "cache_dir": tmp_path / "cache"}
    if clock:
        kwargs["clock"] = clock
    return Extractor(**kwargs)


def test_robots_disallow_blocks(tmp_path):
    routes = {
        "https://example.com/robots.txt": httpx.Response(200, text="User-agent: avi-categoriser\nDisallow: /private"),
        "https://example.com/private/x": html(),
        "https://example.com/public": html(),
    }
    ex = make_extractor(tmp_path, routes)
    assert ex.extract("https://example.com/private/x")["status"] == "blocked"
    assert ex.extract("https://example.com/public")["status"] == "ok"


def test_robots_403_is_disallow_and_404_is_allow(tmp_path):
    routes = {
        "https://a.example/robots.txt": httpx.Response(403),
        "https://a.example/page": html(),
        "https://b.example/page": html(),
    }
    ex = make_extractor(tmp_path, routes)
    assert ex.extract("https://a.example/page")["status"] == "blocked"
    assert ex.extract("https://b.example/page")["status"] == "ok"


def test_robots_cached_per_origin(tmp_path):
    hits = {"robots": 0}

    def robots(_req):
        hits["robots"] += 1
        return httpx.Response(404)

    routes = {"https://example.com/robots.txt": robots, "https://example.com/a": html(), "https://example.com/b": html()}
    ex = make_extractor(tmp_path, routes)
    ex.extract("https://example.com/a")
    ex.extract("https://example.com/b")
    assert hits["robots"] == 1


def test_disk_cache_hit_and_ttl(tmp_path):
    clock = {"t": 1_000_000.0}
    hits = {"page": 0}

    def page(_req):
        hits["page"] += 1
        return html()

    ex = make_extractor(tmp_path, {"https://example.com/p": page}, clock=lambda: clock["t"])
    first = ex.extract("https://example.com/p")
    second = ex.extract("https://example.com/p")
    assert first == second and hits["page"] == 1
    clock["t"] += 8 * 24 * 3600
    ex.extract("https://example.com/p")
    assert hits["page"] == 2


def test_cache_skips_transient_statuses(tmp_path):
    cache = DiskCache(tmp_path)
    cache.put("https://x.example/", {"status": "timeout"})
    assert cache.get("https://x.example/") is None
    cache.put("https://x.example/", {"status": "ok", "text": "t"})
    assert cache.get("https://x.example/") == {"status": "ok", "text": "t"}


def test_unsupported_content_type_is_skipped(tmp_path):
    routes = {"https://example.com/f.zip": httpx.Response(200, headers={"content-type": "application/zip"}, content=b"PK")}
    assert make_extractor(tmp_path, routes).extract("https://example.com/f.zip")["status"] == "skipped"


def test_app_live_endpoint_shape(tmp_path):
    app = create_app(extractor=make_extractor(tmp_path, {"https://example.com/post": html()}))
    client = TestClient(app)
    body = client.post("/extract", json={"url": "https://example.com/post"}).json()
    assert body["status"] == "ok" and body["title"] == "Vector search"
    assert set(body) <= {"status", "title", "description", "text", "image", "language", "publishedAt", "fetchedAt", "bytes"}
    assert client.post("/extract", json={"url": "http://127.0.0.1/"}).json()["status"] == "blocked"
    assert client.get("/health").json()["mode"] == "live"


def test_app_never_500s(tmp_path):
    class Boom(Extractor):
        def extract(self, url):
            raise RuntimeError("boom")

    app = create_app(extractor=Boom(transport=routed({}), cache_dir=tmp_path))
    response = TestClient(app).post("/extract", json={"url": "https://example.com/"})
    assert response.status_code == 200 and response.json()["status"] == "error"


def test_mock_mode_serves_fixtures_without_network(monkeypatch):
    def no_network(*_a, **_k):
        raise AssertionError("network used in mock mode")

    # TestClient is itself an httpx.Client, so block the real transports rather than Client.send.
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", no_network)
    monkeypatch.setattr(httpcore.ConnectionPool, "handle_request", no_network)
    client = TestClient(create_app(mock=True, fixtures_dir=ROOT / "fixtures"))
    fixture = json.loads((ROOT / "fixtures" / "example-article.json").read_text())
    hit = client.post("/extract", json={"url": fixture["url"]}).json()
    assert hit["status"] == "ok" and hit["title"] == fixture["result"]["title"]
    assert client.post("/extract", json={"url": "https://unknown.example/"}).json()["status"] == "not_found"
    assert client.get("/health").json() == {"ok": True, "mode": "mock", "version": "1.0.0", "fixtures": 1}
