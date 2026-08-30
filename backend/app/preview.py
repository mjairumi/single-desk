"""Link preview fetcher — the metadata behind the cards in the web app.

Triage is a glance-and-decide loop: an inbox is only sortable at speed if you
can tell what a link *is* without opening it. So the server fetches each saved
URL once, scrapes its Open Graph / <title> / favicon metadata, and caches the
result in `link_previews`, keyed by a hash of the normalized URL.

Why the server and not the browser:
  * one fetch serves every device, forever — the cache is global because page
    metadata is public information, not user data;
  * opening your Inbox never makes your browser phone every domain in it;
  * no third-party favicon service gets handed your reading list.

Previews are DERIVED data: not syncable, no `rev`, no tombstones. Losing the
table costs a re-fetch and nothing else.

## SSRF

Fetching arbitrary user-supplied URLs from inside our network is the textbook
SSRF sink — "http://169.254.169.254/latest/meta-data/" is a URL like any other.
`_assert_public_url` is therefore deliberately paranoid: https/http only, no
embedded credentials, every resolved address checked against the private /
loopback / link-local / reserved ranges, and each redirect hop re-checked
rather than handed to httpx's follower.

Known limitation: resolve-then-connect is a TOCTOU window — a hostile DNS
server can answer our check with a public address and the actual connection
with a private one (DNS rebinding). Closing it means pinning the connection to
the vetted IP, which fights TLS SNI and certificate validation. For a
single-user product whose URLs come from your own bookmarks, the check-then-
connect guard is the right trade; revisit it if previews ever accept URLs from
untrusted third parties.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import ipaddress
import socket
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx

# Budgets. A preview is a nice-to-have: it must never be the reason a request
# hangs, so every dimension of the fetch is capped.
CONNECT_TIMEOUT = 4.0
READ_TIMEOUT = 6.0
MAX_BYTES = 512 * 1024      # plenty for a <head>; most pages hit </head> first
MAX_REDIRECTS = 3
MAX_URLS_PER_REQUEST = 24   # also enforced by the schema
FETCH_CONCURRENCY = 6

# How long a cached row stays fresh. Failures are retried sooner than successes
# (a site that was down at capture time is usually up later), but not so soon
# that a permanently dead link gets re-fetched on every render.
OK_TTL = dt.timedelta(days=30)
ERROR_TTL = dt.timedelta(days=1)

USER_AGENT = (
    "Mozilla/5.0 (compatible; SignalDeskPreview/1.0; +link preview for the "
    "account that saved this URL)"
)

# Field caps — these land in Postgres and then in a card, so bound them here
# rather than trusting a stranger's <meta>.
MAX_TITLE = 300
MAX_DESCRIPTION = 600
MAX_URL = 2000


class PreviewError(Exception):
    """A URL we will not or could not fetch. Cached as status='error'."""


# ---------------------------------------------------------------------------
# URL handling
# ---------------------------------------------------------------------------

def normalize_url(raw: str) -> str:
    """Canonical form used as the cache key.

    Deliberately conservative: lowercase the scheme and host, drop the fragment
    (never sent to the server anyway), strip a default port. The query string is
    KEPT — `?v=` is the whole identity of a YouTube link.
    """
    u = (raw or "").strip()
    if not u:
        raise PreviewError("empty url")
    if "://" not in u:
        u = "https://" + u
    p = urlsplit(u)
    if not p.hostname:
        raise PreviewError("no host")
    host = p.hostname.lower()
    if ":" in host:
        host = f"[{host}]"        # .hostname strips the brackets off an IPv6 literal
    port = p.port
    if (p.scheme == "http" and port == 80) or (p.scheme == "https" and port == 443):
        port = None
    netloc = f"{host}:{port}" if port else host
    return urlunsplit((p.scheme.lower(), netloc, p.path or "/", p.query, ""))


def url_key(normalized: str) -> str:
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _is_public_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if ip.is_private or ip.is_loopback or ip.is_link_local:
        return False
    if ip.is_multicast or ip.is_reserved or ip.is_unspecified:
        return False
    # ::ffff:127.0.0.1 and friends: judge the embedded v4 address, not the
    # wrapper, which reports itself as global.
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        return _is_public_ip(mapped)
    return True


def _assert_public_url(url: str) -> None:
    """Raise unless `url` is http(s) and every address it resolves to is public."""
    p = urlsplit(url)
    if p.scheme not in ("http", "https"):
        raise PreviewError(f"unsupported scheme: {p.scheme or 'none'}")
    if p.username or p.password:
        raise PreviewError("credentials in url")
    host = p.hostname
    if not host:
        raise PreviewError("no host")
    port = p.port or (443 if p.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        raise PreviewError("dns lookup failed")
    if not infos:
        raise PreviewError("dns lookup failed")
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            raise PreviewError("unresolvable address")
        if not _is_public_ip(ip):
            raise PreviewError("blocked: non-public address")


def _clip(value: str | None, limit: int) -> str | None:
    if value is None:
        return None
    v = " ".join(value.split())        # collapse the newlines OG tags love
    if not v:
        return None
    return v[:limit]


def _abs_url(base: str, href: str | None) -> str | None:
    if not href:
        return None
    try:
        out = urljoin(base, href.strip())
    except ValueError:
        return None
    p = urlsplit(out)
    # Only ever hand the browser an http(s) image — no data:/javascript: from a
    # stranger's markup.
    if p.scheme not in ("http", "https"):
        return None
    return out[:MAX_URL]


# ---------------------------------------------------------------------------
# HTML parsing — stdlib only; we need four tags, not a DOM
# ---------------------------------------------------------------------------

class _HeadParser(HTMLParser):
    """Collect <title>, <meta>, and icon <link>s, then stop at <body>."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.title: str | None = None
        self.icons: list[tuple[int, str]] = []   # (score, href)
        self._in_title = False
        self.finished = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self.finished:
            return
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "title":
            self._in_title = True
        elif tag == "meta":
            # og:* uses property=, twitter:*/description use name=.
            key = (a.get("property") or a.get("name") or "").strip().lower()
            content = a.get("content", "").strip()
            # First tag wins: pages that repeat og:image mean the first one.
            if key and content and key not in self.meta:
                self.meta[key] = content
        elif tag == "link":
            rels = a.get("rel", "").lower().split()
            if "icon" in rels or "apple-touch-icon" in rels or "apple-touch-icon-precomposed" in rels:
                self.icons.append((self._icon_score(rels, a.get("sizes", "")), a.get("href", "")))
        elif tag == "body":
            self.finished = True

    @staticmethod
    def _icon_score(rels: list[str], sizes: str) -> int:
        """Bigger is better; an apple-touch-icon beats an undeclared favicon.

        Icons render into a 30px square, so we want the largest source we can
        get and let the browser downscale — a 16px .ico upscaled looks awful on
        a HiDPI screen.
        """
        best = 0
        for token in sizes.lower().split():
            if token == "any":
                best = max(best, 512)
            elif "x" in token:
                head = token.split("x", 1)[0]
                if head.isdigit():
                    best = max(best, int(head))
        if best:
            return best
        return 180 if any(r.startswith("apple-touch-icon") for r in rels) else 32

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False
        elif tag == "head":
            self.finished = True

    def handle_data(self, data: str) -> None:
        if self._in_title and not self.title:
            text = data.strip()
            if text:
                self.title = text


