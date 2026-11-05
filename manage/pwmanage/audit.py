"""Audit trail: one JSON line per request in CloudWatch Logs, group /playwork/manage/<env>, one stream per day."""
import json
import time
from datetime import datetime, timezone

import boto3

from .config import LOG_RETENTION_DAYS, REGION, Env


class Audit:
    def __init__(self, env: Env, client=None):
        self.env = env
        self.client = client or boto3.client("logs", region_name=REGION)
        self._ready = None

    def _ensure(self, stream):
        """Create the group (with retention) and today's stream on first use; both calls are idempotent."""
        if self._ready == stream:
            return
        errors = self.client.exceptions
        try:
            self.client.create_log_group(logGroupName=self.env.log_group)
            self.client.put_retention_policy(logGroupName=self.env.log_group, retentionInDays=LOG_RETENTION_DAYS)
        except errors.ResourceAlreadyExistsException:
            pass
        try:
            self.client.create_log_stream(logGroupName=self.env.log_group, logStreamName=stream)
        except errors.ResourceAlreadyExistsException:
            pass
        self._ready = stream

    def write(self, event: dict) -> None:
        """Raises when the line cannot be written: callers decide whether that stops the request."""
        now = datetime.now(timezone.utc)
        stream = now.strftime("%Y-%m-%d")
        self._ensure(stream)
        line = json.dumps({"ts": now.isoformat(), "env": self.env.name, **event}, default=str)
        self.client.put_log_events(
            logGroupName=self.env.log_group, logStreamName=stream,
            logEvents=[{"timestamp": int(time.time() * 1000), "message": line}],
        )
