"""LLMProvider plugin abstraction — verify singleton + override hooks."""

from typing import Any

import pytest

from app.plugins.llm import (
    LLMProvider,
    LiteLLMProvider,
    get_llm_provider,
    set_llm_provider,
)


class _FakeProvider(LLMProvider):
    def __init__(self):
        self.calls: list[dict] = []

    async def acompletion(
        self,
        model: str,
        messages: list[dict],
        tools: list | None = None,
        tool_choice: Any = None,
        stream: bool = False,
        **kwargs: Any,
    ):
        self.calls.append({"model": model, "messages": messages, "tools": tools})
        return {"choices": [{"message": {"content": "ok"}}]}


def test_default_provider_is_litellm_wrapper():
    set_llm_provider(None)
    try:
        prov = get_llm_provider()
        assert isinstance(prov, LiteLLMProvider)
    finally:
        set_llm_provider(None)


@pytest.mark.asyncio
async def test_set_llm_provider_overrides_global():
    set_llm_provider(None)
    fake = _FakeProvider()
    set_llm_provider(fake)
    try:
        result = await get_llm_provider().acompletion(
            "MyModel", [{"role": "user", "content": "hi"}]
        )
        assert fake.calls and fake.calls[0]["model"] == "MyModel"
        assert result["choices"][0]["message"]["content"] == "ok"
    finally:
        set_llm_provider(None)
