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

BASE = dict(base_url="https://gw.test", api_key="ag_secret", mcp_consumer="acme")


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


def test_hands_the_llm_plane_to_a_provider_client_without_wrapping_it() -> None:
    tg = client(FakeGateway(), llm_consumer="acme-llm")

    assert tg.llm.base_url == "https://gw.test/acme-llm/v1"
    assert tg.llm.api_key == "ag_secret"


def test_says_so_when_the_key_was_never_pointed_at_an_llm_consumer() -> None:
    with pytest.raises(PlaneUnavailableError, match="TRUSTGATE_LLM_CONSUMER"):
        _ = client(FakeGateway()).llm


def test_end_user_can_read_its_connections_and_mint_a_link() -> None:
    gateway = FakeGateway(actor="end_user")
    alice = client(gateway).connect().for_end_user("user_123")

    connections = alice.connections()
    link = alice.connect_link("com.notion/mcp")

    assert connections[0].provider == "com.notion/mcp"
    assert link.ticket == "t-1"
    assert link.provider == "com.notion/mcp"
