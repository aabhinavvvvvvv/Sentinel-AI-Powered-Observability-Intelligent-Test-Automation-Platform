"""Tests for POST /analyze/{endpoint_id}, against the real test database."""

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.db import connect
from app.main import app

client = TestClient(app)


def add_endpoint(writer) -> int:
    row = writer.execute(
        """INSERT INTO endpoints (name, url, method, interval_seconds, timeout_ms, expected_status,
                                  max_retries, failure_threshold, paused)
           VALUES ('API', 'https://example.com', 'GET', 60, 5000, 200, 0, 3, false) RETURNING id"""
    ).fetchone()
    return row[0]


def add_hour(writer, endpoint_id: int, hours_ago: int, ms: int, ok: bool = True) -> None:
    """Three checks inside the hour that started `hours_ago` hours before the current hour."""
    for minute in (10, 20, 30):
        writer.execute(
            """INSERT INTO check_results (endpoint_id, ok, status_code, response_time_ms, checked_at)
               VALUES (%s, %s, 200, %s,
                       date_trunc('hour', now()) - make_interval(hours => %s) + make_interval(mins => %s))""",
            (endpoint_id, ok, ms, hours_ago, minute),
        )


def test_finds_the_slow_hour_in_real_stored_checks(writer):
    eid = add_endpoint(writer)
    for h in range(30, 0, -1):  # 30 finished hours, oldest first
        add_hour(writer, eid, h, 900 if h == 3 else 240 + h % 3)

    body = client.post(f"/analyze/{eid}").json()

    assert body["hours_scored"] > 0
    # Only the live rule answers: the shadow detectors need 5+ days of history, and this has ~1.
    assert len(body["findings"]) == 1
    finding = body["findings"][0]
    assert finding["method"] == "robust_z_v1"
    assert finding["value"] == 900
    assert finding["baseline"] == pytest.approx(241, abs=1)  # pytest.approx = "close enough"


def test_the_current_unfinished_hour_is_ignored(writer):
    eid = add_endpoint(writer)
    for h in range(30, 0, -1):
        add_hour(writer, eid, h, 240)
    add_hour(writer, eid, 0, 900)  # 0 hours ago = the current hour, still filling up

    assert client.post(f"/analyze/{eid}").json()["findings"] == []


def test_failed_checks_do_not_count_as_slow(writer):
    eid = add_endpoint(writer)
    for h in range(30, 0, -1):
        add_hour(writer, eid, h, 240)
    add_hour(writer, eid, 2, 5000, ok=False)  # timeouts: a failure, not a "speed"

    assert client.post(f"/analyze/{eid}").json()["findings"] == []


def test_no_checks_means_no_findings(writer):
    eid = add_endpoint(writer)
    assert client.post(f"/analyze/{eid}").json() == {"endpoint_id": eid, "hours_scored": 0, "findings": []}


def test_unknown_endpoint_is_404(writer):
    assert client.post("/analyze/999").status_code == 404


def test_endpoint_id_must_be_a_number():
    assert client.post("/analyze/abc").status_code == 422


def test_the_service_cannot_write_to_the_database(writer):
    with connect() as conn:
        with pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
            conn.execute("DELETE FROM endpoints")
