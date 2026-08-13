from __future__ import annotations

import json
from typing import Dict, List
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class RepositoryAiError(RuntimeError):
    pass


class RepositoryAiExplainer:
    """Generate a small, structured Chinese explanation through an OpenAI-compatible API."""

    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        base_url: str = "https://api.openai.com/v1",
        timeout_seconds: int = 45,
    ) -> None:
        self.api_key = api_key.strip()
        self.model = model.strip()
        self.base_url = base_url.strip().rstrip("/")
        self.timeout_seconds = max(5, int(timeout_seconds))

    @property
    def enabled(self) -> bool:
        return bool(self.api_key and self.model and self.base_url)

    def explain(self, repository: Dict[str, object]) -> Dict[str, str]:
        if not self.enabled:
            raise RepositoryAiError("GitHub AI explanation is not configured")
        languages = repository.get("language_breakdown")
        language_text = ", ".join(
            f"{item.get('language')}: {item.get('percentage')}%"
            for item in languages
            if isinstance(item, dict)
        ) if isinstance(languages, list) else ""
        prompt = {
            "repository": str(repository.get("full_name") or ""),
            "original_description": str(repository.get("description") or "")[:2000],
            "topics": list(repository.get("topics") or [])[:20],
            "license": str(repository.get("license_name") or ""),
            "language_composition": language_text,
            "readme_excerpt": str(repository.get("readme_excerpt") or "")[:10000],
        }
        payload = {
            "model": self.model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "你是严谨的开源项目分析员。仅根据提供的仓库元数据与 README，"
                        "用简体中文输出 JSON，不得推测未提供的能力。JSON 必须且只能包含："
                        "summary_zh（1至2句项目简述）、significance_zh（项目意义）、"
                        "problem_zh（解决的核心问题）。每项不超过120个汉字。"
                    ),
                },
                {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)},
            ],
            "response_format": {"type": "json_object"},
        }
        request = Request(
            f"{self.base_url}/chat/completions",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "telegram-fastapi-github-ai/1.0",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                decoded = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:300]
            raise RepositoryAiError(f"AI API HTTP {exc.code}: {detail}") from exc
        except (URLError, TimeoutError, OSError) as exc:
            raise RepositoryAiError(f"AI API unavailable: {exc}") from exc
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError) as exc:
            raise RepositoryAiError("AI API returned invalid JSON") from exc

        content = self._message_content(decoded)
        return self._parse_explanation(content)

    @staticmethod
    def _parse_explanation(content: str) -> Dict[str, str]:
        result = RepositoryAiExplainer._decode_json_object(content)
        if not isinstance(result, dict):
            raise RepositoryAiError("AI response did not contain an explanation object")
        cleaned = {
            key: " ".join(str(result.get(key) or "").split())[:500]
            for key in ("summary_zh", "significance_zh", "problem_zh")
        }
        if not all(cleaned.values()):
            raise RepositoryAiError("AI response omitted required explanation fields")
        return cleaned

    @staticmethod
    def _decode_json_object(content: str) -> object:
        """Accept plain JSON and common model wrappers such as fenced JSON blocks."""
        if not isinstance(content, str):
            raise RepositoryAiError("AI response did not contain a JSON object")
        decoder = json.JSONDecoder()
        text = content.strip()
        try:
            return json.loads(text)
        except (TypeError, ValueError, json.JSONDecodeError):
            pass
        for index, character in enumerate(text):
            if character != "{":
                continue
            try:
                result, _ = decoder.raw_decode(text[index:])
            except (TypeError, ValueError, json.JSONDecodeError):
                continue
            if isinstance(result, dict):
                return result
        raise RepositoryAiError("AI response did not contain a JSON object")

    @staticmethod
    def _message_content(payload: object) -> str:
        if not isinstance(payload, dict):
            raise RepositoryAiError("AI API returned an unexpected response")
        choices = payload.get("choices")
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
            raise RepositoryAiError("AI API response did not contain choices")
        message = choices[0].get("message")
        if not isinstance(message, dict) or not isinstance(message.get("content"), str):
            raise RepositoryAiError("AI API response did not contain message content")
        return str(message["content"])


def language_breakdown(raw_languages: Dict[str, object], *, limit: int = 8) -> List[Dict[str, object]]:
    languages = []
    for language, raw_bytes in raw_languages.items():
        try:
            byte_count = max(0, int(raw_bytes))
        except (TypeError, ValueError):
            continue
        if language and byte_count:
            languages.append((str(language)[:80], byte_count))
    languages.sort(key=lambda item: (-item[1], item[0].casefold()))
    total = sum(item[1] for item in languages)
    if not total:
        return []
    visible = languages[: max(1, limit)]
    remainder = sum(item[1] for item in languages[len(visible) :])
    if remainder:
        visible.append(("其他", remainder))
    return [
        {
            "language": language,
            "bytes": byte_count,
            "percentage": round(byte_count * 100 / total, 1),
        }
        for language, byte_count in visible
    ]
