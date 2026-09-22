"""Where the SDK gets its gateway, its key and its consumers."""

from __future__ import annotations

import os
from dataclasses import dataclass

from .errors import TrustGateError

#: The header the gateway reads the consumer's API key from. It also accepts
#: ``x-api-key`` and ``Authorization: Bearer ag_...``; this one is the
#: unambiguous spelling, so it is the one the SDK sends.
API_KEY_HEADER = "X-AG-API-Key"

#: The header that names which of the application's end users a call is for.
END_USER_HEADER = "X-NeuralTrust-End-User"


@dataclass(frozen=True)
class Config:
    base_url: str
    api_key: str
    mcp_consumer: str | None = None
    llm_consumer: str | None = None
    timeout: float = 30.0


def resolve_config(
    base_url: str | None = None,
    api_key: str | None = None,
    mcp_consumer: str | None = None,
    llm_consumer: str | None = None,
    timeout: float = 30.0,
) -> Config:
    resolved_url = (base_url or os.environ.get("TRUSTGATE_URL") or "").strip().rstrip("/")
    resolved_key = (api_key or os.environ.get("TRUSTGATE_API_KEY") or "").strip()
    if not resolved_url:
        raise TrustGateError("base_url is required (or set TRUSTGATE_URL)")
    if not resolved_url.startswith(("http://", "https://")):
        raise TrustGateError(f'base_url must be an http(s) URL, got "{resolved_url}"')
    if not resolved_key:
        raise TrustGateError("api_key is required (or set TRUSTGATE_API_KEY)")
    return Config(
        base_url=resolved_url,
        api_key=resolved_key,
        mcp_consumer=(mcp_consumer or os.environ.get("TRUSTGATE_MCP_CONSUMER") or "").strip()
        or None,
        llm_consumer=(llm_consumer or os.environ.get("TRUSTGATE_LLM_CONSUMER") or "").strip()
        or None,
        timeout=timeout,
    )
