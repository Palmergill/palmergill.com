"""Translate a plain-English craps strategy into a StrategyIntent.

Mirrors the raw-urllib OpenAI Responses pattern used by ``bitcoin_ai.py`` (no
SDK dependency). The model only ever returns *intent* — bet types and relative
``units`` — never dollar amounts or a seed. The frontend normalizer
(``craps-strategy/strategy.js``) is the single source of truth for money and
randomness, which keeps simulations reproducible.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Dict, List

OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
DEFAULT_MODEL = os.getenv("CRAPS_STRATEGY_MODEL", "gpt-5.5")
MODEL_TIMEOUT_SECONDS = float(os.getenv("CRAPS_STRATEGY_MODEL_TIMEOUT_SECONDS", "30"))

# Must stay in sync with BET_TYPES in craps-strategy/strategy.js.
BET_TYPES: List[str] = [
    "passLine", "dontPass", "come", "dontCome",
    "place4", "place5", "place6", "place8", "place9", "place10",
    "hard4", "hard6", "hard8", "hard10",
    "field", "any7", "anyCraps", "yo11", "craps2", "craps3", "craps12",
]


class CrapsTranslateError(Exception):
    """The model call failed or returned something unusable."""


class CrapsUnavailableError(CrapsTranslateError):
    """Translation is unavailable (e.g. no API key configured)."""


SYSTEM_PROMPT = (
    "You convert a plain-English craps betting strategy into a strict JSON "
    "StrategyIntent for a simulator. Rules:\n"
    "- Output ONLY bet intent: which bets and their RELATIVE size in `units` "
    "(positive integers). Never output dollar amounts or a seed; the app sizes "
    "bets from the user's base unit and bankroll.\n"
    "- Use only these bet types: " + ", ".join(BET_TYPES) + ".\n"
    "- `when` is one of comeOut, pointOn, always. Pass/Don't Pass are comeOut; "
    "come/don't-come and place bets are pointOn; field and prop bets are always "
    "with everyRoll true.\n"
    "- `odds` keys may only be line bets (passLine, dontPass, come, dontCome); "
    'values are an integer multiplier or the string "max".\n'
    "- come/dontCome may set `maxActive` (how many come points to keep working).\n"
    "- `progression` is optional: onWin in {press, regress, none}, onLoss in "
    "{double, none}, resetOnSevenOut boolean, appliesTo a list of bet types.\n"
    "- If the description is vague, choose a sensible, conservative interpretation.\n"
)

# A valid-JSON example (no comments) so structured output is never tempted to
# echo invalid syntax.
EXAMPLE_INTENT = {
    "name": "Iron Cross",
    "summary": "Pass line plus place 5/6/8 and a field bet, so every number but 7 pays.",
    "bets": [
        {"type": "passLine", "units": 1, "when": "comeOut"},
        {"type": "place5", "units": 1, "when": "pointOn"},
        {"type": "place6", "units": 1, "when": "pointOn"},
        {"type": "place8", "units": 1, "when": "pointOn"},
        {"type": "field", "units": 1, "when": "pointOn", "everyRoll": True},
    ],
    "odds": {"passLine": "max"},
}

STRATEGY_INTENT_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "name": {"type": "string"},
        "summary": {"type": "string"},
        "workingOnComeOut": {"type": "boolean"},
        "bets": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "type": {"type": "string", "enum": BET_TYPES},
                    "units": {"type": "integer", "minimum": 1},
                    "when": {"type": "string", "enum": ["comeOut", "pointOn", "always"]},
                    "everyRoll": {"type": "boolean"},
                    "maxActive": {"type": "integer", "minimum": 1},
                },
                "required": ["type", "units"],
            },
        },
        "odds": {
            "type": "object",
            "additionalProperties": {"type": ["string", "integer"]},
        },
        "progression": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "appliesTo": {"type": "array", "items": {"type": "string", "enum": BET_TYPES}},
                "onWin": {"type": "string", "enum": ["press", "regress", "none"]},
                "onLoss": {"type": "string", "enum": ["double", "none"]},
                "resetOnSevenOut": {"type": "boolean"},
            },
        },
    },
    "required": ["name", "bets"],
}


def _extract_output_text(response: Dict[str, Any]) -> str:
    """Pull the assistant text out of a Responses API payload."""
    for item in response.get("output", []):
        if item.get("type") != "message":
            continue
        for part in item.get("content", []):
            if part.get("type") in ("output_text", "text") and part.get("text"):
                return part["text"]
    # Some payloads expose a flat convenience field.
    if isinstance(response.get("output_text"), str):
        return response["output_text"]
    raise CrapsTranslateError("The model returned no strategy.")


def translate_strategy(description: str, base_unit: int) -> Dict[str, Any]:
    """Return a StrategyIntent dict, or raise CrapsTranslate/Unavailable error."""
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise CrapsUnavailableError("OPENAI_API_KEY is not configured.")

    payload = {
        "model": DEFAULT_MODEL,
        "instructions": SYSTEM_PROMPT,
        "input": [
            {
                "role": "user",
                "content": (
                    f"Base unit is ${base_unit}. Here is an example of the exact JSON "
                    f"shape to produce:\n{json.dumps(EXAMPLE_INTENT)}\n\n"
                    f"Now convert this strategy:\n{description}"
                ),
            }
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "strategy_intent",
                "schema": STRATEGY_INTENT_SCHEMA,
                "strict": False,
            }
        },
    }

    request = urllib.request.Request(
        OPENAI_RESPONSES_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=MODEL_TIMEOUT_SECONDS) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise CrapsTranslateError(f"OpenAI API returned {exc.code}: {detail[:300]}") from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise CrapsTranslateError(str(exc)) from exc

    text = _extract_output_text(data)
    try:
        intent = json.loads(text)
    except json.JSONDecodeError as exc:
        raise CrapsTranslateError("The model returned invalid JSON.") from exc

    if not isinstance(intent, dict):
        raise CrapsTranslateError("The model returned a non-object strategy.")
    return intent
