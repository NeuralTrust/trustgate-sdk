"""The HTTP layer, and the one seam the tests replace.

The SDK has no runtime dependencies, so the default transport is the standard
library's. It is a protocol rather than a function because everything above it
- the connections API, the MCP endpoint - is written against the seam, which is
also what lets a caller put their own client, proxy or retry policy underneath.
"""

from __future__ import annotations

import json
import time
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
    """Sends one request and returns the answer, whatever its status.

    An implementation must not follow redirects: return the 3xx as it came.
    The SDK refuses it, because the credential is a header that a followed
    redirect would carry to another host.
    """

    def request(
        self,
        method: str,
        url: str,
        headers: dict[str, str],
        body: bytes | None,
        timeout: float,
    ) -> Response: ...


class _RefuseRedirects(urllib.request.HTTPRedirectHandler):
    """Hands a redirect back as the answer instead of following it.

    urllib copies the request's headers onto the redirected one, and the
    credential is a header; :func:`send` turns the answer into an error.
    """

    def redirect_request(self, *_: Any, **__: Any) -> None:
        return None


class UrllibTransport:
    def __init__(self) -> None:
        self._opener = urllib.request.build_opener(_RefuseRedirects)

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
        # urllib's timeout bounds each socket read, not the request: a server
        # that answers and then trickles its body would hold the call open
        # indefinitely, so the body is read against one deadline.
        deadline = time.monotonic() + timeout
        failure = f"{method} {url} failed to reach the gateway"
        try:
            with self._opener.open(request, timeout=timeout) as response:
                return Response(
                    status=response.status,
                    headers={k.title(): v for k, v in response.headers.items()},
                    text=_read_by(response, deadline, failure, timeout),
                )
        except urllib.error.HTTPError as error:
            # An error status is an answer, not a failure: the gateway puts the
            # reason in the body and the caller needs to read it.
            return Response(
                status=error.code,
                headers={k.title(): v for k, v in (error.headers or {}).items()},
                text=_read_by(error, deadline, failure, timeout),
            )
        except urllib.error.URLError as error:
            raise TrustGateError(f"{failure}: {error}") from error
        except TimeoutError as error:
            raise TrustGateError(f"{failure} (no answer within {timeout} s)") from error


def _read_by(stream: Any, deadline: float, failure: str, timeout: float) -> str:
    """The body, read in chunks as they arrive, and given up on at the deadline."""
    read = getattr(stream, "read1", stream.read)
    chunks: list[bytes] = []
    while True:
        if time.monotonic() > deadline:
            raise TrustGateError(f"{failure} (no answer within {timeout} s)")
        chunk = read(65536)
        if not chunk:
            return b"".join(chunks).decode("utf-8", errors="replace")
        chunks.append(chunk)


_REDIRECTS = (301, 302, 303, 307, 308)


def send(
    transport: Transport,
    method: str,
    url: str,
    headers: dict[str, str],
    body: bytes | None,
    timeout: float,
) -> Response:
    """One request through the transport, with a redirect refused rather than taken.

    The credential travels in a header, and a client that follows a redirect
    carries it to whatever host the Location names. An address that moved is a
    configuration to fix, not a hop to take. This only sees what the transport
    hands back, which is why :class:`Transport` asks not to follow them.
    """
    response = transport.request(method, url, headers, body, timeout)
    if response.status in _REDIRECTS:
        location = response.headers.get("Location")
        raise TrustGateError(
            f"{url} answered {response.status} with a redirect"
            f"{f' to {location}' if location else ''}. The SDK does not follow redirects, "
            "because the credential travels in a header: point it at the final address "
            "instead.",
            status=response.status,
            code="redirect",
        )
    return response


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
        return RateLimitedError(message, retry_after_ms(response))
    if status >= 500:
        return TrustGateServerError(message, status=status, code=code)
    return TrustGateError(message, status=status, code=code)


def retry_after_ms(response: Response) -> int | None:
    raw = response.headers.get("Retry-After")
    if not raw:
        return None
    try:
        return int(float(raw) * 1000)
    except ValueError:
        return None
