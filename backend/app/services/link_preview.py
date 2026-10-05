"""Build a link preview for the gift board: a product page's picture and title,
the way a messages app unfurls a pasted link.

This fetches a URL a member typed, from inside our network, which is the
textbook SSRF setup. The defences, all of which apply to every hop:

  * http/https on the default ports only;
  * the hostname is resolved once, and every address it resolves to must be a
    public unicast address — no loopback, private, link-local (cloud metadata
    lives at 169.254.169.254), multicast, or reserved ranges;
  * the connection is then made to that checked IP, with the hostname passed
    only as the Host header and TLS server name, so a DNS answer that changes
    between the check and the connect (rebinding) cannot redirect it;
  * redirects are followed by hand, at most MAX_REDIRECTS, each re-checked;
  * short timeouts, and at most MAX_BYTES of an HTML response are read.

Only the image's URL is kept. The image itself is never fetched here: viewers'
browsers load it straight from the retailer, so this module never proxies or
stores third-party bytes.
"""
import ipaddress
import json
import logging
import re
import os
import socket
import time
from html.parser import HTMLParser
from typing import Dict, List, Optional
from urllib.parse import urljoin, urlsplit

import certifi
from urllib3 import HTTPConnectionPool, HTTPSConnectionPool, Timeout
from urllib3.exceptions import HTTPError

logger = logging.getLogger(__name__)

MAX_REDIRECTS = 3
MAX_BYTES = 512 * 1024
MAX_IMAGE_URL = 2000
TIMEOUT = Timeout(connect=4.0, read=5.0)
DEFAULT_PORTS = {"http": 80, "https": 443}
USER_AGENT = "Mozilla/5.0 (compatible; PalmerGillLinkPreview/1.0; +https://palmergill.com/gifts/)"

# Per-account budget, per API instance (like the auth limiter in main.py).
RATE_LIMIT = 20
RATE_WINDOW_SECONDS = 600
_recent: Dict[str, List[float]] = {}

# Most specific first. og:image:secure_url is the https copy when a page
# offers both. "ld+json" is a schema.org Product's image; "main-img" is a
# store's main product <img> by its well-known id — Amazon, the most common
# gift link, publishes neither og:image nor JSON-LD.
IMAGE_KEYS = (
    "og:image:secure_url",
    "og:image",
    "og:image:url",
    "twitter:image",
    "twitter:image:src",
    "ld+json",
    "main-img",
    "image",
    "image_src",
)
MAIN_IMAGE_IDS = {"landingImage", "imgBlkFront", "main-image"}
# Title sources, best first. "product-title" is the text of a store's product
# heading by well-known id (Amazon's #productTitle), which is the clean
# product name where <title> is "Amazon.com: <name> : <department>".
TITLE_KEYS = ("product-title", "og:title", "twitter:title", "html-title")
PRODUCT_TITLE_IDS = {"productTitle", "title"}
MAX_TITLE = 200
MAX_TITLE_TEXT = 2000
MAX_JSON_LD = 200_000


class PreviewBlocked(Exception):
    """The URL points somewhere this server must not fetch."""


def previews_disabled() -> bool:
    # Set by the e2e suite so tests never reach the internet.
    return os.getenv("GIFT_LINK_PREVIEWS_DISABLED", "").lower() in {"1", "true", "yes"}


def allow(username: str, now: Optional[float] = None) -> bool:
    """Record one preview for `username`; False once over the budget."""
    now = time.time() if now is None else now
    stamps = [t for t in _recent.get(username, []) if t > now - RATE_WINDOW_SECONDS]
    if len(stamps) >= RATE_LIMIT:
        _recent[username] = stamps
        return False
    stamps.append(now)
    _recent[username] = stamps
    return True


# ── address checks ──────────────────────────────────────────────────────────


def is_public_address(address: str) -> bool:
    ip = ipaddress.ip_address(address)
    # An IPv4-mapped IPv6 address (::ffff:127.0.0.1) is judged as the IPv4
    # address it wraps.
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


def resolve_public(host: str, port: int) -> str:
    """One public IP for `host`, or PreviewBlocked if any answer is not public.

    Every answer is checked, not just the first: a name that returns one public
    and one private address is refused outright.
    """
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError) as exc:
        raise PreviewBlocked(f"Could not resolve {host}") from exc
    addresses = [info[4][0] for info in infos]
    if not addresses:
        raise PreviewBlocked(f"Could not resolve {host}")
    for address in addresses:
        if not is_public_address(address):
            raise PreviewBlocked(f"{host} resolves to a non-public address")
    return addresses[0]


def _check_url(url: str):
    parts = urlsplit(url)
    scheme = parts.scheme.lower()
    if scheme not in DEFAULT_PORTS or not parts.hostname:
        raise PreviewBlocked("Only http and https links can be previewed")
    if parts.username or parts.password:
        raise PreviewBlocked("Links with credentials are not previewed")
    port = parts.port or DEFAULT_PORTS[scheme]
    if port != DEFAULT_PORTS[scheme]:
        raise PreviewBlocked("Only default ports are previewed")
    return parts, scheme, port


