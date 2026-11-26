"""A gateway that lists only its own tools, and Code Mode programs.

A gateway can be set to list only its search, call and program tools, so a
model is not handed every server's schemas up front. The caller's tools still
answer by name: what an agent requires, and the short names it calls, have to
mean the same on such a gateway as on one that lists everything.
"""

from __future__ import annotations

import pytest

from trustgate import MissingToolsError, TrustGate, TrustGateError
from trustgate.mcp import PROGRAM_TIMEOUT
from trustgate.types import GatewayTool

from .fake_gateway import FakeGateway

BASE = dict(base_url="https://gw.test", api_key="ag_secret")

GATEWAY_TOOLS = [
    GatewayTool(name="trustgate_search"),
    GatewayTool(name="trustgate_call"),
    GatewayTool(name="trustgate_execute"),
]


def client(gateway: FakeGateway, **overrides) -> TrustGate:
    return TrustGate(**{**BASE, **overrides}, transport=gateway)


def gateway_listing(searchable: list[dict]) -> FakeGateway:
    return FakeGateway(tools=list(GATEWAY_TOOLS), searchable=searchable)


def test_finds_a_required_tool_the_gateway_does_not_list() -> None:
    gateway = gateway_listing(
        [
            {"name": "linear_list_issues", "server": "Linear", "callable": True},
            {"name": "notion_search", "server": "Notion", "callable": True},
        ]
    )

    agent = client(gateway).connect(requires=["list_issues", "notion_search"])

    # The model is still handed what the gateway lists, and nothing more.
    assert [tool.name for tool in agent.tools] == [t.name for t in GATEWAY_TOOLS]
    assert gateway.searches() == [{"kind": "tool", "brief": True, "limit": 50}]


# A tool on a server still waiting on an account is not callable, and the
# listing would leave it out: requiring it fails the start the same way.
def test_still_refuses_a_required_tool_that_cannot_be_called_yet() -> None:
    gateway = gateway_listing(
        [
            {"name": "linear_list_issues", "server": "Linear", "callable": True},
            {"name": "github_list_prs", "server": "GitHub", "callable": False},
        ]
    )

    with pytest.raises(MissingToolsError) as caught:
        client(gateway).connect(requires=["linear_list_issues", "github_list_prs"])

    assert caught.value.missing == ["github_list_prs"]
    # What it offers is the whole surface, not the gateway's three tools.
    assert "linear_list_issues" in caught.value.available
    assert "github_list_prs" not in caught.value.available


def test_reads_every_page_of_the_search() -> None:
    searchable = [{"name": f"svc_tool_{i:03}", "callable": True} for i in range(120)]
    gateway = gateway_listing(searchable)

    client(gateway).connect(requires=["svc_tool_119"])

    assert [search.get("cursor") for search in gateway.searches()] == [None, "50", "100"]


def test_does_not_search_when_the_listing_has_what_is_required() -> None:
    gateway = FakeGateway(
        tools=[GatewayTool(name="notion_search"), *GATEWAY_TOOLS],
        searchable=[{"name": "notion_search", "callable": True}],
    )

    client(gateway).connect(requires=["notion_search"])

    assert gateway.searches() == []


# An older gateway, or one whose search cannot list tools, leaves the check as
# it was: the listing is all there is.
def test_a_search_that_cannot_list_tools_changes_nothing() -> None:
    gateway = FakeGateway(
        tools=list(GATEWAY_TOOLS),
        call_results={
            "trustgate_search": {
                "isError": True,
                "content": [{"type": "text", "text": "cannot search tool"}],
            }
        },
    )

    with pytest.raises(MissingToolsError) as caught:
        client(gateway).connect(requires=["linear_list_issues"])

    assert caught.value.missing == ["linear_list_issues"]


def test_calls_a_tool_the_gateway_does_not_list_by_its_short_name() -> None:
    gateway = gateway_listing([{"name": "linear_list_issues", "callable": True}])
    agent = client(gateway).connect()

    agent.call_tool("list_issues", {"team": "ENG"})
    agent.call_tool("list_issues", {"team": "OPS"})

    called = [
        r.body["params"]["name"]
        for r in gateway.requests
        if isinstance(r.body, dict) and r.body.get("method") == "tools/call"
    ]
    assert called == ["trustgate_search", "linear_list_issues", "linear_list_issues"]

    # A re-read surface is read through the search again when a name needs it.
    agent.refresh()
    agent.call_tool("list_issues")
    assert len(gateway.searches()) == 2


def test_asks_which_one_when_two_unlisted_tools_share_a_short_name() -> None:
    gateway = gateway_listing(
        [
            {"name": "linear_list_issues", "callable": True},
            {"name": "github_list_issues", "callable": True},
        ]
    )
    agent = client(gateway).connect()

    with pytest.raises(TrustGateError, match="more than one"):
        agent.call_tool("list_issues")


def test_a_named_persons_requirements_are_searched_as_that_person() -> None:
    gateway = gateway_listing([{"name": "linear_list_issues", "callable": True}])

    client(gateway).for_end_user("user_123", requires=["linear_list_issues"])

    searched = [
        r
        for r in gateway.requests
        if isinstance(r.body, dict)
        and r.body.get("method") == "tools/call"
        and r.body["params"]["name"] == "trustgate_search"
    ]
    assert searched and searched[0].headers["X-NeuralTrust-End-User"] == "user_123"


# The gateway stops a program at its own limit and answers with the calls it
# made; a client that gives up at the same moment gets none of that.
def test_waits_longer_for_a_program_than_for_one_tool() -> None:
    gateway = gateway_listing([])
    agent = client(gateway).connect()

    agent.call_tool("trustgate_execute", {"code": "return 1"})
    agent.call_tool("trustgate_call", {"tool": "trustgate_execute", "arguments": {"code": "1"}})
    agent.call_tool("trustgate_call", {"tool": "linear_list_issues", "arguments": {}})

    calls = [
        r.timeout
        for r in gateway.requests
        if isinstance(r.body, dict) and r.body.get("method") == "tools/call"
    ]
    assert calls == [PROGRAM_TIMEOUT, PROGRAM_TIMEOUT, 30.0]


def test_a_longer_configured_timeout_still_holds_for_programs() -> None:
    gateway = gateway_listing([])
    agent = client(gateway, timeout=120.0).connect()

    agent.call_tool("trustgate_execute", {"code": "return 1"})

    assert gateway.requests[-1].timeout == 120.0
