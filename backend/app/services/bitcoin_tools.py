import os
import re
import time
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, List

from app.services.bitcoin_formatting import block_subsidy_btc, btc_to_sats, fee_rate_sats_vb, iso_from_unix, sats_to_btc
from app.services.bitcoin_mempool_space import MempoolSpaceError, mempool_space_client
from app.services.bitcoin_rpc import BitcoinRPCError, bitcoin_rpc_client


MAX_MINED_STATS_BLOCKS = int(os.getenv("BITCOIN_MAX_MINED_STATS_BLOCKS", "1008"))
BITCOIN_DATA_PROVIDER = os.getenv("BITCOIN_DATA_PROVIDER", "mempool").strip().lower()
DEMO_WARNING = "Public demo mode uses estimated sample Bitcoin data and does not call Palmer's live node, mempool.space, or OpenAI."
BITCOIN_ADDRESS_PATTERN = r"(?:bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})"
BITCOIN_ADDRESS_RE = re.compile(rf"^{BITCOIN_ADDRESS_PATTERN}$", re.IGNORECASE)
DEFAULT_ADDRESS_UTXO_LIMIT = 25


def _use_rpc() -> bool:
    return BITCOIN_DATA_PROVIDER == "rpc"


def _use_mempool_space() -> bool:
    return BITCOIN_DATA_PROVIDER in ("", "mempool", "mempool.space", "mempool_space")


def _provider_not_configured() -> bool:
    if _use_rpc():
        return not bitcoin_rpc_client.configured
    if _use_mempool_space():
        return not mempool_space_client.configured
    return True


def _demo_status() -> Dict[str, Any]:
    return {
        "source": "demo",
        "chain": os.getenv("BITCOIN_NETWORK", "main"),
        "blocks": 840000,
        "headers": 840000,
        "verification_progress": 1,
        "initial_block_download": False,
        "warnings": [DEMO_WARNING],
    }


def get_demo_node_status() -> Dict[str, Any]:
    return _demo_status()


def get_demo_latest_block() -> Dict[str, Any]:
    now = int(time.time())
    return {
        "source": "demo",
        "height": 840000,
        "hash": "0000000000000000000320283a032748cef8227873ff4872689bf23f1cda83a5",
        "time": iso_from_unix(now - 600),
        "tx_count": 3050,
        "size": 1847392,
        "weight": 3992920,
        "previous_block_hash": "00000000000000000001f7f1f6d92d2c3d5d1a4c1d9e0f5b4a3c2d1e0f9a8b7c",
        "subsidy_btc": block_subsidy_btc(840000),
        "warnings": [DEMO_WARNING],
    }


def get_demo_block(height_or_hash: str) -> Dict[str, Any]:
    height = int(height_or_hash) if height_or_hash.isdigit() else 840000
    data = get_demo_latest_block()
    data["height"] = height
    data["subsidy_btc"] = block_subsidy_btc(height)
    return data


def get_demo_mempool_summary() -> Dict[str, Any]:
    return {
        "source": "demo",
        "tx_count": 12000,
        "virtual_size_vb": 42000000,
        "total_fees_btc": 1.35,
        "memory_usage_bytes": 124000000,
        "min_relay_fee_btc_kvb": 0.00001,
        "fee_estimates_sats_vb": {"2": 18.4, "6": 9.7, "12": 5.1},
        "warnings": [DEMO_WARNING],
    }


def get_demo_fee_estimate(confirmation_target_blocks: int) -> Dict[str, Any]:
    if confirmation_target_blocks < 1 or confirmation_target_blocks > 1008:
        raise ValueError("Confirmation target must be between 1 and 1008 blocks")

    demo_rate = max(1.0, round(30 / confirmation_target_blocks, 2))
    return {
        "source": "demo",
        "target_blocks": confirmation_target_blocks,
        "btc_per_kvb": demo_rate / 100000,
        "sats_vb": demo_rate,
        "warnings": [DEMO_WARNING],
    }


