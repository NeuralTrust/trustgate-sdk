from __future__ import annotations

from trustgate import ConsentRequiredError, MemoryTokenCache, TrustGate, TrustGateUser, UserToken

from .fake_gateway import FakeGateway

KEY = "ag_do_not_print_me"


# A client ends up in a log line, an error report or a debugger sooner or
# later; none of those may carry the key.
def test_the_client_prints_without_its_key() -> None:
    tg = TrustGate(base_url="https://gw.test", api_key=KEY, transport=FakeGateway())

    assert KEY not in repr(tg)
    assert KEY not in repr(vars(tg))


def test_an_agent_and_its_endpoint_print_without_the_key() -> None:
    tg = TrustGate(
        base_url="https://gw.test", api_key=KEY, mcp_consumer="acme", transport=FakeGateway()
    )
    agent = tg.connect()

    assert KEY not in repr(agent)
    assert KEY not in repr(agent.mcp)
    assert agent.mcp.headers["X-AG-API-Key"] == KEY


def test_the_llm_endpoint_prints_without_the_key() -> None:
    gateway = FakeGateway(
        whoami={
            "gateway": "acme",
            "consumers": [
                {
                    "slug": "acme-llm",
                    "type": "LLM",
                    "active": True,
                    "url": "https://llm.gw.test/acme-llm/v1",
                }
            ],
        }
    )
    llm = TrustGate(base_url="https://gw.test", api_key=KEY, transport=gateway).llm()

    assert llm.api_key == KEY
    assert KEY not in repr(llm)


def test_an_end_user_handle_prints_without_the_key() -> None:
    tg = TrustGate(
        base_url="https://gw.test", api_key=KEY, mcp_consumer="acme", transport=FakeGateway()
    )

    assert KEY not in repr(tg.for_end_user("user_123"))


def test_a_signed_in_user_prints_without_the_session() -> None:
    user = TrustGateUser(
        "https://acme.mcp.test",
        token=UserToken(access_token="tok_access_secret", refresh_token="tok_refresh_secret"),
        cache=MemoryTokenCache(),
    )

    for printed in (repr(vars(user)), repr(vars(user.session))):
        assert "tok_access_secret" not in printed
        assert "tok_refresh_secret" not in printed


# Errors are usually logged whole; the link's ticket works for whoever holds it.
def test_a_consent_error_prints_without_its_link() -> None:
    error = ConsentRequiredError(
        "com.notion/mcp", "https://gw.test/acme/mcp/connect?ticket=t-9", ""
    )

    assert error.connect_url.endswith("t-9")
    assert "t-9" not in str(error)
    assert "t-9" not in repr(error)
