from __future__ import annotations

import base64
import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence
from zoneinfo import ZoneInfo

from .persistence.sqlite.connection import ConnectionFactory, sqlite_path_from_url
from .source_utils import canonical_telegram_public_url, public_source_chat_id


DISPLAYABLE_MESSAGE_SQL = "(TRIM(COALESCE(content, '')) <> '' OR media_type IS NOT NULL) AND COALESCE(media_type, '') <> 'poll'"


@dataclass(frozen=True)
class StoredMessage:
    id: int
    chat_id: int
    chat_title: str
    message_id: int
    sender_name: str
    message_time: str
    content: str
    media_type: Optional[str]
    raw_json: str
    forwarded_at: Optional[str]
    content_version: int = 1


@dataclass(frozen=True)
class StoredSource:
    chat_id: int
    name: str
    source_url: str
    source_type: str
    enabled: bool
    public_visible: bool
    created_at: str
    updated_at: str
    adapter: str = "telegram_public"
    locator: str = ""
    config_json: str = "{}"

    @property
    def source_id(self) -> int:
        return self.chat_id


@dataclass(frozen=True)
class MessagePage:
    items: List[StoredMessage]
    has_more: bool
    next_cursor: Optional[str]


class SQLiteStorage:
    def __init__(self, database_url: str, *, timezone_name: str = "Asia/Shanghai") -> None:
        self.database_url = database_url
        self.db = ConnectionFactory(database_url)
        self.database_path = self.db.database_path
        self.timezone_name = timezone_name
        self._github_fts_available = False

    def init_db(self) -> None:
        if self.database_path != ":memory:":
            Path(self.database_path).parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(
                """
                PRAGMA journal_mode=WAL;

                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    chat_id INTEGER NOT NULL,
                    chat_title TEXT NOT NULL DEFAULT '',
                    message_id INTEGER NOT NULL,
                    sender_name TEXT NOT NULL DEFAULT '',
                    message_time TEXT NOT NULL,
                    content TEXT NOT NULL DEFAULT '',
                    media_type TEXT,
                    raw_json TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    forwarded_at TEXT,
                    content_version INTEGER NOT NULL DEFAULT 1,
                    UNIQUE(chat_id, message_id)
                );

                CREATE INDEX IF NOT EXISTS idx_messages_pending
                    ON messages(chat_id, forwarded_at, message_time);

                CREATE INDEX IF NOT EXISTS idx_messages_feed
                    ON messages(message_time DESC, id DESC);

                CREATE INDEX IF NOT EXISTS idx_messages_chat_feed
                    ON messages(chat_id, message_time DESC, id DESC);

                CREATE TABLE IF NOT EXISTS sources (
                    chat_id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    source_url TEXT NOT NULL UNIQUE,
                    source_type TEXT NOT NULL DEFAULT 'telegram_public',
                    enabled INTEGER NOT NULL DEFAULT 1,
                    public_visible INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_sources_visibility
                    ON sources(enabled, public_visible, name);

                CREATE TABLE IF NOT EXISTS bot_state (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS forward_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    chat_id INTEGER,
                    group_name TEXT NOT NULL DEFAULT '',
                    message_count INTEGER NOT NULL DEFAULT 0,
                    success INTEGER NOT NULL,
                    error TEXT,
                    payload_preview TEXT,
                    sent_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS source_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    chat_id INTEGER NOT NULL,
                    source TEXT NOT NULL DEFAULT '',
                    started_at TEXT NOT NULL,
                    finished_at TEXT NOT NULL,
                    fetched_count INTEGER NOT NULL DEFAULT 0,
                    saved_count INTEGER NOT NULL DEFAULT 0,
                    error TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_source_runs_chat_finished
                    ON source_runs(chat_id, finished_at DESC, id DESC);

                CREATE TABLE IF NOT EXISTS alert_rules (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    keyword TEXT NOT NULL,
                    media_type TEXT,
                    quiet_start TEXT,
                    quiet_end TEXT,
                    cooldown_minutes INTEGER NOT NULL DEFAULT 0,
                    enabled INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS alert_rule_sources (
                    rule_id INTEGER NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
                    chat_id INTEGER NOT NULL,
                    PRIMARY KEY(rule_id, chat_id)
                );

                CREATE TABLE IF NOT EXISTS alert_matches (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    rule_id INTEGER NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
                    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
                    status TEXT NOT NULL DEFAULT 'new',
                    matched_at TEXT NOT NULL,
                    acknowledged_at TEXT,
                    resolved_at TEXT,
                    UNIQUE(rule_id, message_id)
                );

                CREATE INDEX IF NOT EXISTS idx_alert_matches_status
                    ON alert_matches(status, matched_at DESC);

                CREATE TABLE IF NOT EXISTS delivery_batches (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    chat_id INTEGER NOT NULL,
                    group_name TEXT NOT NULL DEFAULT '',
                    channel TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    idempotency_key TEXT NOT NULL UNIQUE,
                    status TEXT NOT NULL DEFAULT 'pending',
                    next_retry_at TEXT,
                    maybe_duplicate INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS delivery_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    batch_id INTEGER NOT NULL REFERENCES delivery_batches(id) ON DELETE CASCADE,
                    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
                    status TEXT NOT NULL DEFAULT 'pending',
                    message_version INTEGER NOT NULL DEFAULT 1,
                    UNIQUE(batch_id, message_id)
                );

                CREATE TABLE IF NOT EXISTS delivery_attempts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    batch_id INTEGER NOT NULL REFERENCES delivery_batches(id) ON DELETE CASCADE,
                    attempt_no INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    error TEXT,
                    started_at TEXT NOT NULL,
                    finished_at TEXT,
                    next_retry_at TEXT,
                    maybe_duplicate INTEGER NOT NULL DEFAULT 0,
                    chunk_count INTEGER NOT NULL DEFAULT 1,
                    completed_chunks INTEGER NOT NULL DEFAULT 0,
                    chunk_results TEXT NOT NULL DEFAULT '[]',
                    UNIQUE(batch_id, attempt_no)
                );

                CREATE TABLE IF NOT EXISTS github_repositories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    github_id INTEGER NOT NULL UNIQUE,
                    full_name TEXT NOT NULL UNIQUE,
                    owner TEXT NOT NULL,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    html_url TEXT NOT NULL,
                    homepage TEXT NOT NULL DEFAULT '',
                    language TEXT NOT NULL DEFAULT '',
                    topics_json TEXT NOT NULL DEFAULT '[]',
                    license_name TEXT NOT NULL DEFAULT '',
                    features_json TEXT NOT NULL DEFAULT '{}',
                    stars INTEGER NOT NULL DEFAULT 0,
                    forks INTEGER NOT NULL DEFAULT 0,
                    open_issues INTEGER NOT NULL DEFAULT 0,
                    watchers INTEGER NOT NULL DEFAULT 0,
                    size INTEGER NOT NULL DEFAULT 0,
                    default_branch TEXT NOT NULL DEFAULT '',
                    archived INTEGER NOT NULL DEFAULT 0,
                    disabled INTEGER NOT NULL DEFAULT 0,
                    is_template INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    pushed_at TEXT,
                    first_seen_at TEXT NOT NULL,
                    last_seen_at TEXT NOT NULL,
                    search_text TEXT NOT NULL DEFAULT ''
                );

                CREATE INDEX IF NOT EXISTS idx_github_repositories_language
                    ON github_repositories(language COLLATE NOCASE, stars DESC);
                CREATE INDEX IF NOT EXISTS idx_github_repositories_activity
                    ON github_repositories(archived, disabled, pushed_at DESC);
                CREATE INDEX IF NOT EXISTS idx_github_repositories_seen
                    ON github_repositories(last_seen_at ASC);

                CREATE TABLE IF NOT EXISTS github_repository_snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    repository_id INTEGER NOT NULL REFERENCES github_repositories(id) ON DELETE CASCADE,
                    captured_at TEXT NOT NULL,
                    stars INTEGER NOT NULL,
                    forks INTEGER NOT NULL,
                    open_issues INTEGER NOT NULL,
                    pushed_at TEXT,
                    UNIQUE(repository_id, captured_at)
                );

                CREATE INDEX IF NOT EXISTS idx_github_snapshots_repository_time
                    ON github_repository_snapshots(repository_id, captured_at DESC);

                CREATE TABLE IF NOT EXISTS github_collection_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    started_at TEXT NOT NULL,
                    finished_at TEXT NOT NULL,
                    status TEXT NOT NULL,
                    fetched_count INTEGER NOT NULL DEFAULT 0,
                    saved_count INTEGER NOT NULL DEFAULT 0,
                    error TEXT,
                    rate_limit_remaining INTEGER,
                    rate_limit_reset TEXT
                );
                """
            )
            try:
                conn.execute(
                    """
                    CREATE VIRTUAL TABLE IF NOT EXISTS github_repository_fts USING fts5(
                        full_name, description, topics, language, license_name, features,
                        tokenize='unicode61 remove_diacritics 2'
                    )
                    """
                )
                self._github_fts_available = True
            except sqlite3.OperationalError:
                self._github_fts_available = False
            _ensure_column(conn, "delivery_attempts", "chunk_count", "INTEGER NOT NULL DEFAULT 1")
            _ensure_column(conn, "delivery_attempts", "completed_chunks", "INTEGER NOT NULL DEFAULT 0")
            _ensure_column(conn, "delivery_attempts", "chunk_results", "TEXT NOT NULL DEFAULT '[]'")
            _ensure_column(conn, "messages", "content_version", "INTEGER NOT NULL DEFAULT 1")
            _ensure_column(conn, "delivery_items", "message_version", "INTEGER NOT NULL DEFAULT 1")
            _ensure_column(conn, "github_repositories", "languages_json", "TEXT NOT NULL DEFAULT '[]'")
            _ensure_column(conn, "github_repositories", "analysis_source_hash", "TEXT NOT NULL DEFAULT ''")
            _ensure_column(conn, "github_repositories", "ai_summary_zh", "TEXT NOT NULL DEFAULT ''")
            _ensure_column(conn, "github_repositories", "ai_significance_zh", "TEXT NOT NULL DEFAULT ''")
            _ensure_column(conn, "github_repositories", "ai_problem_zh", "TEXT NOT NULL DEFAULT ''")
            _ensure_column(conn, "github_repositories", "ai_model", "TEXT NOT NULL DEFAULT ''")
            _ensure_column(conn, "github_repositories", "ai_generated_at", "TEXT")
            _ensure_column(conn, "sources", "adapter", "TEXT NOT NULL DEFAULT ''")
            _ensure_column(conn, "sources", "locator", "TEXT NOT NULL DEFAULT ''")
            _ensure_column(conn, "sources", "config_json", "TEXT NOT NULL DEFAULT '{}'")
            conn.execute(
                "UPDATE sources SET adapter = source_type WHERE adapter = '' OR adapter IS NULL"
            )
            conn.execute(
                "UPDATE sources SET locator = source_url WHERE locator = '' OR locator IS NULL"
            )
            now = utc_now_iso()
            conn.execute(
                """
                UPDATE delivery_attempts
                SET status = 'failed', error = COALESCE(error, 'process interrupted'),
                    finished_at = COALESCE(finished_at, ?), next_retry_at = COALESCE(next_retry_at, ?)
                WHERE status IN ('pending', 'in_progress')
                """,
                (now, now),
            )
            conn.execute(
                """
                UPDATE messages
                SET forwarded_at = (
                    SELECT MAX(db.updated_at)
                    FROM delivery_items di
                    JOIN delivery_batches db ON db.id = di.batch_id
                    WHERE di.message_id = messages.id
                      AND di.message_version = messages.content_version
                      AND db.status = 'succeeded'
                )
                WHERE forwarded_at IS NULL
                  AND EXISTS (
                      SELECT 1
                      FROM delivery_items di
                      JOIN delivery_batches db ON db.id = di.batch_id
                      WHERE di.message_id = messages.id
                        AND di.message_version = messages.content_version
                        AND db.status = 'succeeded'
                  )
                """
            )
            conn.execute(
                """
                UPDATE delivery_batches
                SET status = 'failed', next_retry_at = COALESCE(next_retry_at, ?), updated_at = ?
                WHERE status IN ('pending', 'in_progress')
                """,
                (now, now),
            )
            legacy_attempts = conn.execute(
                """
                SELECT id, status, error, chunk_count, completed_chunks
                FROM delivery_attempts
                WHERE chunk_results IS NULL OR TRIM(chunk_results) IN ('', '[]')
                """
            ).fetchall()
            for attempt in legacy_attempts:
                chunk_results = _final_chunk_results(
                    success=str(attempt["status"]) == "succeeded",
                    status=str(attempt["status"]),
                    chunk_count=int(attempt["chunk_count"] or 1),
                    completed_chunks=int(attempt["completed_chunks"] or 0),
                    error=attempt["error"],
                )
                conn.execute(
                    "UPDATE delivery_attempts SET error = ?, chunk_results = ? WHERE id = ?",
                    (
                        _sanitize_delivery_error(attempt["error"]),
                        _encode_chunk_results(chunk_results),
                        int(attempt["id"]),
                    ),
                )

    def list_sources(
        self,
        *,
        enabled_only: bool = False,
        public_only: bool = False,
    ) -> List[StoredSource]:
        clauses: List[str] = []
        if enabled_only:
            clauses.append("enabled = 1")
        if public_only:
            clauses.append("public_visible = 1")
        where_clause = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM sources {where_clause} ORDER BY name COLLATE NOCASE, chat_id"
            ).fetchall()
        return [row_to_source(row) for row in rows]

    def get_source(self, chat_id: int) -> Optional[StoredSource]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM sources WHERE chat_id = ?",
                (int(chat_id),),
            ).fetchone()
        return row_to_source(row) if row else None

    def create_source(
        self,
        *,
        name: str,
        source_url: str,
        public_visible: bool = False,
        adapter: str = "telegram_public",
    ) -> StoredSource:
        clean_name = str(name or "").strip()
        if not clean_name:
            raise ValueError("source name is required")
        adapter_key = str(adapter or "telegram_public").strip() or "telegram_public"
        if adapter_key == "telegram_public":
            locator = canonical_telegram_public_url(source_url)
            chat_id = public_source_chat_id(locator)
        elif adapter_key == "telegram_bot":
            try:
                chat_id = int(str(source_url).strip())
            except (TypeError, ValueError) as exc:
                raise ValueError("telegram_bot locator must be a numeric chat_id") from exc
            locator = str(chat_id)
        else:
            raise ValueError(f"unknown source adapter: {adapter_key}")
        now = utc_now_iso()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO sources(
                    chat_id, name, source_url, source_type,
                    enabled, public_visible, created_at, updated_at,
                    adapter, locator, config_json
                ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, '{}')
                """,
                (
                    chat_id,
                    clean_name,
                    locator,
                    adapter_key,
                    int(public_visible),
                    now,
                    now,
                    adapter_key,
                    locator,
                ),
            )
        source = self.get_source(chat_id)
        if source is None:
            raise RuntimeError("source insert did not persist")
        return source

    def update_source(
        self,
        chat_id: int,
        *,
        name: Optional[str] = None,
        enabled: Optional[bool] = None,
        public_visible: Optional[bool] = None,
    ) -> StoredSource:
        current = self.get_source(chat_id)
        if current is None:
            raise KeyError(f"source not found: {chat_id}")
        clean_name = current.name if name is None else str(name).strip()
        if not clean_name:
            raise ValueError("source name is required")
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE sources
                SET name = ?, enabled = ?, public_visible = ?, updated_at = ?
                WHERE chat_id = ?
                """,
                (
                    clean_name,
                    int(current.enabled if enabled is None else enabled),
                    int(current.public_visible if public_visible is None else public_visible),
                    utc_now_iso(),
                    int(chat_id),
                ),
            )
        updated = self.get_source(chat_id)
        if updated is None:
            raise RuntimeError("source update did not persist")
        return updated

    def public_chat_ids(self) -> List[int]:
        return [
            source.chat_id
            for source in self.list_sources(enabled_only=True, public_only=True)
        ]

    def save_message(self, message: object) -> bool:
        payload = {
            "chat_id": int(getattr(message, "chat_id")),
            "chat_title": str(getattr(message, "chat_title", "") or ""),
            "message_id": int(getattr(message, "message_id")),
            "sender_name": str(getattr(message, "sender_name", "") or ""),
            "message_time": str(getattr(message, "message_time")),
            "content": str(getattr(message, "content", "") or ""),
            "media_type": getattr(message, "media_type", None),
            "raw_json": json.dumps(getattr(message, "raw", {}), ensure_ascii=False),
        }
        if not message_payload_is_displayable(payload):
            return False
        with self._connect() as conn:
            cursor = conn.execute(
                """
                INSERT OR IGNORE INTO messages (
                    chat_id, chat_title, message_id, sender_name, message_time,
                    content, media_type, raw_json
                ) VALUES (
                    :chat_id, :chat_title, :message_id, :sender_name,
                    :message_time, :content, :media_type, :raw_json
                )
                """,
                payload,
            )
            if cursor.rowcount == 1:
                self._match_alert_rules(conn, int(cursor.lastrowid))
                return True
            row = conn.execute(
                """
                SELECT id, content, media_type, raw_json, forwarded_at, content_version
                FROM messages
                WHERE chat_id = :chat_id AND message_id = :message_id
                """,
                payload,
            ).fetchone()
            content_changed = 1 if row and message_payload_changed(row, payload) else 0
            clear_forwarded = 1 if row and row["forwarded_at"] and content_changed else 0
            conn.execute(
                """
                UPDATE messages
                SET chat_title = :chat_title,
                    sender_name = :sender_name,
                    message_time = :message_time,
                    content = :content,
                    media_type = :media_type,
                    raw_json = :raw_json,
                    content_version = CASE
                        WHEN :content_changed = 1 THEN content_version + 1
                        ELSE content_version
                    END,
                    forwarded_at = CASE
                        WHEN :clear_forwarded = 1 THEN NULL
                        ELSE forwarded_at
                    END
                WHERE chat_id = :chat_id AND message_id = :message_id
                """,
                {
                    **payload,
                    "content_changed": content_changed,
                    "clear_forwarded": clear_forwarded,
                },
            )
            if row:
                self._match_alert_rules(conn, int(row["id"]))
            return False

    def get_state(self, key: str, default: Optional[str] = None) -> Optional[str]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT value FROM bot_state WHERE key = ?",
                (key,),
            ).fetchone()
        return row["value"] if row else default

    def set_state(self, key: str, value: object) -> None:
        now = utc_now_iso()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO bot_state(key, value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at
                """,
                (key, str(value), now),
            )

    def get_pending_messages(self, chat_id: int, limit: int = 1000) -> List[StoredMessage]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM messages
                WHERE chat_id = ? AND forwarded_at IS NULL
                  AND {displayable_clause}
                ORDER BY message_time ASC, message_id ASC
                LIMIT ?
                """.format(displayable_clause=DISPLAYABLE_MESSAGE_SQL),
                (int(chat_id), int(limit)),
            ).fetchall()
        return [row_to_message(row) for row in rows]

    def get_unbatched_pending_messages(self, chat_id: int, limit: int = 1000) -> List[StoredMessage]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT m.*
                FROM messages m
                WHERE m.chat_id = ? AND m.forwarded_at IS NULL
                  AND {displayable_clause}
                  AND NOT EXISTS (
                      SELECT 1
                      FROM delivery_items di
                      JOIN delivery_batches db ON db.id = di.batch_id
                      WHERE di.message_id = m.id
                        AND di.message_version = m.content_version
                        AND db.status IN ('pending', 'in_progress', 'failed', 'succeeded')
                  )
                ORDER BY m.message_time ASC, m.message_id ASC
                LIMIT ?
                """.format(displayable_clause=DISPLAYABLE_MESSAGE_SQL.replace("media_type", "m.media_type").replace("content", "m.content")),
                (int(chat_id), int(limit)),
            ).fetchall()
        return [row_to_message(row) for row in rows]

    def get_message(self, message_id: int) -> Optional[StoredMessage]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM messages WHERE id = ?",
                (int(message_id),),
            ).fetchone()
        return row_to_message(row) if row else None

    def get_message_by_telegram_id(self, chat_id: int, message_id: int) -> Optional[StoredMessage]:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT * FROM messages
                WHERE chat_id = ? AND message_id = ?
                """,
                (int(chat_id), int(message_id)),
            ).fetchone()
        return row_to_message(row) if row else None

    def list_messages(
        self,
        *,
        chat_id: Optional[int] = None,
        limit: int = 50,
        offset: int = 0,
        query: str = "",
        media: str = "all",
        allowed_chat_ids: Optional[Sequence[int]] = None,
    ) -> List[StoredMessage]:
        where_clause, params = build_message_filters(
            chat_id=chat_id,
            query=query,
            media=media,
            allowed_chat_ids=allowed_chat_ids,
        )
        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT * FROM messages
                WHERE {where_clause}
                ORDER BY message_time DESC, message_id DESC
                LIMIT ? OFFSET ?
                """,
                (*params, max(1, min(int(limit), 200)), max(0, int(offset))),
            ).fetchall()
        return [row_to_message(row) for row in rows]

    def list_messages_page(
        self,
        *,
        chat_id: Optional[int] = None,
        limit: int = 50,
        cursor: str = "",
        query: str = "",
        media: str = "all",
        allowed_chat_ids: Optional[Sequence[int]] = None,
    ) -> MessagePage:
        page_limit = max(1, min(int(limit), 200))
        where_clause, params = build_message_filters(
            chat_id=chat_id,
            query=query,
            media=media,
            allowed_chat_ids=allowed_chat_ids,
        )
        cursor_time, cursor_id = decode_message_cursor(cursor)
        if cursor_time is not None and cursor_id is not None:
            where_clause += " AND (message_time < ? OR (message_time = ? AND id < ?))"
            params = (*params, cursor_time, cursor_time, cursor_id)

        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT * FROM messages
                WHERE {where_clause}
                ORDER BY message_time DESC, id DESC
                LIMIT ?
                """,
                (*params, page_limit + 1),
            ).fetchall()

        has_more = len(rows) > page_limit
        page_rows = rows[:page_limit]
        items = [row_to_message(row) for row in page_rows]
        next_cursor = encode_message_cursor(items[-1]) if has_more and items else None
        return MessagePage(items=items, has_more=has_more, next_cursor=next_cursor)

    def count_messages(
        self,
        *,
        chat_id: Optional[int] = None,
        query: str = "",
        media: str = "all",
        allowed_chat_ids: Optional[Sequence[int]] = None,
    ) -> int:
        where_clause, params = build_message_filters(
            chat_id=chat_id,
            query=query,
            media=media,
            allowed_chat_ids=allowed_chat_ids,
        )
        with self._connect() as conn:
            row = conn.execute(
                f"SELECT COUNT(*) AS message_count FROM messages WHERE {where_clause}",
                params,
            ).fetchone()
        return int(row["message_count"] if row else 0)

    def get_unconfigured_pending_counts(self, configured_chat_ids: Iterable[int]) -> List[Dict[str, object]]:
        configured = [int(chat_id) for chat_id in configured_chat_ids]
        placeholders = ",".join("?" for _ in configured)
        where_clause = f"forwarded_at IS NULL AND {DISPLAYABLE_MESSAGE_SQL}"
        params: Sequence[object] = []
        if placeholders:
            where_clause += f" AND chat_id NOT IN ({placeholders})"
            params = configured

        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT chat_id, COALESCE(NULLIF(MAX(chat_title), ''), CAST(chat_id AS TEXT)) AS chat_title,
                       COUNT(*) AS pending_count
                FROM messages
                WHERE {where_clause}
                GROUP BY chat_id
                ORDER BY pending_count DESC, chat_id ASC
                """,
                tuple(params),
            ).fetchall()
        return [dict(row) for row in rows]

    def mark_forwarded(self, message_ids: Iterable[int], forwarded_at: Optional[str] = None) -> int:
        ids = [int(message_id) for message_id in message_ids]
        if not ids:
            return 0
        sent_at = forwarded_at or utc_now_iso()
        placeholders = ",".join("?" for _ in ids)
        with self._connect() as conn:
            cursor = conn.execute(
                f"UPDATE messages SET forwarded_at = ? WHERE id IN ({placeholders})",
                (sent_at, *ids),
            )
            return cursor.rowcount

    def mark_delivery_batch_forwarded(
        self,
        batch_id: int,
        forwarded_at: Optional[str] = None,
    ) -> int:
        sent_at = forwarded_at or utc_now_iso()
        with self._connect() as conn:
            cursor = conn.execute(
                """
                UPDATE messages
                SET forwarded_at = ?
                WHERE EXISTS (
                    SELECT 1
                    FROM delivery_items di
                    WHERE di.batch_id = ?
                      AND di.message_id = messages.id
                      AND di.message_version = messages.content_version
                )
                """,
                (sent_at, int(batch_id)),
            )
            return cursor.rowcount

    def log_forward(
        self,
        *,
        chat_id: Optional[int],
        group_name: str,
        message_count: int,
        success: bool,
        error: Optional[str],
        payload_preview: str,
    ) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO forward_logs(
                    chat_id, group_name, message_count, success, error,
                    payload_preview, sent_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    chat_id,
                    group_name,
                    int(message_count),
                    1 if success else 0,
                    error,
                    payload_preview[:500],
                    utc_now_iso(),
                ),
            )
    def count_pending_by_chat(self) -> List[Dict[str, object]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT chat_id, COALESCE(NULLIF(MAX(chat_title), ''), CAST(chat_id AS TEXT)) AS chat_title,
                       COUNT(*) AS pending_count
                FROM messages
                WHERE forwarded_at IS NULL AND {displayable_clause}
                GROUP BY chat_id
                ORDER BY pending_count DESC, chat_id ASC
                """.format(displayable_clause=DISPLAYABLE_MESSAGE_SQL)
            ).fetchall()
        return [dict(row) for row in rows]

    def get_chats(self) -> List[Dict[str, object]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT chat_id,
                       COALESCE(NULLIF(MAX(chat_title), ''), CAST(chat_id AS TEXT)) AS chat_title,
                       COUNT(*) AS message_count,
                       SUM(CASE WHEN forwarded_at IS NULL THEN 1 ELSE 0 END) AS pending_count,
                       MAX(message_time) AS last_message_time
                FROM messages
                WHERE {displayable_clause}
                GROUP BY chat_id
                ORDER BY last_message_time DESC
                """.format(displayable_clause=DISPLAYABLE_MESSAGE_SQL)
            ).fetchall()
        return [dict(row) for row in rows]

    def get_recent_forward_logs(self, limit: int = 20) -> List[Dict[str, object]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id, chat_id, group_name, message_count, success, error,
                       payload_preview, sent_at
                FROM forward_logs
                ORDER BY id DESC
                LIMIT ?
                """,
                (int(limit),),
            ).fetchall()
        return [dict(row) for row in rows]

    def record_source_run(
        self,
        *,
        chat_id: int,
        source: str,
        started_at: str,
        finished_at: str,
        fetched_count: int,
        saved_count: int,
        error: Optional[str],
    ) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO source_runs(
                    chat_id, source, started_at, finished_at,
                    fetched_count, saved_count, error
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    int(chat_id),
                    str(source or ""),
                    str(started_at),
                    str(finished_at),
                    max(0, int(fetched_count)),
                    max(0, int(saved_count)),
                    str(error)[:1000] if error else None,
                ),
            )
            conn.execute(
                """
                DELETE FROM source_runs
                WHERE chat_id = ? AND id NOT IN (
                    SELECT id FROM source_runs
                    WHERE chat_id = ?
                    ORDER BY finished_at DESC, id DESC
                    LIMIT 200
                )
                """,
                (int(chat_id), int(chat_id)),
            )

    def get_source_health(
        self,
        chat_id: int,
        *,
        stale_after_seconds: int,
        now: Optional[str] = None,
    ) -> Dict[str, object]:
        with self._connect() as conn:
            latest = conn.execute(
                """
                SELECT * FROM source_runs
                WHERE chat_id = ?
                ORDER BY finished_at DESC, id DESC
                LIMIT 1
                """,
                (int(chat_id),),
            ).fetchone()
            latest_success = conn.execute(
                """
                SELECT finished_at FROM source_runs
                WHERE chat_id = ? AND (error IS NULL OR TRIM(error) = '')
                ORDER BY finished_at DESC, id DESC
                LIMIT 1
                """,
                (int(chat_id),),
            ).fetchone()

        if latest is None:
            return {
                "chat_id": int(chat_id),
                "health_status": "unknown",
                "last_run_at": None,
                "last_success_at": None,
                "last_error": None,
                "fetched_count": 0,
                "saved_count": 0,
            }

        last_success_at = str(latest_success["finished_at"]) if latest_success else None
        latest_error = str(latest["error"] or "").strip() or None
        if latest_error:
            health_status = "error"
        elif last_success_at is None:
            health_status = "unknown"
        else:
            current = _parse_utc_datetime(now) if now else datetime.now(timezone.utc)
            last_success = _parse_utc_datetime(last_success_at)
            age_seconds = max(0.0, (current - last_success).total_seconds())
            health_status = "stale" if age_seconds > max(1, int(stale_after_seconds)) else "healthy"

        return {
            "chat_id": int(chat_id),
            "health_status": health_status,
            "last_run_at": str(latest["finished_at"]),
            "last_success_at": last_success_at,
            "last_error": latest_error,
            "fetched_count": int(latest["fetched_count"]),
            "saved_count": int(latest["saved_count"]),
        }

    def create_alert_rule(
        self,
        *,
        name: str,
        keyword: str,
        media_type: Optional[str],
        quiet_start: Optional[str],
        quiet_end: Optional[str],
        cooldown_minutes: int,
        enabled: bool,
        source_ids: Iterable[int],
    ) -> Dict[str, object]:
        now = utc_now_iso()
        with self._connect() as conn:
            cursor = conn.execute(
                """
                INSERT INTO alert_rules(
                    name, keyword, media_type, quiet_start, quiet_end,
                    cooldown_minutes, enabled, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(name).strip(),
                    str(keyword).strip(),
                    str(media_type).strip() if media_type else None,
                    str(quiet_start).strip() if quiet_start else None,
                    str(quiet_end).strip() if quiet_end else None,
                    max(0, int(cooldown_minutes)),
                    1 if enabled else 0,
                    now,
                    now,
                ),
            )
            rule_id = int(cursor.lastrowid)
            conn.executemany(
                "INSERT OR IGNORE INTO alert_rule_sources(rule_id, chat_id) VALUES (?, ?)",
                [(rule_id, int(chat_id)) for chat_id in source_ids],
            )
        return self.get_alert_rule(rule_id)

    def get_alert_rule(self, rule_id: int) -> Dict[str, object]:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM alert_rules WHERE id = ?", (int(rule_id),)).fetchone()
            if row is None:
                raise KeyError(f"alert rule not found: {rule_id}")
            source_rows = conn.execute(
                "SELECT chat_id FROM alert_rule_sources WHERE rule_id = ? ORDER BY chat_id",
                (int(rule_id),),
            ).fetchall()
        return _alert_rule_dict(row, [int(item["chat_id"]) for item in source_rows])

    def list_alert_rules(self) -> List[Dict[str, object]]:
        with self._connect() as conn:
            rows = conn.execute("SELECT id FROM alert_rules ORDER BY id DESC").fetchall()
        return [self.get_alert_rule(int(row["id"])) for row in rows]

    def update_alert_rule(self, rule_id: int, **changes: object) -> Dict[str, object]:
        allowed = {
            "name",
            "keyword",
            "media_type",
            "quiet_start",
            "quiet_end",
            "cooldown_minutes",
            "enabled",
        }
        updates = []
        params: List[object] = []
        for key, value in changes.items():
            if key == "source_ids" or key not in allowed:
                continue
            updates.append(f"{key} = ?")
            if key == "enabled":
                params.append(1 if value else 0)
            elif key == "cooldown_minutes":
                params.append(max(0, int(value)))
            else:
                params.append(value)
        with self._connect() as conn:
            exists = conn.execute("SELECT id FROM alert_rules WHERE id = ?", (int(rule_id),)).fetchone()
            if exists is None:
                raise KeyError(f"alert rule not found: {rule_id}")
            if updates:
                updates.append("updated_at = ?")
                params.append(utc_now_iso())
                conn.execute(
                    f"UPDATE alert_rules SET {', '.join(updates)} WHERE id = ?",
                    (*params, int(rule_id)),
                )
            if "source_ids" in changes:
                conn.execute("DELETE FROM alert_rule_sources WHERE rule_id = ?", (int(rule_id),))
                conn.executemany(
                    "INSERT OR IGNORE INTO alert_rule_sources(rule_id, chat_id) VALUES (?, ?)",
                    [(int(rule_id), int(chat_id)) for chat_id in (changes["source_ids"] or [])],
                )
        return self.get_alert_rule(rule_id)

    def list_alert_matches(self, status: str = "") -> List[Dict[str, object]]:
        where = "WHERE am.status = ?" if status else ""
        params: Sequence[object] = (status,) if status else ()
        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT am.*, ar.name AS rule_name, ar.keyword,
                       m.id AS message_db_id, m.message_id, m.chat_id,
                       m.chat_title, m.sender_name, m.message_time,
                       m.content, m.media_type
                FROM alert_matches am
                JOIN alert_rules ar ON ar.id = am.rule_id
                JOIN messages m ON m.id = am.message_id
                {where}
                ORDER BY am.id DESC
                """,
                params,
            ).fetchall()
        return [dict(row) for row in rows]

    def set_alert_match_status(self, match_id: int, status: str) -> Dict[str, object]:
        if status not in {"new", "acknowledged", "resolved"}:
            raise ValueError("invalid alert status")
        now = utc_now_iso()
        acknowledged_at = now if status in {"acknowledged", "resolved"} else None
        resolved_at = now if status == "resolved" else None
        with self._connect() as conn:
            cursor = conn.execute(
                """
                UPDATE alert_matches
                SET status = ?,
                    acknowledged_at = COALESCE(acknowledged_at, ?),
                    resolved_at = ?
                WHERE id = ?
                """,
                (status, acknowledged_at, resolved_at, int(match_id)),
            )
            if cursor.rowcount != 1:
                raise KeyError(f"alert match not found: {match_id}")
            row = conn.execute("SELECT * FROM alert_matches WHERE id = ?", (int(match_id),)).fetchone()
        return dict(row)

    def create_delivery_batch(
        self,
        *,
        chat_id: int,
        group_name: str,
        channel: str,
        payload: str,
        message_ids: Iterable[int],
        idempotency_key: str,
    ) -> Dict[str, object]:
        now = utc_now_iso()
        ids = list(dict.fromkeys(int(message_id) for message_id in message_ids))
        with self._connect() as conn:
            conn.execute(
                """
                INSERT OR IGNORE INTO delivery_batches(
                    chat_id, group_name, channel, payload, idempotency_key,
                    status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
                """,
                (int(chat_id), str(group_name), str(channel), str(payload), str(idempotency_key), now, now),
            )
            row = conn.execute(
                "SELECT id FROM delivery_batches WHERE idempotency_key = ?",
                (str(idempotency_key),),
            ).fetchone()
            batch_id = int(row["id"])
            message_versions = {
                int(message_id): int(
                    conn.execute(
                        "SELECT content_version FROM messages WHERE id = ?",
                        (int(message_id),),
                    ).fetchone()["content_version"]
                )
                for message_id in ids
            }
            conn.executemany(
                """
                INSERT OR IGNORE INTO delivery_items(batch_id, message_id, message_version)
                VALUES (?, ?, ?)
                """,
                [
                    (batch_id, message_id, message_versions[message_id])
                    for message_id in ids
                ],
            )
        return self.get_delivery_batch(batch_id)

    def begin_delivery_attempt(
        self,
        batch_id: int,
        *,
        maybe_duplicate: bool,
        chunk_count: int = 1,
    ) -> Dict[str, object]:
        now = utc_now_iso()
        normalized_chunk_count = max(1, int(chunk_count))
        chunk_results = _encode_chunk_results(_pending_chunk_results(normalized_chunk_count))
        with self._connect() as conn:
            row = conn.execute(
                "SELECT COALESCE(MAX(attempt_no), 0) AS attempt_no FROM delivery_attempts WHERE batch_id = ?",
                (int(batch_id),),
            ).fetchone()
            attempt_no = int(row["attempt_no"]) + 1
            cursor = conn.execute(
                """
                INSERT INTO delivery_attempts(
                    batch_id, attempt_no, status, started_at, maybe_duplicate,
                    chunk_count, chunk_results
                ) VALUES (?, ?, 'in_progress', ?, ?, ?, ?)
                """,
                (
                    int(batch_id),
                    attempt_no,
                    now,
                    1 if maybe_duplicate else 0,
                    normalized_chunk_count,
                    chunk_results,
                ),
            )
            conn.execute(
                """
                UPDATE delivery_batches
                SET status = 'in_progress', updated_at = ?, next_retry_at = NULL,
                    maybe_duplicate = CASE WHEN ? = 1 THEN 1 ELSE maybe_duplicate END
                WHERE id = ?
                """,
                (now, 1 if maybe_duplicate else 0, int(batch_id)),
            )
        return {"id": int(cursor.lastrowid), "batch_id": int(batch_id), "attempt_no": attempt_no}

    def finish_delivery_attempt(
        self,
        attempt_id: int,
        *,
        success: bool,
        error: Optional[str],
        next_retry_at: Optional[str] = None,
        completed_chunks: Optional[int] = None,
    ) -> None:
        now = utc_now_iso()
        status = "succeeded" if success else "failed"
        with self._connect() as conn:
            attempt = conn.execute(
                "SELECT batch_id, chunk_count FROM delivery_attempts WHERE id = ?",
                (int(attempt_id),),
            ).fetchone()
            if attempt is None:
                raise KeyError(f"delivery attempt not found: {attempt_id}")
            batch_id = int(attempt["batch_id"])
            chunk_count = max(1, int(attempt["chunk_count"] or 1))
            completed_value = (
                chunk_count
                if success
                else min(chunk_count, max(0, int(completed_chunks or 0)))
            )
            safe_error = _sanitize_delivery_error(error)
            chunk_results = _encode_chunk_results(
                _final_chunk_results(
                    success=success,
                    status=status,
                    chunk_count=chunk_count,
                    completed_chunks=completed_value,
                    error=safe_error,
                )
            )
            conn.execute(
                """
                UPDATE delivery_attempts
                SET status = ?, error = ?, finished_at = ?, next_retry_at = ?,
                    completed_chunks = ?, chunk_results = ?
                WHERE id = ?
                """,
                (
                    status,
                    safe_error,
                    now,
                    next_retry_at,
                    completed_value,
                    chunk_results,
                    int(attempt_id),
                ),
            )
            conn.execute(
                """
                UPDATE delivery_batches
                SET status = ?, next_retry_at = ?, updated_at = ?
                WHERE id = ?
                """,
                (status, next_retry_at, now, batch_id),
            )
            conn.execute(
                "UPDATE delivery_items SET status = ? WHERE batch_id = ?",
                (status, batch_id),
            )

    def get_delivery_batch(self, batch_id: int) -> Dict[str, object]:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT db.*,
                       COUNT(DISTINCT da.id) AS attempt_count,
                       COUNT(DISTINCT di.id) AS item_count
                FROM delivery_batches db
                LEFT JOIN delivery_attempts da ON da.batch_id = db.id
                LEFT JOIN delivery_items di ON di.batch_id = db.id
                WHERE db.id = ?
                GROUP BY db.id
                """,
                (int(batch_id),),
            ).fetchone()
            attempt_rows = conn.execute(
                """
                SELECT attempt_no, status, error, started_at, finished_at,
                       next_retry_at, maybe_duplicate, chunk_count, completed_chunks,
                       chunk_results
                FROM delivery_attempts
                WHERE batch_id = ?
                ORDER BY attempt_no DESC
                """,
                (int(batch_id),),
            ).fetchall()
        if row is None:
            raise KeyError(f"delivery batch not found: {batch_id}")
        result = dict(row)
        result["maybe_duplicate"] = bool(result["maybe_duplicate"])
        attempts = [dict(item) for item in attempt_rows]
        for attempt in attempts:
            attempt["maybe_duplicate"] = bool(attempt["maybe_duplicate"])
            attempt["chunk_results"] = _decode_chunk_results(
                attempt.get("chunk_results"),
                status=str(attempt["status"]),
                chunk_count=int(attempt["chunk_count"] or 1),
                completed_chunks=int(attempt["completed_chunks"] or 0),
                error=attempt.get("error"),
            )
        result["attempts"] = attempts
        result["latest_error"] = attempts[0]["error"] if attempts else None
        return result

    def get_delivery_message_ids(self, batch_id: int) -> List[int]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT message_id FROM delivery_items WHERE batch_id = ? ORDER BY id",
                (int(batch_id),),
            ).fetchall()
        return [int(row["message_id"]) for row in rows]

    def list_deliveries(self, limit: int = 50) -> List[Dict[str, object]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id FROM delivery_batches ORDER BY id DESC LIMIT ?",
                (max(1, min(int(limit), 200)),),
            ).fetchall()
        return [self.get_delivery_batch(int(row["id"])) for row in rows]

    def list_due_delivery_ids(self, *, now: Optional[str] = None, limit: int = 50) -> List[int]:
        current = now or utc_now_iso()
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id
                FROM delivery_batches
                WHERE status = 'failed'
                  AND next_retry_at IS NOT NULL
                  AND next_retry_at <= ?
                ORDER BY next_retry_at ASC, id ASC
                LIMIT ?
                """,
                (current, max(1, min(int(limit), 200))),
            ).fetchall()
        return [int(row["id"]) for row in rows]

    def upsert_github_repositories(
        self,
        repositories: Iterable[Dict[str, object]],
        *,
        captured_at: Optional[str] = None,
    ) -> int:
        """Persist current repository features and a point-in-time activity snapshot."""
        captured = captured_at or utc_now_iso()
        saved = 0
        with self._connect() as conn:
            for raw in repositories:
                payload = _github_repository_payload(raw, captured)
                if payload is None:
                    continue
                conn.execute(
                    """
                    INSERT INTO github_repositories(
                        github_id, full_name, owner, name, description, html_url, homepage,
                        language, topics_json, license_name, features_json, stars, forks,
                        open_issues, watchers, size, default_branch, archived, disabled,
                        is_template, created_at, updated_at, pushed_at, first_seen_at,
                        last_seen_at, search_text
                    ) VALUES (
                        :github_id, :full_name, :owner, :name, :description, :html_url, :homepage,
                        :language, :topics_json, :license_name, :features_json, :stars, :forks,
                        :open_issues, :watchers, :size, :default_branch, :archived, :disabled,
                        :is_template, :created_at, :updated_at, :pushed_at, :first_seen_at,
                        :last_seen_at, :search_text
                    )
                    ON CONFLICT(github_id) DO UPDATE SET
                        full_name = excluded.full_name,
                        owner = excluded.owner,
                        name = excluded.name,
                        description = excluded.description,
                        html_url = excluded.html_url,
                        homepage = excluded.homepage,
                        language = excluded.language,
                        topics_json = excluded.topics_json,
                        license_name = excluded.license_name,
                        features_json = excluded.features_json,
                        stars = excluded.stars,
                        forks = excluded.forks,
                        open_issues = excluded.open_issues,
                        watchers = excluded.watchers,
                        size = excluded.size,
                        default_branch = excluded.default_branch,
                        archived = excluded.archived,
                        disabled = excluded.disabled,
                        is_template = excluded.is_template,
                        created_at = excluded.created_at,
                        updated_at = excluded.updated_at,
                        pushed_at = excluded.pushed_at,
                        last_seen_at = excluded.last_seen_at,
                        search_text = excluded.search_text
                    """,
                    payload,
                )
                row = conn.execute(
                    "SELECT id FROM github_repositories WHERE github_id = ?",
                    (payload["github_id"],),
                ).fetchone()
                if row is None:
                    continue
                repository_id = int(row["id"])
                conn.execute(
                    """
                    INSERT INTO github_repository_snapshots(
                        repository_id, captured_at, stars, forks, open_issues, pushed_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(repository_id, captured_at) DO UPDATE SET
                        stars = excluded.stars,
                        forks = excluded.forks,
                        open_issues = excluded.open_issues,
                        pushed_at = excluded.pushed_at
                    """,
                    (
                        repository_id,
                        captured,
                        payload["stars"],
                        payload["forks"],
                        payload["open_issues"],
                        payload["pushed_at"],
                    ),
                )
                if self._github_fts_available:
                    conn.execute("DELETE FROM github_repository_fts WHERE rowid = ?", (repository_id,))
                    conn.execute(
                        """
                        INSERT INTO github_repository_fts(
                            rowid, full_name, description, topics, language, license_name, features
                        ) VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            repository_id,
                            payload["full_name"],
                            payload["description"],
                            " ".join(json.loads(str(payload["topics_json"]))),
                            payload["language"],
                            payload["license_name"],
                            payload["search_text"],
                        ),
                    )
                saved += 1
            retention_cutoff = (
                datetime.now(timezone.utc) - timedelta(days=40)
            ).replace(microsecond=0).isoformat()
            conn.execute(
                "DELETE FROM github_repository_snapshots WHERE captured_at < ?",
                (retention_cutoff,),
            )
        return saved

    def get_github_repository_analysis(self, full_name: str) -> Optional[Dict[str, object]]:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT languages_json, analysis_source_hash, ai_summary_zh,
                       ai_significance_zh, ai_problem_zh, ai_model, ai_generated_at
                FROM github_repositories WHERE full_name = ?
                """,
                (str(full_name),),
            ).fetchone()
        if row is None:
            return None
        result = dict(row)
        try:
            result["language_breakdown"] = json.loads(str(result.pop("languages_json") or "[]"))
        except (TypeError, ValueError, json.JSONDecodeError):
            result["language_breakdown"] = []
        return result

    def save_github_repository_analysis(
        self,
        full_name: str,
        *,
        language_breakdown: List[Dict[str, object]],
        source_hash: str,
        explanation: Dict[str, str],
        model: str,
        generated_at: Optional[str] = None,
    ) -> bool:
        with self._connect() as conn:
            cursor = conn.execute(
                """
                UPDATE github_repositories
                SET languages_json = ?, analysis_source_hash = ?, ai_summary_zh = ?,
                    ai_significance_zh = ?, ai_problem_zh = ?, ai_model = ?,
                    ai_generated_at = ?
                WHERE full_name = ?
                """,
                (
                    json.dumps(language_breakdown, ensure_ascii=False, separators=(",", ":")),
                    str(source_hash),
                    str(explanation.get("summary_zh") or "")[:500],
                    str(explanation.get("significance_zh") or "")[:500],
                    str(explanation.get("problem_zh") or "")[:500],
                    str(model)[:200],
                    generated_at or utc_now_iso(),
                    str(full_name),
                ),
            )
        return cursor.rowcount > 0

    def list_github_repository_names(self, *, limit: int = 100) -> List[str]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT full_name
                FROM github_repositories
                WHERE archived = 0 AND disabled = 0
                ORDER BY last_seen_at ASC, id ASC
                LIMIT ?
                """,
                (max(1, min(int(limit), 500)),),
            ).fetchall()
        return [str(row["full_name"]) for row in rows]

    def list_github_rank_candidates(
        self,
        *,
        cutoff: str,
        language: str = "",
        query: str = "",
    ) -> List[Dict[str, object]]:
        clauses = ["r.archived = 0", "r.disabled = 0"]
        filter_params: List[object] = []
        normalized_language = language.strip()
        if normalized_language:
            clauses.append("r.language = ? COLLATE NOCASE")
            filter_params.append(normalized_language)
        normalized_query = query.strip()
        if normalized_query:
            fts_query = _github_fts_query(normalized_query)
            if self._github_fts_available and fts_query:
                clauses.append(
                    "r.id IN (SELECT rowid FROM github_repository_fts WHERE github_repository_fts MATCH ?)"
                )
                filter_params.append(fts_query)
            else:
                clauses.append("r.search_text LIKE ?")
                filter_params.append(f"%{normalized_query}%")
        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT r.*,
                    COALESCE(
                        (SELECT s.stars FROM github_repository_snapshots s
                         WHERE s.repository_id = r.id AND s.captured_at <= ?
                         ORDER BY s.captured_at DESC LIMIT 1),
                        (SELECT s.stars FROM github_repository_snapshots s
                         WHERE s.repository_id = r.id ORDER BY s.captured_at ASC LIMIT 1),
                        r.stars
                    ) AS baseline_stars,
                    COALESCE(
                        (SELECT s.forks FROM github_repository_snapshots s
                         WHERE s.repository_id = r.id AND s.captured_at <= ?
                         ORDER BY s.captured_at DESC LIMIT 1),
                        (SELECT s.forks FROM github_repository_snapshots s
                         WHERE s.repository_id = r.id ORDER BY s.captured_at ASC LIMIT 1),
                        r.forks
                    ) AS baseline_forks,
                    COALESCE(
                        (SELECT s.open_issues FROM github_repository_snapshots s
                         WHERE s.repository_id = r.id AND s.captured_at <= ?
                         ORDER BY s.captured_at DESC LIMIT 1),
                        (SELECT s.open_issues FROM github_repository_snapshots s
                         WHERE s.repository_id = r.id ORDER BY s.captured_at ASC LIMIT 1),
                        r.open_issues
                    ) AS baseline_open_issues,
                    COALESCE(
                        (SELECT s.captured_at FROM github_repository_snapshots s
                         WHERE s.repository_id = r.id AND s.captured_at <= ?
                         ORDER BY s.captured_at DESC LIMIT 1),
                        (SELECT s.captured_at FROM github_repository_snapshots s
                         WHERE s.repository_id = r.id ORDER BY s.captured_at ASC LIMIT 1),
                        r.first_seen_at
                    ) AS baseline_captured_at,
                    EXISTS(
                        SELECT 1 FROM github_repository_snapshots s
                        WHERE s.repository_id = r.id AND s.captured_at <= ?
                    ) AS history_complete
                FROM github_repositories r
                WHERE {' AND '.join(clauses)}
                LIMIT 10000
                """,
                tuple([cutoff, cutoff, cutoff, cutoff, cutoff] + filter_params),
            ).fetchall()
        return [_github_repository_dict(row) for row in rows]

    def list_github_languages(self) -> List[Dict[str, object]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT language, COUNT(*) AS repository_count
                FROM github_repositories
                WHERE archived = 0 AND disabled = 0 AND TRIM(language) <> ''
                GROUP BY language COLLATE NOCASE
                ORDER BY repository_count DESC, language COLLATE NOCASE
                """
            ).fetchall()
        return [
            {"language": str(row["language"]), "repository_count": int(row["repository_count"])}
            for row in rows
        ]

    def record_github_collection_run(
        self,
        *,
        started_at: str,
        finished_at: str,
        status: str,
        fetched_count: int,
        saved_count: int,
        error: Optional[str] = None,
        rate_limit_remaining: Optional[int] = None,
        rate_limit_reset: Optional[str] = None,
    ) -> int:
        with self._connect() as conn:
            cursor = conn.execute(
                """
                INSERT INTO github_collection_runs(
                    started_at, finished_at, status, fetched_count, saved_count,
                    error, rate_limit_remaining, rate_limit_reset
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    started_at, finished_at, status, int(fetched_count), int(saved_count),
                    error, rate_limit_remaining, rate_limit_reset,
                ),
            )
            return int(cursor.lastrowid)

    def get_latest_github_collection_run(self) -> Optional[Dict[str, object]]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM github_collection_runs ORDER BY id DESC LIMIT 1"
            ).fetchone()
        return dict(row) if row is not None else None

    def _match_alert_rules(self, conn: sqlite3.Connection, message_db_id: int) -> None:
        message = conn.execute("SELECT * FROM messages WHERE id = ?", (int(message_db_id),)).fetchone()
        if message is None:
            return
        rules = conn.execute("SELECT * FROM alert_rules WHERE enabled = 1 ORDER BY id").fetchall()
        content = str(message["content"] or "").casefold()
        for rule in rules:
            keyword = str(rule["keyword"] or "").strip().casefold()
            if not keyword or keyword not in content:
                continue
            required_media = str(rule["media_type"] or "").strip()
            actual_media = str(message["media_type"] or "")
            if required_media == "text" and actual_media:
                continue
            if required_media and required_media != "text" and required_media != actual_media:
                continue
            sources = conn.execute(
                "SELECT chat_id FROM alert_rule_sources WHERE rule_id = ?",
                (int(rule["id"]),),
            ).fetchall()
            if sources and int(message["chat_id"]) not in {int(row["chat_id"]) for row in sources}:
                continue
            message_time = _parse_datetime(str(message["message_time"]))
            if _inside_quiet_hours(
                message_time.astimezone(ZoneInfo(self.timezone_name)),
                str(rule["quiet_start"] or ""),
                str(rule["quiet_end"] or ""),
            ):
                continue
            cooldown_minutes = max(0, int(rule["cooldown_minutes"] or 0))
            if cooldown_minutes:
                previous = conn.execute(
                    """
                    SELECT m.message_time
                    FROM alert_matches am
                    JOIN messages m ON m.id = am.message_id
                    WHERE am.rule_id = ?
                    ORDER BY am.id DESC
                    LIMIT 1
                    """,
                    (int(rule["id"]),),
                ).fetchone()
                if previous is not None:
                    previous_time = _parse_datetime(str(previous["message_time"]))
                    if message_time < previous_time + timedelta(minutes=cooldown_minutes):
                        continue
            conn.execute(
                """
                INSERT OR IGNORE INTO alert_matches(rule_id, message_id, status, matched_at)
                VALUES (?, ?, 'new', ?)
                """,
                (int(rule["id"]), int(message_db_id), utc_now_iso()),
            )

    def _connect(self):
        return self.db.connect()


