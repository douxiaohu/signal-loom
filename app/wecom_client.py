from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional
from urllib import error, request


DEFAULT_MAX_TEXT_CHARS = 1800
Transport = Callable[[str, Dict[str, Any], int], Dict[str, Any]]


class WeComSendError(RuntimeError):
    def __init__(self, message: str, *, completed_chunks: int = 0, total_chunks: int = 0) -> None:
        super().__init__(message)
        self.completed_chunks = max(0, int(completed_chunks))
        self.total_chunks = max(0, int(total_chunks))


@dataclass(frozen=True)
class SendResult:
    chunks: int
    responses: List[Dict[str, Any]]


class WeComClient:
    def __init__(
        self,
        *,
        max_text_chars: int = DEFAULT_MAX_TEXT_CHARS,
        transport: Optional[Transport] = None,
        timeout: int = 15,
    ) -> None:
        self.max_text_chars = int(max_text_chars)
        self.transport = transport or post_json
        self.timeout = int(timeout)

    def send_text(self, webhook_url: str, content: str) -> SendResult:
        if not webhook_url:
            raise WeComSendError("webhook_url is required")
        chunks = split_text(content, self.max_text_chars)
        responses: List[Dict[str, Any]] = []
        for chunk in chunks:
            payload = {"msgtype": "text", "text": {"content": chunk}}
            try:
                response = self.transport(webhook_url, payload, self.timeout)
            except Exception as exc:
                raise WeComSendError(
                    str(exc),
                    completed_chunks=len(responses),
                    total_chunks=len(chunks),
                ) from exc
            if int(response.get("errcode", 0)) != 0:
                raise WeComSendError(
                    str(response),
                    completed_chunks=len(responses),
                    total_chunks=len(chunks),
                )
            responses.append(response)
        return SendResult(chunks=len(chunks), responses=responses)


def split_text(content: str, max_chars: int = DEFAULT_MAX_TEXT_CHARS) -> List[str]:
    text = content or ""
    if len(text) <= max_chars:
        return [text]

    chunks: List[str] = []
    current = ""
    for line in text.splitlines(keepends=True):
        if len(line) > max_chars:
            if current:
                chunks.append(current.rstrip())
                current = ""
            for index in range(0, len(line), max_chars):
                chunks.append(line[index : index + max_chars].rstrip())
            continue
        if len(current) + len(line) > max_chars:
            chunks.append(current.rstrip())
            current = line
        else:
            current += line
    if current:
        chunks.append(current.rstrip())
    return [chunk for chunk in chunks if chunk != ""]


def post_json(url: str, payload: Dict[str, Any], timeout: int) -> Dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    http_request = request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with request.urlopen(http_request, timeout=timeout) as response:
            response_body = response.read().decode("utf-8")
    except error.URLError as exc:
        raise WeComSendError(str(exc)) from exc
    return json.loads(response_body)
