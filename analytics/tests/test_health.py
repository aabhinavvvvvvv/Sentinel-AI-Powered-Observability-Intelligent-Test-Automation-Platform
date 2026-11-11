"""Tests for GET /health.

TestClient sends requests to the app in memory, without starting a real server
(the same idea as Supertest in the Node backend).
"""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


# pytest finds and runs every function whose name starts with "test_".
def test_health_says_ok():
    response = client.get("/health")

    # `assert` = "this must be true, otherwise the test fails".
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "sentinel-analytics"}


def test_unknown_route_is_404():
    assert client.get("/nope").status_code == 404
