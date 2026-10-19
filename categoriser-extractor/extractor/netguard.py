"""SSRF guard: URL validation, private-address blocklist and a DNS-pinning network backend.

The backend resolves the hostname, rejects the connection if *any* resolved address is
non-public, then connects to the vetted IP. TLS still verifies against the original
hostname (httpcore passes the origin host as SNI), so this also closes DNS rebinding.
"""

from __future__ import annotations

import ipaddress
import socket
from collections.abc import Callable, Iterable
from typing import Any
from urllib.parse import urlsplit

import httpcore
import httpx

Resolver = Callable[[str, int], Iterable[str]]


class BlockedAddress(Exception):
    """Raised when a URL or resolved address is not allowed."""


EXPLICIT_BLOCKS = [
    ipaddress.ip_network(n)
    for n in (
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.0.0.0/24",
        "192.168.0.0/16",
        "198.18.0.0/15",
        "::1/128",
        "::/128",
        "fc00::/7",
        "fe80::/10",
    )
]

BLOCKED_HOSTNAMES = {
    "localhost",
    "metadata",
    "metadata.google.internal",
    "metadata.goog",
    "instance-data",
    "instance-data.ec2.internal",
}
BLOCKED_SUFFIXES = (".localhost", ".local", ".internal", ".localdomain", ".home.arpa")


def is_public_ip(raw: str) -> bool:
    try:
        ip = ipaddress.ip_address(raw.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address):
        mapped = ip.ipv4_mapped or ip.sixtofour
        if mapped is not None:
            ip = mapped
    if any(ip in net for net in EXPLICIT_BLOCKS):
        return False
    return ip.is_global and not ip.is_multicast


def _is_ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host.split("%", 1)[0])
        return True
    except ValueError:
        return False


def validate_url(url: str) -> str:
    """Return the lower-cased hostname if the URL may be fetched, else raise BlockedAddress."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise BlockedAddress("scheme")
    if parts.username or parts.password:
        raise BlockedAddress("userinfo")
    host = (parts.hostname or "").rstrip(".").lower()
    if not host:
        raise BlockedAddress("host")
    if host in BLOCKED_HOSTNAMES or host.endswith(BLOCKED_SUFFIXES):
        raise BlockedAddress("hostname")
    if _is_ip_literal(host) and not is_public_ip(host):
        raise BlockedAddress("private-ip")
    if not _is_ip_literal(host) and "." not in host:
        raise BlockedAddress("single-label-host")
    return host


def system_resolver(host: str, port: int) -> list[str]:
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [str(info[4][0]) for info in infos]


def resolve_public(host: str, port: int, resolver: Resolver = system_resolver) -> str:
    if _is_ip_literal(host):
        if not is_public_ip(host):
            raise BlockedAddress("private-ip")
        return host
    try:
        addresses = list(dict.fromkeys(resolver(host, port)))
    except OSError as exc:
        raise BlockedAddress("dns") from exc
    if not addresses:
        raise BlockedAddress("dns")
    if not all(is_public_ip(a) for a in addresses):
        raise BlockedAddress("private-ip")
    return addresses[0]


class GuardedBackend(httpcore.NetworkBackend):
    def __init__(self, resolver: Resolver = system_resolver, inner: httpcore.NetworkBackend | None = None):
        self._resolver = resolver
        self._inner = inner or httpcore.SyncBackend()

    def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[Any] | None = None,
    ) -> httpcore.NetworkStream:
        if host.rstrip(".").lower() in BLOCKED_HOSTNAMES:
            raise BlockedAddress("hostname")
        ip = resolve_public(host, port, self._resolver)
        return self._inner.connect_tcp(
            ip, port, timeout=timeout, local_address=local_address, socket_options=socket_options
        )

    def connect_unix_socket(self, path: str, timeout: float | None = None, socket_options: Any = None):
        raise BlockedAddress("unix-socket")

    def sleep(self, seconds: float) -> None:
        self._inner.sleep(seconds)


class GuardedTransport(httpx.HTTPTransport):
    """httpx transport whose pool connects only to vetted public IPs."""

    def __init__(self, resolver: Resolver = system_resolver):
        super().__init__(retries=0, trust_env=False)
        ssl_context = self._pool._ssl_context  # reuse httpx's default verified context
        self._pool = httpcore.ConnectionPool(
            ssl_context=ssl_context,
            max_connections=10,
            max_keepalive_connections=0,
            network_backend=GuardedBackend(resolver),
        )
