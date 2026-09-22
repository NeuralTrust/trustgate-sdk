from __future__ import annotations

import pytest

from trustgate import (
    Agent,
    EndUserAgent,
    MissingToolsError,
    PlaneUnavailableError,
    TrustGate,
    UpstreamNotConnectedError,
)
from trustgate.config import END_USER_HEADER

from .fake_gateway import FakeGateway

BASE = dict(base_url="https://gw.test", api_key="ag_secret")


def client(gateway: FakeGateway, **overrides) -> TrustGate:
    return TrustGate(**{**BASE, **overrides}, transport=gateway)


def test_gives_an_application_acting_as_itself_its_tools() -> None:
    gateway = FakeGateway()

    agent = client(gateway).connect(requires=["notion_search"])

    assert isinstance(agent, Agent)
    assert agent.actor.value == "application"
    assert [tool.name for tool in agent.tools] == ["notion_search"]
    assert agent.mcp.url == "https://gw.test/acme/mcp"
    assert agent.mcp.headers["X-AG-API-Key"] == "ag_secret"
    assert END_USER_HEADER not in agent.mcp.headers


# The toolkit belongs to an admin, so an agent written around a tool can lose
# it without a line of its own code changing. Startup is the last moment that
# failure is cheap.
def test_refuses_at_startup_when_the_toolkit_lost_a_needed_tool() -> None:
    gateway = FakeGateway()

    with pytest.raises(MissingToolsError) as caught:
        client(gateway).connect(requires=["notion_search", "linear_create_issue"])

    assert caught.value.missing == ["linear_create_issue"]
    assert "linear_create_issue" in str(caught.value)


# Nobody is present to open a connect link once a batch is running, so an
# unconnected upstream has to stop it before it starts - and the refusal names
# who can fix it, because the caller never can.
def test_refuses_an_application_whose_servers_have_no_account_behind_them() -> None:
    gateway = FakeGateway(
        upstreams=[
            {"server": "Notion", "account": "shared", "connected": True},
            {
                "server": "Linear",
                "account": "shared",
                "connected": False,
                "blocked": "administrator",
            },
        ]
    )

    with pytest.raises(UpstreamNotConnectedError) as caught:
        client(gateway).connect()

    assert caught.value.servers == ["Linear"]
    assert "An administrator connects it" in str(caught.value)


# A server that keeps an account per person has nothing for an application, and
# the remedy is a different handle rather than a different admin.
def test_sends_the_caller_to_for_end_user_when_the_account_is_per_person() -> None:
    gateway = FakeGateway(
        upstreams=[
            {"server": "GitHub", "account": "user", "connected": False, "blocked": "end_user"}
        ]
    )

    with pytest.raises(UpstreamNotConnectedError) as caught:
        client(gateway).connect()

    # The fix is one call the developer has not met yet, so it is in the message.
    assert 'agent = tg.for_end_user("user_123")' in str(caught.value)


# The gateway can refuse the whole listing over a server the application has no
# account on. That refusal says nothing about who fixes it, so the account check
# has to come first - otherwise the typed error never gets its turn.
def test_names_the_account_before_the_listing_can_fail_over_it() -> None:
    gateway = FakeGateway(
        upstreams=[
            {"server": "Linear", "account": "user", "connected": False, "blocked": "end_user"}
        ],
        list_error={
            "code": -32003,
            "message": 'mcp: "Linear" uses a per-user account and this request runs as the application itself',
        },
    )

    with pytest.raises(UpstreamNotConnectedError) as caught:
        client(gateway).connect()

    assert caught.value.servers == ["Linear"]
    assert not any(r.body and r.body.get("method") == "tools/list" for r in gateway.requests)


def test_counts_an_account_that_has_gone_stale_as_still_blocking() -> None:
    gateway = FakeGateway(
        upstreams=[
            {
                "server": "Notion",
                "account": "shared",
                "connected": True,
                "needs_reconnect": True,
                "blocked": "administrator",
            }
        ]
    )

    with pytest.raises(UpstreamNotConnectedError):
        client(gateway).connect()


# A server carrying its own credential is not listed, so an empty list is
# "nothing to connect" and the run starts.
def test_starts_when_nothing_is_waiting_to_be_connected() -> None:
    assert isinstance(client(FakeGateway(upstreams=[])).connect(), Agent)


# A gateway too old to send `upstreams` sends nothing, and nothing is not an
# empty list. Reading it as "nothing to connect" is how a batch gets past its own
# startup check and fails on the first row instead - the exact failure the check
# exists to prevent - so the connections list answers instead.
def test_falls_back_to_the_connections_list_without_upstreams() -> None:
    gateway = FakeGateway(
        connections=[
            {"provider": "com.notion/mcp", "status": "connected"},
            {"provider": "app.linear/mcp", "registry": "Linear", "status": "not_connected"},
        ]
    )

    with pytest.raises(UpstreamNotConnectedError) as caught:
        client(gateway).connect()

    assert caught.value.servers == ["Linear"]


def test_starts_on_an_older_gateway_when_every_account_is_connected() -> None:
    gateway = FakeGateway(connections=[{"provider": "com.notion/mcp", "status": "connected"}])

    assert isinstance(client(gateway).connect(), Agent)


# The same consumer, the same key: which actor a call is comes from the call, so
# both handles are always available and neither is configured.
def test_acts_for_a_named_person_on_the_same_consumer() -> None:
    gateway = FakeGateway()

    alice = client(gateway).for_end_user("user_123")
    alice.call_tool("notion_search", {"query": "runbook"})

    assert isinstance(alice, EndUserAgent)
    assert alice.actor.value == "end_user"
    assert alice.mcp.headers[END_USER_HEADER] == "user_123"
    assert gateway.requests[-1].headers[END_USER_HEADER] == "user_123"


