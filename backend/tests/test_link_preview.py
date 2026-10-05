"""Gift board link previews: the SSRF guard, the og:image parser, and the API.

The fetch tests run a real HTTP server on loopback. Loopback is exactly what
the guard refuses, so name resolution is stubbed: "shop.test" maps to the
server and is treated as public; everything else resolves as it really would.
"""
import socket
import threading
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from fastapi.testclient import TestClient

from app import accounts
from app.database import SessionLocal
from app.main import ROLE_MEMBER, SESSION_COOKIE_NAME, app, create_app_session_token
from app.services import link_preview

SECRET = "secret"


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("APP_AUTH_USERNAME", "palmer")
    monkeypatch.setenv("APP_AUTH_PASSWORD", SECRET)
    monkeypatch.delenv("GIFT_LINK_PREVIEWS_DISABLED", raising=False)
    link_preview._recent.clear()


# ── address checks ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("address", [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "fc00::1",
    "::ffff:127.0.0.1", "::ffff:169.254.169.254",
])
def test_non_public_addresses_are_refused(address):
    assert not link_preview.is_public_address(address)


@pytest.mark.parametrize("address", ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"])
def test_public_addresses_are_allowed(address):
    assert link_preview.is_public_address(address)


def _fake_dns(monkeypatch, answers):
    def getaddrinfo(host, port, *args, **kwargs):
        if host not in answers:
            raise socket.gaierror("no such host")
        family = socket.AF_INET6 if ":" in answers[host][0] else socket.AF_INET
        return [(family, socket.SOCK_STREAM, 6, "", (address, port)) for address in answers[host]]
    monkeypatch.setattr(link_preview.socket, "getaddrinfo", getaddrinfo)


def test_a_name_with_any_private_answer_is_refused(monkeypatch):
    _fake_dns(monkeypatch, {"mixed.test": ["93.184.216.34", "10.0.0.5"]})
    with pytest.raises(link_preview.PreviewBlocked):
        link_preview.resolve_public("mixed.test", 443)


def test_metadata_hostname_is_refused(monkeypatch):
    _fake_dns(monkeypatch, {"metadata.test": ["169.254.169.254"]})
    with pytest.raises(link_preview.PreviewBlocked):
        link_preview.resolve_public("metadata.test", 80)


@pytest.mark.parametrize("url", [
    "ftp://example.com/file",
    "http://example.com:8080/",
    "https://example.com:22/",
    "http://user:pass@example.com/",
    "file:///etc/passwd",
    "http:///nohost",
])
def test_unsupported_urls_are_refused(url):
    with pytest.raises(link_preview.PreviewBlocked):
        link_preview._check_url(url)


def test_literal_private_ip_url_finds_nothing():
    assert link_preview.find_image("http://127.0.0.1/") is None
    assert link_preview.find_image("http://169.254.169.254/latest/meta-data/") is None


# ── parsing ─────────────────────────────────────────────────────────────────


def test_parser_prefers_secure_og_image_and_resolves_relative_urls():
    html = """<html><head>
        <meta name="twitter:image" content="https://cdn.test/twitter.jpg">
        <meta property="og:image" content="/img/og.jpg">
        <meta property="og:image:secure_url" content="https://cdn.test/secure.jpg">
    </head></html>"""
    assert link_preview.image_from_html(html, "https://shop.test/p/1") == "https://cdn.test/secure.jpg"
    html = '<meta property="og:image" content="/img/og.jpg">'
    assert link_preview.image_from_html(html, "https://shop.test/p/1") == "https://shop.test/img/og.jpg"


def test_parser_falls_back_and_upgrades_http():
    html = '<link rel="image_src" href="http://cdn.test/a.png"><meta name="twitter:image" content="http://cdn.test/t.png">'
    assert link_preview.image_from_html(html, "https://shop.test/") == "https://cdn.test/t.png"


@pytest.mark.parametrize("value", ["javascript:alert(1)", "data:image/png;base64,AAAA", "//", ""])
def test_parser_rejects_unsafe_image_urls(value):
    html = f'<meta property="og:image" content="{value}">'
    assert link_preview.image_from_html(html, "https://shop.test/") is None


def test_page_without_image_meta():
    assert link_preview.image_from_html("<html><title>x</title></html>", "https://shop.test/") is None


# ── fetching, against a real local server ───────────────────────────────────


class _Handler(BaseHTTPRequestHandler):
    routes = {}

    def do_GET(self):
        status, headers, body = self.routes.get(self.path, (404, {}, b""))
        self.send_response(status)
        for key, value in headers.items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


@pytest.fixture
def shop(monkeypatch):
    server = HTTPServer(("127.0.0.1", 0), _Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    # The test server is on a random port; treat it as http's default so the
    # port rule doesn't refuse it.
    monkeypatch.setattr(link_preview, "DEFAULT_PORTS", {"http": port, "https": 443})
    real_resolve = link_preview.resolve_public

    def resolve(host, port_):
        if host == "shop.test":
            return "127.0.0.1"
        return real_resolve(host, port_)

    monkeypatch.setattr(link_preview, "resolve_public", resolve)
    _Handler.routes = {}
    yield f"http://shop.test:{port}", _Handler.routes
    server.shutdown()


HTML = {"Content-Type": "text/html; charset=utf-8"}


def test_finds_og_image_on_a_product_page(shop):
    base, routes = shop
    routes["/p/kettle"] = (200, HTML, b'<head><meta property="og:image" content="https://cdn.test/kettle.jpg"></head>')
    assert link_preview.find_image(f"{base}/p/kettle") == "https://cdn.test/kettle.jpg"


def test_follows_a_redirect_to_an_allowed_host(shop):
    base, routes = shop
    routes["/short"] = (302, {"Location": "/p/real"}, b"")
    routes["/p/real"] = (200, HTML, b'<meta property="og:image" content="https://cdn.test/real.jpg">')
    assert link_preview.find_image(f"{base}/short") == "https://cdn.test/real.jpg"


def test_redirect_to_a_private_address_is_refused(shop, caplog):
    base, routes = shop
    routes["/evil"] = (302, {"Location": "http://169.254.169.254/latest/meta-data/"}, b"")
    with caplog.at_level("INFO", logger=link_preview.__name__):
        assert link_preview.find_image(f"{base}/evil") is None
    # Refused by the guard, not merely a failed connection.
    assert "non-public address" in caplog.text


def test_redirect_loops_stop(shop, monkeypatch):
    base, routes = shop
    routes["/loop"] = (302, {"Location": "/loop"}, b"")
    opened = []
    real_open = link_preview._open
    monkeypatch.setattr(link_preview, "_open", lambda url: opened.append(url) or real_open(url))
    assert link_preview.find_image(f"{base}/loop") is None
    assert len(opened) == link_preview.MAX_REDIRECTS + 1


def test_non_html_responses_are_ignored(shop):
    base, routes = shop
    routes["/file"] = (200, {"Content-Type": "application/json"}, b'{"og:image": "https://cdn.test/x.jpg"}')
    assert link_preview.find_image(f"{base}/file") is None


def test_reads_at_most_max_bytes(shop):
    base, routes = shop
    padding = b"<!--" + b"x" * (link_preview.MAX_BYTES + 1000) + b"-->"
    routes["/big"] = (200, HTML, padding + b'<meta property="og:image" content="https://cdn.test/late.jpg">')
    assert link_preview.find_image(f"{base}/big") is None


def test_error_status_finds_nothing(shop):
    base, _routes = shop
    assert link_preview.find_image(f"{base}/missing") is None


# ── API ─────────────────────────────────────────────────────────────────────


def _member():
    name = f"prev{uuid.uuid4().hex[:10]}"
    db = SessionLocal()
    try:
        accounts.create_user(db, name, "correct-horse-battery")
    finally:
        db.close()
    client = TestClient(app)
    client.cookies.set(SESSION_COOKIE_NAME, create_app_session_token(name, SECRET, role=ROLE_MEMBER))
    return client


def test_preview_endpoint_requires_sign_in():
    response = TestClient(app).post("/api/gifts/link-preview", json={"url": "https://example.com"})
    assert response.status_code == 403


def test_preview_endpoint_returns_the_image(monkeypatch):
    monkeypatch.setattr(link_preview, "find_image", lambda url: "https://cdn.test/a.jpg")
    response = _member().post("/api/gifts/link-preview", json={"url": "https://shop.example/p"})
    assert response.json() == {"imageUrl": "https://cdn.test/a.jpg", "status": "found"}


def test_preview_endpoint_validates_the_link():
    assert _member().post("/api/gifts/link-preview", json={"url": "javascript:alert(1)"}).status_code == 422


def test_preview_endpoint_can_be_disabled(monkeypatch):
    monkeypatch.setenv("GIFT_LINK_PREVIEWS_DISABLED", "true")
    monkeypatch.setattr(link_preview, "find_image", lambda url: pytest.fail("must not fetch"))
    response = _member().post("/api/gifts/link-preview", json={"url": "https://shop.example/p"})
    assert response.json()["status"] == "disabled"


def test_preview_endpoint_is_rate_limited(monkeypatch):
    monkeypatch.setattr(link_preview, "find_image", lambda url: None)
    monkeypatch.setattr(link_preview, "RATE_LIMIT", 2)
    client = _member()
    statuses = [client.post("/api/gifts/link-preview", json={"url": "https://shop.example/p"}).status_code for _ in range(3)]
    assert statuses == [200, 200, 429]


def test_items_store_and_share_an_image_url():
    owner, viewer = _member(), _member()
    created = owner.post("/api/gifts/items", json={"title": "Kettle", "image_url": "http://cdn.test/k.jpg"}).json()
    assert created["imageUrl"] == "https://cdn.test/k.jpg"
    assert owner.post("/api/gifts/items", json={"title": "x", "image_url": "javascript:alert(1)"}).status_code == 422
    username = owner.get("/api/gifts/board").json()["username"]
    wishlist = viewer.get(f"/api/gifts/wishlists/{username}").json()
    assert wishlist["items"][0]["imageUrl"] == "https://cdn.test/k.jpg"
    cleared = owner.patch(f"/api/gifts/items/{created['id']}", json={"image_url": None}).json()
    assert cleared["imageUrl"] is None


def test_parser_reads_schema_org_product_image():
    html = """<script type="application/ld+json">
        {"@context": "https://schema.org", "@graph": [
            {"@type": "BreadcrumbList"},
            {"@type": ["Product", "Thing"], "name": "Kettle",
             "image": [{"@type": "ImageObject", "url": "https://cdn.test/ld.jpg"}]}
        ]}
    </script>"""
    assert link_preview.image_from_html(html, "https://shop.test/") == "https://cdn.test/ld.jpg"


def test_parser_ignores_broken_json_ld():
    html = '<script type="application/ld+json">{not json</script><meta name="twitter:image" content="https://cdn.test/t.jpg">'
    assert link_preview.image_from_html(html, "https://shop.test/") == "https://cdn.test/t.jpg"


def test_parser_reads_amazon_main_image():
    html = """<img id="landingImage" src="data:image/gif;base64,R0lGOD"
        data-a-dynamic-image='{"https://m.media-amazon.com/images/I/big.jpg":[1500,1500]}'>"""
    assert link_preview.image_from_html(html, "https://www.amazon.com/dp/X") == "https://m.media-amazon.com/images/I/big.jpg"
    html = '<img id="landingImage" data-old-hires="https://m.media-amazon.com/images/I/hires.jpg" src="https://m.media-amazon.com/small.jpg">'
    assert link_preview.image_from_html(html, "https://www.amazon.com/dp/X") == "https://m.media-amazon.com/images/I/hires.jpg"


def test_og_image_beats_the_fallbacks():
    html = """<img id="landingImage" src="https://cdn.test/main.jpg">
        <script type="application/ld+json">{"@type": "Product", "image": "https://cdn.test/ld.jpg"}</script>
        <meta property="og:image" content="https://cdn.test/og.jpg">"""
    assert link_preview.image_from_html(html, "https://shop.test/") == "https://cdn.test/og.jpg"
