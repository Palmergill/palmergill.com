import re
import uuid
from datetime import datetime, time, timedelta, timezone
from typing import Any, Dict, List
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.services import bitcoin_tools


TXID_RE = re.compile(r"\b[a-fA-F0-9]{64}\b")
BITCOIN_ADDRESS_RE = re.compile(rf"\b{bitcoin_tools.BITCOIN_ADDRESS_PATTERN}\b", re.IGNORECASE)
LOCAL_ADDRESS_UTXO_LIMIT = 10

BITCOIN_TOPIC_TERMS = (
    "bitcoin",
    "btc",
    "satoshi",
    "satoshis",
    "sats",
    "sats/vb",
    "sat/vb",
    "utxo",
    "mempool",
    "halving",
    "hashrate",
    "hash rate",
    "proof of work",
    "proof-of-work",
    "lightning network",
    "taproot",
    "segwit",
    "bech32",
    "ordinals",
    "inscriptions",
    "coinbase transaction",
    "block subsidy",
    "difficulty adjustment",
)
BITCOIN_CONTEXT_PHRASES = (
    "block height",
    "latest block",
    "current block",
    "chain tip",
    "transaction fee",
    "fee rate",
    "fee estimate",
    "confirmation fee",
    "confirmations",
    "provider status",
    "sync status",
    "mined today",
    "mined yesterday",
    "mining difficulty",
)
BITCOIN_AMBIGUOUS_TERMS = (
    "block",
    "blocks",
    "transaction",
    "transactions",
    "tx",
    "txid",
    "fee",
    "fees",
    "node",
    "sync",
    "mining",
    "miner",
    "miners",
    "difficulty",
    "wallet",
    "address",
)
OUT_OF_SCOPE_CONTEXT_TERMS = (
    "bank",
    "banks",
    "credit card",
    "mortgage",
    "loan",
    "weather",
    "recipe",
    "cook",
    "cooking",
    "sports",
    "football",
    "basketball",
    "baseball",
    "stock",
    "stocks",
    "tesla",
    "apple",
    "ethereum",
    "solana",
    "dogecoin",
)
OUT_OF_SCOPE_ANSWER = (
    "I can only answer questions that are specifically about Bitcoin or directly tied to Bitcoin. "
    "Try asking about blocks, transactions, mempool fees, provider status, mining, difficulty, UTXOs, or other Bitcoin concepts."
)


def answer_chat(
    message: str,
    session_id: str | None = None,
    timezone_name: str | None = None,
) -> Dict[str, Any]:
    session_id = session_id or str(uuid.uuid4())
    if _is_unsafe_wallet_request(message):
        return _response(
            "I can only inspect public blockchain data. I cannot send bitcoin, sign transactions, broadcast transactions, or handle wallet secrets.",
            session_id,
            [],
            {},
            [],
        )

    if not _is_bitcoin_related(message):
        return _response(OUT_OF_SCOPE_ANSWER, session_id, [], {}, [])

    return _answer_with_local_router(message, session_id, timezone_name)


def answer_demo_chat(
    message: str,
    session_id: str | None = None,
    timezone_name: str | None = None,
) -> Dict[str, Any]:
    session_id = session_id or str(uuid.uuid4())
    if _is_unsafe_wallet_request(message):
        return _response(
            "I can only inspect public blockchain data. I cannot send bitcoin, sign transactions, broadcast transactions, or handle wallet secrets.",
            session_id,
            [],
            {},
            [bitcoin_tools.DEMO_WARNING],
        )

    if not _is_bitcoin_related(message):
        return _response(OUT_OF_SCOPE_ANSWER, session_id, [], {}, [bitcoin_tools.DEMO_WARNING])

    response = _answer_with_local_router(message, session_id, timezone_name, demo=True)
    response["warnings"] = _unique([bitcoin_tools.DEMO_WARNING] + response.get("warnings", []))
    return response


