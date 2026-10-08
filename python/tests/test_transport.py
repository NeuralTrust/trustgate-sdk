from __future__ import annotations

import http.server
import threading
import time
from collections.abc import Callable, Iterator

import pytest

from trustgate import TrustGate, TrustGateError
from trustgate.config import resolve_config
from trustgate.transport import UrllibTransport, send

from .fake_gateway import FakeGateway


def test_refuses_a_gateway_on_another_host_over_plain_http() -> None:
    with pytest.raises(TrustGateError, match="plain http"):
        resolve_config("http://gw.internal", "ag_k")


# Some resolvers send *.localhost to the network's DNS.
def test_does_not_take_a_name_under_localhost_for_this_machine() -> None:
    with pytest.raises(TrustGateError, match="plain http"):
        resolve_config("http://gw.localhost", "ag_k")


@pytest.mark.parametrize(
    "base_url", ["http://localhost:8082", "http://127.0.0.1:8082", "http://[::1]:8082"]
)
def test_allows_this_machine(base_url: str) -> None:
    assert resolve_config(base_url, "ag_k").base_url == base_url


def test_allows_another_host_when_the_caller_opts_in() -> None:
    assert resolve_config(
        "http://gw.internal", "ag_k", allow_insecure_http=True
    ).allow_insecure_http


def test_reads_the_opt_in_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TRUSTGATE_ALLOW_INSECURE_HTTP", "1")

    assert resolve_config("http://gw.internal", "ag_k").allow_insecure_http


# The key already went to the base URL to ask, so the answer's host is not in
# question; its scheme is, because it decides how the key travels next.
def test_refuses_an_https_gateway_that_answers_with_an_http_plane() -> None:
    gateway = FakeGateway(
        whoami={
            "gateway": "acme",
            "consumers": [
                {"slug": "acme", "type": "MCP", "active": True, "url": "http://gw.test/acme/mcp"}
            ],
        }
    )
    tg = TrustGate(base_url="https://gw.test", api_key="ag_k", transport=gateway)

    with pytest.raises(TrustGateError, match="plain http"):
        tg.connect()
    assert [request.url for request in gateway.requests] == ["https://gw.test/whoami"]


class _Server:
    def __init__(self, handle: Callable[[http.server.BaseHTTPRequestHandler], None]) -> None:
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - the stdlib's name
                handle(self)

            def log_message(self, *_: object) -> None:
                pass

        self.httpd = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def servers() -> Iterator[list[_Server]]:
    started: list[_Server] = []
    yield started
    for server in started:
        server.close()


def test_redirects_are_not_followed_so_the_key_never_reaches_the_other_host(
    servers: list[_Server],
) -> None:
    seen: list[str | None] = []

    def other(request: http.server.BaseHTTPRequestHandler) -> None:
        seen.append(request.headers.get("X-AG-API-Key"))
        request.send_response(200)
        request.end_headers()

    def gateway(request: http.server.BaseHTTPRequestHandler) -> None:
        request.send_response(302)
        request.send_header("Location", servers[0].url.replace("127.0.0.1", "localhost") + "/x")
        request.end_headers()

    servers.append(_Server(other))
    servers.append(_Server(gateway))

    with pytest.raises(TrustGateError, match="does not follow redirects"):
        send(
            UrllibTransport(), "GET", f"{servers[1].url}/whoami", {"X-AG-API-Key": "ag_k"}, None, 5
        )
    assert seen == []


# A caller's own transport hands back what it got; the SDK refuses it there too.
def test_a_redirect_from_any_transport_is_refused() -> None:
    tg = TrustGate(
        base_url="https://gw.test", api_key="ag_k", transport=FakeGateway(whoami_status=302)
    )

    with pytest.raises(TrustGateError, match="does not follow redirects"):
        tg.identity()


# Headers first, then a trickle: urllib's timeout is per read, so each byte
# arriving in time would otherwise keep the call open.
def test_the_timeout_covers_the_whole_body(servers: list[_Server]) -> None:
    def trickle(request: http.server.BaseHTTPRequestHandler) -> None:
        request.send_response(200)
        request.send_header("Content-Length", "1000")
        request.end_headers()
        for _ in range(100):
            try:
                request.wfile.write(b" ")
                request.wfile.flush()
            except OSError:
                return
            time.sleep(0.05)

    servers.append(_Server(trickle))
    started = time.monotonic()

    with pytest.raises(TrustGateError, match="no answer within"):
        UrllibTransport().request("GET", f"{servers[0].url}/whoami", {}, None, 0.3)
    assert time.monotonic() - started < 2