def get_demo_mined_stats(start_time: str, end_time: str) -> Dict[str, Any]:
    start_dt = _parse_iso_time(start_time)
    end_dt = _parse_iso_time(end_time)
    if start_dt >= end_dt:
        raise ValueError("The start time must be before the end time.")

    seconds = (end_dt - start_dt).total_seconds()
    blocks_counted = max(0, round(seconds / 600))
    latest_height = 840000
    subsidy = block_subsidy_btc(latest_height)
    return {
        "source": "demo",
        "start_time": start_dt.isoformat().replace("+00:00", "Z"),
        "end_time": end_dt.isoformat().replace("+00:00", "Z"),
        "blocks_counted": blocks_counted,
        "first_height": latest_height - blocks_counted + 1 if blocks_counted else None,
        "last_height": latest_height if blocks_counted else None,
        "subsidy_btc": round(blocks_counted * subsidy, 8),
        "fees_available": False,
        "fees_btc": None,
        "total_miner_reward_available": False,
        "total_miner_reward_btc": None,
        "average_block_interval_seconds": 600 if blocks_counted > 1 else None,
        "warnings": [DEMO_WARNING],
    }


def get_demo_transaction(txid: str) -> Dict[str, Any]:
    if len(txid) != 64 or any(char not in "0123456789abcdefABCDEF" for char in txid):
        raise ValueError("That does not look like a valid transaction id.")

    return {
        "source": "demo",
        "txid": txid,
        "confirmed": False,
        "confirmations": 0,
        "input_count": 2,
        "output_count": 2,
        "total_output_btc": 0.042,
        "fee_available": False,
        "fee_btc": None,
        "fee_rate_sats_vb": None,
        "warnings": [DEMO_WARNING],
    }


def get_demo_address(address: str, utxo_limit: int = DEFAULT_ADDRESS_UTXO_LIMIT) -> Dict[str, Any]:
    address = _validate_address(address)
    _validate_utxo_limit(utxo_limit)
    utxos = [
        {
            "txid": "b" * 64,
            "vout": 0,
            "value_sats": 125000,
            "value_btc": sats_to_btc(125000),
            "confirmed": True,
            "confirmations": 18,
            "block_height": 839982,
            "block_hash": "00000000000000000005a9f68c2f4d7e8b1c3a4d5e6f708192a3b4c5d6e7f809",
            "block_time": iso_from_unix(int(time.time()) - 10800),
        },
        {
            "txid": "c" * 64,
            "vout": 1,
            "value_sats": 42000,
            "value_btc": sats_to_btc(42000),
            "confirmed": False,
            "confirmations": 0,
            "block_height": None,
            "block_hash": None,
            "block_time": None,
        },
    ][:utxo_limit]
    confirmed_balance_sats = 125000
    unconfirmed_delta_sats = 42000
    total_balance_sats = confirmed_balance_sats + unconfirmed_delta_sats
    return {
        "source": "demo",
        "address": address,
        "confirmed_balance_sats": confirmed_balance_sats,
        "confirmed_balance_btc": sats_to_btc(confirmed_balance_sats),
        "unconfirmed_delta_sats": unconfirmed_delta_sats,
        "unconfirmed_delta_btc": sats_to_btc(unconfirmed_delta_sats),
        "total_balance_sats": total_balance_sats,
        "total_balance_btc": sats_to_btc(total_balance_sats),
        "chain_tx_count": 7,
        "mempool_tx_count": 1,
        "funded_txo_count": 9,
        "spent_txo_count": 7,
        "utxo_count": 2,
        "utxos_returned": len(utxos),
        "utxos": utxos,
        "warnings": [DEMO_WARNING],
    }


