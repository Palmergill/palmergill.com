"""Personal ranking board contract tests (spec 18).

Two things get proven here rather than assumed.

First the gate: /boards is the second private corner of /api/fantasy, and it
sits underneath a demo prefix, so anonymous refusal has to be asserted on every
route. Someone else's board must 404 rather than 403 — a 403 confirms it exists.

Second the invariant the whole data model rests on: for two players of the same
position, the overall order and the positional order agree. The board stores one
sort key, so that should hold by construction; ``assert_invariant`` after a long
random move sequence is what makes "should" into "does".
"""
import random

import pytest
from fastapi.testclient import TestClient

from app import accounts
from app.accounts import ROLE_ADMIN, ROLE_MEMBER
from app.database import (
    FantasyCollectionRun,
    FantasyPlayer,
    FantasyProjection,
    FantasyRankBoard,
    FantasyRankEntry,
    FantasyRankTier,
    FantasyRanking,
    SessionLocal,
    utc_now,
)
from app.main import SESSION_COOKIE_NAME, app, create_app_session_token
from app.services.fantasy_collector import SEASON_LONG_WEEK
from app.services import fantasy_rankings_board as boards

ADMIN_USERNAME = "palmer"
ADMIN_PASSWORD = "secret"
SEASON = 2026

MODELS = (
    FantasyRankTier,
    FantasyRankEntry,
    FantasyRankBoard,
    FantasyRanking,
    FantasyProjection,
    FantasyCollectionRun,
    FantasyPlayer,
)

# Every board route, so the gate is proven to cover all of them rather than
# whichever one happened to get a test.
BOARD_ROUTES = (
    ("get", "/api/fantasy/rankings/boards/mine"),
    ("post", "/api/fantasy/rankings/boards"),
    ("get", "/api/fantasy/rankings/boards/1"),
    ("patch", "/api/fantasy/rankings/boards/1"),
    ("delete", "/api/fantasy/rankings/boards/1"),
    ("post", "/api/fantasy/rankings/boards/1/reset"),
    ("post", "/api/fantasy/rankings/boards/1/entries"),
    ("patch", "/api/fantasy/rankings/boards/1/entries/9"),
    ("delete", "/api/fantasy/rankings/boards/1/entries/9?revision=1"),
    ("post", "/api/fantasy/rankings/boards/1/tiers"),
    ("patch", "/api/fantasy/rankings/boards/1/tiers/1"),
    ("delete", "/api/fantasy/rankings/boards/1/tiers/1?revision=1"),
)

# Counts per position in the fixture catalog. Deep enough that the superflex
# quarterback baseline (QB22) has real players on both sides of it.
CATALOG = {"QB": 30, "RB": 40, "WR": 45, "TE": 20}
# Points at positional rank 1, and the drop per rank. Chosen so quarterbacks
# score far more raw points than anyone else — which is exactly why value over
# replacement, not raw points, has to drive the order.
POINTS_TOP = {"QB": 380.0, "RB": 300.0, "WR": 290.0, "TE": 220.0}
POINTS_STEP = {"QB": 6.0, "RB": 5.0, "WR": 4.5, "TE": 5.5}


@pytest.fixture(autouse=True)
def auth_env(monkeypatch):
    monkeypatch.setenv("APP_AUTH_USERNAME", ADMIN_USERNAME)
    monkeypatch.setenv("APP_AUTH_PASSWORD", ADMIN_PASSWORD)


def _player_id(position: str, rank: int) -> str:
    return f"{position.lower()}{rank:03d}"


