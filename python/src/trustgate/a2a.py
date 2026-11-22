"""The gateway's own A2A errors, as the SDK's error types.

The SDK does not speak A2A: an A2A client (``a2a-sdk``) sends the messages,
through the gateway, to the address :meth:`TrustGate.agent` hands over. The
gateway forwards the agent's JSON-RPC as it is, and answers with codes of its
own only when it stops a call itself:

=========  =========================================================
``-32090`` a policy blocked the call or its answer
``-32091`` a rate limit was reached, with the seconds to wait
``-32092`` the gateway could not complete the call (the agent was
           unreachable, timed out, answered something that was not
           A2A...)
``-32093`` the agent's identity mode needs a signed-in user
``-32094`` the call was refused before it was read: no valid key, a
           key or caller the application does not take, no
           application at that path
=========  =========================================================

An A2A client knows none of them, so they reach the caller as a generic
JSON-RPC error. :func:`gateway_error` turns one into the type an MCP call raises
for the same refusal (:class:`PolicyBlockedError`, :class:`RateLimitedError`,
...), and :func:`event_hooks` does it as the response arrives, for an ``httpx``
client handed to ``a2a-sdk``::

    async with httpx.AsyncClient(headers=agent.headers, event_hooks=a2a.event_hooks()) as http:
        client = await create_client(agent.url, client_config=ClientConfig(httpx_client=http))
        with a2a.gateway_errors():
            async for event in client.send_message(request):
                ...

An error the agent itself answers, in the same range of codes, is relayed by
the gateway as it came: one is only taken for the gateway's when it carries
what the gateway writes (its reasons, its messages), and is otherwise left to
the A2A client.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable, Iterator, Mapping
from contextlib import contextmanager
from typing import Any

from .errors import (
    AuthenticationError,
    InvalidRequestError,
    PolicyBlockedError,
    RateLimitedError,
    ServiceUnavailableError,
    TrustGateError,
    TrustGateServerError,
)

__all__ = [
    "CODE_POLICY_BLOCKED",
    "CODE_RATE_LIMITED",
    "CODE_GATEWAY_FAILURE",
    "CODE_IDENTITY_REQUIRED",
    "CODE_ACCESS_REFUSED",
    "gateway_error",
    "gateway_errors",
    "event_hooks",
]

CODE_POLICY_BLOCKED = -32090
CODE_RATE_LIMITED = -32091
CODE_GATEWAY_FAILURE = -32092
CODE_IDENTITY_REQUIRED = -32093
CODE_ACCESS_REFUSED = -32094

#: The message the gateway writes with each code. A client that drops the
#: error's data (a2a-sdk 1.x does for a code it does not know) keeps the code
#: and the message, and the message tells the gateway's error from an agent's.
_MESSAGES = {
    CODE_POLICY_BLOCKED: "Blocked by gateway policy",
    CODE_RATE_LIMITED: "Rate limit exceeded",
    CODE_GATEWAY_FAILURE: "Gateway could not complete the call",
    CODE_IDENTITY_REQUIRED: "An authenticated user is required",
}

_POLICY_REASONS = {"policy_blocked", "mask_unsupported"}

#: The -32092 reasons that a later call may not meet: the agent or the
#: gateway's own store was slow or away. The others need a fix (the agent's
#: answer, a credential, an id that belongs to another caller).
_TRANSIENT = {
    "upstream_unreachable",
    "upstream_timeout",
    "stream_idle",
    "stream_max_duration",
    "ownership_unavailable",
    "signing_key_unavailable",
    "plan_unavailable",
}

#: How a2a-sdk 1.x writes a JSON-RPC error whose code it does not know.
_CLIENT_ERROR = re.compile(r"JSON-RPC Error (-?\d+): (.*)", re.DOTALL)


def gateway_error(error: object, *, status: int | None = None) -> TrustGateError | None:
    """The SDK's error for an A2A error the gateway answered; None for any other.

    ``error`` is what an A2A client raised or returned: an a2a-sdk exception
    (0.3's ``A2AClientJSONRPCError`` keeps the error's data; 1.x keeps only the
    code and the message), a JSON-RPC error object (``{"code", "message",
    "data"}``) or a whole JSON-RPC response. ``status`` is the HTTP status it
    came with, when known. The result chains nothing; raise it ``from`` the
    original to keep both.
    """
    if isinstance(error, TrustGateError):
        return error
    parsed = _rpc_error(error)
    if parsed is None:
        return None
    code, message, data = parsed
    if not _from_gateway(code, message, data):
        return None
    reason = str(data.get("reason") or "") if data is not None else ""
    if code == CODE_POLICY_BLOCKED:
        plugin = str(data.get("plugin") or "") or None if data is not None else None
        by = f" ({plugin})" if plugin else ""
        detail = (
            "a policy asked to mask part of it and the gateway could not write the mask"
            if reason == "mask_unsupported"
            else "a policy blocked it"
        )
        return PolicyBlockedError(
            f"the gateway refused the A2A call: {detail}{by}",
            code=reason or "policy_blocked",
            plugin=plugin,
        )
    if code == CODE_RATE_LIMITED:
        retry = data.get("retry_after") if data is not None else None
        retry_ms = int(retry * 1000) if isinstance(retry, (int, float)) and retry >= 0 else None
        wait = f"; retry in {retry}s" if retry_ms is not None else ""
        return RateLimitedError(f"the gateway rate-limited the A2A call{wait}", retry_ms)
    if code == CODE_GATEWAY_FAILURE:
        upstream = data.get("upstream_status") if data is not None else None
        said = f" ({reason}" + (f", agent answered HTTP {upstream}" if upstream else "") + ")"
        text = "the gateway could not complete the A2A call" + (said if reason else "")
        cls = ServiceUnavailableError if reason in _TRANSIENT else TrustGateServerError
        return cls(text, status=status, code=reason or "gateway_failure")
    if code == CODE_IDENTITY_REQUIRED:
        return AuthenticationError(
            "this agent acts as a signed-in person, and the call names none: "
            "call it as a signed-in user (TrustGate.login) rather than with the "
            "application's key alone",
            status=status,
            code="identity_required",
        )
    # CODE_ACCESS_REFUSED
    text = f"the gateway refused the A2A call before reading it: {message} ({reason})"
    if reason == "invalid_end_user":
        return InvalidRequestError(text, status=status, code=reason)
    if reason == "gateway_data_unavailable":
        return ServiceUnavailableError(text, status=status, code=reason)
    return AuthenticationError(text, status=status, code=reason)


@contextmanager
def gateway_errors() -> Iterator[None]:
    """Raises the gateway's A2A errors in the block as the SDK's error types.

    Any other exception, an agent's own error included, goes through as it
    was. It works around ``async`` code too: the ``with`` only catches.
    """
    try:
        yield
    except TrustGateError:
        raise
    except Exception as error:
        translated = gateway_error(error)
        if translated is None:
            raise
        raise translated from error


def event_hooks() -> dict[str, list[Callable[[Any], Awaitable[None]]]]:
    """``event_hooks`` for the ``httpx.AsyncClient`` handed to an A2A client.

    Each JSON answer is read as it arrives, and one that is a gateway error
    raises the SDK's type there, with the reason, the blocking plugin and the
    wait a rate limit names, which a2a-sdk 1.x would otherwise drop. An event
    stream is left to be read as it streams; an error in it reaches
    :func:`gateway_errors` through the A2A client.
    """
    return {"response": [_raise_gateway_error]}


async def _raise_gateway_error(response: Any) -> None:
    if "application/json" not in str(response.headers.get("content-type", "")).lower():
        return
    await response.aread()
    try:
        body = response.json()
    except ValueError:
        return
    if not isinstance(body, Mapping):
        return
    translated = gateway_error(body, status=getattr(response, "status_code", None))
    if translated is not None:
        raise translated


def _rpc_error(error: object) -> tuple[int, str, Mapping[str, Any] | None] | None:
    """The code, message and data of a JSON-RPC error, however it is held.

    data is None when the holder dropped it; it is an empty mapping when the
    error had none.
    """
    if isinstance(error, Mapping):
        if isinstance(error.get("error"), Mapping):
            return _rpc_error(error["error"])
        code = error.get("code")
        if isinstance(code, int) and not isinstance(code, bool):
            data = error.get("data")
            return code, str(error.get("message") or ""), data if isinstance(data, Mapping) else {}
        return None
    # a2a-sdk 0.3: A2AClientJSONRPCError.error is a JSONRPCErrorResponse, whose
    # .error is the JSONRPCError; both are pydantic models.
    inner = getattr(error, "error", None)
    if inner is not None and inner is not error:
        dumped = inner.model_dump() if hasattr(inner, "model_dump") else inner
        if isinstance(dumped, Mapping):
            found = _rpc_error(dumped)
            if found is not None:
                return found
    if isinstance(error, BaseException):
        match = _CLIENT_ERROR.search(str(error))
        if match:
            return int(match.group(1)), match.group(2).strip(), None
    return None


def _from_gateway(code: int, message: str, data: Mapping[str, Any] | None) -> bool:
    """Whether an error with this code is the gateway's rather than an agent's."""
    if code not in _MESSAGES and code != CODE_ACCESS_REFUSED:
        return False
    if data is None:
        # Only the code and message are left: the gateway's message is its mark.
        return _MESSAGES.get(code) == message
    reason = data.get("reason")
    if code == CODE_POLICY_BLOCKED:
        return reason in _POLICY_REASONS
    if code == CODE_RATE_LIMITED:
        return "retry_after" in data
    if code == CODE_IDENTITY_REQUIRED:
        return reason == "identity_required"
    return isinstance(reason, str) and bool(reason)
