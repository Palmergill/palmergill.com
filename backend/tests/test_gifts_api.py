"""Gift board API (spec 21): the auth boundary and the privacy invariant.

The invariant: an idea (an item with a person_id) is never served to anyone
but its author, by any route. Own-wishlist items are the only rows meant to
cross accounts, and only from the P2 wishlist routes.
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from app import accounts
from app.database import GiftItem, GiftPerson, SessionLocal
from app.main import ROLE_ADMIN, ROLE_MEMBER, SESSION_COOKIE_NAME, app, create_app_session_token
from app.services import gift_board

ADMIN = "palmer"
SECRET = "secret"


@pytest.fixture(autouse=True)
def _auth_env(monkeypatch):
    monkeypatch.setenv("APP_AUTH_USERNAME", ADMIN)
    monkeypatch.setenv("APP_AUTH_PASSWORD", SECRET)
    monkeypatch.delenv("LOCAL_SITE_ROOT", raising=False)
    monkeypatch.delenv("LOCAL_AUTH_USER", raising=False)


def _member_client() -> TestClient:
    name = f"gift{uuid.uuid4().hex[:10]}"
    db = SessionLocal()
    try:
        accounts.create_user(db, name, "correct-horse-battery")
    finally:
        db.close()
    client = TestClient(app)
    client.cookies.set(SESSION_COOKIE_NAME, create_app_session_token(name, SECRET, role=ROLE_MEMBER))
    client.username = name
    return client


def _admin_client() -> TestClient:
    client = TestClient(app)
    client.cookies.set(SESSION_COOKIE_NAME, create_app_session_token(ADMIN, SECRET, role=ROLE_ADMIN))
    return client


def _seed(client: TestClient):
    person = client.post("/api/gifts/people", json={"name": "Mom"}).json()
    idea = client.post(
        "/api/gifts/items", json={"person_id": person["id"], "title": "Secret pasta maker"}
    ).json()
    wish = client.post("/api/gifts/items", json={"title": "Trail shoes"}).json()
    return person, idea, wish


ROUTES = [
    ("get", "/api/gifts/board", None),
    ("post", "/api/gifts/people", {"name": "Sam"}),
    ("patch", "/api/gifts/people/{person}", {"name": "Sam"}),
    ("post", "/api/gifts/people/{person}/move", {"index": 0}),
    ("delete", "/api/gifts/people/{person}", None),
    ("post", "/api/gifts/items", {"title": "Book"}),
    ("patch", "/api/gifts/items/{idea}", {"title": "Book"}),
    ("post", "/api/gifts/items/{idea}/move", {"person_id": None, "index": 0}),
    ("delete", "/api/gifts/items/{idea}", None),
]


def _call(client, method, path, body, person, idea):
    url = path.format(person=person["id"], idea=idea["id"])
    kwargs = {"json": body} if body is not None else {}
    return getattr(client, method)(url, **kwargs)


@pytest.mark.parametrize("method,path,body", ROUTES)
def test_anonymous_callers_get_json_403(method, path, body):
    owner = _member_client()
    person, idea, _wish = _seed(owner)
    response = _call(TestClient(app), method, path, body, person, idea)
    assert response.status_code == 403
    assert "www-authenticate" not in {key.lower() for key in response.headers}
    assert response.json()["detail"] == "Sign in to use the gift board."


@pytest.mark.parametrize("method,path,body", [r for r in ROUTES if "{" in r[1]])
@pytest.mark.parametrize("intruder", ["member", "admin"])
def test_someone_elses_rows_are_404(method, path, body, intruder):
    owner = _member_client()
    person, idea, _wish = _seed(owner)
    other = _member_client() if intruder == "member" else _admin_client()
    response = _call(other, method, path, body, person, idea)
    assert response.status_code == 404
    # And nothing changed for the owner.
    board = owner.get("/api/gifts/board").json()
    assert [p["name"] for p in board["people"]] == ["Mom"]
    assert "Secret pasta maker" in [i["title"] for i in board["items"]]


def test_no_read_route_leaks_another_members_ideas():
    alice, bob, admin = _member_client(), _member_client(), _admin_client()
    secrets = {}
    for client in (alice, bob, admin):
        person = client.post("/api/gifts/people", json={"name": f"Person {uuid.uuid4().hex[:6]}"}).json()
        secret = f"idea-{uuid.uuid4().hex}"
        client.post("/api/gifts/items", json={"person_id": person["id"], "title": secret, "note": secret})
        secrets[id(client)] = (secret, person["name"])

    get_paths = [
        route.path
        for route in app.routes
        if getattr(route, "path", "").startswith("/api/gifts") and "GET" in getattr(route, "methods", set())
    ]
    assert "/api/gifts/board" in get_paths
    for viewer in (alice, bob, admin):
        for path in get_paths:
            assert "{" not in path, f"add a parametrized case for {path}"
            body = viewer.get(path).text
            for other in (alice, bob, admin):
                secret, person_name = secrets[id(other)]
                if other is viewer:
                    assert secret in body
                else:
                    assert secret not in body
                    assert person_name not in body


def test_board_shape_and_default_statuses():
    client = _member_client()
    person, idea, wish = _seed(client)
    assert idea["status"] == "idea" and idea["personId"] == person["id"]
    assert wish["status"] == "wanted" and wish["personId"] is None
    board = client.get("/api/gifts/board").json()
    assert board["people"] == [{"id": person["id"], "name": "Mom", "note": None, "birthday": None}]
    assert {i["id"] for i in board["items"]} == {idea["id"], wish["id"]}


def test_status_must_match_side():
    client = _member_client()
    person, idea, wish = _seed(client)
    assert client.patch(f"/api/gifts/items/{idea['id']}", json={"status": "wanted"}).status_code == 422
    assert client.patch(f"/api/gifts/items/{wish['id']}", json={"status": "bought"}).status_code == 422
    assert client.post("/api/gifts/items", json={"title": "x", "status": "idea"}).status_code == 422
    assert client.patch(f"/api/gifts/items/{idea['id']}", json={"status": "bought"}).json()["status"] == "bought"


@pytest.mark.parametrize(
    "start,to_me,expected",
    [("idea", True, "wanted"), ("bought", True, "wanted"), ("given", True, "received")],
)
def test_moving_across_the_privacy_line_remaps_status(start, to_me, expected):
    client = _member_client()
    person, idea, _wish = _seed(client)
    client.patch(f"/api/gifts/items/{idea['id']}", json={"status": start})
    board = client.post(f"/api/gifts/items/{idea['id']}/move", json={"person_id": None, "index": 0}).json()
    moved = next(i for i in board["items"] if i["id"] == idea["id"])
    assert moved["personId"] is None and moved["status"] == expected
    # ...and back again.
    board = client.post(
        f"/api/gifts/items/{idea['id']}/move", json={"person_id": person["id"], "index": 0}
    ).json()
    back = next(i for i in board["items"] if i["id"] == idea["id"])
    assert back["personId"] == person["id"]
    assert back["status"] == ("given" if expected == "received" else "idea")


def test_move_requires_explicit_destination():
    client = _member_client()
    _person, idea, _wish = _seed(client)
    assert client.post(f"/api/gifts/items/{idea['id']}/move", json={"index": 0}).status_code == 422


def test_cannot_move_into_someone_elses_person():
    alice, bob = _member_client(), _member_client()
    _p, idea, _w = _seed(alice)
    bob_person, _bi, _bw = _seed(bob)
    response = alice.post(
        f"/api/gifts/items/{idea['id']}/move", json={"person_id": bob_person["id"], "index": 0}
    )
    assert response.status_code == 404
    response = alice.post("/api/gifts/items", json={"person_id": bob_person["id"], "title": "x"})
    assert response.status_code == 404


def test_reordering_within_a_column():
    client = _member_client()
    titles = ["a", "b", "c", "d"]
    ids = [client.post("/api/gifts/items", json={"title": t}).json()["id"] for t in titles]
    board = client.post(f"/api/gifts/items/{ids[3]}/move", json={"person_id": None, "index": 1}).json()
    assert [i["title"] for i in board["items"]] == ["a", "d", "b", "c"]
    board = client.post(f"/api/gifts/items/{ids[0]}/move", json={"person_id": None, "index": 3}).json()
    assert [i["title"] for i in board["items"]] == ["d", "b", "c", "a"]


def test_exhausted_gap_respreads_column():
    client = _member_client()
    ids = [client.post("/api/gifts/items", json={"title": t}).json()["id"] for t in "abc"]
    # Repeatedly wedge "c" between the first two until the float gap runs out.
    for _ in range(80):
        client.post(f"/api/gifts/items/{ids[2]}/move", json={"person_id": None, "index": 1})
        client.post(f"/api/gifts/items/{ids[1]}/move", json={"person_id": None, "index": 1})
    board = client.get("/api/gifts/board").json()
    assert len(board["items"]) == 3
    db = SessionLocal()
    try:
        keys = [row.sort_key for row in db.query(GiftItem).filter(GiftItem.id.in_(ids)).order_by(GiftItem.sort_key)]
    finally:
        db.close()
    assert len(set(keys)) == 3


def test_people_order_and_duplicate_names():
    client = _member_client()
    a = client.post("/api/gifts/people", json={"name": "Ann"}).json()
    client.post("/api/gifts/people", json={"name": "Ben"})
    assert client.post("/api/gifts/people", json={"name": "ann"}).status_code == 409
    board = client.post(f"/api/gifts/people/{a['id']}/move", json={"index": 1}).json()
    assert [p["name"] for p in board["people"]] == ["Ben", "Ann"]


def test_deleting_a_person_deletes_their_ideas_only():
    client = _member_client()
    person, idea, wish = _seed(client)
    assert client.delete(f"/api/gifts/people/{person['id']}").status_code == 204
    board = client.get("/api/gifts/board").json()
    assert board["people"] == []
    assert [i["id"] for i in board["items"]] == [wish["id"]]
    db = SessionLocal()
    try:
        assert db.query(GiftItem).filter(GiftItem.id == idea["id"]).first() is None
    finally:
        db.close()


@pytest.mark.parametrize("url", ["javascript:alert(1)", "ftp://example.com/x", "example.com", "http://"])
def test_links_must_be_http(url):
    client = _member_client()
    assert client.post("/api/gifts/items", json={"title": "x", "url": url}).status_code == 422


def test_input_limits():
    client = _member_client()
    assert client.post("/api/gifts/items", json={"title": "x" * 201}).status_code == 422
    assert client.post("/api/gifts/items", json={"title": "x", "note": "n" * 2001}).status_code == 422
    assert client.post("/api/gifts/items", json={"title": "x", "price_cents": -1}).status_code == 422
    assert client.post("/api/gifts/items", json={"title": "   "}).status_code == 422
    ok = client.post("/api/gifts/items", json={"title": "x", "url": "https://example.com/a?b=1", "price_cents": 2599})
    assert ok.status_code == 201 and ok.json()["priceCents"] == 2599


def test_people_limit(monkeypatch):
    monkeypatch.setattr(gift_board, "MAX_PEOPLE", 2)
    client = _member_client()
    client.post("/api/gifts/people", json={"name": "A"})
    client.post("/api/gifts/people", json={"name": "B"})
    assert client.post("/api/gifts/people", json={"name": "C"}).status_code == 422


def test_status_side_is_enforced_by_the_database_too():
    from sqlalchemy.exc import IntegrityError

    db = SessionLocal()
    try:
        db.add(GiftItem(owner_username="x", person_id=None, title="t", status="idea", sort_key=1))
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()
        person = GiftPerson(owner_username="x", name="P", sort_key=1)
        db.add(person)
        db.commit()
        db.add(GiftItem(owner_username="x", person_id=person.id, title="t", status="wanted", sort_key=1))
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()
    finally:
        db.close()