@pytest.fixture
def seeded_db():
    session = SessionLocal()
    for model in MODELS:
        session.query(model).delete()
    session.commit()

    projection_run = FantasyCollectionRun(
        job="projections",
        source="sleeper",
        season=SEASON,
        week=SEASON_LONG_WEEK,
        status="success",
        started_at=utc_now(),
        finished_at=utc_now(),
    )
    ranking_run = FantasyCollectionRun(
        job="rankings",
        source="derived",
        season=SEASON,
        week=SEASON_LONG_WEEK,
        status="success",
        started_at=utc_now(),
        finished_at=utc_now(),
    )
    session.add_all([projection_run, ranking_run])
    session.flush()

    for position, count in CATALOG.items():
        for rank in range(1, count + 1):
            player_id = _player_id(position, rank)
            points = POINTS_TOP[position] - (rank - 1) * POINTS_STEP[position]
            session.add(
                FantasyPlayer(
                    player_id=player_id,
                    full_name=f"{position} Player {rank}",
                    search_name=f"{position.lower()} player {rank}",
                    team="SF",
                    position=position,
                    status="Active",
                )
            )
            session.add(
                FantasyProjection(
                    run_id=projection_run.id,
                    player_id=player_id,
                    season=SEASON,
                    week=SEASON_LONG_WEEK,
                    pts_ppr=points,
                    pts_half_ppr=points - 5,
                    pts_std=points - 10,
                )
            )
            for scoring in ("ppr", "half", "std"):
                session.add(
                    FantasyRanking(
                        run_id=ranking_run.id,
                        player_id=player_id,
                        season=SEASON,
                        week=SEASON_LONG_WEEK,
                        position=position,
                        scoring=scoring,
                        rank=rank,
                        ecr=points,
                    )
                )
    # A kicker, so "boards cover QB/RB/WR/TE only" can be proven rather than
    # assumed from the absence of one.
    session.add(
        FantasyPlayer(
            player_id="k001",
            full_name="Kicker One",
            search_name="kicker one",
            team="SF",
            position="K",
            status="Active",
        )
    )
    session.commit()
    yield session
    session.rollback()
    session.close()


def client_for(username: str, role: str = ROLE_MEMBER) -> TestClient:
    if role == ROLE_MEMBER:
        session = SessionLocal()
        try:
            user = accounts.get_user(session, username)
            if user is None:
                accounts.create_user(session, username, "fixture-password-123")
            elif not user.is_active:
                user.is_active = True
                session.commit()
        finally:
            session.close()
    client = TestClient(app)
    client.cookies.set(
        SESSION_COOKIE_NAME, create_app_session_token(username, ADMIN_PASSWORD, role=role)
    )
    return client


def member_client() -> TestClient:
    return client_for("taylor")


def other_member_client() -> TestClient:
    return client_for("jordan")


def admin_client() -> TestClient:
    return client_for(ADMIN_USERNAME, ROLE_ADMIN)


def make_board(client: TestClient, scoring: str = "ppr", roster: str = "1qb") -> dict:
    response = client.post(
        "/api/fantasy/rankings/boards",
        json={"season": SEASON, "scoring": scoring, "roster": roster},
    )
    assert response.status_code == 201, response.text
    return response.json()


def assert_invariant(board: dict) -> None:
    """The one rule the model exists to make unbreakable.

    Filtering the overall order to a position must reproduce that position's
    own order — i.e. positionRank must run 1, 2, 3, ... in overall sequence.
    """
    seen = {}
    for entry in board["entries"]:
        position = entry["position"]
        seen[position] = seen.get(position, 0) + 1
        assert entry["positionRank"] == seen[position], (
            f"{entry['player_id']} is {position}{entry['positionRank']} but sits "
            f"{seen[position]} deep in the overall order"
        )
    ranks = [entry["overallRank"] for entry in board["entries"]]
    assert ranks == list(range(1, len(ranks) + 1)), "overall ranks are not dense"


def read_board(client: TestClient, board_id: int) -> dict:
    response = client.get(f"/api/fantasy/rankings/boards/{board_id}")
    assert response.status_code == 200, response.text
    return response.json()


def scoped(board: dict, position: str) -> list:
    return [e for e in board["entries"] if e["position"] == position]


# ── the gate ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("method,route", BOARD_ROUTES)
def test_anonymous_is_refused_from_every_board_route(seeded_db, method, route):
    """403 with a JSON body — never a 401, never WWW-Authenticate.

    A Basic-auth challenge on a fetch() path pops a native credential modal,
    which is a dead end. The page has to be able to render its own sign-in
    panel, which needs a readable JSON refusal.
    """
    client = TestClient(app)
    kwargs = {} if method in ("get", "delete") else {"json": {}}
    response = getattr(client, method)(route, **kwargs)
    assert response.status_code == 403, response.text
    assert "WWW-Authenticate" not in response.headers
    assert "sign in" in response.json()["detail"].lower()


def test_member_creates_and_reads_own_board(seeded_db):
    client = member_client()
    board = make_board(client)
    assert board["season"] == SEASON
    assert board["entries"]
    assert read_board(client, board["id"])["id"] == board["id"]


def test_member_cannot_read_another_members_board(seeded_db):
    board = make_board(member_client())
    response = other_member_client().get(f"/api/fantasy/rankings/boards/{board['id']}")
    # 404 rather than 403: a 403 would confirm the board exists and make ids
    # enumerable.
    assert response.status_code == 404


def test_admin_has_no_special_access_to_member_boards(seeded_db):
    board = make_board(member_client())
    assert admin_client().get(f"/api/fantasy/rankings/boards/{board['id']}").status_code == 404


