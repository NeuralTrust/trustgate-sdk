"""A person on their own Store: signed in, with what Access lets them reach.

An application reaches the gateway with an API key. A person has no key: they
sign in, the way their MCP client does, and get the Store - the servers they
installed, narrowed to what Access grants them. Signing in is OAuth against the
gateway itself (authorization code with PKCE, a client registered on the fly,
a redirect to a port on this machine), so nothing here is new on the gateway's
side: it is the flow Claude Code or Cursor run when they add the Store.
"""

from __future__ import annotations

import base64
import hashlib
import http.server
import json
import os
import secrets
import sys
import threading
import time
import webbrowser
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import parse_qs, urlencode, urlparse

from .errors import AuthenticationError, LoginRequiredError, TrustGateError
from .transport import Response, Transport

#: Where a gateway serves the Store, under the host of its MCP plane.
STORE_PATH = "/store/mcp"

#: How long before its expiry a session token is renewed rather than sent.
_RENEW_MARGIN_S = 60.0

#: The name the gateway shows for a client this SDK registers.
CLIENT_NAME = "TrustGate SDK"


def resolve_store_url(url: str | None) -> str:
    """The Store's MCP endpoint, from the URL the console shows or its host.

    The console's "Store" settings show ``https://<gateway>.<mcp host>/store/mcp``.
    The host alone is accepted too, because it is the part people copy.
    """
    raw = (url or "").strip() or os.environ.get("TRUSTGATE_STORE_URL", "").strip()
    if not raw:
        raise TrustGateError(
            "url is required (or set TRUSTGATE_STORE_URL): the Store URL the console "
            "shows, https://<gateway>.<mcp host>/store/mcp"
        )
    parsed = urlparse(raw)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise TrustGateError(f'url must be an http(s) URL, got "{raw}"')
    path = parsed.path.rstrip("/")
    return f"{parsed.scheme}://{parsed.netloc}{path or STORE_PATH}"


@dataclass(frozen=True)
class UserToken:
    """A signed-in session: the token the Store reads, and how to renew it."""

    access_token: str
    #: Unix time the access token stops being accepted. Zero when unknown.
    expires_at: float = 0.0
    refresh_token: str | None = None
    #: The client the session was issued to, which a refresh has to name.
    client_id: str | None = None

    def expires_soon(self, now: float) -> bool:
        return bool(self.expires_at) and now >= self.expires_at - _RENEW_MARGIN_S


class TokenCache(Protocol):
    """Where a session outlives the process that signed in."""

    def load(self, url: str) -> UserToken | None: ...

    def save(self, url: str, token: UserToken) -> None: ...

    def clear(self, url: str) -> None: ...


class MemoryTokenCache:
    """A cache for one process: sign in once, never on disk."""

    def __init__(self) -> None:
        self._tokens: dict[str, UserToken] = {}

    def load(self, url: str) -> UserToken | None:
        return self._tokens.get(url)

    def save(self, url: str, token: UserToken) -> None:
        self._tokens[url] = token

    def clear(self, url: str) -> None:
        self._tokens.pop(url, None)


class FileTokenCache:
    """Sessions in one file, readable only by the user who signed in.

    The default is ``~/.trustgate/sessions.json`` (``TRUSTGATE_HOME`` moves the
    directory), keyed by Store URL so a person on two gateways keeps both.
    """

    def __init__(self, path: str | os.PathLike[str] | None = None) -> None:
        if path is None:
            home = os.environ.get("TRUSTGATE_HOME", "").strip()
            path = Path(home) if home else Path.home() / ".trustgate"
            path = path / "sessions.json"
        self.path = Path(path)

    def load(self, url: str) -> UserToken | None:
        entry = self._read().get(url)
        if not isinstance(entry, dict) or not entry.get("access_token"):
            return None
        return UserToken(
            access_token=str(entry["access_token"]),
            expires_at=float(entry.get("expires_at") or 0.0),
            refresh_token=entry.get("refresh_token") or None,
            client_id=entry.get("client_id") or None,
        )

    def save(self, url: str, token: UserToken) -> None:
        sessions = self._read()
        sessions[url] = asdict(token)
        self._write(sessions)

    def clear(self, url: str) -> None:
        sessions = self._read()
        if sessions.pop(url, None) is not None:
            self._write(sessions)

    def _read(self) -> dict[str, Any]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def _write(self, sessions: dict[str, Any]) -> None:
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        # Created with owner-only permissions before anything is written: a
        # refresh token is a sign-in, and a umask is not a guarantee.
        tmp = self.path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(sessions, handle, indent=2)
        os.replace(tmp, self.path)