# ── fetching ────────────────────────────────────────────────────────────────


def _open(url: str):
    """One GET to `url`, pinned to its checked address. No redirects followed."""
    parts, scheme, port = _check_url(url)
    host = parts.hostname
    address = resolve_public(host, port)
    path = parts.path or "/"
    if parts.query:
        path = f"{path}?{parts.query}"
    headers = {
        "Host": host if port == DEFAULT_PORTS[scheme] else f"{host}:{port}",
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        "Accept-Language": "en-US,en;q=0.8",
    }
    if scheme == "https":
        pool = HTTPSConnectionPool(
            address,
            port=port,
            timeout=TIMEOUT,
            retries=False,
            server_hostname=host,
            assert_hostname=host,
            cert_reqs="CERT_REQUIRED",
            ca_certs=certifi.where(),
        )
    else:
        pool = HTTPConnectionPool(address, port=port, timeout=TIMEOUT, retries=False)
    response = pool.urlopen(
        "GET", path, headers=headers, redirect=False, retries=False, preload_content=False
    )
    return pool, response


def _read_capped(response) -> bytes:
    chunks = []
    total = 0
    while total < MAX_BYTES:
        chunk = response.read(min(65536, MAX_BYTES - total))
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
    return b"".join(chunks)


def fetch_html(url: str) -> Optional[tuple]:
    """(final_url, html) for a page, or None when it isn't a readable HTML page."""
    current = url
    for _hop in range(MAX_REDIRECTS + 1):
        pool, response = _open(current)
        try:
            if response.status in (301, 302, 303, 307, 308):
                location = response.headers.get("Location")
                if not location:
                    return None
                current = urljoin(current, location)
                continue
            if response.status != 200:
                return None
            content_type = response.headers.get("Content-Type", "").lower()
            if "html" not in content_type:
                return None
            body = _read_capped(response)
            charset = "utf-8"
            if "charset=" in content_type:
                charset = content_type.split("charset=", 1)[1].split(";")[0].strip() or "utf-8"
            try:
                text = body.decode(charset, errors="replace")
            except LookupError:
                text = body.decode("utf-8", errors="replace")
            return current, text
        finally:
            response.release_conn()
            pool.close()
    return None


# ── parsing ─────────────────────────────────────────────────────────────────


def _product_image(node) -> Optional[str]:
    """The image of the first schema.org Product in a JSON-LD document."""
    if isinstance(node, list):
        for child in node:
            found = _product_image(child)
            if found:
                return found
        return None
    if not isinstance(node, dict):
        return None
    types = node.get("@type")
    types = types if isinstance(types, list) else [types]
    if "Product" in types:
        image = node.get("image")
        if isinstance(image, list):
            image = image[0] if image else None
        if isinstance(image, dict):
            image = image.get("url") or image.get("contentUrl")
        if isinstance(image, str):
            return image
    return _product_image(node.get("@graph")) if "@graph" in node else None


def _amazon_dynamic_image(value: str) -> Optional[str]:
    # data-a-dynamic-image is a JSON object keyed by image URL.
    try:
        options = json.loads(value)
    except ValueError:
        return None
    return next(iter(options), None) if isinstance(options, dict) else None


class _PreviewParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.found: Dict[str, str] = {}
        self.titles: Dict[str, str] = {}
        self.site_name: Optional[str] = None
        self._json_ld: Optional[List[str]] = None
        # Text being collected for a title: (key, closing tag, chunks).
        self._text: Optional[tuple] = None

    def handle_data(self, data):
        if self._json_ld is not None and sum(map(len, self._json_ld)) < MAX_JSON_LD:
            self._json_ld.append(data)
        if self._text is not None and sum(map(len, self._text[2])) < MAX_TITLE_TEXT:
            self._text[2].append(data)

    def handle_endtag(self, tag):
        if self._text is not None and tag == self._text[1]:
            key, _tag, chunks = self._text
            self._text = None
            text = " ".join("".join(chunks).split())
            if text:
                self.titles.setdefault(key, text)
        if tag == "script" and self._json_ld is not None:
            text, self._json_ld = "".join(self._json_ld), None
            if "ld+json" in self.found:
                return
            try:
                image = _product_image(json.loads(text))
            except ValueError:
                return
            if image:
                self.found["ld+json"] = image

    def handle_starttag(self, tag, attrs):
        values = {name.lower(): (value or "") for name, value in attrs}
        if tag == "title" and "html-title" not in self.titles and self._text is None:
            self._text = ("html-title", "title", [])
        elif (
            values.get("id") in PRODUCT_TITLE_IDS
            and tag in ("span", "h1")
            and "product-title" not in self.titles
            and self._text is None
        ):
            self._text = ("product-title", tag, [])
        if tag == "script" and values.get("type", "").lower() == "application/ld+json":
            self._json_ld = []
        elif tag == "img" and values.get("id") in MAIN_IMAGE_IDS and "main-img" not in self.found:
            # The plain src is often a tiny placeholder or a data: URI, so the
            # high-resolution attributes win.
            image = (
                values.get("data-old-hires")
                or _amazon_dynamic_image(values.get("data-a-dynamic-image", ""))
                or values.get("src")
            )
            if image and not image.startswith("data:"):
                self.found["main-img"] = image
        elif tag == "meta":
            key = (values.get("property") or values.get("name") or values.get("itemprop") or "").strip().lower()
            content = values.get("content", "").strip()
            if key in IMAGE_KEYS and content:
                self.found.setdefault(key, content)
            elif key in ("og:title", "twitter:title") and content:
                self.titles.setdefault(key, " ".join(content.split()))
            elif key == "og:site_name" and content and not self.site_name:
                self.site_name = content.strip()
        elif tag == "link":
            rels = values.get("rel", "").lower().split()
            href = values.get("href", "").strip()
            if "image_src" in rels and href:
                self.found.setdefault("image_src", href)