def _answer_with_local_router(message: str, session_id: str, timezone_name: str | None, demo: bool = False) -> Dict[str, Any]:
    normalized = message.strip().lower()
    tools_used: List[str] = []
    warnings: List[str] = []

    txid_match = TXID_RE.search(message)
    if txid_match:
        data = _local_tool_call(demo, "get_transaction", txid_match.group(0))
        tools_used.append("get_transaction")
        warnings.extend(data.get("warnings", []))
        return _response(_transaction_answer(data), session_id, tools_used, data, warnings)

    address_match = BITCOIN_ADDRESS_RE.search(message)
    if address_match:
        data = _local_tool_call(demo, "get_address", address_match.group(0), LOCAL_ADDRESS_UTXO_LIMIT)
        tools_used.append("get_address")
        warnings.extend(data.get("warnings", []))
        return _response(_address_answer(data), session_id, tools_used, data, warnings)

    if "mined" in normalized or "how many btc" in normalized:
        start_time, end_time, window_label, timezone_warning = _mined_window(message, timezone_name)
        if timezone_warning:
            warnings.append(timezone_warning)
        data = _local_tool_call(demo, "get_mined_stats", start_time, end_time)
        tools_used.append("get_mined_stats")
        warnings.extend(data.get("warnings", []))
        return _response(_mined_answer(data, window_label), session_id, tools_used, data, warnings)

    if "fee" in normalized or "mempool" in normalized:
        data = _local_tool_call(demo, "get_mempool_summary")
        tools_used.append("get_mempool_summary")
        warnings.extend(data.get("warnings", []))
        return _response(_mempool_answer(data), session_id, tools_used, data, warnings)

    if "sync" in normalized or "node" in normalized or "status" in normalized:
        data = _local_tool_call(demo, "get_node_status")
        tools_used.append("get_node_status")
        warnings.extend(data.get("warnings", []))
        return _response(_status_answer(data), session_id, tools_used, data, warnings)

    height_match = re.search(r"\b\d{1,7}\b", normalized)
    block_lookup_requested = "block" in normalized or "latest" in normalized or "height" in normalized
    explicit_block_lookup = bool(
        (height_match and ("block" in normalized or "height" in normalized))
        or re.search(r"\b(?:latest|current)\s+(?:bitcoin\s+)?blocks?\b", normalized)
        or "chain tip" in normalized
        or "block height" in normalized
    )

    # Conceptual questions may mention blocks (for example, "how does mining
    # add new blocks?"). Keep those on the explanation path, but preserve
    # explicit current/numeric block requests as data lookups.
    if not explicit_block_lookup and _looks_conceptual(message):
        return _response(_conceptual_fallback_answer(message), session_id, [], {}, warnings)

    if block_lookup_requested:
        if height_match and "latest" not in normalized:
            data = _local_tool_call(demo, "get_block", height_match.group(0))
            tools_used.append("get_block")
        else:
            data = _local_tool_call(demo, "get_latest_block")
            tools_used.append("get_latest_block")
        warnings.extend(data.get("warnings", []))
        return _response(_block_answer(data), session_id, tools_used, data, warnings)

    data = _local_tool_call(demo, "get_latest_block")
    tools_used.append("get_latest_block")
    warnings.extend(data.get("warnings", []))
    return _response(
        "I can answer live Bitcoin questions about blocks, transactions, provider status, mempool fees, and mined BTC. The latest chain tip I can see is included below.",
        session_id,
        tools_used,
        data,
        warnings,
    )


def _local_tool_call(demo: bool, name: str, *args: Any, **kwargs: Any) -> Dict[str, Any]:
    if demo:
        return bitcoin_tools.safe_demo_tool_call(name, *args, **kwargs)
    return bitcoin_tools.safe_tool_call(name, *args, **kwargs)


def _response(
    answer: str,
    session_id: str,
    tools_used: List[str],
    data: Dict[str, Any],
    warnings: List[str],
) -> Dict[str, Any]:
    return {
        "answer": answer,
        "session_id": session_id,
        "tools_used": tools_used,
        "data": data,
        "warnings": _unique(warnings),
    }


def _is_unsafe_wallet_request(message: str) -> bool:
    normalized = message.strip().lower()
    unsafe_terms = (
        "send bitcoin",
        "broadcast",
        "sign transaction",
        "private key",
        "seed phrase",
        "wallet.dat",
        "xprv",
        "mnemonic",
    )
    return any(term in normalized for term in unsafe_terms)


