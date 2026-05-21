from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services import bitcoin_ai, bitcoin_tools


router = APIRouter(prefix="/api/bitcoin", tags=["bitcoin"])


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
async def bitcoin_health():
    status = bitcoin_tools.get_node_status()
    return {
        "status": "ok" if not status.get("error") else "degraded",
        "source": status.get("source"),
        "node_configured": status.get("source") == "node",
        "live_data_available": status.get("source") in ("node", "mempool.space"),
        "warnings": status.get("warnings", []),
    }


@router.get("/status")
async def bitcoin_status():
    return bitcoin_tools.get_node_status()


@router.get("/block/latest")
async def latest_block():
    return bitcoin_tools.get_latest_block()


@router.get("/block/{height_or_hash}")
async def block(height_or_hash: str):
    try:
        return bitcoin_tools.get_block(height_or_hash)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/tx/{txid}")
async def transaction(txid: str):
    try:
        return bitcoin_tools.get_transaction(txid)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/mempool/summary")
async def mempool_summary():
    return bitcoin_tools.get_mempool_summary()


@router.post("/chat", response_model=BitcoinChatResponse)
async def bitcoin_chat(request: BitcoinChatRequest):
    return bitcoin_ai.answer_chat(request.message, request.session_id, request.timezone)
