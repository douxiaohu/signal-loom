__all__ = ["TelegramPublicAdapter"]


def __getattr__(name: str):
    if name == "TelegramPublicAdapter":
        from .adapter import TelegramPublicAdapter

        return TelegramPublicAdapter
    raise AttributeError(name)