def get_node_status() -> Dict[str, Any]:
    if _provider_not_configured():
        return _demo_status()

    if _use_mempool_space():
        try:
            height = mempool_space_client.get_tip_height()
        except MempoolSpaceError as exc:
            return _api_error_response(exc)

        return {
            "source": "mempool.space",
            "chain": "main",
            "blocks": height,
            "headers": height,
            "verification_progress": 1,
            "initial_block_download": False,
            "warnings": [],
        }

    try:
        info = bitcoin_rpc_client.call("getblockchaininfo")
    except BitcoinRPCError as exc:
        return _rpc_error_response(exc)

    return {
        "source": "node",
        "chain": info.get("chain"),
        "blocks": info.get("blocks"),
        "headers": info.get("headers"),
        "verification_progress": info.get("verificationprogress"),
        "initial_block_download": info.get("initialblockdownload"),
        "warnings": [],
    }


def get_latest_block() -> Dict[str, Any]:
    if _provider_not_configured():
        return get_demo_latest_block()

    if _use_mempool_space():
        try:
            block_hash = mempool_space_client.get_tip_hash()
            block = mempool_space_client.get_block(block_hash)
        except MempoolSpaceError as exc:
            return _api_error_response(exc)

        return _format_mempool_block(block)

    try:
        height = bitcoin_rpc_client.call("getblockcount")
        block_hash = bitcoin_rpc_client.call("getblockhash", [height])
        block = bitcoin_rpc_client.call("getblock", [block_hash, 1])
    except BitcoinRPCError as exc:
        return _rpc_error_response(exc)

    return _format_block(block, source="node")


def get_block(height_or_hash: str) -> Dict[str, Any]:
    if _provider_not_configured():
        return get_demo_block(height_or_hash)

    if _use_mempool_space():
        try:
            block_hash = height_or_hash
            if height_or_hash.isdigit():
                block_hash = mempool_space_client.get_block_hash(int(height_or_hash))
            block = mempool_space_client.get_block(block_hash)
        except MempoolSpaceError as exc:
            return _api_error_response(exc)

        return _format_mempool_block(block)

    try:
        block_hash = height_or_hash
        if height_or_hash.isdigit():
            block_hash = bitcoin_rpc_client.call("getblockhash", [int(height_or_hash)])
        block = bitcoin_rpc_client.call("getblock", [block_hash, 1])
    except BitcoinRPCError as exc:
        return _rpc_error_response(exc)

    return _format_block(block, source="node")


def get_mempool_summary() -> Dict[str, Any]:
    if _provider_not_configured():
        return get_demo_mempool_summary()

    if _use_mempool_space():
        try:
            mempool = mempool_space_client.get_mempool()
            fees = mempool_space_client.get_recommended_fees()
        except MempoolSpaceError as exc:
            return _api_error_response(exc)

        return {
            "source": "mempool.space",
            "tx_count": mempool.get("count"),
            "virtual_size_vb": mempool.get("vsize"),
            "total_fees_btc": sats_to_btc(mempool.get("total_fee", 0)),
            "memory_usage_bytes": None,
            "min_relay_fee_btc_kvb": _sats_vb_to_btc_kvb(fees.get("minimumFee")),
            "fee_estimates_sats_vb": {
                "2": fees.get("fastestFee"),
                "6": fees.get("hourFee"),
                "12": fees.get("economyFee"),
            },
            "warnings": [],
        }

    try:
        mempool = bitcoin_rpc_client.call("getmempoolinfo")
        estimates = {}
        for target in (2, 6, 12):
            estimate = bitcoin_rpc_client.call("estimatesmartfee", [target])
            estimates[str(target)] = fee_rate_sats_vb(estimate.get("feerate"))
    except BitcoinRPCError as exc:
        return _rpc_error_response(exc)

    return {
        "source": "node",
        "tx_count": mempool.get("size"),
        "virtual_size_vb": mempool.get("bytes"),
        "total_fees_btc": mempool.get("total_fee"),
        "memory_usage_bytes": mempool.get("usage"),
        "min_relay_fee_btc_kvb": mempool.get("mempoolminfee"),
        "fee_estimates_sats_vb": estimates,
        "warnings": [],
    }