@dataclass(frozen=True)
class _AuthServer:
    authorization_endpoint: str
    token_endpoint: str
    registration_endpoint: str


class UserSession:
    """The bearer the Store reads, renewed before it runs out.

    A session token lasts an hour and its refresh token keeps it going, but
    only so far: a NeuralTrust sign-in ends after a day, by design, so a change
    an admin makes in Access reaches the person by then. Past that the session
    cannot be renewed and :class:`LoginRequiredError` says to sign in again.
    """

    def __init__(
        self,
        url: str,
        token: UserToken,
        transport: Transport,
        timeout: float,
        cache: TokenCache | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.url = url
        self._token = token
        self._transport = transport
        self._timeout = timeout
        self._cache = cache
        self._clock = clock
        self._lock = threading.Lock()

    @property
    def token(self) -> UserToken:
        return self._token

    def headers(self) -> dict[str, str]:
        with self._lock:
            if self._token.expires_soon(self._clock()) and self._token.refresh_token:
                self._renew()
            return {"Authorization": f"Bearer {self._token.access_token}"}

    def renew(self) -> bool:
        """Renews after the Store refused the token. False when it cannot be."""
        with self._lock:
            if not self._token.refresh_token:
                return False
            self._renew()
            return True

    def _renew(self) -> None:
        server = discover_auth_server(self.url, self._transport, self._timeout)
        form: dict[str, str] = {
            "grant_type": "refresh_token",
            "refresh_token": self._token.refresh_token or "",
            "resource": self.url,
        }
        if self._token.client_id:
            form["client_id"] = self._token.client_id
        response = _post_form(server.token_endpoint, form, self._transport, self._timeout)
        body = response.json() if isinstance(response.json(), dict) else {}
        if response.status >= 400 or not body.get("access_token"):
            if self._cache is not None:
                self._cache.clear(self.url)
            raise LoginRequiredError(self.url, _oauth_reason(body, response))
        self._token = _token_from(body, self._token.client_id, self._clock(), self._token)
        if self._cache is not None:
            self._cache.save(self.url, self._token)


def discover_auth_server(url: str, transport: Transport, timeout: float) -> _AuthServer:
    """Where the gateway that serves ``url`` signs people in.

    Its metadata names the endpoints; a gateway that does not publish it still
    serves them at the conventional paths, so those are the fallback.
    """
    parsed = urlparse(url)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    response = transport.request(
        "GET",
        f"{origin}/.well-known/oauth-authorization-server",
        {"Accept": "application/json"},
        None,
        timeout,
    )
    body = response.json() if response.status < 400 else None
    meta = body if isinstance(body, dict) else {}
    return _AuthServer(
        authorization_endpoint=str(
            meta.get("authorization_endpoint") or f"{origin}/oauth/authorize"
        ),
        token_endpoint=str(meta.get("token_endpoint") or f"{origin}/oauth/token"),
        registration_endpoint=str(meta.get("registration_endpoint") or f"{origin}/oauth/register"),
    )


def login_flow(
    url: str,
    transport: Transport,
    timeout: float,
    open_browser: bool = True,
    on_url: Callable[[str], None] | None = None,
    wait_s: float = 300.0,
    clock: Callable[[], float] = time.time,
) -> UserToken:
    """Signs a person in through their browser and returns the session.

    A server on a loopback port receives the redirect, so this runs on the
    person's own machine: on a server or over SSH there is no browser to come
    back to it. That is what an application's API key is for.
    """
    server = discover_auth_server(url, transport, timeout)
    with _CallbackServer() as callback:
        client_id = _register_client(server, callback.redirect_uri, transport, timeout)
        verifier = secrets.token_urlsafe(48)
        state = secrets.token_urlsafe(24)
        authorize_url = (
            server.authorization_endpoint
            + ("&" if "?" in server.authorization_endpoint else "?")
            + urlencode(
                {
                    "response_type": "code",
                    "client_id": client_id,
                    "redirect_uri": callback.redirect_uri,
                    "state": state,
                    "code_challenge": _s256(verifier),
                    "code_challenge_method": "S256",
                    "resource": url,
                }
            )
        )
        (on_url or _print_url)(authorize_url)
        if open_browser:
            try:
                webbrowser.open(authorize_url)
            except Exception:  # noqa: BLE001 - the printed URL is the fallback
                pass
        params = callback.wait(wait_s)

    if params.get("state") != state:
        raise AuthenticationError("sign-in failed: the browser came back for another sign-in")
    if params.get("error"):
        reason = params.get("error_description") or params["error"]
        raise AuthenticationError(f"sign-in failed: {reason}", code=params["error"])
    code = params.get("code")
    if not code:
        raise AuthenticationError("sign-in failed: the gateway sent no authorization code")

    response = _post_form(
        server.token_endpoint,
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": callback.redirect_uri,
            "client_id": client_id,
            "code_verifier": verifier,
            "resource": url,
        },
        transport,
        timeout,
    )
    body = response.json() if isinstance(response.json(), dict) else {}
    if response.status >= 400 or not body.get("access_token"):
        raise AuthenticationError(
            f"sign-in failed: {_oauth_reason(body, response)}", status=response.status
        )
    return _token_from(body, client_id, clock())


