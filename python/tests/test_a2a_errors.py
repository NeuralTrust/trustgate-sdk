"""The gateway's A2A errors, read from what an A2A client raises."""

from __future__ import annotations

import asyncio
import json

import pytest

from trustgate import (
    AuthenticationError,
    InvalidRequestError,
    PolicyBlockedError,
    RateLimitedError,
    ServiceUnavailableError,
    TrustGateServerError,
    a2a,
)


def rpc(code: int, message: str, data: dict | None = None) -> dict:
    error: dict = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    return error


def test_policy_block_names_the_plugin_and_reason():
    for reason in ("policy_blocked", "mask_unsupported"):
        err = a2a.gateway_error(
            rpc(-32090, "Blocked by gateway policy", {"reason": reason, "plugin": "trustguard"})
        )
        assert isinstance(err, PolicyBlockedError)
        assert err.code == reason
        assert err.plugin == "trustguard"
        assert "trustguard" in str(err)


def test_rate_limit_carries_the_wait():
    err = a2a.gateway_error(rpc(-32091, "Rate limit exceeded", {"retry_after": 30}))
    assert isinstance(err, RateLimitedError)
    assert err.retry_after_ms == 30_000


def test_gateway_failure_is_retryable_only_when_transient():
    slow = a2a.gateway_error(
        rpc(-32092, "Gateway could not complete the call", {"reason": "upstream_timeout"})
    )
    assert isinstance(slow, ServiceUnavailableError)
    assert slow.code == "upstream_timeout"
    broken = a2a.gateway_error(
        rpc(
            -32092,
            "Gateway could not complete the call",
            {"reason": "invalid_upstream_response", "upstream_status": 404},
        )
    )
    assert isinstance(broken, TrustGateServerError)
    assert broken.code == "invalid_upstream_response"
    assert "HTTP 404" in str(broken)


def test_identity_required_and_access_refused():
    who = a2a.gateway_error(
        rpc(-32093, "An authenticated user is required", {"reason": "identity_required"})
    )
    assert isinstance(who, AuthenticationError)
    assert who.code == "identity_required"
    refused = a2a.gateway_error(
        rpc(-32094, "Unauthenticated", {"reason": "unauthenticated"}), status=401
    )
    assert isinstance(refused, AuthenticationError)
    assert (refused.status, refused.code) == (401, "unauthenticated")
    bad_user = a2a.gateway_error(rpc(-32094, "bad end user", {"reason": "invalid_end_user"}))
    assert isinstance(bad_user, InvalidRequestError)
    down = a2a.gateway_error(
        rpc(-32094, "Failed to load gateway data", {"reason": "gateway_data_unavailable"})
    )
    assert isinstance(down, ServiceUnavailableError)


def test_an_agents_own_error_in_the_same_range_is_left_alone():
    # The gateway relays an agent's error as it came; without the gateway's
    # data or message it is not taken for the gateway's.
    for error in (
        rpc(-32090, "Quota of the agent's own", {"reason": "something_else"}),
        rpc(-32091, "Rate limit exceeded", {"limit": 5}),
        rpc(-32092, "agent failed", {}),
        rpc(-32001, "Task not found"),
        rpc(-32602, "Invalid params", {"reason": "agent_rejected"}),
    ):
        assert a2a.gateway_error(error) is None, error


def test_a_whole_response_is_read():
    response = {
        "jsonrpc": "2.0",
        "id": 7,
        "error": rpc(-32091, "Rate limit exceeded", {"retry_after": 2}),
    }
    assert isinstance(a2a.gateway_error(response), RateLimitedError)


class A2AClientError(Exception):
    """What a2a-sdk 1.x raises for a code it does not know: the data is gone."""


def test_a2a_sdk_1x_error_is_read_from_its_code_and_message():
    err = a2a.gateway_error(A2AClientError("JSON-RPC Error -32090: Blocked by gateway policy"))
    assert isinstance(err, PolicyBlockedError)
    assert err.plugin is None
    # An agent's error with the same code but its own message stays the agent's.
    assert a2a.gateway_error(A2AClientError("JSON-RPC Error -32090: my agent's quota")) is None
    assert a2a.gateway_error(ValueError("boom")) is None


class _Model:
    def __init__(self, **fields):
        self._fields = fields

    def model_dump(self):
        return self._fields


class A2AClientJSONRPCError(Exception):
    """a2a-sdk 0.3: .error is the JSONRPCErrorResponse, its .error the JSONRPCError."""

    def __init__(self, response):
        super().__init__("JSON-RPC error")
        self.error = response


def test_a2a_sdk_03_error_keeps_the_data():
    response = _Model(
        jsonrpc="2.0",
        id=1,
        error=rpc(
            -32090,
            "Blocked by gateway policy",
            {"reason": "policy_blocked", "plugin": "rate_limiter"},
        ),
    )
    err = a2a.gateway_error(A2AClientJSONRPCError(response))
    assert isinstance(err, PolicyBlockedError)
    assert err.plugin == "rate_limiter"


def test_gateway_errors_raises_the_sdk_type_from_the_original():
    original = A2AClientError("JSON-RPC Error -32091: Rate limit exceeded")
    with pytest.raises(RateLimitedError) as caught, a2a.gateway_errors():
        raise original
    assert caught.value.__cause__ is original
    with pytest.raises(KeyError), a2a.gateway_errors():
        raise KeyError("not the gateway's")


class FakeResponse:
    def __init__(self, status: int, content_type: str, body: str):
        self.status_code = status
        self.headers = {"content-type": content_type}
        self._body = body
        self.read = False

    async def aread(self) -> bytes:
        self.read = True
        return self._body.encode()

    def json(self):
        return json.loads(self._body)


def run_hook(response: FakeResponse) -> None:
    (hook,) = a2a.event_hooks()["response"]
    asyncio.run(hook(response))


def test_event_hook_raises_on_a_gateway_error_answer():
    body = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": None,
            "error": rpc(
                -32094,
                "Credential not allowed for this application",
                {"reason": "credential_not_allowed"},
            ),
        }
    )
    with pytest.raises(AuthenticationError) as caught:
        run_hook(FakeResponse(403, "application/json; charset=utf-8", body))
    assert (caught.value.status, caught.value.code) == (403, "credential_not_allowed")


def test_event_hook_leaves_results_and_streams_alone():
    result = FakeResponse(
        200, "application/json", json.dumps({"jsonrpc": "2.0", "id": 1, "result": {}})
    )
    run_hook(result)
    assert result.read
    agents_error = FakeResponse(
        200,
        "application/json",
        json.dumps({"jsonrpc": "2.0", "id": 1, "error": rpc(-32001, "Task not found")}),
    )
    run_hook(agents_error)
    stream = FakeResponse(200, "text/event-stream", "data: {}\n\n")
    run_hook(stream)
    assert not stream.read, "an event stream is not read ahead"
