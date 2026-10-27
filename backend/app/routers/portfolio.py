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
    ticker: str = Field(..., min_length=1, max_length=60)
    side: str = Field(..., pattern="^(buy|sell)$")
    shares: float = Field(..., gt=0, le=1e9)
    price: float = Field(..., ge=0, le=1e7)
    fees: float = Field(0.0, ge=0, le=1e7)
    trade_date: date
    account: Optional[str] = Field(None, max_length=120)


# Every plain `def`: the price lookups are synchronous provider calls, which
# FastAPI runs in its threadpool rather than on the event loop.


@router.get("")
def read_portfolio(username: str = Depends(caller), db: Session = Depends(get_db)) -> Dict[str, Any]:
    return portfolio.breakdown(db, username)


@router.get("/history")
def read_value_history(username: str = Depends(caller), db: Session = Depends(get_db)) -> Dict[str, Any]:
    """Daily portfolio value and cost basis since the first trade. Separate
    from the breakdown so a slow price history never holds up the numbers
    the page shows first."""
    return portfolio.value_history(db, username)


@router.get("/transactions")
def read_transactions(
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=portfolio.TRADE_PAGE_MAX),
    q: str = Query("", max_length=60),
    side: str = Query("", pattern="^(|buy|sell)$"),
    account: str = Query("", max_length=120),
    source: str = Query("", max_length=120),
    year: Optional[int] = Query(None, ge=1900, le=2200),
    asset: str = Query("", pattern="^(|stock|crypto|other)$"),
    username: str = Depends(caller),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    return portfolio.list_transactions(
        db, username, offset=offset, limit=limit, q=q, side=side, account=account,
        source=source, year=year, asset=asset,
    )


@router.post("/import")
def import_csv(body: ImportRequest, username: str = Depends(caller), db: Session = Depends(get_db)) -> Dict[str, Any]:
    parsed = portfolio.parse_csv(body.csv, body.kind)
    result = {"added": 0, "duplicates": 0, "removedSample": 0}
    if parsed["kind"] == "holdings":
        if parsed["rows"]:  # Don't wipe a good snapshot with an empty one.
            result["added"] = portfolio.replace_holdings(db, username, parsed["rows"], body.as_of or portfolio.utc_today())
    else:
        result = portfolio.add_transactions(db, username, parsed["rows"], replace=body.replace)
    return {
        "imported": {"kind": parsed["kind"], "count": result["added"], **result},
        "skipped": parsed["skipped"],
        "portfolio": portfolio.breakdown(db, username),
    }


@router.post("/transactions", status_code=201)
def add_transaction(body: TransactionRequest, username: str = Depends(caller), db: Session = Depends(get_db)) -> Dict[str, Any]:
    ticker, asset, reason = portfolio.classify_security(body.ticker, body.account or "")
    if not ticker:
        raise HTTPException(status_code=422, detail=f"Ticker: {reason}.")
    # By hand, a second identical trade is meant: no duplicate check.
    portfolio.add_transactions(db, username, [{
        "ticker": ticker, "asset": asset, "side": body.side, "shares": body.shares, "price": body.price,
        "fees": body.fees, "trade_date": body.trade_date, "account": body.account, "source": "Added by hand",
    }], upload=False)
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
