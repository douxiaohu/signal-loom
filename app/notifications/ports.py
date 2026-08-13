from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, Sequence


@dataclass(frozen=True)
class NotificationEvent:
    kind: str
    source_id: int | None
    payload: dict


class Notifier(Protocol):
    key: str

    def send(self, event: NotificationEvent) -> None: ...


class NotificationService:
    def __init__(self, notifiers: Sequence[Notifier] | None = None) -> None:
        self._notifiers = list(notifiers or [])

    def emit(self, event: NotificationEvent) -> None:
        for notifier in self._notifiers:
            notifier.send(event)
