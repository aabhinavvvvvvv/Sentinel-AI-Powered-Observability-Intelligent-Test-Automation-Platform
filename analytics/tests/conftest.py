"""
Shared test setup (pytest loads conftest.py automatically).

Database tests use the SAME test database as the Node tests (sentinel_test).
It's created by the Node test setup: run `npm test` in backend/ once first.
"""

import os
from pathlib import Path

import psycopg
import pytest
from dotenv import load_dotenv

# Read ../../.env (the project's .env), then point the app at the TEST database.
load_dotenv(Path(__file__).resolve().parents[2] / ".env")
os.environ["DATABASE_URL"] = os.environ["TEST_DATABASE_URL"]


@pytest.fixture
def writer():
    """
    A normal (writable) connection for tests to prepare data, with all tables emptied first.
    A "fixture" is setup code: a test that names `writer` as a parameter gets this connection.
    """
    with psycopg.connect(os.environ["TEST_DATABASE_URL"], autocommit=True) as conn:
        conn.execute("TRUNCATE endpoints RESTART IDENTITY CASCADE")
        yield conn  # the test runs here; afterwards the connection closes
