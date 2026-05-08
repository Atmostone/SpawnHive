"""Per-template LLM config inheritance — exercises docker_manager.effective_llm_config."""

from types import SimpleNamespace

from app.orchestrator.docker_manager import effective_llm_config


def _global() -> dict:
    return {
        "llm_model": "GlobalModel",
        "llm_base_url": "https://global.example.com",
        "llm_api_key": "global-key",
    }


def test_per_template_wins_when_all_three_set():
    template = SimpleNamespace(
        model="CustomModel",
        provider_url="https://template.example.com",
        provider_api_key="template-key",
    )
    cfg = effective_llm_config(template, _global())
    assert cfg == {
        "llm_model": "CustomModel",
        "llm_base_url": "https://template.example.com",
        "llm_api_key": "template-key",
    }


def test_falls_back_to_global_if_one_field_missing():
    template = SimpleNamespace(
        model="CustomModel",
        provider_url=None,
        provider_api_key="template-key",
    )
    cfg = effective_llm_config(template, _global())
    assert cfg == _global()


def test_falls_back_to_global_when_all_empty():
    template = SimpleNamespace(model=None, provider_url=None, provider_api_key=None)
    cfg = effective_llm_config(template, _global())
    assert cfg == _global()