def clean_title(title: str, page_url: str, site_name: Optional[str] = None) -> Optional[str]:
    """Strip the shop's name off a page title, as a messages app's preview does.

    "Amazon.com: Echo Dot : Electronics" → "Echo Dot : Electronics" (the
    domain prefix), and "Tree Runners | Allbirds" → "Tree Runners" (a suffix
    naming the site). A title that is nothing but the site name is dropped.
    """
    title = " ".join(title.split())
    host = (urlsplit(page_url).hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    brand = host.split(".")[-2] if host.count(".") >= 1 else host
    names = {name for name in (host, brand, (site_name or "").lower().strip()) if name}

    def is_site(text: str) -> bool:
        squashed = re.sub(r"[^a-z0-9]", "", text.lower())
        return bool(squashed) and any(squashed == re.sub(r"[^a-z0-9]", "", name) for name in names)

    prefix = re.match(r"^([^:|]{2,40}?)\s*:\s+(.+)$", title)
    if prefix and (is_site(prefix.group(1)) or "." in prefix.group(1)):
        title = prefix.group(2)
    for separator in (" | ", " - ", " – ", " — ", " · "):
        if separator in title:
            head, tail = title.rsplit(separator, 1)
            if is_site(tail):
                title = head
                break
    if not title or is_site(title):
        return None
    return title[:MAX_TITLE].strip() or None


def preview_from_html(html: str, page_url: str) -> Dict[str, Optional[str]]:
    parser = _PreviewParser()
    try:
        parser.feed(html)
    except Exception:  # A malformed page is a page with no preview, not a 500.
        logger.debug("Could not parse %s", page_url, exc_info=True)
    image = None
    for key in IMAGE_KEYS:
        if key in parser.found:
            candidate = clean_image_url(urljoin(page_url, parser.found[key]))
            # A junk value ("//", "#") resolves back to the page itself,
            # which is not an image.
            if candidate and candidate != clean_image_url(page_url):
                image = candidate
                break
    title = None
    for key in TITLE_KEYS:
        if key in parser.titles:
            title = clean_title(parser.titles[key], page_url, parser.site_name)
            if title:
                break
    return {"imageUrl": image, "title": title}


def image_from_html(html: str, page_url: str) -> Optional[str]:
    return preview_from_html(html, page_url)["imageUrl"]


def clean_image_url(value: Optional[str]) -> Optional[str]:
    """An image URL safe to put in an <img src>, or None.

    http is upgraded to https: browsers block or auto-upgrade mixed content on
    an https page anyway, and an explicit https URL fails visibly rather than
    silently.
    """
    if not value:
        return None
    value = value.strip()
    parts = urlsplit(value)
    if parts.scheme.lower() == "http":
        value = "https" + value[4:]
        parts = urlsplit(value)
    if parts.scheme.lower() != "https" or not parts.netloc or len(value) > MAX_IMAGE_URL:
        return None
    return value


def find_preview(url: str) -> Dict[str, Optional[str]]:
    """{"imageUrl", "title"} for a product page; both None when it can't be read.

    Never raises: a blocked, failed or unreadable page is a link with no
    preview, which the page shows as a plain site card.
    """
    empty = {"imageUrl": None, "title": None}
    try:
        fetched = fetch_html(url)
    except PreviewBlocked as exc:
        logger.info("Link preview blocked: %s", exc)
        return empty
    except (HTTPError, OSError, ValueError) as exc:
        logger.info("Link preview failed for %s: %s", urlsplit(url).hostname, exc)
        return empty
    if not fetched:
        return empty
    final_url, html = fetched
    return preview_from_html(html, final_url)


def find_image(url: str) -> Optional[str]:
    return find_preview(url)["imageUrl"]
