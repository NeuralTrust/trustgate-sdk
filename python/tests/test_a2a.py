from __future__ import annotations

import pytest

from trustgate import PlaneUnavailableError, TrustGate, TrustGateError
from trustgate.config import END_USER_HEADER

from .fake_gateway import FakeGateway

BASE = dict(base_url="https://gw.test", api_key="ag_secret")
PLANE = "https://gw-x.agents.test/research-bot/agents"

TRAVEL = {"id": "0192-a", "name": "Travel planner"}
RESEARCH = {"id": "0192-b", "name": "Researcher"}


def agents_whoami(agents: list[dict], url: str = PLANE) -> dict:
    return {
        "gateway": "acme",
        "consumers": [
            {"slug": "acme", "type": "MCP", "active": True, "url": "https://gw.test/acme/mcp"},
            {
                "slug": "research-bot",
                "type": "A2A",
                "active": True,
                "url": url,
                "agents": [
                    {
                        **agent,
                        "card_url": f"{url}/{agent['id']}/.well-known/agent-card.json",
                        "protocol_version": "1.0",
                    }
                    for agent in agents
                ],
            },
        ],
    }


def client(whoami: dict) -> TrustGate:
    return TrustGate(**BASE, transport=FakeGateway(whoami=whoami))


def test_lists_the_agents_with_the_endpoint_and_headers_a_client_needs() -> None:
    agents = client(agents_whoami([TRAVEL, RESEARCH])).agents()

    assert len(agents) == 2
    agent = agents[0]
    assert agent.id == "0192-a"
    assert agent.name == "Travel planner"
    assert agent.card_url == f"{PLANE}/0192-a/.well-known/agent-card.json"
    assert agent.protocol_version == "1.0"
    assert agent.url == f"{PLANE}/0192-a"
    assert agent.consumer == "research-bot"
    assert agent.headers == {"X-AG-API-Key": "ag_secret"}


def test_names_the_end_user_in_the_headers_when_asked_to() -> None:
    agents = client(agents_whoami([TRAVEL])).agents(end_user="user_123")

    assert agents[0].headers[END_USER_HEADER] == "user_123"
    with pytest.raises(TrustGateError, match="end-user id is required"):
        client(agents_whoami([TRAVEL])).agents(end_user="  ")


def test_is_an_empty_list_for_an_a2a_consumer_with_no_agents() -> None:
    assert client(agents_whoami([])).agents() == []


def test_says_so_when_the_key_reaches_no_a2a_consumer() -> None:
    with pytest.raises(PlaneUnavailableError):
        client({"gateway": "acme", "consumers": []}).agents()


def test_says_so_when_the_gateway_publishes_no_host_for_the_plane() -> None:
    whoami = {
        "gateway": "acme",
        "consumers": [{"slug": "research-bot", "type": "A2A", "active": True, "agents": []}],
    }

    with pytest.raises(PlaneUnavailableError, match="publishes no host for its A2A plane"):
        client(whoami).agents()


def test_refuses_an_agent_served_over_plain_http() -> None:
    with pytest.raises(TrustGateError, match="plain http"):
        client(agents_whoami([TRAVEL], "http://agents.test/research-bot/agents")).agents()


def test_keeps_the_key_out_of_a_printed_agent() -> None:
    (agent,) = client(agents_whoami([TRAVEL])).agents()

    assert "ag_secret" not in repr(agent)


def test_finds_one_by_id_or_by_name() -> None:
    tg = client(agents_whoami([TRAVEL, RESEARCH]))

    assert tg.agent("0192-b").name == "Researcher"
    assert tg.agent("Travel planner").id == "0192-a"


def test_names_what_it_reaches_when_nothing_matches() -> None:
    with pytest.raises(TrustGateError, match=r"Travel planner \(0192-a\)") as caught:
        client(agents_whoami([TRAVEL])).agent("Nobody")

    assert caught.value.code == "agent_not_found"


def test_asks_which_one_when_two_agents_share_a_name() -> None:
    twins = [TRAVEL, {"id": "0192-c", "name": "Travel planner"}]

    with pytest.raises(TrustGateError, match="0192-a, 0192-c") as caught:
        client(agents_whoami(twins)).agent("Travel planner")

    assert caught.value.code == "ambiguous_agent"
