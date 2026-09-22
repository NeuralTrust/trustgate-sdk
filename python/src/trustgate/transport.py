"""The HTTP layer, and the one seam the tests replace.

The SDK has no runtime dependencies, so the default transport is the standard
library's. It is a protocol rather than a function because everything above it
- the connections API, the MCP endpoint - is written against the seam, which is
also what lets a caller put their own client, proxy or retry policy underneath.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Protocol

from .errors import (
    AuthenticationError,
    InvalidRequestError,
    RateLimitedError,
    ServiceUnavailableError,
    TrustGateError,
    TrustGateServerError,
)


@dataclass(frozen=True)
class Response:
    status: int
    headers: dict[str, str]
    text: str

    def json(self) -> Any:
        if not self.text.strip():
            return None
        try:
            return json.loads(self.text)
        except json.JSONDecodeError:
            return None


class Transport(Protocol):
    def request(
        self,
        method: str,
        url: str,
        headers: dict[str, str],
        body: bytes | None,
        timeout: float,
    ) -> Response: ...


class UrllibTransport:
    def request(
        self,
        method: str,
        url: str,
        headers: dict[str, str],
        body: bytes | None,
        timeout: float,
    ) -> Response:
        request = urllib.request.Request(url, data=body, method=method)
        for name, value in headers.items():
            request.add_header(name, value)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return Response(
                    status=response.status,
                    headers={k.title(): v for k, v in response.headers.items()},
                    text=response.read().decode("utf-8", errors="replace"),
                )
        except urllib.error.HTTPError as error:
            # An error status is an answer, not a failure: the gateway puts the
            # reason in the body and the caller needs to read it.
            return Response(
                status=error.code,
                headers={k.title(): v for k, v in (error.headers or {}).items()},
                text=error.read().decode("utf-8", errors="replace"),
            )
        except urllib.error.URLError as error:
            raise TrustGateError(f"{method} {url} failed to reach the gateway: {error}") from error


def error_for_response(response: Response) -> TrustGateError:
    """Turns the gateway's ``{error, message}`` into the type that says whose problem it is."""
    body = response.json() or {}
    code = body.get("error") if isinstance(body, dict) else None
    message = (body.get("message") if isinstance(body, dict) else None) or response.text or ""
    status = response.status
    by_code = {
        "unauthenticated": AuthenticationError,
        "invalid_request": InvalidRequestError,
        "unavailable": ServiceUnavailableError,
    }
    if code in by_code:
        return by_code[code](message, status=status, code=code)
    if status in (401, 403):
        return AuthenticationError(message, status=status, code=code)
    if status == 429:
        return RateLimitedError(message, _retry_after_ms(response))
    if status >= 500:
        return TrustGateServerError(message, status=status, code=code)
    return TrustGateError(message, status=status, code=code)


def _retry_after_ms(response: Response) -> int | None:
    raw = response.headers.get("Retry-After")
    if not raw:
        return None
    try:
        return int(float(raw) * 1000)
    except ValueError:
        return None
