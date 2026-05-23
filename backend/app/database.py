from sqlalchemy import create_engine, Column, String, Float, Date, DateTime, Integer, LargeBinary
from sqlalchemy.orm import declarative_base
from sqlalchemy.orm import sessionmaker
from datetime import datetime, timezone

import os

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./stock_data.db")

# Check if using PostgreSQL
is_postgres = DATABASE_URL.startswith("postgres://") or DATABASE_URL.startswith("postgresql://")

if is_postgres:
    # PostgreSQL config - no special connect args needed
    engine = create_engine(
        DATABASE_URL,
        pool_pre_ping=True,  # Verify connections before using
        pool_recycle=300,    # Recycle connections after 5 minutes
    )
else:
    # SQLite config for local dev
    engine = create_engine(
        DATABASE_URL, 
        connect_args={"check_same_thread": False}
    )
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def utc_now():
    return datetime.now(timezone.utc).replace(tzinfo=None)

class EarningsRecord(Base):
    __tablename__ = "earnings"
    
    id = Column(Integer, primary_key=True, index=True)
    ticker = Column(String, index=True)
    fiscal_date = Column(Date)
    period = Column(String)  # Q1, Q2, Q3, Q4, FY
    reported_eps = Column(Float, nullable=True)
    estimated_eps = Column(Float, nullable=True)
    surprise_pct = Column(Float, nullable=True)
    revenue = Column(Float, nullable=True)
    free_cash_flow = Column(Float, nullable=True)
    pe_ratio = Column(Float, nullable=True)  # Historical P/E at time of earnings
    price = Column(Float, nullable=True)  # Stock price at time of earnings
    fetched_at = Column(DateTime, default=utc_now)

class StockSummary(Base):
    __tablename__ = "stock_summaries"
    
    id = Column(Integer, primary_key=True, index=True)
    ticker = Column(String, index=True, unique=True)
    name = Column(String)
    market_cap = Column(Float, nullable=True)
    pe_ratio = Column(Float, nullable=True)
    next_earnings_date = Column(Date, nullable=True)
    # Additional metrics
    profit_margin = Column(Float, nullable=True)
    operating_margin = Column(Float, nullable=True)
    roe = Column(Float, nullable=True)
    debt_to_equity = Column(Float, nullable=True)
    dividend_yield = Column(Float, nullable=True)
    beta = Column(Float, nullable=True)
    price_52w_high = Column(Float, nullable=True)
    price_52w_low = Column(Float, nullable=True)
    current_price = Column(Float, nullable=True)
    # Key overview metrics
    revenue_growth = Column(Float, nullable=True)
    free_cash_flow = Column(Float, nullable=True)
    # Additional valuation metrics
    ps_ratio = Column(Float, nullable=True)
    pb_ratio = Column(Float, nullable=True)
    ev_ebitda = Column(Float, nullable=True)
    enterprise_value = Column(Float, nullable=True)
    shares_outstanding = Column(Float, nullable=True)
    # Profitability metrics
    gross_margin = Column(Float, nullable=True)
    ebitda_margin = Column(Float, nullable=True)
    roa = Column(Float, nullable=True)
    roic = Column(Float, nullable=True)
    # Financial health metrics
    current_ratio = Column(Float, nullable=True)
    quick_ratio = Column(Float, nullable=True)
    interest_coverage = Column(Float, nullable=True)
    cash = Column(Float, nullable=True)
    working_capital = Column(Float, nullable=True)
    # Market data
    avg_volume = Column(Float, nullable=True)
    fetched_at = Column(DateTime, default=utc_now)

class LogEntry(Base):
    __tablename__ = "logs"

    id = Column(Integer, primary_key=True, index=True)
    timestamp = Column(DateTime, default=utc_now, index=True)
    level = Column(String, index=True)  # DEBUG, INFO, WARNING, ERROR, CRITICAL
    logger_name = Column(String, nullable=True)
    message = Column(String)
    path = Column(String, nullable=True)  # request path if HTTP
    status_code = Column(Integer, nullable=True)
    method = Column(String, nullable=True)


class PokerGameState(Base):
    __tablename__ = "poker_game_states"

    game_id = Column(String, primary_key=True, index=True)
    payload = Column(LargeBinary, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, index=True)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def init_db():
    Base.metadata.create_all(bind=engine)
