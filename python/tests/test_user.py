from __future__ import annotations

import base64
import hashlib
import json
import os
import stat
import urllib.request
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

import pytest

from trustgate import (
    AuthenticationError,
    FileTokenCache,
    LoginRequiredError,
    MemoryTokenCache,
    MissingToolsError,
    TrustGate,
    TrustGateError,
    TrustGateUser,
    UserAgent,
    UserToken,
)
from trustgate.transport import Response
from trustgate.user import resolve_store_url

STORE = "https://acme.mcp.test/store/mcp"


@dataclass
class FakeStore:
    """The gateway's sign-in endpoints and its Store, as a transport."""

    tools: list[dict[str, Any]] = field(
        default_factory=lambda: [{"name": "linear_list_issues", "inputSchema": {"type": "object"}}]
    )
    #: Tokens the Store accepts.
    valid: set[str] = field(default_factory=lambda: {"at-1"})
    #: Refresh tokens the token endpoint renews, and what each one becomes.
    refreshable: dict[str, str] = field(default_factory=dict)
    #: Overrides what the browser comes back with.
    callback: dict[str, str] | None = None
    #: Overrides the token endpoint the metadata names.
    token_endpoint: str = "https://acme.mcp.test/oauth/token"
    #: The servers trustgate_list_tools reports.
    inventory: list[dict[str, Any]] = field(default_factory=list)
    #: Overrides the link install answers with.
    connect_url: str = "https://acme.mcp.test/store/mcp/connect?ticket=tk-9"
    #: The tools/call requests the Store got, as (name, arguments).
    calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    #: Answers the metadata request with a redirect instead.
    metadata_moved: bool = False
    challenge: str = ""
    registered: list[dict[str, Any]] = field(default_factory=list)
    authorized: list[dict[str, str]] = field(default_factory=list)
    token_requests: list[dict[str, str]] = field(default_factory=list)
    mcp_auth: list[str] = field(default_factory=list)

    def request(
        self, method: str, url: str, headers: dict[str, str], body: bytes | None, timeout: float
    ) -> Response:
        path = urlparse(url).path
        if path == "/.well-known/oauth-authorization-server":
            if self.metadata_moved:
                return Response(
                    status=302, headers={"Location": "https://elsewhere.test/meta"}, text=""
                )
            return _json(
                200,
                {
                    "issuer": "https://acme.mcp.test",
                    "authorization_endpoint": "https://acme.mcp.test/oauth/authorize",
                    "token_endpoint": self.token_endpoint,
                    "registration_endpoint": "https://acme.mcp.test/oauth/register",
                },
            )
        if path == "/oauth/register":
            payload = json.loads(body or b"{}")
            self.registered.append(payload)
            return _json(201, {"client_id": "agw-1", "redirect_uris": payload["redirect_uris"]})
        if path == "/oauth/token":
            form = {k: v[0] for k, v in parse_qs((body or b"").decode()).items()}
            self.token_requests.append(form)
            return self._token(form)
        if path == "/store/mcp":
            bearer = headers.get("Authorization", "").removeprefix("Bearer ")
            self.mcp_auth.append(bearer)
            if bearer not in self.valid:
                return _json(401, {"error": "invalid_token"})
            rpc = json.loads(body or b"{}")
            if rpc["method"] == "tools/list":
                return _json(
                    200, {"jsonrpc": "2.0", "id": rpc["id"], "result": {"tools": self.tools}}
                )
            name = rpc["params"]["name"]
            self.calls.append((name, rpc["params"].get("arguments") or {}))
            if name == "trustgate_list_tools":
                result = {
                    "content": [{"type": "text", "text": "the list"}],
                    "structuredContent": {"servers": self.inventory},
                }
            elif name == "trustgate_store_install":
                result = {
                    "content": [{"type": "text", "text": "open it"}],
                    "structuredContent": {
                        "already_installed": True,
                        "requires_auth": True,
                        "connect_url": self.connect_url,
                    },
                }
            else:
                result = {"content": [{"type": "text", "text": f"called {name}"}]}
            return _json(200, {"jsonrpc": "2.0", "id": rpc["id"], "result": result})
        return _json(404, {"error": "not_found"})

    def _token(self, form: dict[str, str]) -> Response:
        if form.get("grant_type") == "authorization_code":
            digest = hashlib.sha256(form["code_verifier"].encode()).digest()
            if base64.urlsafe_b64encode(digest).rstrip(b"=").decode() != self.challenge:
                return _json(400, {"error": "invalid_grant", "error_description": "PKCE"})
            self.valid.add("at-1")
            return _json(
                200,
                {
                    "access_token": "at-1",
                    "token_type": "Bearer",
                    "expires_in": 3600,
                    "refresh_token": "gwrt_1",
                },
            )
        renewed = self.refreshable.get(form.get("refresh_token", ""))
        if renewed is None:
            return _json(
                400,
                {"error": "invalid_grant", "error_description": "session expired; sign in again"},
            )
        self.valid.add(renewed)
        return _json(
            200,
            {
                "access_token": renewed,
                "token_type": "Bearer",
                "expires_in": 3600,
                "refresh_token": "gwrt_2",
            },
        )

    def browser(self, authorize_url: str) -> None:
        """What the person's browser does: sign in, and come back to the loopback port."""
        query = {k: v[0] for k, v in parse_qs(urlparse(authorize_url).query).items()}
        self.authorized.append(query)
        self.challenge = query["code_challenge"]
        back = (
            self.callback if self.callback is not None else {"code": "c-1", "state": query["state"]}
        )
        with urllib.request.urlopen(
            f"{query['redirect_uri']}?{urlencode(back)}", timeout=5
        ) as page:
            assert page.status == 200