def estimate_fee(confirmation_target_blocks: int) -> Dict[str, Any]:
    if confirmation_target_blocks < 1 or confirmation_target_blocks > 1008:
        raise ValueError("Confirmation target must be between 1 and 1008 blocks")

    if _provider_not_configured():
        return get_demo_fee_estimate(confirmation_target_blocks)

    if _use_mempool_space():
        try:
            fees = mempool_space_client.get_recommended_fees()
        except MempoolSpaceError as exc:
            return _api_error_response(exc)

        sats_vb = _recommended_fee_for_target(fees, confirmation_target_blocks)
        return {
            "source": "mempool.space",
            "target_blocks": confirmation_target_blocks,
            "btc_per_kvb": _sats_vb_to_btc_kvb(sats_vb),
            "sats_vb": sats_vb,
            "warnings": [],
        }

    try:
        estimate = bitcoin_rpc_client.call("estimatesmartfee", [confirmation_target_blocks])
    except BitcoinRPCError as exc:
        return _rpc_error_response(exc)

    btc_per_kvb = estimate.get("feerate")
    return {
        "source": "node",
        "target_blocks": confirmation_target_blocks,
        "btc_per_kvb": btc_per_kvb,
        "sats_vb": fee_rate_sats_vb(btc_per_kvb),
        "warnings": estimate.get("errors", []),
    }


def get_mined_stats(start_time: str, end_time: str, max_blocks: int = MAX_MINED_STATS_BLOCKS) -> Dict[str, Any]:
    start_dt = _parse_iso_time(start_time)
    end_dt = _parse_iso_time(end_time)
    if start_dt >= end_dt:
        raise ValueError("The start time must be before the end time.")
    if max_blocks < 1 or max_blocks > MAX_MINED_STATS_BLOCKS:
        raise ValueError(f"max_blocks must be between 1 and {MAX_MINED_STATS_BLOCKS}.")

    if _provider_not_configured():
        return get_demo_mined_stats(start_time, end_time)

    if _use_mempool_space():
        return _get_mined_stats_from_mempool_space(start_dt, end_dt, max_blocks)

    start_ts = int(start_dt.timestamp())
    end_ts = int(end_dt.timestamp())
    warnings: List[str] = []

    try:
        height = bitcoin_rpc_client.call("getblockcount")
        matching_blocks = []
        scanned = 0

        while height >= 0 and scanned < max_blocks:
            block_hash = bitcoin_rpc_client.call("getblockhash", [height])
            block = bitcoin_rpc_client.call("getblock", [block_hash, 1])
            block_time = block.get("time")
            scanned += 1

            if block_time is not None and start_ts <= block_time <= end_ts:
                matching_blocks.append(block)

            if block_time is not None and block_time < start_ts:
                break
            height -= 1
    except BitcoinRPCError as exc:
        return _rpc_error_response(exc)

    if scanned >= max_blocks and (not matching_blocks or matching_blocks[-1].get("time", end_ts) >= start_ts):
        warnings.append(
            f"Stopped after scanning {max_blocks} blocks. Narrow the time window or raise BITCOIN_MAX_MINED_STATS_BLOCKS for larger ranges."
        )

    heights = [block.get("height") for block in matching_blocks if block.get("height") is not None]
    timestamps = sorted(block.get("time") for block in matching_blocks if block.get("time") is not None)
    subsidy_total = sum(Decimal(str(block_subsidy_btc(block.get("height") or 0))) for block in matching_blocks)

    return {
        "source": "node",
        "start_time": start_dt.isoformat().replace("+00:00", "Z"),
        "end_time": end_dt.isoformat().replace("+00:00", "Z"),
        "blocks_counted": len(matching_blocks),
        "first_height": min(heights) if heights else None,
        "last_height": max(heights) if heights else None,
        "subsidy_btc": float(subsidy_total),
        "fees_available": False,
        "fees_btc": None,
        "total_miner_reward_available": False,
        "total_miner_reward_btc": None,
        "average_block_interval_seconds": _average_interval_seconds(timestamps),
        "warnings": warnings or ["Fee totals are not included; this counts new bitcoin subsidy only."],
    }


