FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend code
COPY VERSION ./VERSION
COPY backend/ .
# The Castle Defense leaderboard replays runs in the game's own engine,
# and works out each day's tiers with its trial layouts.
COPY castle-defense/castleDefenseGame.js ./castle-defense/castleDefenseGame.js
COPY castle-defense/castleDefenseTrials.js ./castle-defense/castleDefenseTrials.js

# Run as an unprivileged user; give it ownership of the app and SQLite data dir.
RUN useradd --create-home --uid 10001 appuser \
    && mkdir -p /data \
    && chown -R appuser:appuser /app /data

ENV DATABASE_URL="sqlite:////data/stock_data.db"

USER appuser

EXPOSE 8000

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
