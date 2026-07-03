"""Point the test run at a fresh per-run SQLite file in tmp instead of the
dev database. Must run before `app.database` is first imported anywhere, so
this sets the env var at module load time (conftest.py is always imported
before any test module is collected) rather than inside a fixture.
"""
import os
import tempfile

import pytest

_TMP_DB_DIR = tempfile.mkdtemp(prefix="palmergill-backend-tests-")
os.environ.setdefault("DATABASE_URL", f"sqlite:///{_TMP_DB_DIR}/test.db")


@pytest.fixture(scope="session", autouse=True)
def _create_database_schema():
    # Individual test modules may also call this per-function to reset row
    # state; table creation itself only needs to happen once per session,
    # and must not depend on test collection/execution order.
    from app.database import Base, engine

    Base.metadata.create_all(bind=engine)