def get_transaction(txid: str) -> Dict[str, Any]:
    if len(txid) != 64 or any(char not in "0123456789abcdefABCDEF" for char in txid):
        raise ValueError("That does not look like a valid transaction id.")

    if _provider_not_configured():
        return get_demo_transaction(txid)

    if _use_mempool_space():
        try:
            tx = mempool_space_client.get_transaction(txid)
            tip_height = mempool_space_client.get_tip_height()
        except MempoolSpaceError as exc:
            return _api_error_response(exc)

        return _format_mempool_transaction(tx, tip_height)

    try:
        tx = bitcoin_rpc_client.call("getrawtransaction", [txid, True])
    except BitcoinRPCError as exc:
        return _rpc_error_response(exc)

    outputs = tx.get("vout", [])
    total_output = sum(Decimal(str(output.get("value", 0))) for output in outputs)
    input_value_btc, input_warnings = _calculate_input_value(tx)
    fee_btc = None
    fee_rate = None
    if input_value_btc is not None and tx.get("vsize"):
        fee_btc = input_value_btc - total_output
        # Pass the Decimal through — the float() cast was discarding the
        # last few decimal places before scaling, distorting fee_rate.
        fee_rate = round(btc_to_sats(fee_btc) / tx["vsize"], 2)

    block_height = None
    if tx.get("blockhash"):
        try:
            block = bitcoin_rpc_client.call("getblock", [tx["blockhash"], 1])
            block_height = block.get("height")
        except BitcoinRPCError:
            input_warnings.append("Block height lookup failed, but transaction data was available.")

    return {
        "source": "node",
        "txid": tx.get("txid"),
        "confirmed": bool(tx.get("confirmations", 0)),
        "confirmations": tx.get("confirmations", 0),
        "block_hash": tx.get("blockhash"),
        "block_height": block_height,
        "block_time": iso_from_unix(tx.get("blocktime")),
        "input_count": len(tx.get("vin", [])),
        "output_count": len(outputs),
        "total_output_btc": float(total_output),
        "outputs": _summarize_outputs(outputs),
        "vsize": tx.get("vsize"),
        "fee_available": fee_btc is not None,
        "fee_btc": float(fee_btc) if fee_btc is not None else None,
        "fee_rate_sats_vb": fee_rate,
        "warnings": input_warnings,
    }


def get_address(address: str, utxo_limit: int = DEFAULT_ADDRESS_UTXO_LIMIT) -> Dict[str, Any]:
    address = _validate_address(address)
    _validate_utxo_limit(utxo_limit)

    if _provider_not_configured():
        return get_demo_address(address, utxo_limit)

    if not _use_mempool_space():
        return {
            "source": "error",
            "error": "Address lookup requires an indexed provider such as mempool.space; this Bitcoin Core RPC setup is intentionally read-only and not address-indexed.",
            "warnings": ["Switch BITCOIN_DATA_PROVIDER to mempool for public address and UTXO lookups."],
        }

    try:
        address_data = mempool_space_client.get_address(address)
        utxos = mempool_space_client.get_address_utxos(address)
        tip_height = mempool_space_client.get_tip_height()
    except MempoolSpaceError as exc:
        return _api_error_response(exc)

    return _format_mempool_address(address_data, utxos, tip_height, utxo_limit)


def _format_block(block: Dict[str, Any], source: str) -> Dict[str, Any]:
    height = block.get("height")
    return {
        "source": source,
        "height": height,
        "hash": block.get("hash"),
        "time": iso_from_unix(block.get("time")),
        "confirmations": block.get("confirmations"),
        "tx_count": len(block.get("tx", [])),
        "size": block.get("size"),
        "weight": block.get("weight"),
        "previous_block_hash": block.get("previousblockhash"),
        "coinbase_txid": block.get("tx", [None])[0],
        "subsidy_btc": block_subsidy_btc(height or 0),
        "warnings": [],
    }


