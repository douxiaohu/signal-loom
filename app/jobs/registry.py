from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable

from app.context import AppContext


@dataclass(frozen=True)
class JobSpec:
    job_id: str
    interval_seconds: int
    run: Callable[[AppContext], Awaitable[object]]
    enabled: bool = True