# The toolkit is the application's and identical for everyone it acts for, so
# naming a person from an agent already holding it costs no round trip.
def test_names_a_person_from_the_application_handle_without_asking_again() -> None:
    gateway = FakeGateway()
    agent = client(gateway).connect()
    listed_before = len([r for r in gateway.requests if r.url.endswith("/mcp")])

    alice = agent.for_end_user("user_123")

    assert [tool.name for tool in alice.tools] == ["notion_search"]
    assert len([r for r in gateway.requests if r.url.endswith("/mcp")]) == listed_before
    assert alice.mcp.headers[END_USER_HEADER] == "user_123"


def test_checks_required_tools_for_a_named_person_too() -> None:
    with pytest.raises(MissingToolsError) as caught:
        client(FakeGateway()).for_end_user("user_123", requires=["linear_create_issue"])

    assert caught.value.missing == ["linear_create_issue"]


# A server that refuses a request naming nobody is a per-user server, not a
# misconfigured consumer: the named handle reaches it and the application handle
# does not, which is the same distinction stated at the other end.
def test_reaches_a_per_user_surface_once_a_person_is_named() -> None:
    alice = client(FakeGateway(require_end_user=True)).for_end_user("user_123")

    assert [tool.name for tool in alice.tools] == ["notion_search"]


# A key that retires itself is a 401 nobody saw coming; a long run can ask first
# and refuse to start.
def test_says_when_the_calling_key_expires() -> None:
    identity = client(FakeGateway(key_expires_at="2027-03-01T09:30:00Z")).identity()

    assert identity.key.name == "prod"
    assert identity.key.expires_at is not None
    assert identity.key.expires_at.year == 2027


def test_leaves_the_expiry_unset_for_a_key_that_never_expires() -> None:
    assert client(FakeGateway()).identity().key.expires_at is None


def test_rejects_an_empty_end_user() -> None:
    with pytest.raises(Exception, match="end-user id is required"):
        client(FakeGateway()).for_end_user("   ")


BOTH_PLANES = {
    "gateway": "acme",
    "consumers": [
        {"slug": "acme", "type": "MCP", "active": True, "url": "https://gw.test/acme/mcp"},
        {"slug": "acme-llm", "type": "LLM", "active": True, "url": "https://llm.test/acme-llm/v1"},
    ],
}


# The whole point: one secret in, both planes out. The LLM address is on
# another host, which no client could have composed from the MCP one.
def test_finds_both_planes_behind_one_key() -> None:
    tg = client(FakeGateway(whoami=BOTH_PLANES))

    agent = tg.connect()
    llm = tg.llm()

    assert agent.mcp.url == "https://gw.test/acme/mcp"
    assert llm.base_url == "https://llm.test/acme-llm/v1"
    assert llm.consumer == "acme-llm"
    assert llm.api_key == "ag_secret"


# The Anthropic client appends /v1/messages to what it is given, so the base it
# needs stops at the application; the OpenAI one keeps the /v1 it expects.
def test_hands_each_provider_client_the_base_it_extends() -> None:
    llm = client(FakeGateway(whoami=BOTH_PLANES)).llm()

    assert llm.base_url == "https://llm.test/acme-llm/v1"
    assert llm.anthropic_base_url == "https://llm.test/acme-llm"


def test_asks_the_key_once_however_many_planes_are_read() -> None:
    gateway = FakeGateway(whoami=BOTH_PLANES)
    tg = client(gateway)

    tg.connect()
    tg.llm()
    tg.identity()

    assert len([r for r in gateway.requests if r.url.endswith("/whoami")]) == 1


def test_says_so_when_the_key_reaches_no_consumer_of_that_plane() -> None:
    tg = client(FakeGateway(whoami={"gateway": "acme", "consumers": []}))

    with pytest.raises(PlaneUnavailableError, match="reaches no MCP consumer"):
        tg.connect()


# Two consumers of a plane is a legitimate setup this SDK cannot resolve on
# its own; guessing would run the agent against the wrong surface.
def test_asks_which_one_when_a_key_reaches_two_of_a_plane() -> None:
    gateway = FakeGateway(
        whoami={
            "gateway": "acme",
            "consumers": [
                {
                    "slug": "support",
                    "type": "MCP",
                    "active": True,
                    "url": "https://gw.test/support/mcp",
                },
                {
                    "slug": "billing",
                    "type": "MCP",
                    "active": True,
                    "url": "https://gw.test/billing/mcp",
                },
            ],
        }
    )

    with pytest.raises(Exception, match=r"several MCP consumers \(support, billing\)"):
        client(gateway).connect()

    named = client(gateway, mcp_consumer="billing")
    assert named.connect().mcp.url == "https://gw.test/billing/mcp"


def test_shows_the_address_it_asked_when_whoami_is_not_there() -> None:
    # A 404 is far more often the wrong base URL than a gateway too old, so the
    # message leads with that and quotes the URL it actually tried - which is
    # usually enough to see the mistake without reading further.
    with pytest.raises(Exception) as caught:
        client(FakeGateway(whoami_status=404)).connect()

    assert "https://gw.test/whoami answered 404" in str(caught.value)
    assert "no consumer path after it" in str(caught.value)


def test_end_user_can_read_its_connections_and_mint_a_link() -> None:
    gateway = FakeGateway()
    alice = client(gateway).connect().for_end_user("user_123")

    connections = alice.connections()
    link = alice.connect_link("com.notion/mcp")

    assert connections[0].provider == "com.notion/mcp"
    assert link.ticket == "t-1"
    assert link.provider == "com.notion/mcp"