def safe_tool_call(name: str, *args: Any, **kwargs: Any) -> Dict[str, Any]:
    try:
        return globals()[name](*args, **kwargs)
    except MempoolSpaceError as exc:
        return _api_error_response(exc)
    except BitcoinRPCError as exc:
        return _rpc_error_response(exc)
    except ValueError as exc:
        return {
            "source": "error",
            "error": str(exc),
            "warnings": [str(exc)],
        }


def safe_demo_tool_call(name: str, *args: Any, **kwargs: Any) -> Dict[str, Any]:
    demo_handlers = {
        "get_node_status": get_demo_node_status,
        "get_latest_block": get_demo_latest_block,
        "get_block": get_demo_block,
        "get_transaction": get_demo_transaction,
        "get_address": get_demo_address,
        "get_mempool_summary": get_demo_mempool_summary,
        "estimate_fee": get_demo_fee_estimate,
        "get_mined_stats": get_demo_mined_stats,
    }
    try:
        return demo_handlers[name](*args, **kwargs)
    except KeyError:
        return {"source": "error", "error": f"Unknown tool: {name}", "warnings": [f"Unknown tool: {name}"]}
    except ValueError as exc:
        return {
            "source": "error",
            "error": str(exc),
            "warnings": [str(exc)],
        }


def _rpc_error_response(exc: BitcoinRPCError) -> Dict[str, Any]:
    return {
        "source": "error",
        "error": str(exc),
        "warnings": ["I cannot reach the Bitcoin RPC node right now."],
    }


def _api_error_response(exc: MempoolSpaceError) -> Dict[str, Any]:
    return {
        "source": "error",
        "error": str(exc),
        "warnings": ["I cannot reach mempool.space right now."],
    }


def _format_mempool_block(block: Dict[str, Any]) -> Dict[str, Any]:
    height = block.get("height")
    return {
        "source": "mempool.space",
        "height": height,
        "hash": block.get("id"),
        "time": iso_from_unix(block.get("timestamp")),
        "confirmations": None,
        "tx_count": block.get("tx_count"),
        "size": block.get("size"),
        "weight": block.get("weight"),
        "previous_block_hash": block.get("previousblockhash"),
        "coinbase_txid": None,
        "subsidy_btc": block_subsidy_btc(height or 0),
        "warnings": [],
    }


def _format_mempool_transaction(tx: Dict[str, Any], tip_height: int) -> Dict[str, Any]:
    status = tx.get("status", {})
    block_height = status.get("block_height")
    confirmed = bool(status.get("confirmed"))
    confirmations = tip_height - block_height + 1 if confirmed and block_height is not None else 0
    outputs = tx.get("vout", [])
    total_output_sats = sum(int(output.get("value") or 0) for output in outputs)
    fee_sats = tx.get("fee")
    vsize = tx.get("vsize")
    fee_rate = round(fee_sats / vsize, 2) if fee_sats is not None and vsize else None

    return {
        "source": "mempool.space",
        "txid": tx.get("txid"),
        "confirmed": confirmed,
        "confirmations": confirmations,
        "block_hash": status.get("block_hash"),
        "block_height": block_height,
        "block_time": iso_from_unix(status.get("block_time")),
        "input_count": len(tx.get("vin", [])),
        "output_count": len(outputs),
        "total_output_btc": sats_to_btc(total_output_sats),
        "outputs": _summarize_mempool_outputs(outputs),
        "vsize": vsize,
        "fee_available": fee_sats is not None,
        "fee_btc": sats_to_btc(fee_sats) if fee_sats is not None else None,
        "fee_rate_sats_vb": fee_rate,
        "warnings": [],
    }


