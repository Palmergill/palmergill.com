"""Fourth & Fortune fairness, account gating, and live turn flow."""

import hashlib

from fastapi.testclient import TestClient
from sqlalchemy import event

from app.accounts import ROLE_MEMBER
from app.database import (
    Base,
    FantasyDraftFlip,
    FantasyDraftPlayer,
    FantasyDraftRound,
    FantasyDraftSession,
    SessionLocal,
    engine,
)
from app.main import SESSION_COOKIE_NAME, app, create_app_session_token
from app.services import draft_order_game
from app.services.draft_order_game import ROUNDS_PER_PLAYER
from scripts.verify_draft_order import verify_proof

ADMIN_PASSWORD = "secret"


def setup_function():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        db.query(FantasyDraftFlip).delete()
        db.query(FantasyDraftRound).delete()
        db.query(FantasyDraftPlayer).delete()
        db.query(FantasyDraftSession).delete()
        db.commit()
    finally:
        db.close()


def member_client(monkeypatch, username):
    monkeypatch.setenv("APP_AUTH_USERNAME", "palmer")
    monkeypatch.setenv("APP_AUTH_PASSWORD", ADMIN_PASSWORD)
    client = TestClient(app)
    client.cookies.set(
        SESSION_COOKIE_NAME,
        create_app_session_token(username, ADMIN_PASSWORD, role=ROLE_MEMBER),
    )
    return client


def create_room(client, league_name="Sunday Legends"):
    response = client.post(
        "/api/fantasy/draft/sessions",
        json={"league_name": league_name},
    )
    assert response.status_code == 201
    return response.json()


def join_room(client, code):
    response = client.post(
        "/api/fantasy/draft/sessions/join",
        json={"join_code": code},
    )
    assert response.status_code == 200
    return response.json()


def clients_by_player(view, host, guest):
    return {
        "host-player": host,
        "road-warrior": guest,
    }


def test_account_is_required_to_create_or_join(monkeypatch):
    monkeypatch.setenv("APP_AUTH_USERNAME", "palmer")
    monkeypatch.setenv("APP_AUTH_PASSWORD", ADMIN_PASSWORD)
    client = TestClient(app)

    assert client.post(
        "/api/fantasy/draft/sessions", json={"league_name": "Sunday Legends"}
    ).status_code == 401
    assert client.post(
        "/api/fantasy/draft/sessions/join", json={"join_code": "ABC234"}
    ).status_code == 401


def test_room_is_inserted_before_host_player():
    inserted_tables = []

    def capture_insert(_connection, _cursor, statement, _parameters, _context, _many):
        normalized = " ".join(statement.lower().split())
        if normalized.startswith("insert into ff_draft_"):
            inserted_tables.append(normalized.split()[2].strip('"'))

    event.listen(engine, "before_cursor_execute", capture_insert)
    db = SessionLocal()
    try:
        draft_order_game.create_session(
            db,
            {"username": "host-player", "role": ROLE_MEMBER},
            "Sunday Legends",
        )
    finally:
        db.close()
        event.remove(engine, "before_cursor_execute", capture_insert)

    assert inserted_tables == ["ff_draft_sessions", "ff_draft_players"]


def test_open_room_code_can_invite_a_new_account(monkeypatch):
    host = member_client(monkeypatch, "host-player")
    monkeypatch.delenv("APP_SIGNUP_INVITE_CODE", raising=False)
    room = create_room(host)
    newcomer = TestClient(app)

    response = newcomer.post(
        "/login/signup",
        json={
            "username": "new-manager",
            "password": "a-great-password",
            "inviteCode": room["joinCode"].lower(),
            "next": f"/fantasy/draft-order/?join={room['joinCode']}",
        },
    )

    assert response.status_code == 200
    assert response.json()["username"] == "new-manager"
    assert response.json()["redirect"].endswith(f"?join={room['joinCode']}")


def test_room_publishes_commitment_then_locks_roster(monkeypatch):
    host = member_client(monkeypatch, "Host-Player")
    guest = member_client(monkeypatch, "Road-Warrior")
    late = member_client(monkeypatch, "Late-Player")

    room = create_room(host)
    assert room["state"] == "lobby"
    assert len(room["seedHash"]) == 64
    assert room["joinCode"]
    assert room["players"][0]["username"] == "host-player"
    assert room["canStart"] is False

    joined = join_room(guest, room["joinCode"].lower())
    assert len(joined["players"]) == 2

    started_response = host.post(f"/api/fantasy/draft/sessions/{room['id']}/start")
    assert started_response.status_code == 200
    started = started_response.json()
    assert started["state"] == "active"
    assert sorted(player["turnPosition"] for player in started["players"]) == [1, 2]
    assert started["currentPlayer"]["turnPosition"] == 1

    too_late = late.post(
        "/api/fantasy/draft/sessions/join",
        json={"join_code": room["joinCode"]},
    )
    assert too_late.status_code == 409


