import os
import time
from typing import Any, Dict

from app.services.bitcoin_formatting import block_subsidy_btc, fee_rate_sats_vb, iso_from_unix
from app.services.bitcoin_rpc import BitcoinRPCError, bitcoin_rpc_client


def _demo_status() -> Dict[str, Any]:
    return {
        "source": "demo",
        "chain": os.getenv("BITCOIN_NETWORK", "main"),
        "blocks": 840000,
        "headers": 840000,
        "verification_progress": 1,
        "initial_block_download": False,
        "warnings": ["Bitcoin RPC is not configured. Showing demo data."],
    }


def get_node_status() -> Dict[str, Any]:
    if not bitcoin_rpc_client.configured:
        return _demo_status()

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
    if not bitcoin_rpc_client.configured:
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
            "warnings": ["Bitcoin RPC is not configured. Showing demo data."],
        }

    try:
        height = bitcoin_rpc_client.call("getblockcount")
        block_hash = bitcoin_rpc_client.call("getblockhash", [height])
        block = bitcoin_rpc_client.call("getblock", [block_hash, 1])
    except BitcoinRPCError as exc:
        return _rpc_error_response(exc)

    return _format_block(block, source="node")


def get_block(height_or_hash: str) -> Dict[str, Any]:
    if not bitcoin_rpc_client.configured:
        height = int(height_or_hash) if height_or_hash.isdigit() else 840000
        data = get_latest_block()
        data["height"] = height
        data["subsidy_btc"] = block_subsidy_btc(height)
        return data

    try:
        block_hash = height_or_hash
        if height_or_hash.isdigit():
            block_hash = bitcoin_rpc_client.call("getblockhash", [int(height_or_hash)])
        block = bitcoin_rpc_client.call("getblock", [block_hash, 1])
    except BitcoinRPCError as exc:
        return _rpc_error_response(exc)

    return _format_block(block, source="node")


def get_mempool_summary() -> Dict[str, Any]:
    if not bitcoin_rpc_client.configured:
        return {
            "source": "demo",
            "tx_count": 12000,
            "virtual_size_vb": 42000000,
            "total_fees_btc": 1.35,
            "memory_usage_bytes": 124000000,
            "min_relay_fee_btc_kvb": 0.00001,
            "fee_estimates_sats_vb": {"2": 18.4, "6": 9.7, "12": 5.1},
            "warnings": ["Bitcoin RPC is not configured. Showing demo data."],
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

    if not bitcoin_rpc_client.configured:
        demo_rate = max(1.0, round(30 / confirmation_target_blocks, 2))
        return {
            "source": "demo",
            "target_blocks": confirmation_target_blocks,
            "btc_per_kvb": demo_rate / 100000,
            "sats_vb": demo_rate,
            "warnings": ["Bitcoin RPC is not configured. Showing demo data."],
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


def get_transaction(txid: str) -> Dict[str, Any]:
    if len(txid) != 64 or any(char not in "0123456789abcdefABCDEF" for char in txid):
        raise ValueError("That does not look like a valid transaction id.")

    if not bitcoin_rpc_client.configured:
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
            "warnings": ["Bitcoin RPC is not configured. Showing demo transaction shape."],
        }

    try:
        tx = bitcoin_rpc_client.call("getrawtransaction", [txid, True])
    except BitcoinRPCError as exc:
        return _rpc_error_response(exc)

    outputs = tx.get("vout", [])
    total_output = sum(output.get("value", 0) for output in outputs)
    return {
        "source": "node",
        "txid": tx.get("txid"),
        "confirmed": bool(tx.get("confirmations", 0)),
        "confirmations": tx.get("confirmations", 0),
        "block_hash": tx.get("blockhash"),
        "block_time": iso_from_unix(tx.get("blocktime")),
        "input_count": len(tx.get("vin", [])),
        "output_count": len(outputs),
        "total_output_btc": total_output,
        "vsize": tx.get("vsize"),
        "fee_available": False,
        "fee_btc": None,
        "fee_rate_sats_vb": None,
        "warnings": ["Fee calculation requires previous output lookup and is not enabled yet."],
    }


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
    except BitcoinRPCError as exc:
        return _rpc_error_response(exc)


def _rpc_error_response(exc: BitcoinRPCError) -> Dict[str, Any]:
    return {
        "source": "error",
        "error": str(exc),
        "warnings": ["I cannot reach the Bitcoin node right now."],
    }