def _format_mempool_address(
    address_data: Dict[str, Any],
    utxos: List[Dict[str, Any]],
    tip_height: int,
    utxo_limit: int,
) -> Dict[str, Any]:
    chain = address_data.get("chain_stats", {}) or {}
    mempool = address_data.get("mempool_stats", {}) or {}
    confirmed_balance_sats = int(chain.get("funded_txo_sum") or 0) - int(chain.get("spent_txo_sum") or 0)
    unconfirmed_delta_sats = int(mempool.get("funded_txo_sum") or 0) - int(mempool.get("spent_txo_sum") or 0)
    total_balance_sats = confirmed_balance_sats + unconfirmed_delta_sats
    selected_utxos = utxos[:utxo_limit]
    formatted_utxos = [_format_mempool_utxo(utxo, tip_height) for utxo in selected_utxos]
    mempool_tx_count = mempool.get("tx_count")
    warnings = (
        ["This address has mempool activity; balance and UTXO details may change between provider calls."]
        if mempool_tx_count
        else []
    )

    return {
        "source": "mempool.space",
        "address": address_data.get("address"),
        "confirmed_balance_sats": confirmed_balance_sats,
        "confirmed_balance_btc": sats_to_btc(confirmed_balance_sats),
        "unconfirmed_delta_sats": unconfirmed_delta_sats,
        "unconfirmed_delta_btc": sats_to_btc(unconfirmed_delta_sats),
        "total_balance_sats": total_balance_sats,
        "total_balance_btc": sats_to_btc(total_balance_sats),
        "chain_tx_count": chain.get("tx_count"),
        "mempool_tx_count": mempool_tx_count,
        "funded_txo_count": (chain.get("funded_txo_count") or 0) + (mempool.get("funded_txo_count") or 0),
        "spent_txo_count": (chain.get("spent_txo_count") or 0) + (mempool.get("spent_txo_count") or 0),
        "utxo_count": len(utxos),
        "utxos_returned": len(formatted_utxos),
        "utxos": formatted_utxos,
        "warnings": warnings,
    }


def _format_mempool_utxo(utxo: Dict[str, Any], tip_height: int) -> Dict[str, Any]:
    status = utxo.get("status", {}) or {}
    block_height = status.get("block_height")
    confirmed = bool(status.get("confirmed"))
    confirmations = tip_height - block_height + 1 if confirmed and block_height is not None else 0
    value_sats = int(utxo.get("value") or 0)
    return {
        "txid": utxo.get("txid"),
        "vout": utxo.get("vout"),
        "value_sats": value_sats,
        "value_btc": sats_to_btc(value_sats),
        "confirmed": confirmed,
        "confirmations": confirmations,
        "block_height": block_height,
        "block_hash": status.get("block_hash"),
        "block_time": iso_from_unix(status.get("block_time")),
    }


def _get_mined_stats_from_mempool_space(start_dt: datetime, end_dt: datetime, max_blocks: int) -> Dict[str, Any]:
    start_ts = int(start_dt.timestamp())
    end_ts = int(end_dt.timestamp())
    warnings: List[str] = []

    try:
        height = mempool_space_client.get_tip_height()
        matching_blocks = []
        scanned = 0
        done = False

        while height >= 0 and scanned < max_blocks and not done:
            blocks = mempool_space_client.get_blocks(height)
            if not blocks:
                break

            for block in blocks:
                scanned += 1
                block_time = block.get("timestamp")
                if block_time is not None and start_ts <= block_time <= end_ts:
                    matching_blocks.append(block)
                if block_time is not None and block_time < start_ts:
                    done = True
                    break
                if scanned >= max_blocks:
                    break

            height = min(block.get("height", height) for block in blocks) - 1
    except MempoolSpaceError as exc:
        return _api_error_response(exc)

    if scanned >= max_blocks and (not matching_blocks or matching_blocks[-1].get("timestamp", end_ts) >= start_ts):
        warnings.append(
            f"Stopped after scanning {max_blocks} blocks. Narrow the time window or raise BITCOIN_MAX_MINED_STATS_BLOCKS for larger ranges."
        )

    heights = [block.get("height") for block in matching_blocks if block.get("height") is not None]
    timestamps = sorted(block.get("timestamp") for block in matching_blocks if block.get("timestamp") is not None)
    subsidy_total = sum(Decimal(str(block_subsidy_btc(block.get("height") or 0))) for block in matching_blocks)

    return {
        "source": "mempool.space",
        "start_time": start_dt.isoformat().replace("+00:00", "Z"),
        "end_time": end_dt.isoformat().replace("+00:00", "Z"),
        "blocks_counted": len(matching_blocks),
        "first_height": min(heights) if heights else None,
        "last_height": max(heights) if heights else None,
        "subsidy_btc": float(subsidy_total),
        "fees_available": False,
        "fees_btc": None,
        "total_miner_reward_available": False,
        "total_miner_reward_btc": None,
        "average_block_interval_seconds": _average_interval_seconds(timestamps),
        "warnings": warnings or ["Fee totals are not included; this counts new bitcoin subsidy only."],
    }