def test_boards_are_listed_per_owner(seeded_db):
    make_board(member_client())
    assert len(member_client().get("/api/fantasy/rankings/boards/mine").json()["boards"]) == 1
    assert other_member_client().get("/api/fantasy/rankings/boards/mine").json()["boards"] == []


def test_rankings_page_stays_publicly_reachable():
    """Deliberately NOT a member path.

    Published boards are shared by URL and the consensus is public, so an
    anonymous visitor must reach the page. Adding /fantasy/rankings to
    MEMBER_PATH_PREFIXES would bounce every share-link visitor to /login/ and
    silently break the feature; the board API gates itself per-endpoint instead.
    """
    from app.main import is_demo_path, is_member_path

    assert is_member_path("/fantasy/rankings/") is False
    assert is_demo_path("/fantasy/rankings/") is True
    assert is_demo_path("/api/fantasy/rankings/boards/mine") is True
    # The members-only hub next door stays locked.
    assert is_member_path("/fantasy/league/") is True


def test_public_fantasy_dashboard_is_still_anonymous(seeded_db):
    assert TestClient(app).get("/api/fantasy/state").status_code == 200


# ── the invariant ───────────────────────────────────────────────────────────


def test_seed_overall_order_respects_every_positional_order(seeded_db):
    assert_invariant(make_board(member_client()))


def test_seed_orders_each_position_by_the_sites_ranking(seeded_db):
    board = make_board(member_client())
    for position in ("QB", "RB", "WR", "TE"):
        ids = [e["player_id"] for e in scoped(board, position)]
        assert ids == sorted(ids), f"{position} is not in the site's ranking order"


def test_positional_move_reorders_overall(seeded_db):
    client = member_client()
    board = make_board(client)
    qbs = scoped(board, "QB")
    mover, old_top = qbs[2], qbs[0]

    response = client.patch(
        f"/api/fantasy/rankings/boards/{board['id']}/entries/{mover['player_id']}",
        json={"revision": board["revision"], "scope": "QB", "before_player_id": old_top["player_id"]},
    )
    assert response.status_code == 200, response.text
    assert response.json()["moved"]["positionRank"] == 1

    after = read_board(client, board["id"])
    assert_invariant(after)
    qbs_after = scoped(after, "QB")
    assert qbs_after[0]["player_id"] == mover["player_id"]
    # He lands directly above the quarterback he displaced, not at the very top
    # of the board.
    moved_rank = next(e["overallRank"] for e in after["entries"] if e["player_id"] == mover["player_id"])
    displaced_rank = next(e["overallRank"] for e in after["entries"] if e["player_id"] == old_top["player_id"])
    assert moved_rank == displaced_rank - 1


def test_overall_move_reorders_position(seeded_db):
    client = member_client()
    board = make_board(client)
    wrs = scoped(board, "WR")
    mover = wrs[4]
    target = wrs[1]

    response = client.patch(
        f"/api/fantasy/rankings/boards/{board['id']}/entries/{mover['player_id']}",
        json={
            "revision": board["revision"],
            "scope": "OVERALL",
            "before_player_id": target["player_id"],
        },
    )
    assert response.status_code == 200, response.text

    after = read_board(client, board["id"])
    assert_invariant(after)
    # He passed WR2, WR3 and WR4, so WR5 becomes WR2 — the overall drag moved
    # him within his position without anyone touching the positional list.
    assert next(e["positionRank"] for e in after["entries"] if e["player_id"] == mover["player_id"]) == 2


@pytest.mark.parametrize("roster", ["1qb", "superflex"])
def test_invariant_holds_after_a_random_move_sequence(seeded_db, roster):
    """The test that protects the entire data model.

    Two hundred mixed moves across every scope, with the invariant checked after
    each one. If a positional move can ever put the two orders out of step, this
    finds it; nothing else in the suite would.
    """
    client = member_client()
    board = make_board(client, roster=roster)
    rng = random.Random(1234)

    for _ in range(200):
        scope = rng.choice(["OVERALL", "QB", "RB", "WR", "TE"])
        pool = board["entries"] if scope == "OVERALL" else scoped(board, scope)
        if len(pool) < 2:
            continue
        mover = rng.choice(pool)
        target_rank = rng.randint(1, len(pool))
        response = client.patch(
            f"/api/fantasy/rankings/boards/{board['id']}/entries/{mover['player_id']}",
            json={"revision": board["revision"], "scope": scope, "to_rank": target_rank},
        )
        assert response.status_code == 200, response.text
        board = read_board(client, board["id"])
        assert_invariant(board)


