"""Personal portfolio API: a member's own holdings and trades.

Lives under /api/stocks so it inherits that prefix's edge and origin handling
(anonymous callers get through to the router instead of a Basic-auth
challenge), but nothing here is demo data: every route is gated with
``accounts.require_member_identity``, a JSON 403 the page turns into its
sign-in panel. ``services/portfolio.py`` filters every query on the caller.

Must be included BEFORE the stocks router: its ``GET /api/stocks/{ticker}``
would otherwise answer ``GET /api/stocks/portfolio``.
"""
from datetime import date
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app import accounts
from app.database import get_db
from app.services import portfolio

router = APIRouter(prefix="/api/stocks/portfolio", tags=["portfolio"])


def require_member(request: Request) -> Dict[str, Any]:
    return accounts.require_member_identity(request, "Sign in to see your portfolio.")


def caller(identity: Dict[str, Any] = Depends(require_member)) -> str:
    return portfolio.username_for(identity)


class ImportRequest(BaseModel):
    csv: str = Field(..., min_length=1, max_length=portfolio.MAX_CSV_CHARS)
    kind: str = Field("auto", pattern="^(auto|holdings|transactions)$")
    # The holdings snapshot's date; today when omitted.
    as_of: Optional[date] = None
    # Transactions only: replace the stored history instead of adding to it.
    replace: bool = False


class TransactionRequest(BaseModel):
    ticker: str = Field(..., min_length=1, max_length=12)
    side: str = Field(..., pattern="^(buy|sell)$")
    shares: float = Field(..., gt=0, le=1e9)
    price: float = Field(..., ge=0, le=1e7)
    fees: float = Field(0.0, ge=0, le=1e7)
    trade_date: date


# Every plain `def`: the price lookups are synchronous provider calls, which
# FastAPI runs in its threadpool rather than on the event loop.


@router.get("")
def read_portfolio(username: str = Depends(caller), db: Session = Depends(get_db)) -> Dict[str, Any]:
    return portfolio.breakdown(db, username)


@router.get("/history")
def read_value_history(
    days: int = Query(portfolio.HISTORY_DEFAULT_DAYS, ge=7, le=portfolio.HISTORY_MAX_DAYS),
    username: str = Depends(caller),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """Daily portfolio value. Separate from the breakdown so a slow price
    history never holds up the numbers the page shows first."""
    return portfolio.value_history(db, username, days)


@router.post("/import")
def import_csv(body: ImportRequest, username: str = Depends(caller), db: Session = Depends(get_db)) -> Dict[str, Any]:
    parsed = portfolio.parse_csv(body.csv, body.kind)
    if parsed["kind"] == "holdings":
        if not parsed["rows"]:
            count = 0  # Don't wipe a good snapshot with an empty one.
        else:
            count = portfolio.replace_holdings(db, username, parsed["rows"], body.as_of or portfolio.utc_today())
    else:
        count = portfolio.add_transactions(db, username, parsed["rows"], replace=body.replace)
    return {
        "imported": {"kind": parsed["kind"], "count": count},
        "skipped": parsed["skipped"],
        "portfolio": portfolio.breakdown(db, username),
    }


@router.post("/transactions", status_code=201)
def add_transaction(body: TransactionRequest, username: str = Depends(caller), db: Session = Depends(get_db)) -> Dict[str, Any]:
    ticker, reason = portfolio.clean_ticker(body.ticker)
    if not ticker:
        raise HTTPException(status_code=422, detail=f"Ticker: {reason}.")
    portfolio.add_transactions(db, username, [{
        "ticker": ticker, "side": body.side, "shares": body.shares, "price": body.price,
        "fees": body.fees, "trade_date": body.trade_date,
    }])
    return portfolio.breakdown(db, username)


@router.delete("/transactions/{transaction_id}")
def delete_transaction(
    transaction_id: int = Path(..., ge=1),
    username: str = Depends(caller),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    portfolio.delete_transaction(db, username, transaction_id)
    return portfolio.breakdown(db, username)


@router.delete("/holdings")
def clear_holdings(username: str = Depends(caller), db: Session = Depends(get_db)) -> Dict[str, Any]:
    portfolio.clear(db, username, transactions=False)
    return portfolio.breakdown(db, username)


@router.delete("")
def clear_portfolio(username: str = Depends(caller), db: Session = Depends(get_db)) -> Dict[str, Any]:
    portfolio.clear(db, username)
    return portfolio.breakdown(db, username)
