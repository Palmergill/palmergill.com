"""Fourth & Fortune fairness, account gating, and live turn flow."""

import hashlib

from fastapi.testclient import TestClient
from sqlalchemy import event

from app.accounts import ROLE_ADMIN, ROLE_MEMBER
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
    # A finished hand is normally held face up for a beat so every spectator's
    # poll catches the card that ended the round. Flow tests drive dozens of
    # turns, so they release instantly; the hold itself is covered on its own
    # in test_finished_hand_is_held_on_the_table_before_the_turn_moves.
    draft_order_game.TURN_HOLD_SECONDS = 0
    db = SessionLocal()
    try:
        db.query(FantasyDraftFlip).delete()
        db.query(FantasyDraftRound).delete()
        db.query(FantasyDraftPlayer).delete()
        db.query(FantasyDraftSession).delete()
        db.commit()
    finally:
        db.close()


def settled(client, room_id):
    """Read the room back so a turn-ending action's held hand has cleared."""
    response = client.get(f"/api/fantasy/draft/sessions/{room_id}")
    assert response.status_code == 200, response.text
    return response.json()


def member_client(monkeypatch, username):
    monkeypatch.setenv("APP_AUTH_USERNAME", "palmer")
    monkeypatch.setenv("APP_AUTH_PASSWORD", ADMIN_PASSWORD)
    client = TestClient(app)
    client.cookies.set(
        SESSION_COOKIE_NAME,
        create_app_session_token(username, ADMIN_PASSWORD, role=ROLE_MEMBER),
    )
    return client