def test_only_host_can_start_and_two_players_are_required(monkeypatch):
    host = member_client(monkeypatch, "host-player")
    guest = member_client(monkeypatch, "road-warrior")
    room = create_room(host)

    assert host.post(f"/api/fantasy/draft/sessions/{room['id']}/start").status_code == 409
    join_room(guest, room["joinCode"])
    assert guest.post(f"/api/fantasy/draft/sessions/{room['id']}/start").status_code == 403


def test_turn_is_server_authoritative_and_deck_continues_between_rounds(monkeypatch):
    host = member_client(monkeypatch, "host-player")
    guest = member_client(monkeypatch, "road-warrior")
    room = create_room(host)
    join_room(guest, room["joinCode"])
    started = host.post(f"/api/fantasy/draft/sessions/{room['id']}/start").json()

    clients = clients_by_player(started, host, guest)
    current_name = next(
        player["username"]
        for player in started["players"]
        if player["id"] == started["currentPlayer"]["id"]
    )
    other_client = guest if clients[current_name] is host else host
    assert other_client.post(
        f"/api/fantasy/draft/sessions/{room['id']}/flip"
    ).status_code == 403

    current_client = clients[current_name]
    first = current_client.post(f"/api/fantasy/draft/sessions/{room['id']}/flip")
    assert first.status_code == 200
    assert first.json()["event"]["card"]["deckIndex"] == 0
    assert current_client.post(
        f"/api/fantasy/draft/sessions/{room['id']}/bank"
    ).status_code == 200

    second = current_client.post(f"/api/fantasy/draft/sessions/{room['id']}/flip")
    assert second.status_code == 200
    assert second.json()["event"]["card"]["deckIndex"] == 1
    assert second.json()["currentRound"]["number"] == 2


def test_duplicate_rank_busts_and_scores_zero(monkeypatch):
    host = member_client(monkeypatch, "host-player")
    guest = member_client(monkeypatch, "road-warrior")
    room = create_room(host)
    join_room(guest, room["joinCode"])
    view = host.post(f"/api/fantasy/draft/sessions/{room['id']}/start").json()
    clients = clients_by_player(view, host, guest)
    current_name = next(
        player["username"] for player in view["players"] if player["isCurrent"]
    )
    current_client = clients[current_name]

    for _ in range(14):
        response = current_client.post(f"/api/fantasy/draft/sessions/{room['id']}/flip")
        assert response.status_code == 200
        view = response.json()
        if view["event"]["busted"]:
            break
    else:
        raise AssertionError("A duplicate rank must appear within 14 cards")

    current = next(player for player in view["players"] if player["username"] == current_name)
    assert current["roundsCompleted"] == 1
    assert current["rounds"][0]["busted"] is True
    assert current["rounds"][0]["score"] == 0


def test_full_game_reveals_seed_and_reproducible_decks(monkeypatch):
    host = member_client(monkeypatch, "host-player")
    guest = member_client(monkeypatch, "road-warrior")
    room = create_room(host)
    join_room(guest, room["joinCode"])
    view = host.post(f"/api/fantasy/draft/sessions/{room['id']}/start").json()
    clients = clients_by_player(view, host, guest)

    early_verify = host.get(f"/api/fantasy/draft/sessions/{room['id']}/verify")
    assert early_verify.status_code == 409

    while view["state"] == "active":
        current_name = next(
            player["username"] for player in view["players"] if player["isCurrent"]
        )
        current_client = clients[current_name]
        view = current_client.post(
            f"/api/fantasy/draft/sessions/{room['id']}/flip"
        ).json()
        view = current_client.post(
            f"/api/fantasy/draft/sessions/{room['id']}/bank"
        ).json()

    assert view["state"] == "complete"
    assert [entry["pick"] for entry in view["draftOrder"]] == [1, 2]

    verified = host.get(f"/api/fantasy/draft/sessions/{room['id']}/verify")
    assert verified.status_code == 200
    proof = verified.json()
    assert proof["hashMatches"] is True
    assert hashlib.sha256(bytes.fromhex(proof["masterSeed"])).hexdigest() == room["seedHash"]
    assert len(proof["players"]) == 2
    for player in proof["players"]:
        assert len(player["deck"]) == 52
        derived_codes = [card["code"] for card in player["deck"]]
        assert derived_codes == draft_order_game.derive_player_deck(
            proof["masterSeed"], player["username"]
        )
        assert [draw["deckIndex"] for draw in player["draws"]] == list(range(3))
    assert verify_proof(proof) == []

    proof["players"][0]["deck"][0]["code"] = "AS"
    assert any("full deck" in error for error in verify_proof(proof))


def test_host_can_remove_player_only_before_start(monkeypatch):
    host = member_client(monkeypatch, "host-player")
    guest = member_client(monkeypatch, "road-warrior")
    room = create_room(host)
    joined = join_room(guest, room["joinCode"])
    guest_player = next(player for player in joined["players"] if player["username"] == "road-warrior")

    assert guest.delete(
        f"/api/fantasy/draft/sessions/{room['id']}/players/{guest_player['id']}"
    ).status_code == 403
    removed = host.delete(
        f"/api/fantasy/draft/sessions/{room['id']}/players/{guest_player['id']}"
    )
    assert removed.status_code == 200
    assert len(removed.json()["players"]) == 1


