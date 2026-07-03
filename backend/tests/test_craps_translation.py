"""Craps strategy translation contract: StrategyIntent validation (legal bet
vocabulary, odds multipliers, null optional fields, duplicate bets) and the
POST /api/craps/translate endpoint. `craps_ai.translate_strategy` — the only
network call in this path — is always monkeypatched with a fixture dict, so
no LLM call ever happens in this suite.
"""
import pytest
from pydantic import ValidationError

from app.main import app
from app.routers import craps as craps_router
from app.routers.craps import StrategyIntent
from app.services import craps_ai
from fastapi.testclient import TestClient

client = TestClient(app)


def setup_function():
    craps_router._rate_limit_store.clear()


def valid_intent(**overrides):
    intent = {
        "name": "Iron Cross",
        "summary": "Pass line plus place 5/6/8 and a field bet.",
        "bets": [
            {"type": "passLine", "units": 1, "when": "comeOut"},
            {"type": "place6", "units": 1, "when": "pointOn"},
        ],
        "odds": {"passLine": "max"},
    }
    intent.update(overrides)
    return intent


# ── StrategyIntent model validation ─────────────────────────────────────

def test_strategy_intent_accepts_a_well_formed_bet_list():
    intent = StrategyIntent.model_validate(valid_intent())
    assert intent.bets[0].type == "passLine"
    assert intent.odds["passLine"] == "max"


def test_strategy_intent_rejects_unknown_bet_type():
    with pytest.raises(ValidationError):
        StrategyIntent.model_validate(valid_intent(bets=[{"type": "roulette-red", "units": 1}]))


def test_strategy_intent_rejects_duplicate_bet_types():
    # The client engine keys state by bet type, so a duplicate silently
    # clobbers the first entry instead of erroring — reject it up front.
    with pytest.raises(ValidationError):
        StrategyIntent.model_validate(valid_intent(bets=[
            {"type": "place6", "units": 1},
            {"type": "place6", "units": 2},
        ]))


@pytest.mark.parametrize("multiplier", ["max", 1, 5, 100])
def test_strategy_intent_accepts_legal_odds_multipliers(multiplier):
    intent = StrategyIntent.model_validate(valid_intent(odds={"passLine": multiplier}))
    assert intent.odds["passLine"] == multiplier


@pytest.mark.parametrize("multiplier", [0, 101, "double", 2.5, None])
def test_strategy_intent_rejects_illegal_odds_multipliers(multiplier):
    with pytest.raises(ValidationError):
        StrategyIntent.model_validate(valid_intent(odds={"passLine": multiplier}))


def test_strategy_intent_rejects_odds_on_a_non_line_bet():
    # Only passLine/dontPass/come/dontCome can take odds — a place or prop
    # bet has no "odds" concept in craps.
    with pytest.raises(ValidationError):
        StrategyIntent.model_validate(valid_intent(odds={"place6": "max"}))


def test_strategy_intent_treats_explicit_null_optional_fields_as_absent():
    # Regression: the model (and FastAPI's response serialization) emit
    # explicit null for unset optional fields. A dict with literal Nones for
    # every optional field must validate exactly like one that omits them.
    intent = StrategyIntent.model_validate({
        "name": "Custom strategy",
        "summary": "",
        "workingOnComeOut": False,
        "bets": [{
            "type": "come", "units": 1, "when": None, "everyRoll": None, "maxActive": None,
        }],
        "odds": {},
        "progression": None,
        "cashOut": None,
    })
    assert intent.bets[0].when is None
    assert intent.bets[0].maxActive is None
    assert intent.progression is None
    assert intent.cashOut is None


def test_strategy_intent_rejects_bet_with_zero_units():
    with pytest.raises(ValidationError):
        StrategyIntent.model_validate(valid_intent(bets=[{"type": "passLine", "units": 0}]))


def test_strategy_intent_rejects_empty_bet_list():
    with pytest.raises(ValidationError):
        StrategyIntent.model_validate(valid_intent(bets=[]))


