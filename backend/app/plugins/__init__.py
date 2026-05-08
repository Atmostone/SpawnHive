"""Pluggable backends for LLM, embeddings, agent runtime, notifications, and secrets.

Selection happens via env: `LLM_PROVIDER`, `EMBEDDING_PROVIDER`, `AGENT_RUNTIME`,
`SECRETS_PROVIDER`, `NOTIFIER`. Each `get_*_provider()` returns a process-wide
singleton. Tests override by monkeypatching the cached singleton.
"""
