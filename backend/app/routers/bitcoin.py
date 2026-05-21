from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.services import bitcoin_ai, bitcoin_tools


router = APIRouter(prefix="/api/bitcoin", tags=["bitcoin"])


def is_demo_request(request: Request) -> bool:
    return bool(getattr(request.state, "demo_mode", False))


class BitcoinChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=1000)
    session_id: Optional[str] = None
    timezone: Optional[str] = None


class BitcoinChatResponse(BaseModel):
    answer: str
    session_id: str
    tools_used: list[str]
    data: Dict[str, Any]
    warnings: list[str] = []


@router.get("/health")
async def bitcoin_health(request: Request):
    status = (
        bitcoin_tools.get_demo_node_status()
        if is_demo_request(request)
        else bitcoin_tools.get_node_status()
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
        else bitcoin_tools.get_node_status()
    )


@router.get("/block/latest")
async def latest_block(request: Request):
    return (
        bitcoin_tools.get_demo_latest_block()
        if is_demo_request(request)
        else bitcoin_tools.get_latest_block()
    )


@router.get("/block/{height_or_hash}")
async def block(request: Request, height_or_hash: str):
    try:
        if is_demo_request(request):
            return bitcoin_tools.get_demo_block(height_or_hash)
        return bitcoin_tools.get_block(height_or_hash)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/tx/{txid}")
async def transaction(request: Request, txid: str):
    try:
        if is_demo_request(request):
            return bitcoin_tools.get_demo_transaction(txid)
        return bitcoin_tools.get_transaction(txid)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/mempool/summary")
async def mempool_summary(request: Request):
    return (
        bitcoin_tools.get_demo_mempool_summary()
        if is_demo_request(request)
        else bitcoin_tools.get_mempool_summary()
    )


@router.post("/chat", response_model=BitcoinChatResponse)
async def bitcoin_chat(http_request: Request, request: BitcoinChatRequest):
    if is_demo_request(http_request):
        return bitcoin_ai.answer_demo_chat(request.message, request.session_id, request.timezone)
    return bitcoin_ai.answer_chat(request.message, request.session_id, request.timezone)
