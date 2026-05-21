from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session
from app.database import get_db
from app.services.stock_data_client import stock_data_client
from app.services.stock_data import search_stocks

router = APIRouter(prefix="/api/stocks", tags=["stocks"])
DEMO_STOCK_WARNING = (
    "Public demo mode uses generated sample stock data and does not call live market data providers."
)


def is_demo_request(request: Request) -> bool:
    return bool(getattr(request.state, "demo_mode", False))


def mark_demo(data):
    if isinstance(data, dict):
        data["_demo"] = True
        data.setdefault("_warning", DEMO_STOCK_WARNING)
    return data


def stock_error_status(error: Exception) -> int:
    message = str(error)
    if "POLYGON_API_KEY" in message or message.startswith("Real "):
        return 503
    return 404


@router.get("/search")
async def search_stocks_endpoint(
    request: Request,
    q: str = Query(..., min_length=1),
    limit: int = 10,
):
    """Search stocks by ticker or company name"""
    try:
        if is_demo_request(request) or stock_data_client._use_mock():
            results = stock_data_client.mock.search_stocks(q, limit)
        else:
            stock_data_client._require_real_data_configured()
            try:
                results = stock_data_client.polygon.search_stocks(q, limit)
            except Exception as exc:
                raise RuntimeError(f"Real stock search unavailable: {exc}") from exc
            if not results:
                results = search_stocks(q, limit)
        response = {"results": results, "query": q}
        if is_demo_request(request):
            response["demo"] = True
            response["warning"] = DEMO_STOCK_WARNING
        return response
    except Exception as e:
        status = stock_error_status(e)
        detail = (
            "Stock data temporarily unavailable"
            if status == 503
            else f"No results found for '{q}'"
        )
        raise HTTPException(status_code=status, detail=detail)


@router.get("/{ticker}/earnings")
async def get_earnings(request: Request, ticker: str, db: Session = Depends(get_db)):
    """Get earnings data for a ticker"""
    try:
        data = (
            stock_data_client.mock.get_stock_data(ticker)
            if is_demo_request(request)
            else stock_data_client.get_stock_data(ticker, db)
        )
        if is_demo_request(request):
            mark_demo(data)
        return {"ticker": ticker, "earnings": data["earnings"]}
    except Exception as e:
        status = stock_error_status(e)
        detail = (
            "Stock data temporarily unavailable"
            if status == 503
            else f"Earnings data not found for '{ticker}'"
        )
        raise HTTPException(status_code=status, detail=detail)


@router.get("/{ticker}/prices")
async def get_price_history(request: Request, ticker: str, days: int = 365):
    """Get daily price history for a ticker"""
    try:
        price_history = (
            stock_data_client.mock.get_price_history(ticker, days=days)
            if is_demo_request(request)
            else stock_data_client.get_price_history(ticker, days=days)
        )
        response = {
            "ticker": ticker.upper(),
            "days": days,
            "count": len(price_history),
            "prices": price_history
        }
        if is_demo_request(request):
            response["demo"] = True
            response["warning"] = DEMO_STOCK_WARNING
        return response
    except Exception as e:
        status = stock_error_status(e)
        detail = (
            "Stock data temporarily unavailable"
            if status == 503
            else f"Price history not found for '{ticker}'"
        )
        raise HTTPException(status_code=status, detail=detail)


@router.get("/{ticker}")
async def get_stock(request: Request, ticker: str, refresh: bool = False, db: Session = Depends(get_db)):
    """Get stock data including earnings and summary"""
    try:
        data = (
            stock_data_client.mock.get_stock_data(ticker)
            if is_demo_request(request)
            else stock_data_client.get_stock_data(ticker, db, force_refresh=refresh)
        )
        if is_demo_request(request):
            mark_demo(data)
        return data
    except Exception as e:
        raise HTTPException(
            status_code=stock_error_status(e),
            detail=f"Could not fetch data for {ticker}: {str(e)}",
        )
