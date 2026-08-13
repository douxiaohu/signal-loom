from __future__ import annotations

import logging
from datetime import datetime
from typing import Sequence
from zoneinfo import ZoneInfo

from app.context import AppContext
from app.jobs.registry import JobSpec

LOGGER = logging.getLogger(__name__)


class JobRunner:
    """Single-process AsyncIOScheduler host. Dockerfile must keep uvicorn --workers 1."""

    def __init__(self, ctx: AppContext, jobs: Sequence[JobSpec]) -> None:
        self.ctx = ctx
        self.jobs = list(jobs)
        self.scheduler = None

    def start(self):
        from apscheduler.schedulers.asyncio import AsyncIOScheduler
        from apscheduler.triggers.interval import IntervalTrigger

        LOGGER.info("Starting job runner (single SQLite writer; uvicorn workers must stay 1)")
        try:
            timezone_info = ZoneInfo(self.ctx.config.timezone)
        except Exception:  # noqa: BLE001
            timezone_info = ZoneInfo("UTC")
        scheduler = AsyncIOScheduler(timezone=timezone_info)
        for spec in self.jobs:
            if not spec.enabled:
                continue

            async def _run(job=spec):
                return await job.run(self.ctx)

            scheduler.add_job(
                _run,
                IntervalTrigger(seconds=spec.interval_seconds, timezone=timezone_info),
                id=spec.job_id,
                replace_existing=True,
                max_instances=1,
                coalesce=True,
                next_run_time=datetime.now(timezone_info),
            )
        scheduler.start()
        self.scheduler = scheduler
        return scheduler

    def shutdown(self, *, wait: bool = False) -> None:
        if self.scheduler is not None:
            self.scheduler.shutdown(wait=wait)
