from app.services import bitcoin_tools


def test_bucket_fee_history_averages_into_six_hour_buckets():
    bucket = bitcoin_tools.FEE_HISTORY_BUCKET_SECONDS
    rates = [
        {"timestamp": bucket * 10 + 60, "avgFee_50": 1, "avgFee_90": 3},
        {"timestamp": bucket * 10 + 120, "avgFee_50": 2, "avgFee_90": 5},
        {"timestamp": bucket * 11 + 60, "avgFee_50": 4, "avgFee_90": 8},
        {"timestamp": bucket * 11 + 90, "avgFee_50": None},
    ]
    prices = [
        {"timestamp": bucket * 10 + 60, "USD": 80000},
        {"timestamp": bucket * 10 + 120, "USD": 82000},
    ]

    points = bitcoin_tools._bucket_fee_history(rates, prices)

    assert points == [
        {"t": bucket * 10, "median": 1.5, "priority": 4.0, "btc_usd": 81000.0},
        {"t": bucket * 11, "median": 4.0, "priority": 8.0, "btc_usd": None},
    ]


def test_demo_fee_history_has_thirty_days_of_points():
    payload = bitcoin_tools.get_demo_fee_history()
    assert payload["source"] == "demo"
    assert len(payload["points"]) == 120
    assert payload["median_last"] == payload["points"][-1]["median"]
