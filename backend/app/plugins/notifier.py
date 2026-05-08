"""Notifier abstraction (Slack/Discord/email/webhook). Default is no-op."""

from __future__ import annotations

import os
import uuid
from abc import ABC, abstractmethod


class Notifier(ABC):
    @abstractmethod
    async def notify(self, event_type: str, data: dict, workspace_id: uuid.UUID) -> None: ...


class NoopNotifier(Notifier):
    async def notify(self, event_type: str, data: dict, workspace_id: uuid.UUID) -> None:
        return None


_notifier: Notifier | None = None


def get_notifier() -> Notifier:
    global _notifier
    if _notifier is not None:
        return _notifier
    name = os.environ.get("NOTIFIER", "noop")
    if name == "noop":
        _notifier = NoopNotifier()
    else:
        raise ValueError(f"unknown NOTIFIER={name}")
    return _notifier


def set_notifier(notifier: Notifier | None) -> None:
    global _notifier
    _notifier = notifier
