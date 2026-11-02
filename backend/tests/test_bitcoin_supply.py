from datetime import date

from app.services import bitcoin_supply


def test_issued_supply_follows_halvings():
    assert bitcoin_supply.issued_supply_btc(0) == 50
    assert bitcoin_supply.issued_supply_btc(209999) == 10_500_000
    assert bitcoin_supply.issued_supply_btc(839999) == 19_687_500
    assert bitcoin_supply.issued_supply_btc(10_000_000) < 21_000_000


def test_estimated_height_hits_anchors_and_tip():
    assert bitcoin_supply.estimated_height(date(2016, 7, 9)) == 420000
    tip = (950000, date(2026, 1, 1))
    assert bitcoin_supply.estimated_height(date(2026, 1, 1), tip) == 950000
    assert 840000 < bitcoin_supply.estimated_height(date(2025, 1, 1), tip) < 950000


def test_build_supply_history_aligns_monthly_m2():
    m2 = {date(2009, 1, 1): 8000.0, date(2009, 2, 1): 8100.0}
    payload = bitcoin_supply.build_supply_history(date(2009, 3, 15), m2)
    assert [p["m2_usd"] for p in payload["points"]] == [8000e9, 8100e9, None, None]
    assert payload["m2_last"] == 8100e9
    assert payload["btc_last"] > payload["btc_first"]