def _is_bitcoin_related(message: str) -> bool:
    normalized = message.strip().lower()
    if TXID_RE.search(message) or BITCOIN_ADDRESS_RE.search(message):
        return True
    if any(term in normalized for term in BITCOIN_TOPIC_TERMS):
        return True
    if any(phrase in normalized for phrase in BITCOIN_CONTEXT_PHRASES):
        return True
    if any(term in normalized for term in OUT_OF_SCOPE_CONTEXT_TERMS):
        return False

    tokens = set(re.findall(r"[a-z0-9]+", normalized))
    return any(term in tokens for term in BITCOIN_AMBIGUOUS_TERMS)


def _looks_conceptual(message: str) -> bool:
    normalized = message.strip().lower()
    if TXID_RE.search(message) or any(
        term in normalized for term in ("latest", "height", "mempool", "fee", "sync", "status", "node", "mined")
    ):
        return False
    # "block"/"blocks" is deliberately not in the exclusion list above: a
    # question like "how does mining work? who adds new blocks?" mentions
    # blocks but is asking about the concept, not requesting a specific
    # block's data — the plain block/latest/height lookup route in
    # _answer_with_local_router only runs after this check, so a bare
    # "show me the latest block" still resolves there as before.
    return any(term in normalized for term in ("explain", "how does", "why", "what is", "utxo", "mining", "difficulty"))


def _user_zone(timezone_name: str | None) -> tuple[ZoneInfo | timezone, str | None]:
    warning = None
    try:
        user_zone = ZoneInfo(timezone_name or "UTC")
    except ZoneInfoNotFoundError:
        user_zone = timezone.utc
        warning = f"Unknown timezone {timezone_name}; interpreted the time window in UTC."
    return user_zone, warning


def _iso_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _today_window(timezone_name: str | None) -> tuple[str, str, str | None]:
    user_zone, warning = _user_zone(timezone_name)

    now = datetime.now(user_zone)
    start_local = datetime.combine(now.date(), time.min, tzinfo=user_zone)
    end_local = now
    return _iso_utc(start_local), _iso_utc(end_local), warning


def _mined_window(message: str, timezone_name: str | None) -> tuple[str, str, str, str | None]:
    normalized = message.strip().lower()
    user_zone, warning = _user_zone(timezone_name)
    now = datetime.now(user_zone)

    last_hours = re.search(r"\blast\s+(\d{1,3})\s+hours?\b", normalized)
    if last_hours:
        hours = max(1, min(168, int(last_hours.group(1))))
        start = now - timedelta(hours=hours)
        return _iso_utc(start), _iso_utc(now), f"the last {hours} hour{'s' if hours != 1 else ''}", warning

    if "yesterday" in normalized:
        target = now.date() - timedelta(days=1)
        start = datetime.combine(target, time.min, tzinfo=user_zone)
        end = start + timedelta(days=1, microseconds=-1)
        return _iso_utc(start), _iso_utc(end), f"yesterday ({timezone_name or 'UTC'})", warning

    start_utc, end_utc, _ = _today_window(timezone_name)
    return start_utc, end_utc, f"today ({timezone_name or 'UTC'})", warning


def _status_answer(data: Dict[str, Any]) -> str:
    if data.get("error"):
        return data["error"]
    sync = "syncing" if data.get("initial_block_download") else "synced"
    progress = data.get("verification_progress")
    progress_line = f"\n- **Verification:** {progress:.4%}" if isinstance(progress, float) else ""
    return (
        "The node is reachable.\n\n"
        f"- **Chain:** {data.get('chain')}\n"
        f"- **Height:** {data.get('blocks')}\n"
        f"- **Status:** {sync}"
        f"{progress_line}"
    )


def _block_answer(data: Dict[str, Any]) -> str:
    if data.get("error"):
        return data["error"]
    return (
        f"Block **{data.get('height')}**:\n\n"
        f"- **Transactions:** {data.get('tx_count')}\n"
        f"- **Weight:** {data.get('weight')}\n"
        f"- **Subsidy:** {data.get('subsidy_btc')} BTC\n"
        f"- **Timestamp:** {data.get('time')}"
    )


