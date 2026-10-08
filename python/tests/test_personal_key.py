from __future__ import annotations

import pytest

from trustgate import (
    PlaneUnavailableError,
    TrustGate,
    TrustGateError,
    TrustGateUser,
    UserAgent,
)

from .fake_gateway import FakeGateway

KEY = "ag_personal"


def personal_whoami(llm: bool = True) -> dict:
    consumers = [
        {
            "slug": "store",
            "name": "MCP Store",
            "type": "MCP",
            "active": True,
            "url": "https://acme.mcp.test/store/mcp",
        }
    ]
    if llm:
        consumers.append(
            {
                "slug": "store",
                "name": "LLM Store",
                "type": "LLM",
                "active": True,
                "url": "https://acme.llm.test/store/v1",
            }
        )
    return {
        "gateway": "acme",
        "key": {"name": "personal", "personal": True},
        "consumers": consumers,
    }


def test_a_personal_key_opens_its_owners_store_without_a_browser() -> None:
    gateway = FakeGateway(whoami=personal_whoami())

    me = TrustGateUser(api_key=KEY, transport=gateway).connect(requires=["notion_search"])

    assert isinstance(me, UserAgent)
    assert [tool.name for tool in me.tools] == ["notion_search"]
    assert me.mcp.url == "https://acme.mcp.test/store/mcp"
    assert me.mcp.headers["X-AG-API-Key"] == KEY
    whoami, listing = gateway.requests
    assert whoami.url == "https://agentgateway-mcp.neuraltrust.ai/whoami"
    assert listing.url == "https://acme.mcp.test/store/mcp"
    assert listing.headers["X-AG-API-Key"] == KEY
    assert not any("/connections" in request.url for request in gateway.requests)


def test_a_personal_key_reaches_its_owners_models() -> None:
    gateway = FakeGateway(whoami=personal_whoami())

    llm = TrustGateUser(api_key=KEY, transport=gateway).llm()

    assert llm.base_url == "https://acme.llm.test/store/v1"
    assert llm.api_key == KEY
    assert llm.headers == {"X-AG-API-Key": KEY}


def test_says_so_when_the_gateway_offers_the_key_no_models() -> None:
    gateway = FakeGateway(whoami=personal_whoami(llm=False))

    with pytest.raises(PlaneUnavailableError, match="no models"):
        TrustGateUser(api_key=KEY, transport=gateway).llm()


def test_goes_straight_to_the_store_when_given_its_url() -> None:
    gateway = FakeGateway(whoami=personal_whoami())

    TrustGateUser("https://acme.mcp.test/store/mcp", api_key=KEY, transport=gateway).connect()

    assert [request.url for request in gateway.requests] == ["https://acme.mcp.test/store/mcp"]


def test_asks_the_store_host_for_the_models_when_given_the_store_url() -> None:
    gateway = FakeGateway(whoami=personal_whoami())

    llm = TrustGateUser("https://acme.mcp.test/store/mcp", api_key=KEY, transport=gateway).llm()

    assert gateway.requests[0].url == "https://acme.mcp.test/whoami"
    assert llm.base_url == "https://acme.llm.test/store/v1"


def test_reads_the_key_from_the_environment(monkeypatch) -> None:
    monkeypatch.setenv("TRUSTGATE_PERSONAL_KEY", KEY)
    gateway = FakeGateway(whoami=personal_whoami())

    me = TrustGateUser(transport=gateway).connect()

    assert me.mcp.headers["X-AG-API-Key"] == KEY


def test_an_application_key_is_pointed_at_TrustGate() -> None:
    gateway = FakeGateway()

    with pytest.raises(TrustGateError, match=r"TrustGate\(api_key=\.\.\.\)"):
        TrustGateUser(api_key="ag_application", transport=gateway).connect()


def test_TrustGate_points_a_personal_key_at_TrustGateUser() -> None:
    gateway = FakeGateway(whoami=personal_whoami())
    tg = TrustGate(api_key=KEY, transport=gateway)

    for open_it in (tg.connect, lambda: tg.for_end_user("user_123")):
        with pytest.raises(TrustGateError, match=r"TrustGateUser\(api_key=\.\.\.\)"):
            open_it()


def test_a_sign_in_has_no_models() -> None:
    user = TrustGateUser("https://acme.mcp.test/store/mcp", access_token="at-1")

    with pytest.raises(TrustGateError, match="personal key"):
        user.llm()


def test_a_key_and_a_token_together_are_refused() -> None:
    with pytest.raises(TrustGateError, match="not both"):
        TrustGateUser("https://acme.mcp.test/store/mcp", access_token="at-1", api_key=KEY)