def admin_client(monkeypatch):
    monkeypatch.setenv("APP_AUTH_USERNAME", "palmer")
    monkeypatch.setenv("APP_AUTH_PASSWORD", ADMIN_PASSWORD)
    client = TestClient(app)
    client.cookies.set(
        SESSION_COOKIE_NAME,
        create_app_session_token("palmer", ADMIN_PASSWORD, role=ROLE_ADMIN),
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


def test_practice_is_private_replayable_and_does_not_fill_recent_rooms(monkeypatch):
    player = member_client(monkeypatch, "road-warrior")
    practice = player.post("/api/fantasy/draft/practice")

    assert practice.status_code == 201
    view = practice.json()
    first_id = view["id"]
    assert view["mode"] == draft_order_game.MODE_PRACTICE
    assert view["state"] == "active"
    assert view["joinCode"] is None
    assert view["canPlay"] is True
    assert len(view["players"]) == 1
    assert player.get("/api/fantasy/draft/sessions/mine").json()["sessions"] == []

    # Starting practice twice resumes the unfinished warm-up instead of
    # leaving abandoned rooms behind.
    assert player.post("/api/fantasy/draft/practice").json()["id"] == first_id

    while view["state"] == "active":
        player.post(f"/api/fantasy/draft/sessions/{first_id}/flip")
        player.post(f"/api/fantasy/draft/sessions/{first_id}/bank")
        view = settled(player, first_id)

    assert view["state"] == "complete"
    assert len(view["draftOrder"]) == 1
    assert player.get(
        f"/api/fantasy/draft/sessions/{first_id}/verify"
    ).status_code == 200
    assert all(
        room["id"] != first_id
        for room in player.get("/api/fantasy/draft/sessions/mine").json()["sessions"]
    )

    replay = player.post("/api/fantasy/draft/practice").json()
    assert replay["id"] != first_id
    assert replay["state"] == "active"


def test_only_admin_can_create_bot_test_room_and_bots_finish_full_flow(monkeypatch):
    member = member_client(monkeypatch, "road-warrior")
    forbidden = member.post(
        "/api/fantasy/draft/sessions/test",
        json={"league_name": "Production Test", "bot_count": 4},
    )
    assert forbidden.status_code == 403

    host = admin_client(monkeypatch)
    created = host.post(
        "/api/fantasy/draft/sessions/test",
        json={"league_name": "Production Test", "bot_count": 4},
    )
    assert created.status_code == 201
    view = created.json()
    room_id = view["id"]
    assert view["mode"] == draft_order_game.MODE_TEST
    assert view["joinCode"] is None
    assert len(view["players"]) == 5
    assert sum(player["isBot"] for player in view["players"]) == 4
    assert view["canStart"] is True

    db = SessionLocal()
    try:
        join_code = db.query(FantasyDraftSession.join_code).filter(
            FantasyDraftSession.id == room_id
        ).scalar()
    finally:
        db.close()
    assert member.post(
        "/api/fantasy/draft/sessions/join",
        json={"join_code": join_code},
    ).status_code == 409

    view = host.post(f"/api/fantasy/draft/sessions/{room_id}/start").json()
    bot_rounds = 0
    turns_by_round = {number: [] for number in range(1, ROUNDS_PER_PLAYER + 1)}
    expected_orders = {
        1: [
            player["username"]
            for player in sorted(view["players"], key=lambda player: player["turnPosition"])
        ]
    }
    while view["state"] == "active":
        round_number = view["currentRound"]["number"]
        current_username = next(
            player["username"] for player in view["players"] if player["isCurrent"]
        )
        if round_number not in expected_orders:
            expected_orders[round_number] = [
                player["username"] for player in view["leaderboard"]
            ]
        turns_by_round[round_number].append(current_username)
        if view["currentPlayer"]["isBot"]:
            assert view["canRunBot"] is True
            # One request per card lets the UI pace the bot; the round is over
            # only when a step reports the bank or the bust.
            steps = 0
            while True:
                response = host.post(
                    f"/api/fantasy/draft/sessions/{room_id}/bots/step"
                )
                assert response.status_code == 200
                view = response.json()
                event = view["lastEvent"]
                steps += 1
                assert event["type"] in {"flip", "bank"}
                assert event["round"] == round_number
                assert event["isBot"] is True
                if round_number == ROUNDS_PER_PLAYER:
                    # The host is a spectator to every bot, so the final round
                    # stays sealed to them even though they drive the requests.
                    assert event["sealed"] is True
                    assert event["card"] is None
                    assert event["score"] is None
                elif event["type"] == "flip":
                    assert event["card"]["rank"]
                if event["turnComplete"]:
                    break
                assert steps <= 5
            assert event["cardCount"] >= 1
            view = settled(host, room_id)
            bot_rounds += 1
        else:
            assert view["canPlay"] is True
            host.post(f"/api/fantasy/draft/sessions/{room_id}/flip")
            host.post(f"/api/fantasy/draft/sessions/{room_id}/bank")
            view = settled(host, room_id)

    assert bot_rounds == 4 * draft_order_game.ROUNDS_PER_PLAYER
    assert turns_by_round == expected_orders
    assert view["state"] == "complete"
    assert view["resultsRevealed"] is False
    assert view["draftOrder"] is None
    assert host.get(
        f"/api/fantasy/draft/sessions/{room_id}/verify"
    ).status_code == 409

    revealed = host.post(
        f"/api/fantasy/draft/sessions/{room_id}/reveal"
    )
    assert revealed.status_code == 200
    view = revealed.json()
    assert view["resultsRevealed"] is True
    assert len(view["draftOrder"]) == 5
    proof = host.get(
        f"/api/fantasy/draft/sessions/{room_id}/verify"
    ).json()
    assert proof["hashMatches"] is True
    assert verify_proof(proof) == []


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
    assert first.json()["lastEvent"]["card"]["deckIndex"] == 0
    after_first = current_client.post(
        f"/api/fantasy/draft/sessions/{room['id']}/bank"
    )
    assert after_first.status_code == 200
    after_first_view = settled(current_client, room["id"])
    next_name = next(
        player["username"]
        for player in after_first_view["players"]
        if player["isCurrent"]
    )
    assert next_name != current_name

    # Everyone completes round one before anyone starts round two.
    next_client = clients[next_name]
    assert next_client.post(
        f"/api/fantasy/draft/sessions/{room['id']}/flip"
    ).status_code == 200
    next_client.post(f"/api/fantasy/draft/sessions/{room['id']}/bank")
    round_two_view = settled(next_client, room["id"])
    assert round_two_view["currentRound"]["number"] == 2

    # The round-two leader goes first, and their personal deck resumes at the
    # next undealt card rather than being reshuffled between rounds.
    leader_name = round_two_view["leaderboard"][0]["username"]
    assert next(
        player["username"]
        for player in round_two_view["players"]
        if player["isCurrent"]
    ) == leader_name

    second = clients[leader_name].post(f"/api/fantasy/draft/sessions/{room['id']}/flip")
    assert second.status_code == 200
    assert second.json()["lastEvent"]["card"]["deckIndex"] == 1
    assert second.json()["currentRound"]["number"] == 2


def test_spectators_see_live_cards_until_the_final_round_is_sealed(monkeypatch):
    host = member_client(monkeypatch, "host-player")
    guest = member_client(monkeypatch, "road-warrior")
    room = create_room(host)
    join_room(guest, room["joinCode"])
    rid = room["id"]
    view = host.post(f"/api/fantasy/draft/sessions/{rid}/start").json()
    assert view["roundsPerPlayer"] == 5
    clients = clients_by_player(view, host, guest)

    first_name = next(player["username"] for player in view["players"] if player["isCurrent"])
    first_client = clients[first_name]
    spectator = guest if first_client is host else host
    first_flip = first_client.post(f"/api/fantasy/draft/sessions/{rid}/flip").json()
    spectator_view = spectator.get(f"/api/fantasy/draft/sessions/{rid}").json()

    assert spectator_view["currentRound"]["concealed"] is False
    assert spectator_view["currentRound"]["cards"] == first_flip["currentRound"]["cards"]
    assert spectator_view["currentRound"]["pot"] == first_flip["currentRound"]["pot"]
    open_rounds_checked = {1}
    first_client.post(f"/api/fantasy/draft/sessions/{rid}/bank")
    view = settled(first_client, rid)

    while view["state"] == "active" and view["currentRound"]["number"] < ROUNDS_PER_PLAYER:
        current_name = next(
            player["username"] for player in view["players"] if player["isCurrent"]
        )
        current_client = clients[current_name]
        flip_view = current_client.post(f"/api/fantasy/draft/sessions/{rid}/flip").json()
        open_spectator = guest if current_client is host else host
        open_view = open_spectator.get(f"/api/fantasy/draft/sessions/{rid}").json()
        assert open_view["currentRound"]["concealed"] is False
        assert open_view["currentRound"]["cards"] == flip_view["currentRound"]["cards"]
        assert open_view["currentRound"]["pot"] == flip_view["currentRound"]["pot"]
        open_rounds_checked.add(view["currentRound"]["number"])
        current_client.post(f"/api/fantasy/draft/sessions/{rid}/bank")
        view = settled(current_client, rid)

    assert open_rounds_checked == set(range(1, ROUNDS_PER_PLAYER))
    assert view["currentRound"]["number"] == ROUNDS_PER_PLAYER
    final_name = next(player["username"] for player in view["players"] if player["isCurrent"])
    final_client = clients[final_name]
    final_spectator = guest if final_client is host else host
    pre_final_score = next(
        player["score"] for player in view["leaderboard"] if player["username"] == final_name
    )

    actor_view = final_client.post(f"/api/fantasy/draft/sessions/{rid}/flip").json()
    spectator_view = final_spectator.get(f"/api/fantasy/draft/sessions/{rid}").json()
    assert actor_view["currentRound"]["concealed"] is False
    assert len(actor_view["currentRound"]["cards"]) == 1
    assert actor_view["currentRound"]["pot"] > 0
    assert actor_view["decision"] is not None
    assert spectator_view["currentRound"] == {
        "number": ROUNDS_PER_PLAYER,
        "cards": [],
        "cardCount": 1,
        "concealed": True,
        "pot": None,
        "bustChance": None,
        "deckRemaining": None,
    }
    assert spectator_view["decision"] is None

    final_client.post(f"/api/fantasy/draft/sessions/{rid}/bank")
    sealed_view = final_spectator.get(f"/api/fantasy/draft/sessions/{rid}").json()
    sealed_player = next(
        player for player in sealed_view["players"] if player["username"] == final_name
    )
    sealed_round = next(row for row in sealed_player["rounds"] if row["number"] == ROUNDS_PER_PLAYER)
    assert sealed_player["scoreHidden"] is True
    assert sealed_player["score"] == pre_final_score
    assert sealed_round["cards"] == []
    assert sealed_round["cardCount"] == 1
    assert sealed_round["score"] is None
    assert sealed_round["state"] == "sealed"


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
        if view["lastEvent"]["busted"]:
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
        current_client.post(f"/api/fantasy/draft/sessions/{room['id']}/flip")
        current_client.post(f"/api/fantasy/draft/sessions/{room['id']}/bank")
        view = settled(current_client, room["id"])

    assert view["state"] == "complete"
    assert view["resultsRevealed"] is False
    assert view["draftOrder"] is None
    assert guest.post(
        f"/api/fantasy/draft/sessions/{room['id']}/reveal"
    ).status_code == 403
    assert host.get(
        f"/api/fantasy/draft/sessions/{room['id']}/verify"
    ).status_code == 409

    reveal = host.post(f"/api/fantasy/draft/sessions/{room['id']}/reveal")
    assert reveal.status_code == 200
    view = reveal.json()
    assert view["resultsRevealed"] is True
    assert [entry["pick"] for entry in view["draftOrder"]] == [1, 2]
    assert guest.get(
        f"/api/fantasy/draft/sessions/{room['id']}"
    ).json()["resultsRevealed"] is True

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
        assert [draw["deckIndex"] for draw in player["draws"]] == list(range(ROUNDS_PER_PLAYER))
    assert verify_proof(proof) == []

    original_code = proof["players"][0]["deck"][0]["code"]
    proof["players"][0]["deck"][0]["code"] = "AS" if original_code != "AS" else "KH"
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
            assert skipped.json()["lastEvent"]["type"] == "forfeit"
            view = settled(host, rid)
            continue
        clients[current_name].post(f"/api/fantasy/draft/sessions/{rid}/flip")
        clients[current_name].post(f"/api/fantasy/draft/sessions/{rid}/bank")
        view = settled(clients[current_name], rid)

    assert view["state"] == "complete"
    view = host.post(f"/api/fantasy/draft/sessions/{rid}/reveal").json()
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


def test_finished_hand_is_held_on_the_table_before_the_turn_moves(monkeypatch):
    """The card that ended a round used to be gone before anyone could poll.

    Banking advanced the turn inside the same transaction, so a spectator's
    next read already showed the next manager sitting behind an empty table.
    """
    draft_order_game.TURN_HOLD_SECONDS = 30
    host = member_client(monkeypatch, "host-player")
    guest = member_client(monkeypatch, "road-warrior")
    room = create_room(host)
    join_room(guest, room["joinCode"])
    rid = room["id"]
    view = host.post(f"/api/fantasy/draft/sessions/{rid}/start").json()
    clients = clients_by_player(view, host, guest)
    current_name = next(p["username"] for p in view["players"] if p["isCurrent"])
    current_client = clients[current_name]
    spectator = guest if current_client is host else host

    current_client.post(f"/api/fantasy/draft/sessions/{rid}/flip")
    banked = current_client.post(f"/api/fantasy/draft/sessions/{rid}/bank").json()

    assert banked["holdingTurn"] is True
    assert banked["currentPlayer"]["displayName"] == current_name
    assert len(banked["currentRound"]["cards"]) == 1
    assert banked["canPlay"] is False
    assert banked["decision"] is None

    # A spectator polling mid-hold sees the same hand, and is told what it was.
    watched = spectator.get(f"/api/fantasy/draft/sessions/{rid}").json()
    assert watched["holdingTurn"] is True
    assert watched["currentPlayer"]["id"] == banked["currentPlayer"]["id"]
    assert watched["currentRound"]["cards"] == banked["currentRound"]["cards"]
    assert watched["lastEvent"]["type"] == "bank"
    assert watched["lastEvent"]["turnComplete"] is True
    assert watched["lastEvent"]["displayName"] == current_name
    assert watched["lastEvent"]["score"] == banked["currentRound"]["pot"]

    # Nobody is on the clock while the hand is still up.
    assert current_client.post(
        f"/api/fantasy/draft/sessions/{rid}/flip"
    ).status_code == 409

    draft_order_game.TURN_HOLD_SECONDS = 0
    released = spectator.get(f"/api/fantasy/draft/sessions/{rid}").json()
    assert released["holdingTurn"] is False
    assert released["currentPlayer"]["id"] != banked["currentPlayer"]["id"]
    assert released["currentRound"]["cards"] == []


def test_a_busting_card_stays_face_up_for_the_table(monkeypatch):
    draft_order_game.TURN_HOLD_SECONDS = 30
    host = member_client(monkeypatch, "host-player")
    guest = member_client(monkeypatch, "road-warrior")
    room = create_room(host)
    join_room(guest, room["joinCode"])
    rid = room["id"]
    view = host.post(f"/api/fantasy/draft/sessions/{rid}/start").json()
    clients = clients_by_player(view, host, guest)
    current_name = next(p["username"] for p in view["players"] if p["isCurrent"])
    current_client = clients[current_name]
    spectator = guest if current_client is host else host

    for _ in range(14):
        view = current_client.post(f"/api/fantasy/draft/sessions/{rid}/flip").json()
        if view["lastEvent"]["busted"]:
            break
    else:
        raise AssertionError("A duplicate rank must appear within 14 cards")

    watched = spectator.get(f"/api/fantasy/draft/sessions/{rid}").json()
    assert watched["holdingTurn"] is True
    assert watched["lastEvent"]["busted"] is True
    assert watched["lastEvent"]["card"] == view["lastEvent"]["card"]
    # The whole busted hand is still on the table, including the card that
    # ended it, and the pot has already dropped to zero.
    assert watched["currentRound"]["cards"] == view["currentRound"]["cards"]
    assert watched["currentRound"]["cards"][-1]["code"] == view["lastEvent"]["card"]["code"]
    assert watched["currentRound"]["pot"] == 0


def test_bank_position_agrees_with_the_standings_on_a_tie(monkeypatch):
    """The decision strip used to rank on turn position while the standings
    ranked on best round, so a manager could be told they'd sit first and be
    shown second in the same screenful."""
    host = member_client(monkeypatch, "host-player")
    guest = member_client(monkeypatch, "road-warrior")
    room = create_room(host)
    join_room(guest, room["joinCode"])
    rid = room["id"]
    host.post(f"/api/fantasy/draft/sessions/{rid}/start")

    db = SessionLocal()
    try:
        players = {
            player.username: player
            for player in db.query(FantasyDraftPlayer).filter(
                FantasyDraftPlayer.session_id == rid
            ).all()
        }
        # Equal totals, different best rounds. The host is second on the one
        # ranking rule but first in turn order, so the two disagree unless the
        # projection uses the same key as the standings.
        rounds = {"host-player": [20, 20], "road-warrior": [30, 10]}
        for username, scores in rounds.items():
            for number, score in enumerate(scores, start=1):
                db.add(FantasyDraftRound(
                    id=f"{players[username].id}-{number}",
                    session_id=rid,
                    player_id=players[username].id,
                    round_number=number,
                    cards_json="[]",
                    score=score,
                    busted=False,
                    state="banked",
                ))
            players[username].final_score = sum(scores)
        players["host-player"].turn_position = 1
        players["road-warrior"].turn_position = 2
        room_row = db.query(FantasyDraftSession).filter(
            FantasyDraftSession.id == rid
        ).first()
        room_row.current_player_id = players["host-player"].id
        db.commit()
    finally:
        db.close()

    view = host.get(f"/api/fantasy/draft/sessions/{rid}").json()
    places = {player["username"]: player["place"] for player in view["leaderboard"]}

    assert places["road-warrior"] == 1
    assert places["host-player"] == 2
    assert view["decision"]["projectedScore"] == 40
    assert view["decision"]["scoreToBeat"] == 40
    assert view["decision"]["isLeadingIfBanked"] is False
    assert view["decision"]["bankPosition"] == places["host-player"]


def test_room_list_summarises_without_building_every_view(monkeypatch):
    host = member_client(monkeypatch, "host-player")
    guest = member_client(monkeypatch, "road-warrior")
    room = create_room(host)
    join_room(guest, room["joinCode"])
    host.post(f"/api/fantasy/draft/sessions/{room['id']}/start")

    listed = host.get("/api/fantasy/draft/sessions/mine").json()["sessions"]

    assert len(listed) == 1
    card = listed[0]
    assert card["id"] == room["id"]
    assert card["leagueName"] == "Sunday Legends"
    assert card["state"] == "active"
    assert card["playerCount"] == 2
    assert card["isHost"] is True
    assert card["currentPlayerName"] in {"host-player", "road-warrior"}
    # The launcher never needed the seed-derived heavy fields, and building
    # them for a dozen rooms cost hundreds of queries per page load.
    assert "leaderboard" not in card
    assert "players" not in card


def test_room_list_excludes_practice_and_test_rooms(monkeypatch):
    host = admin_client(monkeypatch)
    league = create_room(host)
    practice = host.post("/api/fantasy/draft/practice").json()
    test_room = host.post(
        "/api/fantasy/draft/sessions/test",
        json={"league_name": "Production Test", "bot_count": 3},
    ).json()

    listed = host.get("/api/fantasy/draft/sessions/mine").json()["sessions"]

    assert [room["id"] for room in listed] == [league["id"]]
    assert practice["id"] not in {room["id"] for room in listed}
    assert test_room["id"] not in {room["id"] for room in listed}


def test_only_admin_can_delete_a_room_and_the_deal_goes_with_it(monkeypatch):
    admin = admin_client(monkeypatch)
    guest = member_client(monkeypatch, "road-warrior")
    room = create_room(admin)
    join_room(guest, room["joinCode"])
    started = admin.post(f"/api/fantasy/draft/sessions/{room['id']}/start").json()
    current = next(
        player["username"] for player in started["players"] if player["isCurrent"]
    )
    dealer = admin if current == "palmer" else guest
    assert dealer.post(f"/api/fantasy/draft/sessions/{room['id']}/flip").status_code == 200

    assert guest.delete(f"/api/fantasy/draft/sessions/{room['id']}").status_code == 403
    assert admin.delete(f"/api/fantasy/draft/sessions/{room['id']}").status_code == 204

    assert admin.get(f"/api/fantasy/draft/sessions/{room['id']}").status_code == 404
    assert admin.get("/api/fantasy/draft/sessions/mine").json()["sessions"] == []
    db = SessionLocal()
    try:
        for model in (FantasyDraftFlip, FantasyDraftRound, FantasyDraftPlayer):
            assert db.query(model).filter(model.session_id == room["id"]).count() == 0
    finally:
        db.close()


def test_admin_lists_and_deletes_rooms_it_never_joined(monkeypatch):
    guest = member_client(monkeypatch, "road-warrior")
    stranger = create_room(guest, league_name="Someone Else's League")
    practice = guest.post("/api/fantasy/draft/practice").json()
    admin = admin_client(monkeypatch)

    assert guest.get("/api/fantasy/draft/sessions/all").status_code == 403
    listed = admin.get("/api/fantasy/draft/sessions/all").json()["sessions"]

    # The launcher is scoped to rooms you sit in; this list is not.
    assert admin.get("/api/fantasy/draft/sessions/mine").json()["sessions"] == []
    by_id = {room["id"]: room for room in listed}
    assert by_id[stranger["id"]]["createdBy"] == "road-warrior"
    assert by_id[practice["id"]]["mode"] == draft_order_game.MODE_PRACTICE

    assert admin.delete(f"/api/fantasy/draft/sessions/{stranger['id']}").status_code == 204
    assert admin.delete(f"/api/fantasy/draft/sessions/{practice['id']}").status_code == 204
    assert admin.get("/api/fantasy/draft/sessions/all").json()["sessions"] == []
    assert guest.get("/api/fantasy/draft/sessions/mine").json()["sessions"] == []


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

    view = host.post(f"/api/fantasy/draft/sessions/{rid}/reveal").json()
    assert [p["score"] for p in view["leaderboard"]] == [40, 40]
    assert (
        [p["displayName"] for p in view["leaderboard"]]
        == [entry["displayName"] for entry in view["draftOrder"]]
    )
    assert [p["place"] for p in view["leaderboard"]] == [1, 2]
    # Best round is the first tiebreak, so 30 beats 20 in both lists.
    assert view["leaderboard"][0]["bestRound"] == 30
