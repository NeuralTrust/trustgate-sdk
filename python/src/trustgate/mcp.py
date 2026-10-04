"""The gateway's MCP endpoint, spoken directly.

Only two methods are needed to put a consumer's tools in front of a model -
list them and call them - so this is a JSON-RPC client rather than a whole MCP
implementation. The gateway is stateless: there is no handshake to do and no
session to carry, so every call stands on its own.
"""

from __future__ import annotations

import json
from typing import Any

from .config import API_KEY_HEADER, Config
from .errors import (
    AuthenticationError,
    ConsentRequiredError,
    InvalidRequestError,
    PolicyBlockedError,
    RateLimitedError,
    ServiceUnavailableError,
    ToolNotFoundError,
    TrustGateError,
    TrustGateServerError,
    UpstreamNotConnectedError,
)
from .transport import Response, Transport, retry_after_ms
from .types import GatewayTool
from .whoami import BLOCKED_BY_ADMINISTRATOR, BLOCKED_BY_END_USER, KeyUpstream

CODE_CONSENT_REQUIRED = -32003
CODE_RATE_LIMITED = -32004
CODE_UNAVAILABLE = -32005
CODE_RESOURCE_NOT_FOUND = -32002
CODE_POLICY_BLOCKED = -32001
CODE_INVALID_REQUEST = -32600
CODE_INVALID_PARAMS = -32602
CODE_INTERNAL = -32603


