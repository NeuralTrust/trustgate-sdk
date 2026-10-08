"""Where the SDK gets its gateway, its key and its consumers."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from urllib.parse import ParseResult, urlparse

from .errors import TrustGateError

#: The header the gateway reads the consumer's API key from. It also accepts
#: ``x-api-key`` and ``Authorization: Bearer ag_...``; this one is the
#: unambiguous spelling, so it is the one the SDK sends.
API_KEY_HEADER = "X-AG-API-Key"

#: The header that names which of the application's end users a call is for.
END_USER_HEADER = "X-NeuralTrust-End-User"

#: Where a client with nothing but its key starts. The gateway finds which
#: gateway the key belongs to and answers with that gateway's own addresses, so
#: nothing else is called here. Set ``base_url`` / ``TRUSTGATE_URL`` only for a
#: Hybrid gateway, to the MCP host its own data plane is published on.
DEFAULT_BASE_URL = "https://agentgateway-mcp.neuraltrust.ai"


@dataclass(frozen=True)
class Config:
    base_url: str
    # Out of the repr: a config ends up in logs and tracebacks, the key must not.
    api_key: str = field(repr=False)
    mcp_consumer: str | None = None
    llm_consumer: str | None = None
    timeout: float = 30.0
    #: Lets the key travel over plain http to a host other than this machine.
    allow_insecure_http: bool = False


def resolve_config(
    base_url: str | None = None,
    api_key: str | None = None,
    mcp_consumer: str | None = None,
    llm_consumer: str | None = None,
    timeout: float = 30.0,
    allow_insecure_http: bool | None = None,
) -> Config:
    resolved_url = (
        (base_url or "").strip() or os.environ.get("TRUSTGATE_URL", "").strip() or DEFAULT_BASE_URL
    ).rstrip("/")
    resolved_key = (api_key or os.environ.get("TRUSTGATE_API_KEY") or "").strip()
    insecure = insecure_http_from_env() if allow_insecure_http is None else allow_insecure_http
    require_safe_url(resolved_url, insecure, "base_url")
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
        allow_insecure_http=insecure,
    )


def insecure_http_from_env() -> bool:
    """Whether ``TRUSTGATE_ALLOW_INSECURE_HTTP`` opts in to plain http."""
    return os.environ.get("TRUSTGATE_ALLOW_INSECURE_HTTP", "").strip().lower() in (
        "1",
        "true",
        "yes",
    )


def require_safe_url(url: str, allow_insecure_http: bool, what: str) -> ParseResult:
    """Checks that a credential may be sent to ``url``, and parses it.

    The key and the session token travel in headers, so plain http hands them
    to whoever is on the path. This machine is exempt, because nothing leaves
    it; any other host needs the caller to opt in. Every address the SDK sends
    a credential to passes through here - the configured one and the ones the
    gateway answers with - so an https gateway cannot steer it onto http.
    """
    parsed = urlparse(url)
    if parsed.scheme == "https" and parsed.netloc:
        return parsed
    if parsed.scheme != "http" or not parsed.netloc:
        raise TrustGateError(f'{what} must be an http(s) URL, got "{url}"')
    if allow_insecure_http or _is_loopback(parsed.hostname or ""):
        return parsed
    raise TrustGateError(
        f"{what} is plain http ({parsed.scheme}://{parsed.netloc}), which would send credentials "
        "unencrypted. Use https, or set allow_insecure_http (TRUSTGATE_ALLOW_INSECURE_HTTP=1) "
        "for a gateway reached over a private network."
    )


def _is_loopback(hostname: str) -> bool:
    """This machine, named so that no resolver is asked.

    ``*.localhost`` is local on some systems and forwarded to the network's DNS
    on others, so only the literal name and addresses count.
    """
    host = hostname.lower()
    return host in ("localhost", "::1") or re.fullmatch(r"127(\.\d{1,3}){3}", host) is not None