def test_move_to_rank_is_equivalent_to_neighbour_move(seeded_db):
    client = member_client()
    board = make_board(client)
    rbs = scoped(board, "RB")

    client.patch(
        f"/api/fantasy/rankings/boards/{board['id']}/entries/{rbs[9]['player_id']}",
        json={"revision": board["revision"], "scope": "RB", "to_rank": 4},
    )
    by_rank = read_board(client, board["id"])

    board = make_board(other_member_client())
    other = other_member_client()
    rbs = scoped(board, "RB")
    other.patch(
        f"/api/fantasy/rankings/boards/{board['id']}/entries/{rbs[9]['player_id']}",
        json={"revision": board["revision"], "scope": "RB", "before_player_id": rbs[3]["player_id"]},
    )
    by_neighbour = read_board(other, board["id"])

    assert [e["player_id"] for e in scoped(by_rank, "RB")] == [
        e["player_id"] for e in scoped(by_neighbour, "RB")
    ]


def test_key_exhaustion_triggers_renormalization(seeded_db):
    """Sixty insertions into one gap must respread rather than collapse."""
    client = member_client()
    board = make_board(client)
    top_two = board["entries"][:2]
    movers = [e["player_id"] for e in board["entries"][10:70]]

    renormalized_at_least_once = False
    for player_id in movers:
        response = client.patch(
            f"/api/fantasy/rankings/boards/{board['id']}/entries/{player_id}",
            json={
                "revision": _current_revision(client, board["id"]),
                "scope": "OVERALL",
                "before_player_id": top_two[1]["player_id"],
            },
        )
        assert response.status_code == 200, response.text
        renormalized_at_least_once = renormalized_at_least_once or response.json()["renormalized"]

    assert renormalized_at_least_once, "expected the float gap to run out"
    final = read_board(client, board["id"])
    assert_invariant(final)
    assert final["entries"][0]["player_id"] == top_two[0]["player_id"]

    keys = [
        row.sort_key
        for row in seeded_db.query(FantasyRankEntry)
        .filter(FantasyRankEntry.board_id == board["id"])
        .order_by(FantasyRankEntry.sort_key)
        .all()
    ]
    assert len(set(keys)) == len(keys), "respread keys must stay distinct"


def _current_revision(client: TestClient, board_id: int) -> int:
    return read_board(client, board_id)["revision"]


# ── writes ──────────────────────────────────────────────────────────────────


def test_stale_revision_returns_409_with_current_board(seeded_db):
    client = member_client()
    board = make_board(client)
    mover = board["entries"][5]["player_id"]

    first = client.patch(
        f"/api/fantasy/rankings/boards/{board['id']}/entries/{mover}",
        json={"revision": board["revision"], "scope": "OVERALL", "to_rank": 1},
    )
    assert first.status_code == 200

    # The second tab still holds the revision it loaded with.
    second = client.patch(
        f"/api/fantasy/rankings/boards/{board['id']}/entries/{mover}",
        json={"revision": board["revision"], "scope": "OVERALL", "to_rank": 3},
    )
    assert second.status_code == 409
    detail = second.json()["detail"]
    assert detail["board"]["entries"][0]["player_id"] == mover
    assert detail["board"]["revision"] > board["revision"]


def test_revision_check_is_atomic_across_two_database_sessions(seeded_db):
    """Both requests may pass the early check; only one commit may win."""
    client = member_client()
    created = make_board(client)
    first_session = SessionLocal()
    second_session = SessionLocal()
    try:
        first_board = first_session.get(FantasyRankBoard, created["id"])
        second_board = second_session.get(FantasyRankBoard, created["id"])
        assert first_board.revision == second_board.revision == created["revision"]
        boards.check_revision(first_session, first_board, created["revision"])
        boards.check_revision(second_session, second_board, created["revision"])

        first_player = created["entries"][-1]["player_id"]
        stale_player = created["entries"][-2]["player_id"]
        winner = boards.move_entry(
            first_session, first_board, first_player, "OVERALL", to_rank=1
        )
        with pytest.raises(boards.BoardConflict) as conflict:
            boards.move_entry(
                second_session, second_board, stale_player, "OVERALL", to_rank=1
            )

        current = read_board(client, created["id"])
        assert current["revision"] == winner["revision"]
        assert conflict.value.detail["board"]["revision"] == winner["revision"]
        assert current["entries"][0]["player_id"] == first_player
        assert current["entries"][1]["player_id"] != stale_player
    finally:
        first_session.close()
        second_session.close()