def test_cash_out_requires_exactly_one_target():
    with pytest.raises(ValidationError):
        StrategyIntent.model_validate(valid_intent(cashOut={"amount": 200, "multiplier": 2}))
    with pytest.raises(ValidationError):
        StrategyIntent.model_validate(valid_intent(cashOut={}))

    ok = StrategyIntent.model_validate(valid_intent(cashOut={"multiplier": 2}))
    assert ok.cashOut.multiplier == 2


# ── POST /api/craps/translate ────────────────────────────────────────────

def test_translate_endpoint_returns_validated_intent(monkeypatch):
    monkeypatch.setattr(craps_ai, "translate_strategy", lambda description, base_unit: valid_intent())

    response = client.post("/api/craps/translate", json={"description": "iron cross", "baseUnit": 5})

    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "Iron Cross"
    assert body["bets"][0]["type"] == "passLine"


def test_translate_endpoint_excludes_null_fields_from_response(monkeypatch):
    # response_model_exclude_none=True must actually be in effect, or a
    # frontend validator that treats present-null as invalid (the original
    # bug) would break again on the wire even though the model accepts it.
    monkeypatch.setattr(
        craps_ai, "translate_strategy",
        lambda description, base_unit: {
            "name": "Custom strategy",
            "bets": [{"type": "passLine", "units": 1, "when": None, "everyRoll": None, "maxActive": None}],
            "progression": None,
            "cashOut": None,
        },
    )

    response = client.post("/api/craps/translate", json={"description": "just pass line", "baseUnit": 5})

    assert response.status_code == 200
    body = response.json()
    assert "progression" not in body
    assert "cashOut" not in body
    assert "when" not in body["bets"][0]
    assert "maxActive" not in body["bets"][0]


def test_translate_endpoint_returns_503_when_unavailable(monkeypatch):
    def raise_unavailable(description, base_unit):
        raise craps_ai.CrapsUnavailableError("OPENAI_API_KEY is not configured.")

    monkeypatch.setattr(craps_ai, "translate_strategy", raise_unavailable)

    response = client.post("/api/craps/translate", json={"description": "iron cross", "baseUnit": 5})

    assert response.status_code == 503


def test_translate_endpoint_returns_502_on_model_error(monkeypatch):
    def raise_translate_error(description, base_unit):
        raise craps_ai.CrapsTranslateError("upstream boom")

    monkeypatch.setattr(craps_ai, "translate_strategy", raise_translate_error)

    response = client.post("/api/craps/translate", json={"description": "iron cross", "baseUnit": 5})

    assert response.status_code == 502


def test_translate_endpoint_returns_400_when_model_output_is_invalid(monkeypatch):
    # The model returned JSON, but it doesn't satisfy StrategyIntent (e.g. an
    # unknown bet type slipped past the LLM's own schema constraint).
    monkeypatch.setattr(
        craps_ai, "translate_strategy",
        lambda description, base_unit: {"name": "Bad", "bets": [{"type": "roulette-red", "units": 1}]},
    )

    response = client.post("/api/craps/translate", json={"description": "iron cross", "baseUnit": 5})

    assert response.status_code == 400


def test_translate_endpoint_rejects_empty_description():
    response = client.post("/api/craps/translate", json={"description": "", "baseUnit": 5})
    assert response.status_code == 422


def test_translate_endpoint_rate_limits_repeated_requests(monkeypatch):
    monkeypatch.setattr(craps_router, "TRANSLATE_RATE_LIMIT_MAX", 2)
    monkeypatch.setattr(craps_ai, "translate_strategy", lambda description, base_unit: valid_intent())
    craps_router._rate_limit_store.clear()

    payload = {"description": "iron cross", "baseUnit": 5}
    assert client.post("/api/craps/translate", json=payload).status_code == 200
    assert client.post("/api/craps/translate", json=payload).status_code == 200
    limited = client.post("/api/craps/translate", json=payload)

    assert limited.status_code == 429
