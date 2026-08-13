from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, Optional

from .source_utils import public_source_chat_id


DEFAULT_DATABASE_URL = "sqlite:///./data/telegram_forwarder.db"
DEFAULT_TIMEZONE = "Asia/Shanghai"
DEFAULT_FORWARD_CRON = "0 * * * *"
DEFAULT_CRAWL_INTERVAL_SECONDS = 300
DEFAULT_GROUPS_CONFIG_PATH = "config/groups.yaml"
DEFAULT_SCREENSHOT_OUTPUT_DIR = "./data/screenshots"
DEFAULT_MEDIA_CACHE_DIR = "./data/media-cache"
DEFAULT_GITHUB_REFRESH_INTERVAL_SECONDS = 1800
DEFAULT_GITHUB_LANGUAGES = (
    "Python", "JavaScript", "TypeScript", "Java", "Go", "Rust",
    "C++", "C#", "PHP", "Swift", "Kotlin", "Ruby",
)


@dataclass(frozen=True)
class GroupConfig:
    chat_id: int
    name: str
    webhook_url: str = ""
    source: Optional[str] = None
    source_type: str = "telegram_bot"
    screenshot_enabled: bool = True

    @property
    def forward_enabled(self) -> bool:
        return bool(self.webhook_url) or self.screenshot_enabled


@dataclass(frozen=True)
class AppConfig:
    telegram_bot_token: str
    database_url: str
    timezone: str
    forward_cron: str
    groups_config_path: str
    groups: Dict[int, GroupConfig]
    crawl_interval_seconds: int = DEFAULT_CRAWL_INTERVAL_SECONDS
    admin_api_key: str = ""
    screenshot_output_dir: str = DEFAULT_SCREENSHOT_OUTPUT_DIR
    media_cache_dir: str = DEFAULT_MEDIA_CACHE_DIR
    session_secret: str = ""
    session_ttl_hours: int = 12
    session_cookie_secure: bool = True
    app_env: str = "production"
    login_max_attempts: int = 5
    login_window_seconds: int = 900
    source_stale_after_seconds: int = 900
    github_enabled: bool = True
    github_token: str = ""
    github_refresh_interval_seconds: int = DEFAULT_GITHUB_REFRESH_INTERVAL_SECONDS
    github_languages: tuple[str, ...] = DEFAULT_GITHUB_LANGUAGES
    github_candidates_per_language: int = 30
    github_min_stars: int = 20
    github_ai_enabled: bool = False
    github_ai_api_key: str = ""
    github_ai_base_url: str = "https://api.openai.com/v1"
    github_ai_model: str = ""
    github_ai_timeout_seconds: int = 45
    github_ai_repositories_per_refresh: int = 6

    def group_for_chat(self, chat_id: int) -> Optional[GroupConfig]:
        return self.groups.get(int(chat_id))

    def public_source_groups(self) -> List[GroupConfig]:
        return [
            group
            for group in self.groups.values()
            if group.source_type == "telegram_public" and group.source
        ]