def test_reset_restores_the_seed_order(seeded_db):
    client = member_client()
    board = make_board(client)
    seed_order = [e["player_id"] for e in board["entries"]]

    client.patch(
        f"/api/fantasy/rankings/boards/{board['id']}/entries/{seed_order[40]}",
        json={"revision": board["revision"], "scope": "OVERALL", "to_rank": 1},
    )
    scrambled = read_board(client, board["id"])
    assert [e["player_id"] for e in scrambled["entries"]] != seed_order

    response = client.post(
        f"/api/fantasy/rankings/boards/{board['id']}/reset",
        json={"revision": scrambled["revision"]},
    )
    assert response.status_code == 200, response.text
    assert [e["player_id"] for e in response.json()["entries"]] == seed_order


def test_adding_a_kicker_is_rejected(seeded_db):
    client = member_client()
    board = make_board(client)
    response = client.post(
        f"/api/fantasy/rankings/boards/{board['id']}/entries",
        json={"player_id": "k001", "revision": board["revision"], "scope": "OVERALL"},
    )
    assert response.status_code == 422
    assert "QB, RB, WR and TE" in response.json()["detail"]


def test_adding_and_removing_a_player(seeded_db):
    client = member_client()
    board = make_board(client)
    seeded_db.query(FantasyRankEntry).filter(
        FantasyRankEntry.board_id == board["id"],
        FantasyRankEntry.player_id == _player_id("WR", 45),
    ).delete()
    seeded_db.commit()

    revision = _current_revision(client, board["id"])
    response = client.post(
        f"/api/fantasy/rankings/boards/{board['id']}/entries",
        json={
            "player_id": _player_id("WR", 45),
            "revision": revision,
            "scope": "WR",
            "to_rank": 1,
        },
    )
    assert response.status_code == 201, response.text
    assert response.json()["moved"]["positionRank"] == 1

    after = read_board(client, board["id"])
    assert_invariant(after)

    removal = client.delete(
        f"/api/fantasy/rankings/boards/{board['id']}/entries/{_player_id('WR', 45)}"
        f"?revision={after['revision']}"
    )
    assert removal.status_code == 200
    assert _player_id("WR", 45) not in removal.json()["ranks"]


def test_duplicate_board_is_rejected_with_the_existing_id(seeded_db):
    client = member_client()
    board = make_board(client)
    response = client.post(
        "/api/fantasy/rankings/boards",
        json={"season": SEASON, "scoring": "ppr", "roster": "1qb"},
    )
    assert response.status_code == 409
    assert response.json()["detail"]["boardId"] == board["id"]


def test_deleting_a_board_removes_its_entries(seeded_db):
    client = member_client()
    board = make_board(client)
    assert client.delete(f"/api/fantasy/rankings/boards/{board['id']}").status_code == 204
    assert (
        seeded_db.query(FantasyRankEntry)
        .filter(FantasyRankEntry.board_id == board["id"])
        .count()
        == 0
    )


def test_seed_degrades_to_an_empty_board_when_no_rankings_run_exists(seeded_db):
    seeded_db.query(FantasyRanking).delete()
    seeded_db.query(FantasyCollectionRun).delete()
    seeded_db.commit()

    board = make_board(member_client())
    assert board["entries"] == []
    assert board["seededFrom"] is None


# ── player search ───────────────────────────────────────────────────────────


def test_board_search_puts_the_best_player_first(seeded_db):
    """The reason this endpoint exists instead of the shared one.

    /api/fantasy/players/search orders the whole historical catalog
    alphabetically, so a common surname buries the player anyone actually means
    behind long-retired namesakes. Here the highest projected player wins.
    """
    session = seeded_db
    # Three namesakes: the one who matters is neither first nor last by name.
    session.add_all(
        [
            FantasyPlayer(
                player_id="wr900",
                full_name="Aaron Ziggler",
                search_name="aaron ziggler",
                team="NYJ",
                position="WR",
                status="Active",
            ),
            FantasyPlayer(
                player_id="wr901",
                full_name="Zeke Ziggler",
                search_name="zeke ziggler",
                team="NYJ",
                position="WR",
                status="Active",
            ),
        ]
    )
    run = (
        session.query(FantasyCollectionRun)
        .filter(FantasyCollectionRun.job == "projections")
        .first()
    )
    # Only Zeke has a projection, so he must outrank the alphabetically first one.
    session.add(
        FantasyProjection(
            run_id=run.id,
            player_id="wr901",
            season=SEASON,
            week=SEASON_LONG_WEEK,
            pts_ppr=310.0,
            pts_half_ppr=305.0,
            pts_std=300.0,
        )
    )
    session.commit()

    results = member_client().get(
        f"/api/fantasy/rankings/players/search?q=ziggler&season={SEASON}"
    ).json()["results"]
    assert [row["player_id"] for row in results] == ["wr901", "wr900"]
    # The unprojected namesake is still addable, just not first.
    assert results[1]["projected_points"] is None