def _parse_html(html: str, final_url: str) -> dict:
    p = _HeadParser()
    try:
        p.feed(html)
    except Exception:
        pass  # malformed markup is the norm; keep whatever we got
    m = p.meta

    def first(*keys: str) -> str | None:
        for k in keys:
            v = m.get(k)
            if v:
                return v
        return None

    icon = None
    if p.icons:
        icon = _abs_url(final_url, max(p.icons, key=lambda pair: pair[0])[1])
    if not icon:
        # Nothing declared: the well-known location is right often enough.
        parts = urlsplit(final_url)
        icon = f"{parts.scheme}://{parts.netloc}/favicon.ico"

    return {
        "title": _clip(first("og:title", "twitter:title") or p.title, MAX_TITLE),
        "description": _clip(
            first("og:description", "twitter:description", "description"), MAX_DESCRIPTION
        ),
        "image_url": _abs_url(
            final_url, first("og:image", "og:image:url", "og:image:secure_url",
                             "twitter:image", "twitter:image:src")
        ),
        "icon_url": icon,
        "site_name": _clip(first("og:site_name"), 120) or urlsplit(final_url).hostname,
    }


# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------

def _open_guarded(client: httpx.Client, url: str) -> httpx.Response:
    """Open a STREAMING GET for `url`, following redirects ourselves.

    Two reasons not to let httpx follow them: every hop needs the SSRF guard
    re-run (httpx would happily walk from a public URL to http://127.0.0.1/),
    and the response must stay unread so `MAX_BYTES` can actually cap it — a
    buffered `client.get()` has already pulled the whole body by the time we
    could measure it.

    The caller owns the returned response and must close it.
    """
    current = url
    for _ in range(MAX_REDIRECTS + 1):
        _assert_public_url(current)
        request = client.build_request("GET", current, headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en",
        })
        response = client.send(request, stream=True)
        if response.is_redirect:
            location = response.headers.get("location")
            response.close()
            if not location:
                raise PreviewError("redirect without location")
            current = urljoin(current, location)
            continue
        return response
    raise PreviewError("too many redirects")