def _mempool_answer(data: Dict[str, Any]) -> str:
    if data.get("error"):
        return data["error"]
    estimates = data.get("fee_estimates_sats_vb", {})
    fast = estimates.get("2")
    medium = estimates.get("6")
    return (
        "Current mempool snapshot:\n\n"
        f"- **Transactions:** {data.get('tx_count')}\n"
        f"- **Fast estimate:** {fast} sats/vB, roughly 2 blocks\n"
        f"- **Medium estimate:** {medium} sats/vB, roughly 6 blocks"
    )


def _mined_answer(data: Dict[str, Any], window_label: str) -> str:
    if data.get("error"):
        return data["error"]
    return (
        f"For **{window_label}**:\n\n"
        f"- **Blocks counted:** {data.get('blocks_counted')}\n"
        f"- **New subsidy:** {data.get('subsidy_btc')} BTC\n"
        "- **Not included:** transaction fees, because fees are not new BTC issuance"
    )


def _transaction_answer(data: Dict[str, Any]) -> str:
    if data.get("error"):
        return data["error"]
    status = "confirmed" if data.get("confirmed") else "unconfirmed"
    fee_text = (
        f"The fee was {data.get('fee_btc')} BTC, about {data.get('fee_rate_sats_vb')} sats/vB."
        if data.get("fee_available")
        else "Exact fee is not available from this lookup."
    )
    block_text = f" in block {data.get('block_height')}" if data.get("block_height") else ""
    return (
        f"That transaction is **{status}**{block_text}.\n\n"
        f"- **Confirmations:** {data.get('confirmations', 0)}\n"
        f"- **Inputs:** {data.get('input_count')}\n"
        f"- **Outputs:** {data.get('output_count')}\n"
        f"- **Total output:** {data.get('total_output_btc')} BTC\n"
        f"- **Fee:** {fee_text}"
    )


def _address_answer(data: Dict[str, Any]) -> str:
    if data.get("error"):
        return data["error"]
    utxo_count = data.get("utxo_count")
    unconfirmed = data.get("unconfirmed_delta_btc")
    unconfirmed_line = (
        f"\n- **Unconfirmed delta:** {unconfirmed} BTC"
        if unconfirmed not in (None, 0, 0.0)
        else ""
    )
    return (
        "That public Bitcoin address snapshot shows:\n\n"
        f"- **Confirmed balance:** {data.get('confirmed_balance_btc')} BTC\n"
        f"- **Total balance:** {data.get('total_balance_btc')} BTC"
        f"{unconfirmed_line}\n"
        f"- **Transactions:** {data.get('chain_tx_count')} confirmed, {data.get('mempool_tx_count')} unconfirmed\n"
        f"- **Current UTXOs:** {utxo_count}\n\n"
        "This is public chain data only; it does not prove who controls the address."
    )


def _conceptual_fallback_answer(message: str) -> str:
    normalized = message.strip().lower()
    if "utxo" in normalized:
        return (
            "A **UTXO** is an unspent transaction output: a chunk of bitcoin that exists on-chain and has not been spent yet.\n\n"
            "- Wallets spend one or more UTXOs as transaction inputs.\n"
            "- New payments create new UTXOs as outputs.\n"
            "- Your balance is the sum of spendable UTXOs your wallet can control."
        )
    if "difficulty" in normalized:
        return (
            "**Difficulty** controls how hard it is to find a valid proof-of-work block.\n\n"
            "- Every 2016 blocks, nodes retarget difficulty.\n"
            "- The goal is to keep blocks averaging about 10 minutes.\n"
            "- If total hash rate rises, difficulty tends to rise too."
        )
    if "mining" in normalized:
        return (
            "**Mining** is Bitcoin's proof-of-work process.\n\n"
            "- Miners order transactions into blocks.\n"
            "- They compete to find a block hash below the current target.\n"
            "- Full nodes independently verify each block."
        )
    return (
        "I can help with:\n\n"
        "- **Live node facts:** blocks, transactions, fees, sync status, and mined BTC\n"
        "- **Bitcoin concepts:** UTXOs, mining, difficulty, confirmations, and fees"
    )


def _unique(values: List[str]) -> List[str]:
    result = []
    for value in values:
        if value and value not in result:
            result.append(value)
    return result