def test_board_search_orders_results_for_the_requested_scoring(seeded_db):
    session = seeded_db
    session.add_all(
        [
            FantasyPlayer(
                player_id="wr910", full_name="PPR Switch", search_name="switch receiver",
                team="SF", position="WR", status="Active",
            ),
            FantasyPlayer(
                player_id="wr911", full_name="Standard Switch", search_name="switch receiver",
                team="SF", position="WR", status="Active",
            ),
        ]
    )
    run = session.query(FantasyCollectionRun).filter(
        FantasyCollectionRun.job == "projections"
    ).first()
    session.add_all(
        [
            FantasyProjection(
                run_id=run.id, player_id="wr910", season=SEASON, week=SEASON_LONG_WEEK,
                pts_ppr=300.0, pts_half_ppr=200.0, pts_std=100.0,
            ),
            FantasyProjection(
                run_id=run.id, player_id="wr911", season=SEASON, week=SEASON_LONG_WEEK,
                pts_ppr=200.0, pts_half_ppr=225.0, pts_std=250.0,
            ),
        ]
    )
    session.commit()

    ppr = member_client().get(
        f"/api/fantasy/rankings/players/search?q=switch&season={SEASON}&scoring=ppr"
    ).json()["results"]
    standard = member_client().get(
        f"/api/fantasy/rankings/players/search?q=switch&season={SEASON}&scoring=std"
    ).json()["results"]
    assert [row["player_id"] for row in ppr] == ["wr910", "wr911"]
    assert [row["player_id"] for row in standard] == ["wr911", "wr910"]


def test_board_search_excludes_positions_a_board_cannot_hold(seeded_db):
    results = member_client().get(
        "/api/fantasy/rankings/players/search?q=kicker"
    ).json()["results"]
    assert results == []


def test_board_search_requires_an_account(seeded_db):
    response = TestClient(app).get("/api/fantasy/rankings/players/search?q=player")
    assert response.status_code == 403


# ── superflex ───────────────────────────────────────────────────────────────


def test_superflex_seed_lifts_quarterbacks(seeded_db):
    single = make_board(member_client(), roster="1qb")
    superflex = make_board(other_member_client(), roster="superflex")

    top_qb = _player_id("QB", 1)
    single_rank = next(e["overallRank"] for e in single["entries"] if e["player_id"] == top_qb)
    superflex_rank = next(e["overallRank"] for e in superflex["entries"] if e["player_id"] == top_qb)
    assert superflex_rank < single_rank

    # The baseline shift moves quarterbacks *through* the board; it must not
    # reshuffle the other positions relative to each other.
    def non_qb_order(board):
        return [e["player_id"] for e in board["entries"] if e["position"] != "QB"]

    assert non_qb_order(single) == non_qb_order(superflex)


def test_superflex_seeds_a_deeper_quarterback_pool():
    """A unit assertion, because the fixture catalog cannot show this.

    Every fixture position is smaller than either roster's cap, so both boards
    seed the whole catalog and the caps never bite. Asserting the constants
    directly says the real thing: superflex trades room from the other
    positions to rank quarterbacks deeper, and both formats still seed ~300.
    """
    assert boards.SEED_CAPS["superflex"]["QB"] > boards.SEED_CAPS["1qb"]["QB"]
    for roster, caps in boards.SEED_CAPS.items():
        assert sum(caps.values()) == 300, roster
        assert set(caps) == set(boards.RANKABLE_POSITIONS)


def test_superflex_and_1qb_boards_coexist_for_one_owner(seeded_db):
    client = member_client()
    make_board(client, roster="1qb")
    make_board(client, roster="superflex")
    assert len(client.get("/api/fantasy/rankings/boards/mine").json()["boards"]) == 2


def test_scoring_formats_are_separate_boards(seeded_db):
    client = member_client()
    make_board(client, scoring="ppr")
    make_board(client, scoring="half")
    rosters = {b["scoring"] for b in client.get("/api/fantasy/rankings/boards/mine").json()["boards"]}
    assert rosters == {"ppr", "half"}


