"""Every failure the SDK raises, as a type you can catch.

The gateway answers a tool call with a JSON-RPC error and the connections API
with ``{"error": ..., "message": ...}``. Both are relayed here as classes
rather than status codes, because the useful question is never "what number
came back" but "is this mine to fix, my user's, or my admin's".
"""

from __future__ import annotations

__all__ = [
    "TrustGateError",
    "AuthenticationError",
    "InvalidRequestError",
    "MissingToolsError",
    "UpstreamNotConnectedError",
    "ConsentRequiredError",
    "PolicyBlockedError",
    "ToolNotFoundError",
    "AppActorUnavailableError",
    "EndUserActorUnavailableError",
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
    """The application itself has upstream accounts left to authorize.

    Raised only for an application that acts as itself, and only at startup:
    nobody is present to follow a connect link once a batch is running, so the
    run either knows beforehand or fails halfway through.
    """

    def __init__(self, providers: list[str], connect_url: str) -> None:
        super().__init__(
            f"this application has not signed in to {', '.join(providers)}. "
            f"Open {connect_url} with its API key to connect them."
        )
        self.providers = providers
        self.connect_url = connect_url


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


class AppActorUnavailableError(TrustGateError):
    """The application acts for its users, so it holds no accounts of its own."""


class EndUserActorUnavailableError(TrustGateError):
    """The application acts as itself, so it has no end users to ask about."""


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