def _register_client(
    server: _AuthServer, redirect_uri: str, transport: Transport, timeout: float
) -> str:
    response = transport.request(
        "POST",
        server.registration_endpoint,
        {"Content-Type": "application/json", "Accept": "application/json"},
        json.dumps(
            {
                "client_name": CLIENT_NAME,
                "redirect_uris": [redirect_uri],
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": "none",
            }
        ).encode("utf-8"),
        timeout,
    )
    body = response.json()
    if response.status >= 400 or not isinstance(body, dict) or not body.get("client_id"):
        reason = _oauth_reason(body if isinstance(body, dict) else {}, response)
        raise AuthenticationError(
            f"this gateway does not let a client sign people in: {reason}",
            status=response.status,
        )
    return str(body["client_id"])


def _post_form(url: str, form: dict[str, str], transport: Transport, timeout: float) -> Response:
    return transport.request(
        "POST",
        url,
        {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
        urlencode(form).encode("utf-8"),
        timeout,
    )


def _token_from(
    body: dict[str, Any], client_id: str | None, now: float, previous: UserToken | None = None
) -> UserToken:
    expires_in = body.get("expires_in")
    try:
        expires_at = now + float(expires_in) if expires_in else 0.0
    except (TypeError, ValueError):
        expires_at = 0.0
    return UserToken(
        access_token=str(body["access_token"]),
        expires_at=expires_at,
        # The gateway rotates it on every refresh; keep the old one only when
        # an answer leaves it out.
        refresh_token=body.get("refresh_token") or (previous.refresh_token if previous else None),
        client_id=client_id,
    )


def _oauth_reason(body: dict[str, Any], response: Response) -> str:
    reason = body.get("error_description") or body.get("message") or body.get("error")
    return str(reason) if reason else f"HTTP {response.status}"


def _s256(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def _print_url(url: str) -> None:
    print(f"Sign in to TrustGate in your browser:\n\n    {url}\n", file=sys.stderr)


_DONE_PAGE = (
    b"<!doctype html><meta charset=utf-8><title>TrustGate</title>"
    b"<body style='font-family:system-ui;margin:3rem'>"
    b"<h1>Signed in</h1><p>You can close this tab and go back to your terminal.</p>"
)


class _CallbackServer:
    """A one-shot HTTP server on a loopback port, for the sign-in redirect."""

    def __init__(self) -> None:
        received: dict[str, str] = {}
        done = threading.Event()

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - the stdlib's name
                parsed = urlparse(self.path)
                if parsed.path != "/callback":
                    self.send_error(404)
                    return
                if not done.is_set():
                    query = parse_qs(parsed.query)
                    received.update({key: values[0] for key, values in query.items() if values})
                    done.set()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(_DONE_PAGE)

            def log_message(self, *_: Any) -> None:
                return

        self._server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        self._received = received
        self._done = done
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        port = self._server.server_address[1]
        self.redirect_uri = f"http://127.0.0.1:{port}/callback"

    def __enter__(self) -> _CallbackServer:
        self._thread.start()
        return self

    def __exit__(self, *_: Any) -> None:
        self._server.shutdown()
        self._server.server_close()

    def wait(self, wait_s: float) -> dict[str, str]:
        if not self._done.wait(wait_s):
            raise AuthenticationError(
                f"sign-in timed out after {int(wait_s)}s waiting for the browser"
            )
        return dict(self._received)