def _json(status: int, body: Any) -> Response:
    return Response(
        status=status, headers={"Content-Type": "application/json"}, text=json.dumps(body)
    )


def login(store: FakeStore, cache=None, **kwargs) -> TrustGateUser:
    return TrustGate.login(
        STORE,
        cache=cache if cache is not None else MemoryTokenCache(),
        open_browser=False,
        transport=store,
        on_url=store.browser,
        **kwargs,
    )


def test_signs_a_person_in_through_the_browser_and_opens_their_store() -> None:
    store = FakeStore()
    cache = MemoryTokenCache()

    agent = login(store, cache).connect(requires=["list_issues"])

    assert isinstance(agent, UserAgent)
    assert agent.actor.value == "user"
    assert [tool.name for tool in agent.tools] == ["linear_list_issues"]
    assert agent.mcp.url == STORE
    assert agent.mcp.headers["Authorization"] == "Bearer at-1"
    assert "X-AG-API-Key" not in agent.mcp.headers
    redirect = store.registered[0]["redirect_uris"][0]
    assert redirect.startswith("http://127.0.0.1:") and redirect.endswith("/callback")
    assert store.authorized[0]["resource"] == STORE
    assert store.authorized[0]["code_challenge_method"] == "S256"
    assert store.token_requests[0]["redirect_uri"] == redirect
    assert cache.load(STORE) == UserToken(
        access_token="at-1",
        expires_at=pytest.approx(cache.load(STORE).expires_at),
        refresh_token="gwrt_1",
        client_id="agw-1",
    )


def test_calls_run_as_the_signed_in_person() -> None:
    store = FakeStore()

    result = login(store).connect().call_tool("list_issues", {})

    assert result["content"][0]["text"] == "called linear_list_issues"
    assert store.mcp_auth == ["at-1", "at-1"]


def test_reuses_the_session_from_last_time_without_a_browser() -> None:
    store = FakeStore()
    cache = MemoryTokenCache()
    cache.save(STORE, UserToken("at-1", expires_at=9e12, refresh_token="gwrt_1", client_id="agw-1"))

    login(store, cache).connect()

    assert store.authorized == []


def test_renews_a_session_that_is_about_to_end() -> None:
    store = FakeStore(refreshable={"gwrt_1": "at-2"})
    cache = MemoryTokenCache()
    cache.save(
        STORE, UserToken("at-old", expires_at=1.0, refresh_token="gwrt_1", client_id="agw-1")
    )

    agent = login(store, cache).connect()

    assert store.authorized == []
    assert agent.mcp.headers["Authorization"] == "Bearer at-2"
    assert store.token_requests[0]["client_id"] == "agw-1"
    assert store.token_requests[0]["resource"] == STORE
    assert cache.load(STORE).refresh_token == "gwrt_2"