def fetch_preview(url: str) -> dict:
    """Fetch one URL and return a row dict for `link_previews`.

    Never raises: a failure is a cacheable result (status='error'), because a
    dead link should not be re-fetched on every single render.
    """
    normalized = None
    try:
        normalized = normalize_url(url)
        _assert_public_url(normalized)
        timeout = httpx.Timeout(READ_TIMEOUT, connect=CONNECT_TIMEOUT)
        with httpx.Client(timeout=timeout, follow_redirects=False) as client:
            response = _open_guarded(client, normalized)
            try:
                if response.status_code >= 400:
                    raise PreviewError(f"http {response.status_code}")
                final_url = str(response.url)
                content_type = response.headers.get("content-type", "").lower()
                if content_type and "html" not in content_type and "xml" not in content_type:
                    # A PDF or an image: no metadata to scrape, but the site's
                    # favicon still tells you at a glance where it came from.
                    parts = urlsplit(final_url)
                    return _row(normalized, "ok", {
                        "title": None, "description": None, "image_url": None,
                        "icon_url": f"{parts.scheme}://{parts.netloc}/favicon.ico",
                        "site_name": parts.hostname,
                    })
                body = b""
                for chunk in response.iter_bytes():
                    body += chunk
                    if len(body) >= MAX_BYTES:
                        break
                encoding = response.charset_encoding or "utf-8"
            finally:
                response.close()
        try:
            html = body.decode(encoding, errors="replace")
        except LookupError:
            html = body.decode("utf-8", errors="replace")
        return _row(normalized, "ok", _parse_html(html, final_url))
    except PreviewError as e:
        return _row(normalized or (url or "")[:MAX_URL], "error", None, str(e))
    except httpx.HTTPError as e:
        return _row(normalized or (url or "")[:MAX_URL], "error", None,
                    type(e).__name__.replace("Error", "").lower() or "request failed")
    except Exception as e:  # noqa: BLE001 — a preview must never 500 the request
        return _row(normalized or (url or "")[:MAX_URL], "error", None, type(e).__name__)


def _row(normalized: str, status: str, meta: dict | None, error: str | None = None) -> dict:
    meta = meta or {}
    return {
        "url_hash": url_key(normalized),
        "url": normalized[:MAX_URL],
        "status": status,
        "title": meta.get("title"),
        "description": meta.get("description"),
        "image_url": meta.get("image_url"),
        "icon_url": meta.get("icon_url"),
        "site_name": meta.get("site_name"),
        "error": _clip(error, 200),
        "fetched_at": dt.datetime.now(dt.timezone.utc),
    }


def is_stale(status: str, fetched_at: dt.datetime) -> bool:
    if fetched_at.tzinfo is None:
        fetched_at = fetched_at.replace(tzinfo=dt.timezone.utc)
    ttl = ERROR_TTL if status == "error" else OK_TTL
    return dt.datetime.now(dt.timezone.utc) - fetched_at > ttl