def load_config(
    env_path: str = ".env",
    groups_path: Optional[str] = None,
    *,
    require_token: bool = True,
) -> AppConfig:
    env_values = load_env_file(env_path)
    merged = {**env_values, **os.environ}

    token = merged.get("TELEGRAM_BOT_TOKEN", "").strip()
    if require_token and not token:
        raise ValueError("TELEGRAM_BOT_TOKEN is required")

    configured_groups_path = (
        groups_path
        or merged.get("GROUPS_CONFIG_PATH")
        or DEFAULT_GROUPS_CONFIG_PATH
    )
    groups = load_groups_file(configured_groups_path)

    return AppConfig(
        telegram_bot_token=token,
        database_url=merged.get("DATABASE_URL", DEFAULT_DATABASE_URL).strip()
        or DEFAULT_DATABASE_URL,
        timezone=merged.get("TIMEZONE", DEFAULT_TIMEZONE).strip() or DEFAULT_TIMEZONE,
        forward_cron=merged.get("FORWARD_CRON", DEFAULT_FORWARD_CRON).strip()
        or DEFAULT_FORWARD_CRON,
        crawl_interval_seconds=parse_positive_int(
            merged.get("CRAWL_INTERVAL_SECONDS"),
            default=DEFAULT_CRAWL_INTERVAL_SECONDS,
        ),
        groups_config_path=configured_groups_path,
        groups={group.chat_id: group for group in groups},
        admin_api_key=merged.get("ADMIN_API_KEY", "").strip(),
        screenshot_output_dir=merged.get(
            "SCREENSHOT_OUTPUT_DIR",
            DEFAULT_SCREENSHOT_OUTPUT_DIR,
        ).strip()
        or DEFAULT_SCREENSHOT_OUTPUT_DIR,
        media_cache_dir=merged.get("MEDIA_CACHE_DIR", DEFAULT_MEDIA_CACHE_DIR).strip()
        or DEFAULT_MEDIA_CACHE_DIR,
        session_secret=merged.get("SESSION_SECRET", "").strip(),
        session_ttl_hours=parse_positive_int(merged.get("SESSION_TTL_HOURS"), default=12),
        session_cookie_secure=parse_bool(merged.get("SESSION_COOKIE_SECURE"), default=True),
        app_env=merged.get("APP_ENV", "production").strip().lower() or "production",
        login_max_attempts=parse_positive_int(merged.get("LOGIN_MAX_ATTEMPTS"), default=5),
        login_window_seconds=parse_positive_int(merged.get("LOGIN_WINDOW_SECONDS"), default=900),
        source_stale_after_seconds=parse_positive_int(
            merged.get("SOURCE_STALE_AFTER_SECONDS"), default=900
        ),
        github_enabled=parse_bool(merged.get("GITHUB_ENABLED"), default=True),
        github_token=merged.get("GITHUB_TOKEN", "").strip(),
        github_refresh_interval_seconds=parse_positive_int(
            merged.get("GITHUB_REFRESH_INTERVAL_SECONDS"),
            default=DEFAULT_GITHUB_REFRESH_INTERVAL_SECONDS,
        ),
        github_languages=parse_csv(
            merged.get("GITHUB_LANGUAGES"), default=DEFAULT_GITHUB_LANGUAGES
        ),
        github_candidates_per_language=min(
            100,
            parse_positive_int(merged.get("GITHUB_CANDIDATES_PER_LANGUAGE"), default=30),
        ),
        github_min_stars=parse_positive_int(merged.get("GITHUB_MIN_STARS"), default=20),
        github_ai_enabled=parse_bool(merged.get("GITHUB_AI_ENABLED"), default=False),
        github_ai_api_key=merged.get("GITHUB_AI_API_KEY", "").strip(),
        github_ai_base_url=merged.get(
            "GITHUB_AI_BASE_URL", "https://api.openai.com/v1"
        ).strip().rstrip("/"),
        github_ai_model=merged.get("GITHUB_AI_MODEL", "").strip(),
        github_ai_timeout_seconds=parse_positive_int(
            merged.get("GITHUB_AI_TIMEOUT_SECONDS"), default=45
        ),
        github_ai_repositories_per_refresh=min(
            24,
            parse_positive_int(
                merged.get("GITHUB_AI_REPOSITORIES_PER_REFRESH"), default=6
            ),
        ),
    )


def validate_security_config(config: AppConfig) -> None:
    if config.app_env in {"test", "testing"}:
        return
    if not config.admin_api_key:
        raise ValueError("ADMIN_API_KEY is required when APP_ENV is not test")
    if len(config.admin_api_key) < 16:
        raise ValueError("ADMIN_API_KEY must be at least 16 characters")
    if not config.session_secret:
        raise ValueError("SESSION_SECRET is required when APP_ENV is not test")
    if len(config.session_secret.encode("utf-8")) < 32:
        raise ValueError("SESSION_SECRET must be at least 32 bytes")
    if config.app_env == "production" and not config.session_cookie_secure:
        raise ValueError("SESSION_COOKIE_SECURE must be true in production")


def load_env_file(path: str) -> Dict[str, str]:
    env_path = Path(path)
    if not env_path.exists():
        return {}

    values: Dict[str, str] = {}
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key:
            continue
        values[key] = _strip_quotes(value.strip())
    return values


