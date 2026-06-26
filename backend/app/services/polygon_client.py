import requests
from datetime import datetime, timedelta
from typing import Optional, Dict, List
import os
import logging

logger = logging.getLogger(__name__)

class PolygonClient:
    """Polygon.io API client - primary data source"""
    
    BASE_URL = "https://api.polygon.io"
    
    def __init__(self):
        self.api_key = os.getenv("POLYGON_API_KEY")
    
    def is_configured(self) -> bool:
        return self.api_key is not None and self.api_key != ""

    def search_stocks(self, query: str, limit: int = 10) -> List[Dict]:
        """Search active stock tickers through Polygon."""
        if not self.is_configured():
            raise ValueError("Polygon API key not configured")

        query = query.upper().strip()
        if not query:
            return []

        url = f"{self.BASE_URL}/v3/reference/tickers"
        params = {
            "search": query,
            "market": "stocks",
            "active": "true",
            "sort": "ticker",
            "order": "asc",
            "limit": limit,
            "apiKey": self.api_key,
        }

        response = requests.get(url, params=params, timeout=10)
        response.raise_for_status()
        data = response.json()

        results = []
        for item in data.get("results", []):
            ticker = item.get("ticker")
            if not ticker:
                continue
            results.append({
                "ticker": ticker,
                "name": item.get("name", ticker),
                "sector": item.get("primary_exchange") or "Stocks",
            })

        return results
    
    def get_stock_data(self, ticker: str) -> Optional[Dict]:
        """Fetch complete stock data from Polygon.io"""
        if not self.is_configured():
            raise ValueError("Polygon API key not configured")
        
        ticker = ticker.upper()
        
        try:
            # 1. Get ticker details
            details = self._get_ticker_details(ticker)
            
            # 2. Get latest daily prices. This powers both the displayed price and 52-week range.
            price_history = self._get_price_history(ticker, days=365)

            # 3. Previous close is kept as a fallback if aggregates are unavailable.
            price_data = self._get_previous_close(ticker)
            if price_history:
                latest_bar = price_history[-1]
                price_data = {
                    "open": latest_bar.get("open"),
                    "high": latest_bar.get("high"),
                    "low": latest_bar.get("low"),
                    "close": latest_bar.get("close"),
                    "volume": latest_bar.get("volume"),
                }

            # 4. Get financials (quarterly)
            financials = self._get_financials(ticker)
            
            # 5. Get 52-week range from the same price series shown in the chart.
            year_high_low = self._get_range_from_price_history(price_history)
            
            # 6. Build earnings history from financials (without historical P/E initially)
            earnings = self._build_earnings_from_financials(financials, [])
            
            # 7. Calculate additional metrics
            revenue_growth = self._calculate_revenue_growth(financials)
            ttm_fcf = self._get_ttm_free_cash_flow(financials)
            
            # Calculate margins from financial data
            profit_margin = self._calculate_profit_margin(financials)
            operating_margin = self._calculate_operating_margin(financials)
            gross_margin = self._calculate_gross_margin(financials)
            ebitda_margin = self._calculate_ebitda_margin(financials)
            
            # Calculate additional valuation and health metrics
            shares_outstanding = self._get_shares_outstanding(details, financials)
            market_cap = self._get_market_cap(details, shares_outstanding, price_data)
            enterprise_value = self._calculate_ev(market_cap, financials)
            
            # Financial health metrics
            current_ratio = self._calculate_current_ratio(financials)
            quick_ratio = self._calculate_quick_ratio(financials)
            interest_coverage = self._calculate_interest_coverage(financials)
            cash = self._extract_balance_sheet(financials, "cash_and_cash_equivalents")
            working_capital = self._calculate_working_capital(financials)
            
            # Profitability metrics
            roe = self._calculate_roe(financials)
            roa = self._calculate_roa(financials)
            roic = self._calculate_roic(financials)
            
            # Calculate ratios
            ps_ratio = self._calculate_ps_ratio(market_cap, financials)
            pb_ratio = self._calculate_pb_ratio(market_cap, financials)
            ev_ebitda = self._calculate_ev_ebitda(enterprise_value, financials)
            
            return {
                "name": details.get("name", ticker),
                "ticker": ticker,
                "market_cap": market_cap,
                "current_price": price_data.get("close"),
                "pe_ratio": self._calculate_pe(details, price_data, earnings),
                "revenue_growth": revenue_growth,
                "free_cash_flow": ttm_fcf,
                "debt_to_equity": self._extract_metric(financials, "debt_to_equity"),
                "roe": roe,
                "price_52w_high": year_high_low.get("high"),
                "price_52w_low": year_high_low.get("low"),
                "profit_margin": profit_margin,
                "operating_margin": operating_margin,
                "gross_margin": gross_margin,
                "ebitda_margin": ebitda_margin,
                "roa": roa,
                "roic": roic,
                "ps_ratio": ps_ratio,
                "pb_ratio": pb_ratio,
                "ev_ebitda": ev_ebitda,
                "enterprise_value": enterprise_value,
                "shares_outstanding": shares_outstanding,
                "current_ratio": current_ratio,
                "quick_ratio": quick_ratio,
                "interest_coverage": interest_coverage,
                "cash": cash,
                "working_capital": working_capital,
                "dividend_yield": details.get("dividend_yield"),
                "beta": details.get("beta"),
                "avg_volume": price_data.get("volume"),
                "next_earnings_date": None,
                "earnings": earnings,
                "price_history": [],  # Fetched separately via /prices endpoint
                "source": "Polygon.io"
            }
            
        except Exception as e:
            logger.error(f"Polygon.io error for {ticker}: {e}")
            raise
    
    def _get_ticker_details(self, ticker: str) -> Dict:
        """Get company details"""
        url = f"{self.BASE_URL}/v3/reference/tickers/{ticker}"
        response = requests.get(url, params={"apiKey": self.api_key}, timeout=10)
        response.raise_for_status()
        data = response.json()
        
        if data.get("status") != "OK" or not data.get("results"):
            raise ValueError(f"Ticker {ticker} not found")
        
        return data["results"]
    
    def _get_previous_close(self, ticker: str) -> Dict:
        """Get previous day's close price"""
        url = f"{self.BASE_URL}/v2/aggs/ticker/{ticker}/prev"
        response = requests.get(url, params={"apiKey": self.api_key}, timeout=10)
        response.raise_for_status()
        data = response.json()
        
        if data.get("results") and len(data["results"]) > 0:
            result = data["results"][0]
            return {
                "open": result.get("o"),
                "high": result.get("h"),
                "low": result.get("l"),
                "close": result.get("c"),
                "volume": result.get("v")
            }
        return {}
    
    def _get_financials(self, ticker: str) -> List[Dict]:
        """Get quarterly financial statements"""
        url = f"{self.BASE_URL}/vX/reference/financials"
        params = {
            "ticker": ticker,
            "timeframe": "quarterly",
            "order": "desc",
            "limit": 12,
            "apiKey": self.api_key
        }
        response = requests.get(url, params=params, timeout=10)
        response.raise_for_status()
        data = response.json()
        
        return data.get("results", [])
    
    def _get_price_history(self, ticker: str, days: int = 365) -> List[Dict]:
        """Get daily price history for the specified number of days"""
        try:
            end_date = datetime.now()
            start_date = end_date - timedelta(days=days)
            
            url = f"{self.BASE_URL}/v2/aggs/ticker/{ticker}/range/1/day/{start_date.strftime('%Y-%m-%d')}/{end_date.strftime('%Y-%m-%d')}"
            params = {
                "adjusted": "true",
                "sort": "asc",
                "apiKey": self.api_key
            }
            
            response = requests.get(url, params=params, timeout=15)
            response.raise_for_status()
            data = response.json()
            
            if data.get("results"):
                # Return simplified price data
                return [
                    {
                        "date": datetime.fromtimestamp(r["t"] / 1000).strftime("%Y-%m-%d"),
                        "open": r.get("o"),
                        "high": r.get("h"),
                        "low": r.get("l"),
                        "close": r.get("c"),
                        "volume": r.get("v")
                    }
                    for r in data["results"]
                    if r.get("c")  # Only include if we have a close price
                ]
            return []
        except Exception as e:
            logger.warning(f"Could not fetch price history for {ticker}: {e}")
            return []

    def _get_range_from_price_history(self, price_history: List[Dict]) -> Dict:
        """Calculate high/low from the returned aggregate price series."""
        highs = [p.get("high") for p in price_history if p.get("high") is not None]
        lows = [p.get("low") for p in price_history if p.get("low") is not None]
        return {
            "high": max(highs) if highs else None,
            "low": min(lows) if lows else None,
        }

    def _statement_value(self, statement: Dict, keys: List[str]) -> Optional[float]:
        """Extract a numeric value from a Polygon financial statement section."""
        for key in keys:
            item = statement.get(key)
            value = item.get("value") if isinstance(item, dict) else item
            if value is not None:
                try:
                    return float(value)
                except (TypeError, ValueError):
                    continue
        return None

    def _ttm_statement_sum(self, financials: List[Dict], section: str, keys: List[str]) -> Optional[float]:
        """Sum a financial statement field across the latest four quarters."""
        values = []
        for fin in financials[:4]:
            statement = fin.get("financials", {}).get(section, {}) or {}
            value = self._statement_value(statement, keys)
            if value is not None:
                values.append(value)

        if not values:
            return None
        return sum(values)

    def _calculate_free_cash_flow(self, financials_data: Dict) -> Optional[float]:
        """Calculate FCF as operating cash flow less capex when FCF is absent."""
        cash_flow = financials_data.get("cash_flow_statement", {}) or {}

        direct_fcf = self._statement_value(cash_flow, ["free_cash_flow"])
        if direct_fcf is not None:
            return direct_fcf

        operating_cash_flow = self._statement_value(cash_flow, [
            "net_cash_flow_from_operating_activities",
            "net_cash_flow_from_operating_activities_continuing",
            "operating_cash_flow",
        ])
        capex = self._statement_value(cash_flow, [
            "capital_expenditures",
            "payments_to_acquire_property_plant_and_equipment",
            "payments_to_acquire_productive_assets",
        ])

        if operating_cash_flow is None:
            return None
        if capex is None:
            return operating_cash_flow

        return operating_cash_flow + capex if capex < 0 else operating_cash_flow - capex

    def _get_ttm_free_cash_flow(self, financials: List[Dict]) -> Optional[float]:
        values = []
        for fin in financials[:4]:
            value = self._calculate_free_cash_flow(fin.get("financials", {}) or {})
            if value is not None:
                values.append(value)

        if not values:
            return None
        return sum(values)

    def _get_total_debt(self, balance: Dict) -> Optional[float]:
        direct_debt = self._statement_value(balance, ["total_debt"])
        if direct_debt is not None:
            return direct_debt

        debt_parts = []
        for key in ["long_term_debt", "short_term_debt", "current_debt"]:
            value = self._statement_value(balance, [key])
            if value is not None:
                debt_parts.append(value)

        if debt_parts:
            return sum(debt_parts)

        return self._statement_value(balance, ["liabilities", "total_liabilities"])

    def _get_market_cap(
        self,
        details: Dict,
        shares_outstanding: Optional[float],
        price_data: Dict,
    ) -> Optional[float]:
        market_cap = details.get("market_cap")
        if market_cap:
            return float(market_cap)

        price = price_data.get("close")
        if shares_outstanding and price:
            return float(shares_outstanding) * float(price)

        return None
    
    def _build_earnings_from_financials(self, financials: List[Dict], price_history: List[Dict] = None) -> List[Dict]:
        """Build earnings records from financial statements"""
        earnings = []
        
        for i, fin in enumerate(financials[:8]):  # Last 8 quarters
            try:
                fiscal_date = fin.get("filing_date") or fin.get("period_of_report_date") or fin.get("end_date")
                if not fiscal_date:
                    continue
                
                # Extract financial data with multiple field name possibilities
                financials_data = fin.get("financials", {})
                income = financials_data.get("income_statement", {}) or {}
                balance = financials_data.get("balance_sheet", {}) or {}
                cash_flow = financials_data.get("cash_flow_statement", {}) or {}
                
                # Get revenue with multiple possible field names
                revenue = None
                for rev_key in ["revenues", "total_revenue", "revenue"]:
                    rev_data = income.get(rev_key)
                    if isinstance(rev_data, dict):
                        revenue = rev_data.get("value")
                    elif rev_data is not None:
                        revenue = rev_data
                    if revenue is not None:
                        break
                
                # Get EPS directly from income statement (Polygon provides this!)
                eps = None
                for eps_key in ["basic_earnings_per_share", "diluted_earnings_per_share", "earnings_per_share"]:
                    eps_data = income.get(eps_key)
                    if isinstance(eps_data, dict):
                        eps = eps_data.get("value")
                    elif eps_data is not None:
                        eps = eps_data
                    if eps is not None:
                        break
                
                fcf = self._calculate_free_cash_flow(financials_data)
                
                fiscal_period = fin.get("fiscal_period") or fin.get("period")
                fiscal_quarter = None
                if isinstance(fiscal_period, str) and fiscal_period.upper().startswith("Q"):
                    fiscal_quarter = fiscal_period.upper().removeprefix("Q")

                earnings.append({
                    "fiscal_date": fiscal_date,
                    "period": fiscal_period.upper() if fiscal_quarter else self._get_quarter_from_date(fiscal_date),
                    "fiscal_year": fin.get("fiscal_year"),
                    "fiscal_quarter": fiscal_quarter,
                    "reported_eps": eps,
                    "estimated_eps": None,
                    "surprise_pct": None,
                    "revenue": revenue,
                    "free_cash_flow": fcf,
                    "pe_ratio": None,  # Will be calculated after we have all earnings
                    "price": None
                })
            except Exception as e:
                logger.warning(f"Error processing financial {i}: {e}")
                continue
        
        # Note: Historical P/E calculation requires price data which is fetched separately
        # to avoid rate limits. The frontend can calculate P/E using the /prices endpoint.
        
        return earnings
    
    def _calculate_pe(self, details: Dict, price_data: Dict, earnings: List[Dict]) -> Optional[float]:
        """Calculate P/E ratio from price and TTM earnings"""
        try:
            price = price_data.get("close")
            if not price:
                logger.warning("No price available for P/E calculation")
                return None
            
            # Calculate TTM EPS from earnings records
            if earnings and len(earnings) >= 4:
                total_eps = 0
                quarters_with_eps = 0
                
                for i, e in enumerate(earnings[:4]):  # Last 4 quarters
                    eps = e.get("reported_eps")
                    logger.info(f"Q{i}: reported_eps={eps}")
                    
                    if eps and eps > 0:
                        total_eps += eps
                        quarters_with_eps += 1
                
                logger.info(f"Total TTM EPS: {total_eps} from {quarters_with_eps} quarters, price={price}")
                if quarters_with_eps >= 3 and total_eps > 0:  # Allow 3+ quarters for recent IPOs
                    pe = round(price / total_eps, 2)
                    logger.info(f"Calculated P/E: {pe}")
                    return pe
            else:
                logger.warning(f"Not enough earnings: {len(earnings) if earnings else 0}")
                    
        except Exception as e:
            logger.warning(f"Could not calculate P/E: {e}")
        return None
    
    def _calculate_revenue_growth(self, financials: List[Dict]) -> Optional[float]:
        """Calculate YoY revenue growth rate (%)"""
        try:
            if len(financials) < 5:
                return None

            # Get latest quarter revenue
            latest = financials[0].get("financials", {}).get("income_statement", {}).get("revenues", {})
            latest_rev = latest.get("value") if isinstance(latest, dict) else None

            # Get same quarter last year (4 quarters back)
            year_ago = financials[4].get("financials", {}).get("income_statement", {}).get("revenues", {})
            year_ago_rev = year_ago.get("value") if isinstance(year_ago, dict) else None

            # Distinguish "no data" (None) from "zero revenue" — a legitimate
            # zero shouldn't be silently treated as missing data.
            if latest_rev is None or year_ago_rev is None or year_ago_rev <= 0:
                return None
            growth = ((latest_rev - year_ago_rev) / year_ago_rev) * 100
            return round(growth, 2)
        except Exception as e:
            logger.warning(f"Could not calculate revenue growth: {e}")
        return None
    
    def _extract_metric(self, financials: List[Dict], metric_name: str) -> Optional[float]:
        """Extract a metric from most recent financial statement"""
        if not financials:
            return None
        
        try:
            fin = financials[0]
            financials_data = fin.get("financials", {})
            
            # Try different possible field names based on Polygon's schema
            metric_map = {
                "profit_margin": [
                    ("income_statement", "net_profit_margin"),
                    ("income_statement", "profit_margin"),
                ],
                "operating_margin": [
                    ("income_statement", "operating_income_margin"),
                    ("income_statement", "operating_margin"),
                ],
                "return_on_equity": [
                    ("financial_metrics", "return_on_equity"),
                    ("financial_metrics", "roe"),
                ],
                "debt_to_equity": [
                    ("financial_metrics", "debt_to_equity_ratio"),
                    ("financial_metrics", "debt_equity_ratio"),
                ]
            }
            
            if metric_name in metric_map:
                for section, key in metric_map[metric_name]:
                    try:
                        section_data = financials_data.get(section, {})
                        if isinstance(section_data, dict):
                            value_data = section_data.get(key)
                            if isinstance(value_data, dict):
                                value = value_data.get("value")
                            else:
                                value = value_data
                            if value is not None:
                                return float(value)
                    except Exception:
                        continue
            
            # Calculate ROE and Debt-to-Equity from balance sheet if not found
            if metric_name == "return_on_equity":
                return self._calculate_roe([fin])
            elif metric_name == "debt_to_equity":
                return self._calculate_debt_to_equity(financials_data)
                
        except Exception as e:
            logger.warning(f"Error extracting metric {metric_name}: {e}")
        
        return None
    
    def _calculate_roe(self, financials: List[Dict]) -> Optional[float]:
        """Calculate ROE = TTM Net Income / Shareholder Equity."""
        try:
            if not financials:
                return None

            net_income = self._ttm_statement_sum(financials, "income_statement", [
                "net_income_loss",
                "net_income",
                "net_income_loss_attributable_to_parent",
            ])
            balance = financials[0].get("financials", {}).get("balance_sheet", {}) or {}
            equity = self._statement_value(balance, [
                "equity",
                "equity_attributable_to_parent",
                "stockholders_equity",
            ])

            if net_income is not None and equity and equity > 0:
                roe = (net_income / equity) * 100
                return round(roe, 2)
        except Exception as e:
            logger.warning(f"Could not calculate ROE: {e}")
        return None
    
    def _calculate_debt_to_equity(self, financials_data: Dict) -> Optional[float]:
        """Calculate Debt-to-Equity = Total Liabilities / Shareholder Equity"""
        try:
            balance = financials_data.get("balance_sheet", {})
            
            debt = self._get_total_debt(balance)
            equity = self._statement_value(balance, [
                "equity",
                "equity_attributable_to_parent",
                "stockholders_equity",
            ])
            
            if debt is not None and equity and equity > 0:
                dte = debt / equity
                return round(dte, 2)
        except Exception as e:
            logger.warning(f"Could not calculate D/E: {e}")
        return None
    
    def _calculate_profit_margin(self, financials: List[Dict]) -> Optional[float]:
        """Calculate TTM profit margin: Net Income / Revenue * 100"""
        try:
            if not financials:
                return None

            net_income = self._ttm_statement_sum(financials, "income_statement", [
                "net_income_loss",
                "net_income",
                "net_income_loss_attributable_to_parent",
            ])
            revenue = self._ttm_statement_sum(financials, "income_statement", [
                "revenues",
                "total_revenue",
                "revenue",
            ])
            
            if net_income is not None and revenue and revenue > 0:
                margin = (net_income / revenue) * 100
                return round(margin, 2)
        except Exception as e:
            logger.warning(f"Could not calculate profit margin: {e}")
        return None
    
    def _calculate_operating_margin(self, financials: List[Dict]) -> Optional[float]:
        """Calculate TTM operating margin: Operating Income / Revenue * 100"""
        try:
            if not financials:
                return None

            op_income = self._ttm_statement_sum(financials, "income_statement", [
                "operating_income_loss",
                "operating_income",
            ])
            revenue = self._ttm_statement_sum(financials, "income_statement", [
                "revenues",
                "total_revenue",
                "revenue",
            ])
            
            if op_income is not None and revenue and revenue > 0:
                margin = (op_income / revenue) * 100
                return round(margin, 2)
        except Exception as e:
            logger.warning(f"Could not calculate operating margin: {e}")
        return None
    
    def _get_quarter_from_date(self, date_str: str) -> str:
        """Extract quarter from date string"""
        try:
            if isinstance(date_str, str):
                date = datetime.fromisoformat(date_str.replace('Z', '+00:00'))
            else:
                date = date_str
            
            month = date.month
            if month <= 3:
                return "Q1"
            elif month <= 6:
                return "Q2"
            elif month <= 9:
                return "Q3"
            else:
                return "Q4"
        except Exception:
            return "Q"
    
    # ==================== NEW CALCULATION METHODS ====================
    
    def _calculate_gross_margin(self, financials: List[Dict]) -> Optional[float]:
        """Calculate TTM gross margin: Gross Profit / Revenue * 100"""
        try:
            if not financials:
                return None

            gross_profit = self._ttm_statement_sum(financials, "income_statement", [
                "gross_profit",
                "gross_profit_loss",
            ])
            revenue = self._ttm_statement_sum(financials, "income_statement", [
                "revenues",
                "total_revenue",
                "revenue",
            ])
            
            if gross_profit is not None and revenue and revenue > 0:
                margin = (gross_profit / revenue) * 100
                return round(margin, 2)
        except Exception as e:
            logger.warning(f"Could not calculate gross margin: {e}")
        return None
    
    def _calculate_ebitda_margin(self, financials: List[Dict]) -> Optional[float]:
        """Calculate TTM EBITDA margin: EBITDA / Revenue * 100"""
        try:
            if not financials:
                return None

            ebitda = self._ttm_statement_sum(financials, "income_statement", ["ebitda", "EBITDA"])
            revenue = self._ttm_statement_sum(financials, "income_statement", [
                "revenues",
                "total_revenue",
                "revenue",
            ])
            
            if ebitda is not None and revenue and revenue > 0:
                margin = (ebitda / revenue) * 100
                return round(margin, 2)
        except Exception as e:
            logger.warning(f"Could not calculate EBITDA margin: {e}")
        return None
    
    def _calculate_roa(self, financials: List[Dict]) -> Optional[float]:
        """Calculate ROA = TTM Net Income / Total Assets * 100"""
        try:
            if not financials:
                return None

            net_income = self._ttm_statement_sum(financials, "income_statement", [
                "net_income_loss",
                "net_income",
                "net_income_loss_attributable_to_parent",
            ])
            balance = financials[0].get("financials", {}).get("balance_sheet", {}) or {}
            assets = self._statement_value(balance, ["assets", "total_assets"])
            
            if net_income is not None and assets and assets > 0:
                roa = (net_income / assets) * 100
                return round(roa, 2)
        except Exception as e:
            logger.warning(f"Could not calculate ROA: {e}")
        return None
    
    def _calculate_roic(self, financials: List[Dict]) -> Optional[float]:
        """Calculate ROIC = TTM operating income / invested capital * 100"""
        try:
            if not financials:
                return None

            operating_income = self._ttm_statement_sum(financials, "income_statement", [
                "operating_income_loss",
                "operating_income",
            ])
            balance = financials[0].get("financials", {}).get("balance_sheet", {}) or {}
            equity = self._statement_value(balance, [
                "equity",
                "equity_attributable_to_parent",
                "stockholders_equity",
            ])
            debt = self._get_total_debt(balance) or 0
            cash = self._statement_value(balance, ["cash_and_cash_equivalents", "cash"]) or 0
            
            if operating_income is not None and equity is not None:
                invested_capital = equity + debt - cash
                
                if invested_capital > 0:
                    roic = (operating_income / invested_capital) * 100
                    return round(roic, 2)
        except Exception as e:
            logger.warning(f"Could not calculate ROIC: {e}")
        return None
    
    def _calculate_current_ratio(self, financials: List[Dict]) -> Optional[float]:
        """Calculate current ratio: Current Assets / Current Liabilities"""
        try:
            if not financials:
                return None
            
            fin = financials[0].get("financials", {})
            balance = fin.get("balance_sheet", {})
            
            # Get current assets
            current_assets = None
            for key in ["current_assets", "total_current_assets"]:
                ca_data = balance.get(key)
                if isinstance(ca_data, dict):
                    current_assets = ca_data.get("value")
                elif ca_data is not None:
                    current_assets = ca_data
                if current_assets is not None:
                    break
            
            # Get current liabilities
            current_liabilities = None
            for key in ["current_liabilities", "total_current_liabilities"]:
                cl_data = balance.get(key)
                if isinstance(cl_data, dict):
                    current_liabilities = cl_data.get("value")
                elif cl_data is not None:
                    current_liabilities = cl_data
                if current_liabilities is not None:
                    break
            
            if current_assets is not None and current_liabilities and current_liabilities > 0:
                ratio = current_assets / current_liabilities
                return round(ratio, 2)
        except Exception as e:
            logger.warning(f"Could not calculate current ratio: {e}")
        return None
    
    def _calculate_quick_ratio(self, financials: List[Dict]) -> Optional[float]:
        """Calculate quick ratio: (Current Assets - Inventory) / Current Liabilities"""
        try:
            if not financials:
                return None
            
            fin = financials[0].get("financials", {})
            balance = fin.get("balance_sheet", {})
            
            # Get current assets
            current_assets = None
            for key in ["current_assets", "total_current_assets"]:
                ca_data = balance.get(key)
                if isinstance(ca_data, dict):
                    current_assets = ca_data.get("value")
                elif ca_data is not None:
                    current_assets = ca_data
                if current_assets is not None:
                    break
            
            # Get inventory
            inventory = None
            for key in ["inventory", "inventories"]:
                inv_data = balance.get(key)
                if isinstance(inv_data, dict):
                    inventory = inv_data.get("value")
                elif inv_data is not None:
                    inventory = inv_data
                if inventory is not None:
                    break
            
            # Get current liabilities
            current_liabilities = None
            for key in ["current_liabilities", "total_current_liabilities"]:
                cl_data = balance.get(key)
                if isinstance(cl_data, dict):
                    current_liabilities = cl_data.get("value")
                elif cl_data is not None:
                    current_liabilities = cl_data
                if current_liabilities is not None:
                    break
            
            if current_assets is not None and current_liabilities and current_liabilities > 0:
                quick_assets = current_assets - (inventory or 0)
                ratio = quick_assets / current_liabilities
                return round(ratio, 2)
        except Exception as e:
            logger.warning(f"Could not calculate quick ratio: {e}")
        return None
    
    def _calculate_interest_coverage(self, financials: List[Dict]) -> Optional[float]:
        """Calculate interest coverage: EBIT / Interest Expense"""
        try:
            if not financials:
                return None
            
            fin = financials[0].get("financials", {})
            income = fin.get("income_statement", {})
            
            # Get EBIT (operating income)
            ebit = None
            for key in ["operating_income_loss", "operating_income", "ebit"]:
                ebit_data = income.get(key)
                if isinstance(ebit_data, dict):
                    ebit = ebit_data.get("value")
                elif ebit_data is not None:
                    ebit = ebit_data
                if ebit is not None:
                    break
            
            # Get interest expense
            interest_expense = None
            for key in ["interest_expense", "interest_expense_operating"]:
                int_data = income.get(key)
                if isinstance(int_data, dict):
                    interest_expense = int_data.get("value")
                elif int_data is not None:
                    interest_expense = int_data
                if interest_expense is not None:
                    break
            
            if ebit is not None and interest_expense and interest_expense > 0:
                coverage = ebit / interest_expense
                return round(coverage, 2)
        except Exception as e:
            logger.warning(f"Could not calculate interest coverage: {e}")
        return None
    
    def _calculate_working_capital(self, financials: List[Dict]) -> Optional[float]:
        """Calculate working capital: Current Assets - Current Liabilities"""
        try:
            if not financials:
                return None
            
            fin = financials[0].get("financials", {})
            balance = fin.get("balance_sheet", {})
            
            # Get current assets
            current_assets = None
            for key in ["current_assets", "total_current_assets"]:
                ca_data = balance.get(key)
                if isinstance(ca_data, dict):
                    current_assets = ca_data.get("value")
                elif ca_data is not None:
                    current_assets = ca_data
                if current_assets is not None:
                    break
            
            # Get current liabilities
            current_liabilities = None
            for key in ["current_liabilities", "total_current_liabilities"]:
                cl_data = balance.get(key)
                if isinstance(cl_data, dict):
                    current_liabilities = cl_data.get("value")
                elif cl_data is not None:
                    current_liabilities = cl_data
                if current_liabilities is not None:
                    break
            
            if current_assets is not None and current_liabilities is not None:
                return current_assets - current_liabilities
        except Exception as e:
            logger.warning(f"Could not calculate working capital: {e}")
        return None
    
    def _extract_balance_sheet(self, financials: List[Dict], field: str) -> Optional[float]:
        """Extract a field from the balance sheet"""
        if not financials:
            return None
        
        try:
            fin = financials[0].get("financials", {})
            balance = fin.get("balance_sheet", {})
            
            data = balance.get(field)
            if isinstance(data, dict):
                return data.get("value")
            elif data is not None:
                return float(data)
        except Exception as e:
            logger.warning(f"Error extracting {field}: {e}")
        return None
    
    def _get_shares_outstanding(self, details: Dict, financials: List[Dict]) -> Optional[float]:
        """Get shares outstanding from ticker details or financials"""
        # Try details first
        shares = details.get("weighted_shares_outstanding") or details.get("shares_outstanding")
        if shares:
            return float(shares)
        
        # Try financials
        if financials:
            fin = financials[0].get("financials", {})
            balance = fin.get("balance_sheet", {})
            
            for key in ["shares_outstanding", "common_stock_shares_outstanding"]:
                data = balance.get(key)
                if isinstance(data, dict):
                    return data.get("value")
                elif data is not None:
                    return float(data)
        return None
    
    def _calculate_ev(self, market_cap: Optional[float], financials: List[Dict]) -> Optional[float]:
        """Calculate Enterprise Value: Market Cap + Debt - Cash"""
        try:
            if not market_cap:
                return None
            
            if financials:
                balance = financials[0].get("financials", {}).get("balance_sheet", {}) or {}
                debt = self._get_total_debt(balance) or 0
                cash = self._statement_value(balance, ["cash_and_cash_equivalents", "cash"]) or 0
                
                return market_cap + debt - cash
        except Exception as e:
            logger.warning(f"Could not calculate EV: {e}")
        return None
    
    def _calculate_ps_ratio(self, market_cap: Optional[float], financials: List[Dict]) -> Optional[float]:
        """Calculate P/S ratio: Market Cap / TTM Revenue"""
        try:
            if not market_cap:
                return None
            
            revenue = self._ttm_statement_sum(financials, "income_statement", [
                "revenues",
                "total_revenue",
                "revenue",
            ])
            if revenue and revenue > 0:
                return round(market_cap / revenue, 2)
        except Exception as e:
            logger.warning(f"Could not calculate P/S ratio: {e}")
        return None
    
    def _calculate_pb_ratio(self, market_cap: Optional[float], financials: List[Dict]) -> Optional[float]:
        """Calculate P/B ratio: Market Cap / Book Value"""
        try:
            if not market_cap:
                return None
            
            if financials:
                balance = financials[0].get("financials", {}).get("balance_sheet", {}) or {}
                book_value = self._statement_value(balance, [
                    "equity",
                    "equity_attributable_to_parent",
                    "stockholders_equity",
                ])
                if book_value and book_value > 0:
                    return round(market_cap / book_value, 2)
        except Exception as e:
            logger.warning(f"Could not calculate P/B ratio: {e}")
        return None
    
    def _calculate_ev_ebitda(self, ev: Optional[float], financials: List[Dict]) -> Optional[float]:
        """Calculate EV/EBITDA ratio"""
        try:
            if not ev or not financials:
                return None
            
            ebitda = self._ttm_statement_sum(financials, "income_statement", ["ebitda", "EBITDA"])
            if ebitda is not None and ebitda > 0:
                return round(ev / ebitda, 2)
        except Exception as e:
            logger.warning(f"Could not calculate EV/EBITDA: {e}")
        return None

# Singleton instance
polygon_client = PolygonClient()
