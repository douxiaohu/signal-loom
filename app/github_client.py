from __future__ import annotations

import json
import base64
from datetime import datetime, timezone
from typing import Dict, List, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


class GitHubApiError(RuntimeError):
    pass


class GitHubClient:
    """Small dependency-free client for the public GitHub repository API."""

    def __init__(self, token: str = "", *, timeout_seconds: int = 20) -> None:
        self.token = token.strip()
        self.timeout_seconds = timeout_seconds
        self.rate_limit_remaining: Optional[int] = None
        self.rate_limit_reset: Optional[str] = None

    def search_repositories(
        self,
        query: str,
        *,
        sort: str = "stars",
        order: str = "desc",
        per_page: int = 30,
    ) -> List[Dict[str, object]]:
        payload = self._request_json(
            "/search/repositories",
            {
                "q": query,
                "sort": sort if sort in {"stars", "forks", "updated"} else "stars",
                "order": order if order in {"asc", "desc"} else "desc",
                "per_page": str(max(1, min(int(per_page), 100))),
                "page": "1",
            },
        )
        items = payload.get("items", []) if isinstance(payload, dict) else []
        return [dict(item) for item in items if isinstance(item, dict)]

    def get_repository(self, full_name: str) -> Dict[str, object]:
        owner, name = full_name.split("/", 1)
        payload = self._request_json(f"/repos/{owner}/{name}")
        if not isinstance(payload, dict):
            raise GitHubApiError(f"GitHub returned an invalid repository payload for {full_name}")
        return dict(payload)

    def get_repository_languages(self, full_name: str) -> Dict[str, int]:
        owner, name = full_name.split("/", 1)
        payload = self._request_json(f"/repos/{owner}/{name}/languages")
        return {
            str(language): int(byte_count)
            for language, byte_count in payload.items()
            if isinstance(language, str) and isinstance(byte_count, int) and byte_count > 0
        }

    def get_repository_readme(self, full_name: str, *, max_chars: int = 12000) -> str:
        owner, name = full_name.split("/", 1)
        try:
            payload = self._request_json(f"/repos/{owner}/{name}/readme")
        except GitHubApiError as exc:
            if "HTTP 404" in str(exc):
                return ""
            raise
        encoded = payload.get("content")
        if not isinstance(encoded, str) or payload.get("encoding") != "base64":
            return ""
        try:
            decoded = base64.b64decode(encoded, validate=False).decode("utf-8", errors="replace")
        except (ValueError, TypeError):
            return ""
        return " ".join(decoded.split())[: max(1, int(max_chars))]

    def _request_json(
        self, path: str, params: Optional[Dict[str, str]] = None
    ) -> Dict[str, object]:
        query_string = f"?{urlencode(params)}" if params else ""
        request = Request(
            f"https://api.github.com{path}{query_string}",
            headers=self._headers(),
            method="GET",
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                self._remember_rate_limit(response.headers)
                raw = response.read()
        except HTTPError as exc:
            self._remember_rate_limit(exc.headers)
            detail = ""
            try:
                decoded = json.loads(exc.read().decode("utf-8", errors="replace"))
                if isinstance(decoded, dict):
                    detail = str(decoded.get("message") or "")
            except (ValueError, json.JSONDecodeError):
                detail = ""
            suffix = f": {detail[:300]}" if detail else ""
            raise GitHubApiError(f"GitHub API HTTP {exc.code}{suffix}") from exc
        except (URLError, TimeoutError, OSError) as exc:
            raise GitHubApiError(f"GitHub API unavailable: {exc}") from exc
        try:
            decoded = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError) as exc:
            raise GitHubApiError("GitHub returned invalid JSON") from exc
        if not isinstance(decoded, dict):
            raise GitHubApiError("GitHub returned an unexpected response")
        return decoded

    def _headers(self) -> Dict[str, str]:
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "telegram-fastapi-github-zone/1.0",
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    def _remember_rate_limit(self, headers) -> None:
        try:
            self.rate_limit_remaining = int(headers.get("X-RateLimit-Remaining"))
        except (TypeError, ValueError):
            self.rate_limit_remaining = None
        try:
            reset_at = int(headers.get("X-RateLimit-Reset"))
            self.rate_limit_reset = datetime.fromtimestamp(
                reset_at, tz=timezone.utc
            ).replace(microsecond=0).isoformat()
        except (TypeError, ValueError, OSError, OverflowError):
            self.rate_limit_reset = None