def load_groups_file(path: str) -> List[GroupConfig]:
    groups_path = Path(path)
    if not groups_path.exists():
        return []

    raw_text = groups_path.read_text(encoding="utf-8")
    loaded = _load_yaml(raw_text)
    raw_groups = loaded.get("groups", []) if isinstance(loaded, Mapping) else []
    if not isinstance(raw_groups, Iterable):
        raise ValueError("groups config must contain a list named 'groups'")

    groups: List[GroupConfig] = []
    for index, item in enumerate(raw_groups, start=1):
        if not isinstance(item, Mapping):
            raise ValueError(f"groups[{index}] must be a mapping")
        try:
            source = str(item.get("source") or "").strip() or None
            chat_id = int(item["chat_id"]) if "chat_id" in item else public_source_chat_id(source or "")
            name = str(item.get("name") or source or chat_id).strip()
            webhook_url = str(item.get("webhook_url") or "").strip()
            screenshot_enabled = parse_bool(item.get("screenshot_enabled"), default=True)
        except KeyError as exc:
            raise ValueError(f"groups[{index}] missing required key: {exc}") from exc

        source_type = str(item.get("source_type") or ("telegram_public" if source else "telegram_bot")).strip()
        groups.append(
            GroupConfig(
                chat_id=chat_id,
                name=name,
                webhook_url=webhook_url,
                source=source,
                source_type=source_type,
                screenshot_enabled=screenshot_enabled,
            )
        )
    seen_chat_ids = set()
    for group in groups:
        if group.chat_id in seen_chat_ids:
            raise ValueError(f"duplicate chat_id in groups config: {group.chat_id}")
        seen_chat_ids.add(group.chat_id)
    return groups


def _strip_quotes(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def _load_yaml(raw_text: str) -> Mapping[str, object]:
    try:
        import yaml  # type: ignore

        loaded = yaml.safe_load(raw_text) or {}
        if not isinstance(loaded, Mapping):
            raise ValueError("YAML root must be a mapping")
        return loaded
    except ModuleNotFoundError:
        return _load_simple_groups_yaml(raw_text)


def _load_simple_groups_yaml(raw_text: str) -> Mapping[str, object]:
    """Fallback parser for the documented groups.yaml shape.

    Runtime installs should use PyYAML. This narrow fallback keeps local unit
    tests and basic deployments usable before dependencies are installed.
    """
    groups: List[Dict[str, object]] = []
    current: Optional[Dict[str, object]] = None

    for raw_line in raw_text.splitlines():
        line = raw_line.split("#", 1)[0].rstrip()
        stripped = line.strip()
        if not stripped or stripped == "groups:":
            continue
        if stripped.startswith("- "):
            if current:
                groups.append(current)
            current = {}
            remainder = stripped[2:].strip()
            if remainder:
                key, value = _parse_yaml_key_value(remainder)
                current[key] = value
            continue
        if current is None:
            continue
        key, value = _parse_yaml_key_value(stripped)
        current[key] = value

    if current:
        groups.append(current)
    return {"groups": groups}


def _parse_yaml_key_value(line: str) -> tuple[str, object]:
    if ":" not in line:
        raise ValueError(f"Unsupported groups.yaml line: {line}")
    key, raw_value = line.split(":", 1)
    value = _strip_quotes(raw_value.strip())
    if key.strip() == "chat_id":
        return key.strip(), int(value)
    if key.strip() == "screenshot_enabled":
        return key.strip(), parse_bool(value, default=True)
    return key.strip(), value


def parse_bool(value: object, *, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "yes", "y", "on"}:
        return True
    if normalized in {"0", "false", "no", "n", "off"}:
        return False
    return default


def parse_csv(value: object, *, default: tuple[str, ...]) -> tuple[str, ...]:
    if value is None:
        return default
    items = tuple(dict.fromkeys(part.strip() for part in str(value).split(",") if part.strip()))
    return items or default


def parse_positive_int(value: object, *, default: int) -> int:
    try:
        parsed = int(str(value).strip())
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default
