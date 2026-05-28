from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional


SATOSHIS_PER_BTC = Decimal("100000000")


def sats_to_btc(sats: int) -> float:
    return float(Decimal(sats) / SATOSHIS_PER_BTC)


def btc_to_sats(btc) -> int:
    # Accept Decimal or numeric inputs without forcing a float round-trip,
    # which loses precision past ~8 decimal places — significant for fee math.
    if isinstance(btc, Decimal):
        return int(btc * SATOSHIS_PER_BTC)
    return int(Decimal(str(btc)) * SATOSHIS_PER_BTC)


def block_subsidy_btc(height: int) -> float:
    halvings = height // 210000
    if halvings >= 64:
        return 0.0
    return float(Decimal("50") / (Decimal(2) ** halvings))


def iso_from_unix(timestamp: Optional[int]) -> Optional[str]:
    if timestamp is None:
        return None
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def fee_rate_sats_vb(btc_per_kvb: Optional[float]) -> Optional[float]:
    if btc_per_kvb is None or btc_per_kvb < 0:
        return None
    return round(btc_per_kvb * 100000, 2)
