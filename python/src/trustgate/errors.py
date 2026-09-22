"""Every failure the SDK raises, as a type you can catch.

The gateway answers a tool call with a JSON-RPC error and the connections API
with ``{"error": ..., "message": ...}``. Both are relayed here as classes
rather than status codes, because the useful question is never "what number
came back" but "is this mine to fix, my user's, or my admin's".
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover - import cycle, types only
    from .whoami import KeyUpstream

__all__ = [
    "TrustGateError",
    "AuthenticationError",
    "InvalidRequestError",
    "MissingToolsError",
    "UpstreamNotConnectedError",
    "ConsentRequiredError",
    "PolicyBlockedError",
    "ToolNotFoundError",
    "RateLimitedError",
    "ServiceUnavailableError",
    "TrustGateServerError",
    "PlaneUnavailableError",
]


class TrustGateError(Exception):
    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        code: str | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code


class AuthenticationError(TrustGateError):
    """The API key is wrong, or it does not belong to this consumer."""


class InvalidRequestError(TrustGateError):
    """The request was malformed - a bad end-user id, an unknown provider."""


class MissingToolsError(TrustGateError):
    """The consumer's toolkit does not carry every tool the agent declared.

    An admin owns that toolkit, so this is not something the caller can fix in
    code: it is raised at startup, by name, so the agent never reaches a user
    only to find the tool it was written around is not there.
    """

    def __init__(self, missing: list[str], available: list[str]) -> None:
        offered = ", ".join(available) if available else "(nothing)"
        super().__init__(
            f"the consumer's toolkit is missing {', '.join(repr(t) for t in missing)}. "
            f"It offers: {offered}. Ask the admin who owns this application to add them."
        )
        self.missing = missing
        self.available = available


class UpstreamNotConnectedError(TrustGateError):
    """Servers the application cannot call yet, and who has to fix that.

    Raised at startup only, for the application handle: nobody is present to
    follow a connect link once a batch is running, so the run either knows
    beforehand or fails halfway through. The remedy is never the caller's - an
    account a whole team rides on is an administrator's to connect, and a
    per-caller account wants the person this call is for, which is what
    ``for_end_user`` is.
    """

    def __init__(self, upstreams: list["KeyUpstream"]) -> None:
        super().__init__(_describe_blocked(upstreams))
        self.upstreams = upstreams

    @property
    def servers(self) -> list[str]:
        """The server names, for a caller that wants to log or list them."""
        return [upstream.server for upstream in self.upstreams]


def _describe_blocked(upstreams: list["KeyUpstream"]) -> str:
    """Says who fixes each server, with the line of code when it is the caller.

    Read on a terminal at startup, so it is written to be acted on there: the
    per-user case is the one a developer hits first, and the fix is one call
    they have not seen yet, so the call is in the message.
    """
    by_admin = [u for u in upstreams if u.blocked == "administrator"]
    by_user = [u for u in upstreams if u.blocked == "end_user"]
    parts: list[str] = []
    if by_user:
        parts.append(
            f"{_names(by_user)} {_verb(by_user, 'keeps', 'keep')} one account per user, and "
            "connect() runs as the application, which has none there.\n"
            "\n"
            "Run as the person the work is for:\n"
            "\n"
            '    agent = tg.for_end_user("user_123")\n'
            "\n"
            f"or have an administrator set {_names(by_user)} to a shared account in the "
            "console (Registry, on the server's instance), and connect() works as it is."
        )
    if by_admin:
        parts.append(
            f"{_names(by_admin)} {_verb(by_admin, 'uses', 'use')} one shared account for every "
            "caller, and nobody has connected it yet. An administrator connects it in the "
            "console: Registry, on the server's instance, Connect."
        )
    if not parts:
        return f"{_names(upstreams)} {_verb(upstreams, 'is', 'are')} not connected."
    return "\n\n".join(parts)


def _names(upstreams: list["KeyUpstream"]) -> str:
    return ", ".join(f'"{upstream.server}"' for upstream in upstreams)


def _verb(upstreams: list["KeyUpstream"], one: str, many: str) -> str:
    return one if len(upstreams) == 1 else many


class ConsentRequiredError(TrustGateError):
    """An end user has not connected the account this call needs.

    The link comes with the error because the gateway mints it there: it is the
    page to put in front of that user, and it expires.
    """

    def __init__(
        self, provider: str, connect_url: str, reason: str, message: str | None = None
    ) -> None:
        super().__init__(
            message or f"user consent required for {provider}: open {connect_url}",
            code="consent_required",
        )
        self.provider = provider
        self.connect_url = connect_url
        self.reason = reason


class PolicyBlockedError(TrustGateError):
    """A policy on the gateway refused the call. Not retryable."""


class ToolNotFoundError(TrustGateError):
    """The tool is not on this consumer's surface - usually because it just left it."""

    def __init__(self, tool: str, message: str | None = None) -> None:
        super().__init__(message or f'the gateway does not serve a tool named "{tool}"')
        self.tool = tool


class RateLimitedError(TrustGateError):
    def __init__(self, message: str, retry_after_ms: int | None = None) -> None:
        super().__init__(message, status=429, code="rate_limited")
        self.retry_after_ms = retry_after_ms


class ServiceUnavailableError(TrustGateError):
    """The gateway could not serve the request and says so. Retryable."""


class TrustGateServerError(TrustGateError):
    """The gateway failed on its own account."""


class PlaneUnavailableError(TrustGateError):
    """The SDK was pointed at a plane this API key does not reach."""
