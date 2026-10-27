from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.feedback_api import router
from app.storage import SQLiteStorage


def make_client(tmp_path):
    app = FastAPI()
    app.include_router(router)
    storage = SQLiteStorage(f"sqlite:///{tmp_path / 'feedback.db'}")
    storage.init_db()
    app.state.storage = storage
    app.state.config = type("Config", (), {"app_env": "test", "feedback_rate_limit": 2, "feedback_rate_window_seconds": 60})()
    app.state.session_signer = type("Signer", (), {"verify": lambda self, token: 1})()
    return TestClient(app)


def test_public_feedback_is_created_and_listed(tmp_path):
    client = make_client(tmp_path)
    response = client.post("/api/public/feedback", json={"message": "The feed is useful"})
    assert response.status_code == 201
    assert response.json()["status"] == "new"
    listed = client.get("/api/admin/feedback", cookies={"tg_session": "valid"})
    assert listed.status_code == 200
    assert listed.json()["items"][0]["message"] == "The feed is useful"


def test_feedback_is_rate_limited_by_ip(tmp_path):
    client = make_client(tmp_path)
    for _ in range(2):
        assert client.post("/api/public/feedback", json={"message": "hello"}).status_code == 201
    limited = client.post("/api/public/feedback", json={"message": "hello"})
    assert limited.status_code == 429


def test_admin_can_update_feedback_status(tmp_path):
    client = make_client(tmp_path)
    created = client.post("/api/public/feedback", json={"message": "please fix"}).json()
    response = client.patch(
        f"/api/admin/feedback/{created['id']}",
        json={"status": "resolved"},
        cookies={"tg_session": "valid"},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "resolved"


def test_feedback_rejects_blank_message(tmp_path):
    client = make_client(tmp_path)
    assert client.post("/api/public/feedback", json={"message": "  "}).status_code == 422
