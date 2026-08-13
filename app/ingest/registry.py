from __future__ import annotations

from typing import Dict

from .ports import SourceAdapter
from .telegram_bot.adapter import TelegramBotAdapter
from .telegram_public.adapter import TelegramPublicAdapter


class AdapterRegistry:
    def __init__(self, adapters: Dict[str, SourceAdapter] | None = None) -> None:
        self._adapters = dict(adapters or {})

    def register(self, adapter: SourceAdapter) -> None:
        self._adapters[adapter.key] = adapter

    def get(self, key: str) -> SourceAdapter:
        adapter = self._adapters.get(key or "telegram_public")
        if adapter is None:
            raise KeyError(key)
        return adapter

    def keys(self) -> tuple[str, ...]:
        return tuple(self._adapters)


def build_default_registry(*, timeout: int = 20) -> AdapterRegistry:
    registry = AdapterRegistry()
    registry.register(TelegramPublicAdapter(timeout=timeout))
    registry.register(TelegramBotAdapter())
    return registry