# ── tiers ───────────────────────────────────────────────────────────────────


def test_tier_lifecycle_and_scope_isolation(seeded_db):
    client = member_client()
    board = make_board(client)
    rbs = scoped(board, "RB")

    created = client.post(
        f"/api/fantasy/rankings/boards/{board['id']}/tiers",
        json={
            "revision": board["revision"],
            "scope": "RB",
            "label": "Every-week starters",
            "to_rank": 3,
        },
    )
    assert created.status_code == 201, created.text
    payload = created.json()
    tier_id = payload["tierId"]
    tier = next(row for row in payload["tiers"] if row["id"] == tier_id)
    assert tier == {
        "id": tier_id,
        "scope": "RB",
        "label": "Every-week starters",
        "beforePlayerId": rbs[2]["player_id"],
    }

    renamed = client.patch(
        f"/api/fantasy/rankings/boards/{board['id']}/tiers/{tier_id}",
        json={"revision": payload["revision"], "label": "Upside starters"},
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["tiers"][0]["label"] == "Upside starters"

    moved = client.patch(
        f"/api/fantasy/rankings/boards/{board['id']}/tiers/{tier_id}",
        json={"revision": renamed.json()["revision"], "to_rank": 1},
    )
    assert moved.status_code == 200, moved.text
    assert moved.json()["tiers"][0]["beforePlayerId"] == rbs[0]["player_id"]
    # A positional divider never leaks into the overall list.
    assert all(row["scope"] == "RB" for row in moved.json()["tiers"])

    deleted = client.delete(
        f"/api/fantasy/rankings/boards/{board['id']}/tiers/{tier_id}"
        f"?revision={moved.json()['revision']}"
    )
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["tiers"] == []


def test_player_can_cross_a_tier_without_crossing_another_player(seeded_db):
    client = member_client()
    board = make_board(client)
    first, second, mover = board["entries"][0], board["entries"][1], board["entries"][-1]
    created = client.post(
        f"/api/fantasy/rankings/boards/{board['id']}/tiers",
        json={
            "revision": board["revision"], "scope": "OVERALL", "label": "Starters",
            "before_player_id": second["player_id"],
        },
    ).json()
    tier_id = created["tierId"]

    below = client.patch(
        f"/api/fantasy/rankings/boards/{board['id']}/entries/{mover['player_id']}",
        json={
            "revision": created["revision"], "scope": "OVERALL",
            "after_tier_id": tier_id,
        },
    )
    assert below.status_code == 200, below.text
    below_board = read_board(client, board["id"])
    assert [row["player_id"] for row in below_board["entries"][:3]] == [
        first["player_id"], mover["player_id"], second["player_id"],
    ]
    assert below.json()["tiers"][0]["beforePlayerId"] == mover["player_id"]

    above = client.patch(
        f"/api/fantasy/rankings/boards/{board['id']}/entries/{mover['player_id']}",
        json={
            "revision": below.json()["revision"], "scope": "OVERALL",
            "before_tier_id": tier_id,
        },
    )
    assert above.status_code == 200, above.text
    above_board = read_board(client, board["id"])
    assert [row["player_id"] for row in above_board["entries"][:3]] == [
        first["player_id"], mover["player_id"], second["player_id"],
    ]
    assert above.json()["tiers"][0]["beforePlayerId"] == second["player_id"]


def test_move_rejects_ambiguous_placement_intent(seeded_db):
    client = member_client()
    board = make_board(client)
    player = board["entries"][0]["player_id"]
    response = client.patch(
        f"/api/fantasy/rankings/boards/{board['id']}/entries/{player}",
        json={
            "revision": board["revision"], "scope": "OVERALL", "to_rank": 2,
            "before_player_id": board["entries"][1]["player_id"],
        },
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "Choose one destination for this move."


def test_tiers_share_renormalization_without_jumping(seeded_db):
    client = member_client()
    board = make_board(client)
    target = board["entries"][1]["player_id"]
    created = client.post(
        f"/api/fantasy/rankings/boards/{board['id']}/tiers",
        json={
            "revision": board["revision"],
            "scope": "OVERALL",
            "label": "Cut",
            "before_player_id": target,
        },
    ).json()
    tier_id = created["tierId"]

    renormalized = False
    movers = [entry["player_id"] for entry in board["entries"][10:50]]
    for player_id in movers:
        response = client.patch(
            f"/api/fantasy/rankings/boards/{board['id']}/entries/{player_id}",
            json={
                "revision": created["revision"], "scope": "OVERALL",
                "after_tier_id": tier_id,
            },
        )
        assert response.status_code == 200, response.text
        created = response.json()
        renormalized = renormalized or created["renormalized"]

    tier = next(row for row in created["tiers"] if row["id"] == tier_id)
    assert renormalized, "moving successive players into one tier gap should respread keys"
    assert tier["beforePlayerId"] == movers[-1]


def test_reset_removes_tiers(seeded_db):
    client = member_client()
    board = make_board(client)
    tiered = client.post(
        f"/api/fantasy/rankings/boards/{board['id']}/tiers",
        json={"revision": board["revision"], "scope": "OVERALL", "label": "Top", "to_rank": 1},
    ).json()
    reset = client.post(
        f"/api/fantasy/rankings/boards/{board['id']}/reset",
        json={"revision": tiered["revision"]},
    )
    assert reset.status_code == 200
    assert reset.json()["tiers"] == []


# ── publishing and consensus ────────────────────────────────────────────────


def publish(client: TestClient, board: dict, value: bool = True) -> dict:
    response = client.patch(
        f"/api/fantasy/rankings/boards/{board['id']}",
        json={"revision": board["revision"], "published": value},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_share_link_only_serves_published_board(seeded_db):
    client = member_client()
    board = make_board(client)
    slug = board["shareUrl"].split("share=", 1)[1]
    anonymous = TestClient(app)

    assert anonymous.get(f"/api/fantasy/rankings/shared/{slug}").status_code == 404
    published = publish(client, board)
    shared = anonymous.get(f"/api/fantasy/rankings/shared/{slug}")
    assert shared.status_code == 200, shared.text
    assert shared.json()["owner"] == "taylor"
    assert shared.json()["readOnly"] is True
    assert "revision" not in shared.json()

    unpublished = publish(client, published, False)
    assert unpublished["published"] is False
    assert anonymous.get(f"/api/fantasy/rankings/shared/{slug}").status_code == 404


def test_public_consensus_averages_published_boards_and_imputes_omissions(seeded_db):
    first_client = member_client()
    second_client = other_member_client()
    first = make_board(first_client)
    second = make_board(second_client)
    omitted = first["entries"][0]["player_id"]

    removal = second_client.delete(
        f"/api/fantasy/rankings/boards/{second['id']}/entries/{omitted}"
        f"?revision={second['revision']}"
    )
    assert removal.status_code == 200
    second = read_board(second_client, second["id"])
    publish(first_client, first)
    publish(second_client, second)

    response = TestClient(app).get(
        f"/api/fantasy/rankings/consensus?season={SEASON}&scoring=ppr&roster=1qb"
    )
    assert response.status_code == 200, response.text
    consensus = response.json()
    assert consensus["boardCount"] == 2
    row = next(entry for entry in consensus["entries"] if entry["player_id"] == omitted)
    # Rank 1 on the first board, one past the shortened second board on the
    # other. This proves the omission participates in the average.
    expected = round((1 + len(second["entries"]) + 1) / 2, 2)
    assert row["averageRank"] == expected
    assert row["appearances"] == 1


def test_consensus_uses_an_appearance_floor(seeded_db):
    clients = [client_for(f"member-{index}") for index in range(5)]
    created = [make_board(client) for client in clients]
    rare = created[0]["entries"][-1]["player_id"]
    for index, (client, board) in enumerate(zip(clients, created)):
        if index:
            response = client.delete(
                f"/api/fantasy/rankings/boards/{board['id']}/entries/{rare}"
                f"?revision={board['revision']}"
            )
            assert response.status_code == 200
            board = read_board(client, board["id"])
        publish(client, board)

    consensus = TestClient(app).get(
        f"/api/fantasy/rankings/consensus?season={SEASON}&scoring=ppr&roster=1qb"
    ).json()
    assert consensus["appearanceFloor"] == 2
    assert rare not in {row["player_id"] for row in consensus["entries"]}


def test_board_timestamps_are_marked_utc(seeded_db):
    """`updatedAt` has to say it is UTC, or the client reads it as local time.

    The board list and the save pill both compute an age from this field.
    Stored timestamps are naive UTC, so an offsetless string parses hours
    into the future in any browser west of UTC, and the clamped age pins to
    "Saved just now" for as long as the offset lasts.
    """
    client = member_client()
    board = make_board(client)

    assert board["updatedAt"].endswith("Z")
    assert read_board(client, board["id"])["updatedAt"].endswith("Z")

    listed = client.get("/api/fantasy/rankings/boards/mine").json()["boards"]
    assert [entry["updatedAt"].endswith("Z") for entry in listed] == [True]