def _parse_datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def _inside_quiet_hours(value: datetime, start_text: str, end_text: str) -> bool:
    if not start_text or not end_text or start_text == end_text:
        return False
    start_hour, start_minute = (int(part) for part in start_text.split(":", 1))
    end_hour, end_minute = (int(part) for part in end_text.split(":", 1))
    current = value.hour * 60 + value.minute
    start = start_hour * 60 + start_minute
    end = end_hour * 60 + end_minute
    if start < end:
        return start <= current < end
    return current >= start or current < end


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    existing = {str(row["name"]) for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def _pending_chunk_results(chunk_count: int) -> List[Dict[str, object]]:
    return [
        {"index": index, "status": "pending", "error": None}
        for index in range(1, max(1, int(chunk_count)) + 1)
    ]


def _final_chunk_results(
    *,
    success: bool,
    status: str,
    chunk_count: int,
    completed_chunks: int,
    error: object,
) -> List[Dict[str, object]]:
    count = max(1, int(chunk_count))
    if status in {"pending", "in_progress"}:
        return _pending_chunk_results(count)
    if success:
        return [
            {"index": index, "status": "succeeded", "error": None}
            for index in range(1, count + 1)
        ]

    completed = min(count, max(0, int(completed_chunks)))
    safe_error = _sanitize_delivery_error(error)
    results: List[Dict[str, object]] = []
    for index in range(1, count + 1):
        if index <= completed:
            chunk_status = "succeeded"
            chunk_error = None
        elif index == completed + 1:
            chunk_status = "failed"
            chunk_error = safe_error
        else:
            chunk_status = "not_attempted"
            chunk_error = None
        results.append({"index": index, "status": chunk_status, "error": chunk_error})
    return results


def _encode_chunk_results(results: List[Dict[str, object]]) -> str:
    return json.dumps(results, ensure_ascii=False, separators=(",", ":"))


def _decode_chunk_results(
    raw: object,
    *,
    status: str,
    chunk_count: int,
    completed_chunks: int,
    error: object,
) -> List[Dict[str, object]]:
    try:
        decoded = json.loads(str(raw or "[]"))
    except (TypeError, ValueError, json.JSONDecodeError):
        decoded = []
    if isinstance(decoded, list) and decoded:
        return [dict(item) for item in decoded if isinstance(item, dict)]
    return _final_chunk_results(
        success=status == "succeeded",
        status=status,
        chunk_count=chunk_count,
        completed_chunks=completed_chunks,
        error=error,
    )


def _sanitize_delivery_error(error: object) -> Optional[str]:
    if error is None:
        return None
    value = str(error).strip()
    if not value:
        return None
    urls: List[str] = []

    def preserve_url(match: re.Match[str]) -> str:
        urls.append(match.group(0))
        return f"__DELIVERY_URL_{len(urls) - 1}__"

    value = re.sub(r"https?://[^\s'\"<>]+", preserve_url, value)
    value = re.sub(
        (
            r"(?<![\w.])(?:"
            r"[A-Za-z]:[\\/][^\s'\"<>]+|"
            r"(?:/[^\s'\"<>:,;]+)+|"
            r"(?:[A-Za-z0-9_.-]+[\\/])+(?:[A-Za-z0-9_.-]+)"
            r")"
        ),
        "[redacted-path]",
        value,
    )
    for index, url in enumerate(urls):
        value = value.replace(f"__DELIVERY_URL_{index}__", url)
    return value[:1000]


def _parse_utc_datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _alert_rule_dict(row: sqlite3.Row, source_ids: List[int]) -> Dict[str, object]:
    result = dict(row)
    result["enabled"] = bool(result["enabled"])
    result["source_ids"] = source_ids
    return result


def _github_repository_payload(
    raw: Dict[str, object], captured_at: str
) -> Optional[Dict[str, object]]:
    try:
        github_id = int(raw["id"])
    except (KeyError, TypeError, ValueError):
        return None
    full_name = str(raw.get("full_name") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", full_name):
        return None
    owner_name, repository_name = full_name.split("/", 1)
    raw_owner = raw.get("owner")
    if isinstance(raw_owner, dict):
        owner_name = str(raw_owner.get("login") or owner_name).strip() or owner_name
    raw_topics = raw.get("topics")
    topics = [
        str(topic).strip()[:80]
        for topic in raw_topics
        if isinstance(topic, str) and topic.strip()
    ][:30] if isinstance(raw_topics, list) else []
    raw_license = raw.get("license")
    license_name = ""
    if isinstance(raw_license, dict):
        license_name = str(
            raw_license.get("spdx_id") or raw_license.get("name") or ""
        ).strip()[:120]
        if license_name.upper() == "NOASSERTION":
            license_name = str(raw_license.get("name") or "").strip()[:120]
    language = str(raw.get("language") or "").strip()[:80]
    description = str(raw.get("description") or "").strip()[:2000]
    homepage = str(raw.get("homepage") or "").strip()[:500]
    features = {
        "topics": topics,
        "language": language,
        "license": license_name,
        "has_issues": bool(raw.get("has_issues", True)),
        "has_projects": bool(raw.get("has_projects", True)),
        "has_wiki": bool(raw.get("has_wiki", True)),
        "has_pages": bool(raw.get("has_pages", False)),
        "has_discussions": bool(raw.get("has_discussions", False)),
        "is_template": bool(raw.get("is_template", False)),
        "default_branch": str(raw.get("default_branch") or "")[:200],
    }
    search_text = " ".join(
        part for part in [full_name, description, language, license_name, *topics] if part
    )[:12000]
    created_at = str(raw.get("created_at") or captured_at)
    updated_at = str(raw.get("updated_at") or captured_at)
    pushed_at = str(raw.get("pushed_at") or "").strip() or None
    return {
        "github_id": github_id,
        "full_name": full_name,
        "owner": owner_name[:255],
        "name": repository_name[:255],
        "description": description,
        "html_url": f"https://github.com/{full_name}",
        "homepage": homepage,
        "language": language,
        "topics_json": json.dumps(topics, ensure_ascii=False, separators=(",", ":")),
        "license_name": license_name,
        "features_json": json.dumps(features, ensure_ascii=False, separators=(",", ":")),
        "stars": max(0, int(raw.get("stargazers_count") or 0)),
        "forks": max(0, int(raw.get("forks_count") or 0)),
        "open_issues": max(0, int(raw.get("open_issues_count") or 0)),
        "watchers": max(0, int(raw.get("subscribers_count") or raw.get("watchers_count") or 0)),
        "size": max(0, int(raw.get("size") or 0)),
        "default_branch": str(raw.get("default_branch") or "")[:200],
        "archived": int(bool(raw.get("archived", False))),
        "disabled": int(bool(raw.get("disabled", False))),
        "is_template": int(bool(raw.get("is_template", False))),
        "created_at": created_at,
        "updated_at": updated_at,
        "pushed_at": pushed_at,
        "first_seen_at": captured_at,
        "last_seen_at": captured_at,
        "search_text": search_text,
    }


def _github_repository_dict(row: sqlite3.Row) -> Dict[str, object]:
    result = dict(row)
    for key in ("topics_json", "features_json", "languages_json"):
        try:
            decoded = json.loads(str(result.pop(key, "")))
        except (TypeError, ValueError, json.JSONDecodeError):
            decoded = {} if key == "features_json" else []
        target_key = {
            "topics_json": "topics",
            "features_json": "features",
            "languages_json": "language_breakdown",
        }[key]
        result[target_key] = decoded
    for key in ("archived", "disabled", "is_template", "history_complete"):
        result[key] = bool(result.get(key))
    return result


def _github_fts_query(query: str) -> str:
    tokens = re.findall(r"[\w.+#-]+", query, flags=re.UNICODE)[:12]
    return " AND ".join(f'"{token.replace(chr(34), "")}"*' for token in tokens if token)


def row_to_message(row: sqlite3.Row) -> StoredMessage:
    return StoredMessage(
        id=int(row["id"]),
        chat_id=int(row["chat_id"]),
        chat_title=str(row["chat_title"] or ""),
        message_id=int(row["message_id"]),
        sender_name=str(row["sender_name"] or ""),
        message_time=str(row["message_time"]),
        content=str(row["content"] or ""),
        media_type=row["media_type"],
        raw_json=str(row["raw_json"]),
        forwarded_at=row["forwarded_at"],
        content_version=int(row["content_version"] or 1),
    )


def row_to_source(row: sqlite3.Row) -> StoredSource:
    keys = set(row.keys())
    source_type = str(row["source_type"] or "telegram_public")
    adapter = str(row["adapter"] or "") if "adapter" in keys else ""
    locator = str(row["locator"] or "") if "locator" in keys else ""
    config_json = str(row["config_json"] or "{}") if "config_json" in keys else "{}"
    return StoredSource(
        chat_id=int(row["chat_id"]),
        name=str(row["name"]),
        source_url=str(row["source_url"]),
        source_type=adapter or source_type,
        enabled=bool(row["enabled"]),
        public_visible=bool(row["public_visible"]),
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
        adapter=adapter or source_type or "telegram_public",
        locator=locator or str(row["source_url"]),
        config_json=config_json or "{}",
    )


def message_payload_changed(row: sqlite3.Row, payload: Dict[str, object]) -> bool:
    if str(row["content"] or "") != str(payload["content"] or ""):
        return True
    if (row["media_type"] or None) != (payload["media_type"] or None):
        return True
    return media_urls_from_raw_json(str(row["raw_json"] or "")) != media_urls_from_raw_json(
        str(payload["raw_json"] or "")
    )


def message_payload_is_displayable(payload: Dict[str, object]) -> bool:
    media_type = payload.get("media_type")
    if media_type == "poll":
        return False
    content = str(payload.get("content") or "").strip()
    return bool(content or media_type)


def media_urls_from_raw_json(raw_json: str) -> List[str]:
    try:
        raw = json.loads(raw_json)
    except json.JSONDecodeError:
        return []
    media_urls = raw.get("media_urls", []) if isinstance(raw, dict) else []
    if isinstance(media_urls, str):
        return [media_urls]
    if isinstance(media_urls, list):
        return [str(url) for url in media_urls if isinstance(url, str)]
    return []


def media_items_from_raw_json(raw_json: str, fallback_media_type: Optional[str] = None) -> List[Dict[str, str]]:
    try:
        raw = json.loads(raw_json)
    except json.JSONDecodeError:
        raw = {}
    if isinstance(raw, dict):
        raw_items = raw.get("media_items", [])
        if isinstance(raw_items, list):
            items = []
            for item in raw_items:
                if not isinstance(item, dict) or not isinstance(item.get("url"), str):
                    continue
                kind = str(item.get("kind") or fallback_media_kind(fallback_media_type))
                role = str(item.get("role") or fallback_media_role(fallback_media_type))
                items.append({"url": item["url"], "kind": kind, "role": role})
            if items:
                return items

    return [
        {
            "url": url,
            "kind": fallback_media_kind(fallback_media_type),
            "role": fallback_media_role(fallback_media_type),
        }
        for url in media_urls_from_raw_json(raw_json)
    ]


def fallback_media_kind(media_type: Optional[str]) -> str:
    if media_type in {"photo", "video"}:
        return "image"
    if media_type in {"animation"}:
        return "video"
    return str(media_type or "file")


def fallback_media_role(media_type: Optional[str]) -> str:
    return "poster" if media_type == "video" else "media"


def source_url_from_raw_json(raw_json: str) -> str:
    try:
        raw = json.loads(raw_json)
    except json.JSONDecodeError:
        return ""
    if not isinstance(raw, dict):
        return ""
    return str(raw.get("source_url") or "")


def build_message_filters(
    *,
    chat_id: Optional[int],
    query: str,
    media: str,
    allowed_chat_ids: Optional[Sequence[int]] = None,
) -> tuple[str, tuple[object, ...]]:
    clauses = [DISPLAYABLE_MESSAGE_SQL]
    params: List[object] = []
    if chat_id is not None:
        clauses.append("chat_id = ?")
        params.append(int(chat_id))
    if allowed_chat_ids is not None:
        allowed = [int(value) for value in allowed_chat_ids]
        if not allowed:
            clauses.append("0 = 1")
        else:
            placeholders = ",".join("?" for _ in allowed)
            clauses.append(f"chat_id IN ({placeholders})")
            params.extend(allowed)
    normalized_query = query.strip()
    if normalized_query:
        clauses.append("(content LIKE ? OR sender_name LIKE ? OR chat_title LIKE ?)")
        like = f"%{normalized_query}%"
        params.extend([like, like, like])
    if media == "text":
        clauses.append("media_type IS NULL")
    elif media not in {"", "all"}:
        clauses.append("media_type = ?")
        params.append(media)
    return " AND ".join(clauses), tuple(params)


def encode_message_cursor(message: StoredMessage) -> str:
    payload = json.dumps(
        {"message_time": message.message_time, "id": message.id},
        separators=(",", ":"),
    ).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def decode_message_cursor(cursor: str) -> tuple[Optional[str], Optional[int]]:
    if not cursor:
        return None, None
    try:
        padding = "=" * (-len(cursor) % 4)
        payload = json.loads(base64.urlsafe_b64decode((cursor + padding).encode("ascii")))
        message_time = payload.get("message_time")
        message_id = payload.get("id")
        if not isinstance(message_time, str):
            return None, None
        return message_time, int(message_id)
    except Exception:
        return None, None


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()
