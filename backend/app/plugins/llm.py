"""LLM provider abstraction. Default impl wraps litellm."""

from __future__ import annotations

import os
from abc import ABC, abstractmethod
from typing import Any


class LLMProvider(ABC):
    @abstractmethod
    async def acompletion(
        self,
        model: str,
        messages: list[dict],
        tools: list | None = None,
        tool_choice: Any = None,
        stream: bool = False,
        **kwargs: Any,
    ) -> Any: ...


class LiteLLMProvider(LLMProvider):
    async def acompletion(
        self,
        model: str,
        messages: list[dict],
        tools: list | None = None,
        tool_choice: Any = None,
        stream: bool = False,
        **kwargs: Any,
    ) -> Any:
        import litellm

        prefixed = model if "/" in model else f"openai/{model}"
        return await litellm.acompletion(
            model=prefixed,
            messages=messages,
            tools=tools,
            tool_choice=tool_choice,
            stream=stream,
            **kwargs,
        )


_provider: LLMProvider | None = None


def get_llm_provider() -> LLMProvider:
    global _provider
    if _provider is not None:
        return _provider
    name = os.environ.get("LLM_PROVIDER", "litellm")
    if name == "litellm":
        _provider = LiteLLMProvider()
    else:
        raise ValueError(f"unknown LLM_PROVIDER={name}")
    return _provider


def set_llm_provider(provider: LLMProvider | None) -> None:
    """Override (or reset with None). Used by tests."""
    global _provider
    _provider = provider