class MCPTransport:
    def __init__(
        self,
        config: Config,
        transport: Transport,
        url: str,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        self._config = config
        self._transport = transport
        self.url = url
        self._extra_headers = dict(extra_headers or {})
        self._next_id = 1

    @property
    def headers(self) -> dict[str, str]:
        return {API_KEY_HEADER: self._config.api_key, **self._extra_headers}

    def list_tools(self) -> list[GatewayTool]:
        result = self.call("tools/list", {})
        tools = result.get("tools") or []
        return [
            GatewayTool(
                name=str(tool.get("name", "")),
                description=tool.get("description"),
                title=tool.get("title"),
                input_schema=tool.get("inputSchema") or {"type": "object", "properties": {}},
                output_schema=tool.get("outputSchema"),
            )
            for tool in tools
        ]

    def call_tool(self, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        try:
            return self.call("tools/call", {"name": name, "arguments": arguments or {}})
        except InvalidRequestError as error:
            # The gateway reports an unknown tool as invalid params, which is
            # true of the request and useless to the caller: what they need to
            # know is which tool, because a toolkit can lose one under them.
            if error.code == str(CODE_INVALID_PARAMS):
                raise ToolNotFoundError(name, error.message) from error
            raise

    def call(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        request_id = self._next_id
        self._next_id += 1
        body = json.dumps(
            {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
        ).encode("utf-8")
        response = self._transport.request(
            "POST",
            self.url,
            {
                **self.headers,
                "Content-Type": "application/json",
                # A plain JSON answer is enough: the SDK re-lists on demand
                # rather than listening for a change on the response.
                "Accept": "application/json",
            },
            body,
            self._config.timeout,
        )
        if response.status in (401, 403):
            raise AuthenticationError(
                f"the gateway refused this API key for {self.url}", status=response.status
            )
        rpc = parse_rpc_response(response.text, request_id)
        if rpc is None:
            raise TrustGateError(
                f"MCP {method} returned no JSON-RPC response (HTTP {response.status})"
                f"{_what_it_said(response.text)}",
                status=response.status,
            )
        if "error" in rpc:
            raise _error_for_rpc(rpc["error"], response)
        return rpc.get("result") or {}


def parse_rpc_response(text: str, request_id: int) -> dict[str, Any] | None:
    """Reads the response body, which is not always JSON.

    When a change to the surface has to be announced, the gateway answers the
    same request as an event stream and puts the response in a frame after the
    notification. Both shapes carry the same JSON-RPC object, so both are read
    here; a frame that is not this request's answer is skipped rather than
    mistaken for it.
    """
    trimmed = text.strip()
    if not trimmed:
        return None
    if trimmed.startswith("{"):
        try:
            return json.loads(trimmed)
        except json.JSONDecodeError:
            return None
    for line in trimmed.splitlines():
        if not line.startswith("data:"):
            continue
        try:
            frame = json.loads(line[len("data:") :].strip())
        except json.JSONDecodeError:
            continue
        if isinstance(frame, dict) and frame.get("id") == request_id:
            return frame
    return None


def _what_it_said(text: str) -> str:
    """The reason the endpoint gave, when it did not give it in JSON-RPC.

    A plain HTTP error - a missing header, a path that is no virtual MCP - says
    why in its body, and dropping that leaves a status code to guess from.
    """
    said = " ".join((text or "").split())
    try:
        body = json.loads(text)
    except ValueError:
        body = None
    if isinstance(body, dict):
        for key in ("error", "message", "detail"):
            value = body.get(key)
            if isinstance(value, str) and value.strip():
                said = value.strip()
                break
    return f": {said[:200]}" if said else ""


#: The reason a -32003 carries when nobody on this call can connect the account.
REASON_APPLICATION_NOT_CONNECTED = "application_not_connected"


def _error_for_rpc(error: dict[str, Any], response: Response | None = None) -> TrustGateError:
    code = error.get("code")
    message = str(error.get("message", ""))
    data = error.get("data") or {}
    if not isinstance(data, dict):
        data = {}
    if code == CODE_CONSENT_REQUIRED and _not_connectable_here(data):
        return UpstreamNotConnectedError([_upstream_from(data, message)])
    if code == CODE_CONSENT_REQUIRED:
        return ConsentRequiredError(
            str(data.get("provider", "this provider")),
            str(data.get("connect_url", "")),
            str(data.get("cause", "")),
            message,
        )
    if code == CODE_POLICY_BLOCKED:
        return PolicyBlockedError(message, code=str(code))
    if code == CODE_RATE_LIMITED:
        return RateLimitedError(message, retry_after_ms(response) if response else None)
    if code == CODE_UNAVAILABLE:
        return ServiceUnavailableError(message, code=str(code))
    if code == CODE_INTERNAL:
        return TrustGateServerError(message, code=str(code))
    if code in (CODE_INVALID_PARAMS, CODE_INVALID_REQUEST, CODE_RESOURCE_NOT_FOUND):
        return InvalidRequestError(message, code=str(code))
    return TrustGateError(message, code=str(code))


def _not_connectable_here(data: dict[str, Any]) -> bool:
    """Whether a -32003 names an account this call cannot connect.

    The gateway uses the code for both: a consent prompt, which carries the page
    to open, and a server whose account belongs to its instance or to a person
    the call did not name, which carries none. A gateway too old to send the
    reason still leaves the link out, and an empty link is never something to
    put in front of anyone.
    """
    if data.get("reason") == REASON_APPLICATION_NOT_CONNECTED:
        return True
    return not str(data.get("connect_url") or "").strip()


def _upstream_from(data: dict[str, Any], message: str) -> KeyUpstream:
    """The blocked server, as much of it as the error names."""
    provider = str(data.get("provider") or "") or None
    server = str(data.get("registry") or "") or provider or _server_in(message) or "this server"
    shared = data.get("shared") is True
    return KeyUpstream(
        server=server,
        provider=provider,
        account="shared" if shared else "user",
        blocked=BLOCKED_BY_ADMINISTRATOR if shared else BLOCKED_BY_END_USER,
    )


def _server_in(message: str) -> str | None:
    """The server a message without data quotes first, as the gateway writes it."""
    start = message.find('"')
    end = message.find('"', start + 1) if start >= 0 else -1
    return message[start + 1 : end] if end > start else None
