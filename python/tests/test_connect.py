from __future__ import annotations

import pytest

from trustgate import (
    Agent,
    EndUserAgentFactory,
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
# unconnected upstream has to stop it before it starts.
def test_refuses_an_application_whose_own_accounts_are_not_connected() -> None:
    gateway = FakeGateway(
        connections=[
            {"provider": "com.notion/mcp", "status": "connected"},
            {"provider": "app.linear/mcp", "status": "not_connected"},
        ]
    )

    with pytest.raises(UpstreamNotConnectedError) as caught:
        client(gateway).connect()

    assert caught.value.providers == ["app.linear/mcp"]
    assert caught.value.connect_url == "https://gw.test/acme/connect"


def test_counts_an_expired_account_as_not_connected() -> None:
    gateway = FakeGateway(connections=[{"provider": "com.notion/mcp", "status": "needs_reconnect"}])

    with pytest.raises(UpstreamNotConnectedError):
        client(gateway).connect()


# The consumer decides which actor it is; the SDK reads that off the one
# question only one of the two can answer.
def test_discovers_an_application_that_acts_for_its_own_users() -> None:
    gateway = FakeGateway(actor="end_user")

    handle = client(gateway).connect()

    assert isinstance(handle, EndUserAgentFactory)
    assert handle.actor.value == "end_user"


def test_names_the_user_on_every_call_once_one_is_chosen() -> None:
    gateway = FakeGateway(actor="end_user")
    handle = client(gateway).connect()

    alice = handle.for_end_user("user_123")
    alice.call_tool("notion_search", {"query": "runbook"})

    assert alice.mcp.headers[END_USER_HEADER] == "user_123"
    assert gateway.requests[-1].headers[END_USER_HEADER] == "user_123"


# An application that acts as itself has no users to speak for, and a handle
# that pretended otherwise would pool everyone into one account.
def test_refuses_to_name_a_user_on_an_application_that_acts_as_itself() -> None:
    agent = client(FakeGateway()).connect()

    with pytest.raises(Exception, match="no end users"):
        agent.for_end_user("user_123")


def test_rejects_an_empty_end_user() -> None:
    handle = client(FakeGateway(actor="end_user")).connect()

    with pytest.raises(Exception, match="end-user id is required"):
        handle.for_end_user("   ")


BOTH_PLANES = {
    "gateway": "acme",
    "consumers": [
        {"slug": "acme", "type": "MCP", "active": True, "url": "https://gw.test/acme/mcp",
         "acts_for_users": False},
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
                {"slug": "support", "type": "MCP", "active": True, "url": "https://gw.test/support/mcp"},
                {"slug": "billing", "type": "MCP", "active": True, "url": "https://gw.test/billing/mcp"},
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
    gateway = FakeGateway(actor="end_user")
    alice = client(gateway).connect().for_end_user("user_123")

    connections = alice.connections()
    link = alice.connect_link("com.notion/mcp")

    assert connections[0].provider == "com.notion/mcp"
    assert link.ticket == "t-1"
    assert link.provider == "com.notion/mcp"