def test_host_can_skip_a_manager_who_stops_playing(monkeypatch):
    """A closed laptop used to strand the room: locked roster, only the
    current player may act, and no seed reveal without a final score."""
    host = member_client(monkeypatch, "host-player")
    guest = member_client(monkeypatch, "road-warrior")
    room = create_room(host)
    join_room(guest, room["joinCode"])
    rid = room["id"]
    view = host.post(f"/api/fantasy/draft/sessions/{rid}/start").json()
    clients = clients_by_player(view, host, guest)

    while view["state"] == "active":
        current_name = next(
            player["username"] for player in view["players"] if player["isCurrent"]
        )
        if current_name == "road-warrior":
            # The guest walks away. Only the host can move the room on, and
            # the guest cannot skip themselves out of a bad position.
            assert guest.post(
                f"/api/fantasy/draft/sessions/{rid}/forfeit"
            ).status_code == 403
            guest_view = guest.get(f"/api/fantasy/draft/sessions/{rid}").json()
            assert guest_view["canForfeit"] is False
            assert view["canForfeit"] is True
            skipped = host.post(f"/api/fantasy/draft/sessions/{rid}/forfeit")
            assert skipped.status_code == 200
            view = skipped.json()
            assert view["event"]["type"] == "forfeit"
            continue
        view = clients[current_name].post(
            f"/api/fantasy/draft/sessions/{rid}/flip"
        ).json()
        view = clients[current_name].post(
            f"/api/fantasy/draft/sessions/{rid}/bank"
        ).json()

    assert view["state"] == "complete"
    walked = next(p for p in view["players"] if p["username"] == "road-warrior")
    assert walked["score"] == 0
    assert walked["roundsCompleted"] == ROUNDS_PER_PLAYER
    assert all(row["state"] == "forfeited" for row in walked["rounds"])
    # The whole point: the proof still unlocks and still reproduces.
    proof = host.get(f"/api/fantasy/draft/sessions/{rid}/verify").json()
    assert proof["hashMatches"] is True
    assert verify_proof(proof) == []
    assert [entry["pick"] for entry in view["draftOrder"]] == [1, 2]


def test_forfeit_zeroes_a_round_that_already_holds_cards(monkeypatch):
    host = member_client(monkeypatch, "host-player")
    guest = member_client(monkeypatch, "road-warrior")
    room = create_room(host)
    join_room(guest, room["joinCode"])
    rid = room["id"]
    view = host.post(f"/api/fantasy/draft/sessions/{rid}/start").json()
    clients = clients_by_player(view, host, guest)
    current_name = view["currentPlayer"]["displayName"]
    dealt = clients[current_name].post(f"/api/fantasy/draft/sessions/{rid}/flip").json()
    assert dealt["currentRound"]["pot"] > 0

    view = host.post(f"/api/fantasy/draft/sessions/{rid}/forfeit").json()
    walked = next(p for p in view["players"] if p["username"] == current_name)
    # The dealt card stays on the record, but the round is worth nothing.
    assert walked["rounds"][0]["cards"]
    assert walked["rounds"][0]["score"] == 0
    assert walked["rounds"][0]["state"] == "forfeited"
    assert walked["score"] == 0


def test_standings_and_draft_order_break_ties_the_same_way(monkeypatch):
    """The leaderboard used to fall back to turn position, so a manager could
    hold first place in the standings and be handed the second pick."""
    host = member_client(monkeypatch, "host-player")
    guest = member_client(monkeypatch, "road-warrior")
    room = create_room(host)
    join_room(guest, room["joinCode"])
    rid = room["id"]
    host.post(f"/api/fantasy/draft/sessions/{rid}/start")

    db = SessionLocal()
    try:
        players = db.query(FantasyDraftPlayer).filter(
            FantasyDraftPlayer.session_id == rid
        ).all()
        for index, player in enumerate(players):
            player.final_score = 40
            for number, score in enumerate([[30, 10, 0], [20, 20, 0]][index], start=1):
                db.add(FantasyDraftRound(
                    id=f"{player.id}-{number}",
                    session_id=rid,
                    player_id=player.id,
                    round_number=number,
                    cards_json="[]",
                    score=score,
                    busted=False,
                    state="banked",
                ))
        session_row = db.query(FantasyDraftSession).filter(
            FantasyDraftSession.id == rid
        ).first()
        session_row.state = "complete"
        session_row.current_player_id = None
        db.commit()
    finally:
        db.close()

    view = host.get(f"/api/fantasy/draft/sessions/{rid}").json()
    assert [p["score"] for p in view["leaderboard"]] == [40, 40]
    assert (
        [p["displayName"] for p in view["leaderboard"]]
        == [entry["displayName"] for entry in view["draftOrder"]]
    )
    assert [p["place"] for p in view["leaderboard"]] == [1, 2]
    # Best round is the first tiebreak, so 30 beats 20 in both lists.
    assert view["leaderboard"][0]["bestRound"] == 30
