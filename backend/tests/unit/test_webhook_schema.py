"""Pydantic discriminated-union schema tests for the webhook protocol."""

import pytest
from pydantic import TypeAdapter, ValidationError

from app.schemas.webhooks import AgentWebhookEvent

_adapter = TypeAdapter(AgentWebhookEvent)


def test_progress_event_minimal():
    obj = _adapter.validate_python({"event": "progress", "data": {}})
    assert obj.event == "progress"


def test_completed_event_with_token_usage_aliases():
    obj = _adapter.validate_python({
        "event": "completed",
        "data": {
            "result_summary": "ok",
            "files": ["a.txt"],
            "token_usage": {"input": 10, "output": 20},
        },
    })
    assert obj.data.token_usage.input_tokens == 10
    assert obj.data.token_usage.output_tokens == 20


def test_idempotency_key_propagates():
    obj = _adapter.validate_python({
        "event": "completed",
        "idempotency_key": "abc123",
        "data": {"result_summary": "x"},
    })
    assert obj.idempotency_key == "abc123"


def test_unknown_event_type_rejected():
    with pytest.raises(ValidationError):
        _adapter.validate_python({"event": "junk", "data": {}})


def test_completed_missing_data_rejected_with_invalid_payload():
    # data={} should still validate (all fields default), but a non-dict shape must fail.
    with pytest.raises(ValidationError):
        _adapter.validate_python({"event": "completed", "data": "not-a-dict"})
