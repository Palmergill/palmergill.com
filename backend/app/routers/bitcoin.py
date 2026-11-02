import asyncio

from fastapi import APIRouter, HTTPException, Query, Request

from app.services import bitcoin_tools


router = APIRouter(prefix="/api/bitcoin", tags=["bitcoin"])


def is_demo_request(request: Request) -> bool:
    return bool(getattr(request.state, "demo_mode", False))


async def run_blocking(func, *args, **kwargs):
    """Run sync provider work off the event loop."""
    return await asyncio.to_thread(func, *args, **kwargs)


@router.get("/health")
async def bitcoin_health(request: Request):
    status = (
        bitcoin_tools.get_demo_node_status()
        if is_demo_request(request)
        else await run_blocking(bitcoin_tools.get_node_status)
    )
    return {
        "status": "ok" if not status.get("error") else "degraded",
        "source": status.get("source"),
        "node_configured": status.get("source") == "node",
        "live_data_available": status.get("source") in ("node", "mempool.space"),
        "warnings": status.get("warnings", []),
    }


@router.get("/status")
async def bitcoin_status(request: Request):
    return (
        bitcoin_tools.get_demo_node_status()
        if is_demo_request(request)
        else await run_blocking(bitcoin_tools.get_node_status)
    )


@router.get("/block/latest")
async def latest_block(request: Request):
    return (
        bitcoin_tools.get_demo_latest_block()
        if is_demo_request(request)
        else await run_blocking(bitcoin_tools.get_latest_block)
    )


@router.get("/block/{height_or_hash}")
async def block(request: Request, height_or_hash: str):
    try:
        if is_demo_request(request):
            return bitcoin_tools.get_demo_block(height_or_hash)
        return await run_blocking(bitcoin_tools.get_block, height_or_hash)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/tx/{txid}")
async def transaction(request: Request, txid: str):
    try:
        if is_demo_request(request):
            return bitcoin_tools.get_demo_transaction(txid)
        return await run_blocking(bitcoin_tools.get_transaction, txid)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/address/{address}")
async def address(
    request: Request,
    address: str,
    utxo_limit: int = Query(bitcoin_tools.DEFAULT_ADDRESS_UTXO_LIMIT, ge=1, le=100),
):
    try:
        if is_demo_request(request):
            return bitcoin_tools.get_demo_address(address, utxo_limit)
        return await run_blocking(bitcoin_tools.get_address, address, utxo_limit)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/price")
async def price(request: Request):
    return (
        bitcoin_tools.get_demo_price()
        if is_demo_request(request)
        else await run_blocking(bitcoin_tools.get_price)
    )


@router.get("/price/history")
async def price_history(
    request: Request,
    range_key: str = Query("1m", alias="range", pattern="^(1d|1w|1m|3m|1y|5y)$"),
):
    try:
        if is_demo_request(request):
            return bitcoin_tools.get_demo_price_history(range_key)
        return await run_blocking(bitcoin_tools.get_price_history, range_key)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/supply/history")
async def supply_history(request: Request):
    return (
        bitcoin_tools.get_demo_supply_history()
        if is_demo_request(request)
        else await run_blocking(bitcoin_tools.get_supply_history)
    )


@router.get("/blocks/recent")
async def recent_blocks(request: Request, limit: int = Query(8, ge=1, le=15)):
    return (
        bitcoin_tools.get_demo_recent_blocks(limit)
        if is_demo_request(request)
        else await run_blocking(bitcoin_tools.get_recent_blocks, limit)
    )


@router.get("/difficulty")
async def difficulty_adjustment(request: Request):
    return (
        bitcoin_tools.get_demo_difficulty_adjustment()
        if is_demo_request(request)
        else await run_blocking(bitcoin_tools.get_difficulty_adjustment)
    )


@router.get("/mempool/summary")
async def mempool_summary(request: Request):
    return (
        bitcoin_tools.get_demo_mempool_summary()
        if is_demo_request(request)
        else await run_blocking(bitcoin_tools.get_mempool_summary)
    )
