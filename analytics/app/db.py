"""
Reading from PostgreSQL. This service only READS: Node owns the tables and all writes.
"""

import os

import pandas as pd
import psycopg


def connect() -> psycopg.Connection:
    # "default_transaction_read_only=on": Postgres itself refuses any INSERT/UPDATE/DELETE
    # on this connection, so this service can't change data even by mistake.
    return psycopg.connect(os.environ["DATABASE_URL"], options="-c default_transaction_read_only=on")


def endpoint_exists(conn: psycopg.Connection, endpoint_id: int) -> bool:
    return conn.execute("SELECT 1 FROM endpoints WHERE id = %s", (endpoint_id,)).fetchone() is not None


def load_finished_hours(conn: psycopg.Connection, endpoint_id: int, hours: int) -> pd.DataFrame:
    """
    The endpoint's checks from the last `hours` FINISHED hours (the current hour is still
    filling up, so it's left out). Columns: checked_at, ok, response_time_ms.
    """
    rows = conn.execute(
        """
        SELECT checked_at, ok, response_time_ms
        FROM check_results
        WHERE endpoint_id = %s
          AND checked_at >= date_trunc('hour', now()) - make_interval(hours => %s)
          AND checked_at <  date_trunc('hour', now())
        ORDER BY checked_at
        """,
        (endpoint_id, hours),  # %s placeholders: values are sent separately (no SQL injection)
    ).fetchall()
    return pd.DataFrame(rows, columns=["checked_at", "ok", "response_time_ms"])
