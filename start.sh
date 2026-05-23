#!/bin/bash

echo "Starting Palmer Gill local site..."

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$ROOT_DIR/logs"
VENV_DIR="$ROOT_DIR/backend/venv"
mkdir -p "$LOG_DIR"

find_python() {
    for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
        if command -v "$candidate" >/dev/null 2>&1; then
            if "$candidate" - <<'PY' >/dev/null 2>&1
import sys
raise SystemExit(0 if sys.version_info >= (3, 10) else 1)
PY
            then
                command -v "$candidate"
                return 0
            fi
        fi
    done
    return 1
}

PYTHON_BIN="$(find_python)"
if [ -z "$PYTHON_BIN" ]; then
    echo "Python 3.10 or newer is required. Install Python 3.11+ and rerun ./start.sh."
    exit 1
fi

if [ ! -d "$VENV_DIR" ]; then
    echo "Creating backend virtual environment with $PYTHON_BIN..."
    "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

echo "Installing backend dependencies..."
"$VENV_DIR/bin/python" -m pip install --upgrade pip >/dev/null
"$VENV_DIR/bin/pip" install -r "$ROOT_DIR/backend/requirements.txt" >/dev/null

# Start local site and API
echo "Starting local site and API on http://localhost:8000..."
cd "$ROOT_DIR/backend"
source venv/bin/activate
LOCAL_SITE_ROOT=true uvicorn app.main:app --reload >> "$LOG_DIR/backend.log" 2>&1 &
BACKEND_PID=$!
cd "$ROOT_DIR"

echo ""
echo "✅ Local site started!"
echo "📊 Open http://localhost:8000 in your browser"
echo "📝 Logs: $LOG_DIR/backend.log"
echo ""
echo "Press Ctrl+C to stop the server"

# Wait for interrupt
trap "kill $BACKEND_PID; exit" INT
wait