def test_signs_in_again_when_the_session_cannot_be_renewed() -> None:
    store = FakeStore()
    cache = MemoryTokenCache()
    cache.save(
        STORE, UserToken("at-old", expires_at=1.0, refresh_token="gwrt_dead", client_id="agw-1")
    )

    login(store, cache).connect()

    assert len(store.authorized) == 1
    assert cache.load(STORE).access_token == "at-1"


def test_renews_once_when_the_store_refuses_a_token_mid_run() -> None:
    store = FakeStore(valid=set(), refreshable={"gwrt_1": "at-2"})
    user = TrustGateUser(
        STORE,
        transport=store,
        token=UserToken("at-revoked", expires_at=9e12, refresh_token="gwrt_1", client_id="agw-1"),
    )

    agent = user.connect()

    assert store.mcp_auth == ["at-revoked", "at-2"]
    assert agent.tools


def test_says_to_sign_in_again_when_the_sign_in_has_ended() -> None:
    store = FakeStore(valid=set())
    user = TrustGateUser(
        STORE,
        transport=store,
        token=UserToken(
            "at-revoked", expires_at=9e12, refresh_token="gwrt_dead", client_id="agw-1"
        ),
    )

    with pytest.raises(LoginRequiredError) as raised:
        user.connect()

    assert "TrustGate.login" in str(raised.value)


def test_takes_a_token_a_backend_already_holds() -> None:
    store = FakeStore(valid={"at-mine"})

    agent = TrustGateUser(STORE, access_token="at-mine", transport=store).connect()

    assert agent.mcp.headers["Authorization"] == "Bearer at-mine"


def test_a_refused_token_with_nothing_to_renew_it_is_an_authentication_error() -> None:
    store = FakeStore(valid=set())

    with pytest.raises(AuthenticationError) as raised:
        TrustGateUser(STORE, access_token="at-bad", transport=store).connect()

    assert "refused this sign-in" in str(raised.value)
    assert not isinstance(raised.value, LoginRequiredError)


INVENTORY = {"name": "trustgate_list_tools", "inputSchema": {"type": "object"}}


def linear_waiting(**extra: Any) -> dict[str, Any]:
    return {
        "name": "Linear",
        "code": "app.linear/mcp",
        "state": "needs_connect",
        "connect_tool": "trustgate_store_install",
        **extra,
    }


def test_names_the_servers_waiting_on_an_account_and_the_page_to_connect_them() -> None:
    store = FakeStore(
        tools=[{"name": "notion_search", "inputSchema": {"type": "object"}}, INVENTORY],
        inventory=[
            {"name": "Notion", "code": "com.notion/mcp", "state": "ready"},
            linear_waiting(),
        ],
    )

    agent = login(store).connect()
    link = agent.connect_link()

    assert agent.needs_connect == ["Linear"]
    assert link is not None
    assert link.connect_url == "https://acme.mcp.test/store/mcp/connect?ticket=tk-9"
    assert link.ticket == "tk-9"
    # The Store connects an installed server by installing it again.
    assert store.calls[-1] == ("trustgate_store_install", {"code": "app.linear/mcp"})


def test_links_the_server_it_is_asked_for() -> None:
    store = FakeStore(
        tools=[INVENTORY],
        inventory=[linear_waiting(), linear_waiting(name="Notion", code="com.notion/mcp")],
    )
    agent = login(store).connect()

    agent.connect_link("Notion")

    assert store.calls[-1] == ("trustgate_store_install", {"code": "com.notion/mcp"})
    with pytest.raises(TrustGateError) as caught:
        agent.connect_link("GitHub")
    assert caught.value.code == "nothing_to_connect"


def test_leaves_out_a_server_the_person_cannot_connect() -> None:
    # An account an admin holds for everyone has no connect pointer.
    store = FakeStore(
        tools=[INVENTORY],
        inventory=[
            {
                "name": "Vanta",
                "code": "com.vanta/mcp",
                "state": "needs_connect",
                "cause": "shared_account_not_connected",
            }
        ],
    )

    agent = login(store).connect()

    assert agent.needs_connect == []
    assert agent.connect_link() is None


