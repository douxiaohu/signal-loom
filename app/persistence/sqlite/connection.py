from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from typing import Iterator

BUSY_TIMEOUT_MS = 5000


def sqlite_path_from_url(database_url: str) -> str:
    if database_url in {":memory:", "sqlite:///:memory:"}:
        return ":memory:"
    if database_url.startswith("sqlite:///"):
        return database_url[len("sqlite:///") :]
    raise ValueError("Only sqlite:/// database URLs are supported")


class ConnectionFactory:
    """Open SQLite connections. Only this type may commit/close what it opened."""

    def __init__(self, database_url: str) -> None:
        self.database_url = database_url
        self.database_path = sqlite_path_from_url(database_url)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.database_path, timeout=BUSY_TIMEOUT_MS / 1000)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
