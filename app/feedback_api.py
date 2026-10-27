from __future__ import annotations

import time
from collections import defaultdict
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from .security import require_same_origin, require_session
from .storage import SQLiteStorage

router = APIRouter(prefix="/api", tags=["feedback"])
_LIMITS: dict[str, list[float]] = defaultdict(list)


class FeedbackPayload(BaseModel):
    message: str = Field(min_length=1, max_length=2000)


class FeedbackStatusPayload(BaseModel):
    status: Literal["new", "reviewed", "resolved", "dismissed"]


def _ip(request: Request) -> str:
    return (request.client.host if request.client else "unknown")[:64]


def _allowed(request: Request) -> bool:
    config = request.app.state.config
    now = time.monotonic()
    key = _ip(request)
    window = max(1, int(getattr(config, "feedback_rate_window_seconds", 60)))
    entries = [stamp for stamp in _LIMITS[key] if stamp > now - window]
    _LIMITS[key] = entries
    limit = max(1, int(getattr(config, "feedback_rate_limit", 5)))
    if len(entries) >= limit:
        return False
    entries.append(now)
    return True


@router.post("/public/feedback", status_code=status.HTTP_201_CREATED, dependencies=[Depends(require_same_origin)])
async def create_feedback(request: Request, payload: FeedbackPayload):
    if not _allowed(request):
        raise HTTPException(status_code=429, detail="Too many feedback submissions")
    return request.app.state.storage.create_feedback(message=payload.message, ip=_ip(request))


admin_router = APIRouter(prefix="/admin", tags=["admin feedback"], dependencies=[Depends(require_session)])


@admin_router.get("/feedback")
async def list_feedback(request: Request):
    return {"items": request.app.state.storage.list_feedback()}


@admin_router.patch("/feedback/{feedback_id}", dependencies=[Depends(require_same_origin)])
async def update_feedback(request: Request, feedback_id: int, payload: FeedbackStatusPayload):
    try:
        return request.app.state.storage.update_feedback_status(feedback_id, payload.status)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Feedback not found") from exc
