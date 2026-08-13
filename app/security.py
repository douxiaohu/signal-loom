from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Optional
from urllib.parse import urlsplit

from fastapi import HTTPException, Request, status


SESSION_COOKIE_NAME = "tg_session"


class SessionSigner:
    def __init__(self, secret: str, *, ttl_seconds: int) -> None:
        if not secret:
            raise ValueError("session secret is required")
        self._secret = secret.encode("utf-8")
        self.ttl_seconds = max(1, int(ttl_seconds))
        self._active_sessions: dict[str, int] = {}

    def issue(self, *, now: Optional[float] = None) -> tuple[str, int]:
        issued_at = int(time.time() if now is None else now)
        expires_at = issued_at + self.ttl_seconds
        self._prune(issued_at)
        session_id = secrets.token_urlsafe(18)
        self._active_sessions[session_id] = expires_at
        payload = _b64encode(
            json.dumps({"exp": expires_at, "sid": session_id}, separators=(",", ":")).encode("utf-8")
        )
        signature = _b64encode(hmac.new(self._secret, payload.encode("ascii"), hashlib.sha256).digest())
        return f"{payload}.{signature}", expires_at

    def verify(self, token: str, *, now: Optional[float] = None) -> Optional[int]:
        try:
            payload, supplied_signature = token.split(".", 1)
            expected_signature = _b64encode(
                hmac.new(self._secret, payload.encode("ascii"), hashlib.sha256).digest()
            )
            if not hmac.compare_digest(supplied_signature, expected_signature):
                return None
            decoded = json.loads(_b64decode(payload))
            expires_at = int(decoded["exp"])
            session_id = str(decoded["sid"])
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            return None
        current_time = int(time.time() if now is None else now)
        active_expiry = self._active_sessions.get(session_id)
        return expires_at if expires_at > current_time and active_expiry == expires_at else None

    def revoke(self, token: str) -> None:
        try:
            payload, supplied_signature = token.split(".", 1)
            expected_signature = _b64encode(
                hmac.new(self._secret, payload.encode("ascii"), hashlib.sha256).digest()
            )
            if not hmac.compare_digest(supplied_signature, expected_signature):
                return
            decoded = json.loads(_b64decode(payload))
            session_id = str(decoded["sid"])
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            return
        self._active_sessions.pop(session_id, None)

    def _prune(self, now: int) -> None:
        expired = [session_id for session_id, expires_at in self._active_sessions.items() if expires_at <= now]
        for session_id in expired:
            self._active_sessions.pop(session_id, None)


class LoginAttemptLimiter:
    def __init__(self, *, max_attempts: int = 5, window_seconds: int = 900) -> None:
        self.max_attempts = max(1, int(max_attempts))
        self.window_seconds = max(1, int(window_seconds))
        self._failures: dict[str, list[int]] = {}

    def is_allowed(self, key: str, *, now: Optional[float] = None) -> bool:
        current = int(time.time() if now is None else now)
        recent = [stamp for stamp in self._failures.get(key, []) if stamp > current - self.window_seconds]
        self._failures[key] = recent
        return len(recent) < self.max_attempts

    def record_failure(self, key: str, *, now: Optional[float] = None) -> None:
        current = int(time.time() if now is None else now)
        self.is_allowed(key, now=current)
        self._failures.setdefault(key, []).append(current)

    def reset(self, key: str) -> None:
        self._failures.pop(key, None)


def get_session_signer(request: Request) -> SessionSigner:
    signer = getattr(request.app.state, "session_signer", None)
    if signer is not None:
        return signer
    config = request.app.state.config
    signer = SessionSigner(config.session_secret, ttl_seconds=config.session_ttl_hours * 3600)
    request.app.state.session_signer = signer
    return signer


def session_expiry(request: Request) -> Optional[int]:
    token = request.cookies.get(SESSION_COOKIE_NAME, "")
    return get_session_signer(request).verify(token) if token else None


async def require_session(request: Request) -> int:
    expires_at = session_expiry(request)
    if expires_at is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    return expires_at


async def require_same_origin(request: Request) -> None:
    origin = request.headers.get("origin", "").strip()
    config = request.app.state.config
    if not origin and config.app_env in {"development", "test", "testing"}:
        return
    if not origin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Origin header required")
    origin_parts = urlsplit(origin)
    host = request.headers.get("host", "").strip()
    try:
        host_parts = urlsplit(f"//{host}")
        origin_port = origin_parts.port
        host_port = host_parts.port
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cross-origin request rejected",
        ) from None
    same_host = bool(
        origin_parts.scheme in {"http", "https"}
        and origin_parts.hostname
        and host_parts.hostname
        and origin_parts.hostname.rstrip(".").lower()
        == host_parts.hostname.rstrip(".").lower()
    )
    if host_port is not None:
        same_host = same_host and (origin_port or _default_port(origin_parts.scheme)) == host_port
    elif origin_port is not None:
        same_host = same_host and origin_port == _default_port(origin_parts.scheme)
    if not same_host:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cross-origin request rejected")


def _default_port(scheme: str) -> Optional[int]:
    return {"http": 80, "https": 443}.get(scheme.lower())


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)