def test_refresh_reads_what_is_still_waiting() -> None:
    store = FakeStore(tools=[INVENTORY], inventory=[linear_waiting()])
    agent = login(store).connect()
    assert agent.needs_connect == ["Linear"]

    store.inventory = [linear_waiting(state="ready")]
    agent.refresh()

    assert agent.needs_connect == []


def test_has_no_link_when_everything_is_connected() -> None:
    agent = login(FakeStore()).connect()

    assert agent.needs_connect == []
    assert agent.connect_link() is None


def test_a_missing_tool_points_at_the_store_and_access() -> None:
    with pytest.raises(MissingToolsError) as raised:
        login(FakeStore()).connect(requires=["github_create_issue"])

    assert "Install them from the Store" in str(raised.value)


def test_a_browser_that_comes_back_for_another_sign_in_is_refused() -> None:
    store = FakeStore(callback={"code": "c-1", "state": "someone-elses"})

    with pytest.raises(AuthenticationError, match="another sign-in"):
        login(store)

    assert store.token_requests == []


def test_a_refused_sign_in_says_why() -> None:
    store = FakeStore(callback={"error": "access_denied", "error_description": "not a member"})
    # The gateway echoes the state on an error too; the fake reads it from the URL.
    original = store.browser

    def browser(url: str) -> None:
        state = parse_qs(urlparse(url).query)["state"][0]
        store.callback = {**(store.callback or {}), "state": state}
        original(url)

    with pytest.raises(AuthenticationError, match="not a member"):
        TrustGate.login(
            STORE, cache=MemoryTokenCache(), open_browser=False, transport=store, on_url=browser
        )


def test_the_store_url_can_be_its_host() -> None:
    assert resolve_store_url("https://acme.mcp.test") == STORE
    assert resolve_store_url("https://acme.mcp.test/") == STORE
    assert resolve_store_url(STORE + "/") == STORE


def test_keeps_sessions_in_a_file_only_its_owner_reads(tmp_path) -> None:
    cache = FileTokenCache(tmp_path / "trustgate" / "sessions.json")

    cache.save(STORE, UserToken("at-1", expires_at=10.0, refresh_token="gwrt_1", client_id="agw-1"))

    assert stat.S_IMODE(os.stat(cache.path).st_mode) == 0o600
    assert FileTokenCache(cache.path).load(STORE) == UserToken("at-1", 10.0, "gwrt_1", "agw-1")
    cache.clear(STORE)
    assert cache.load(STORE) is None


def test_refuses_a_store_on_another_host_over_plain_http() -> None:
    with pytest.raises(TrustGateError, match="plain http"):
        resolve_store_url("http://acme.mcp.test")
    assert resolve_store_url("http://127.0.0.1:8082") == "http://127.0.0.1:8082/store/mcp"
    assert resolve_store_url("http://acme.mcp.test", True) == "http://acme.mcp.test/store/mcp"


# The metadata decides where the code, the PKCE verifier and later the refresh
# token are sent.
def test_refuses_metadata_that_would_send_the_sign_in_over_plain_http() -> None:
    store = FakeStore(token_endpoint="http://acme.mcp.test/oauth/token")

    with pytest.raises(TrustGateError, match="token endpoint is plain http"):
        login(store)
    assert store.token_requests == []


def test_signs_in_at_the_conventional_paths_when_the_metadata_has_moved() -> None:
    store = FakeStore(metadata_moved=True)

    agent = login(store).connect()

    assert [tool.name for tool in agent.tools] == ["linear_list_issues"]
    assert store.token_requests[0]["grant_type"] == "authorization_code"


def test_does_not_pass_on_a_connect_link_that_is_not_the_gateways() -> None:
    store = FakeStore(
        tools=[INVENTORY],
        inventory=[linear_waiting()],
        connect_url="https://login.example/connect?ticket=tk-9",
    )
    agent = login(store).connect()

    with pytest.raises(TrustGateError) as caught:
        agent.connect_link()
    assert caught.value.code == "untrusted_connect_url"


def test_a_session_prints_without_its_tokens() -> None:
    token = UserToken(access_token="tok_access_secret", refresh_token="tok_refresh_secret")

    assert "tok_access_secret" not in repr(token)
    assert "tok_refresh_secret" not in repr(token)