def _recommended_fee_for_target(fees: Dict[str, Any], target_blocks: int) -> float | None:
    if target_blocks <= 2:
        return fees.get("fastestFee")
    if target_blocks <= 3:
        return fees.get("halfHourFee")
    if target_blocks <= 6:
        return fees.get("hourFee")
    return fees.get("economyFee") or fees.get("minimumFee")


def _validate_address(address: str) -> str:
    normalized = (address or "").strip()
    if not BITCOIN_ADDRESS_RE.match(normalized):
        raise ValueError("That does not look like a supported Bitcoin address.")
    return normalized


def _validate_utxo_limit(utxo_limit: int) -> None:
    if utxo_limit < 1 or utxo_limit > 100:
        raise ValueError("UTXO limit must be between 1 and 100.")


def _sats_vb_to_btc_kvb(sats_vb: Any) -> float | None:
    if sats_vb is None:
        return None
    return round(float(sats_vb) / 100000, 8)


def _parse_iso_time(value: str) -> datetime:
    normalized = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ValueError("Times must be ISO 8601 strings, for example 2026-05-06T00:00:00Z.") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _average_interval_seconds(timestamps: List[int]) -> float | None:
    if len(timestamps) < 2:
        return None
    intervals = [later - earlier for earlier, later in zip(timestamps, timestamps[1:])]
    return round(sum(intervals) / len(intervals), 2)


def _calculate_input_value(tx: Dict[str, Any]) -> tuple[Decimal | None, List[str]]:
    warnings: List[str] = []
    total = Decimal("0")
    for vin in tx.get("vin", []):
        if vin.get("coinbase"):
            return None, ["Coinbase transactions create new bitcoin, so normal fee calculation does not apply."]

        prev_txid = vin.get("txid")
        prev_vout = vin.get("vout")
        if prev_txid is None or prev_vout is None:
            warnings.append("One input was missing previous-output references.")
            return None, warnings

        try:
            prev_tx = bitcoin_rpc_client.call("getrawtransaction", [prev_txid, True])
            prev_outputs = prev_tx.get("vout", [])
            total += Decimal(str(prev_outputs[prev_vout].get("value", 0)))
        except (BitcoinRPCError, IndexError, TypeError):
            warnings.append("Fee calculation needs previous outputs; this node could not retrieve every spent output.")
            return None, warnings

    return total, warnings


def _summarize_outputs(outputs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    summaries = []
    for output in outputs[:10]:
        script = output.get("scriptPubKey", {})
        summaries.append(
            {
                "n": output.get("n"),
                "value_btc": output.get("value"),
                "script_type": script.get("type"),
                "address": script.get("address"),
            }
        )
    return summaries


def _summarize_mempool_outputs(outputs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    summaries = []
    for index, output in enumerate(outputs[:10]):
        summaries.append(
            {
                "n": index,
                "value_btc": sats_to_btc(output.get("value", 0)),
                "script_type": output.get("scriptpubkey_type"),
                "address": output.get("scriptpubkey_address"),
            }
        )
    return summaries
