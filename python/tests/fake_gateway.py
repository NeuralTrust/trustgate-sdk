"""A gateway that answers like the real one, without a network."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs, urlparse

from trustgate.transport import Response
from trustgate.types import GatewayTool

END_USER_HEADER = "X-NeuralTrust-End-User"


@dataclass
class Recorded:
    method: str
    url: str
    headers: dict[str, str]
    body: Any = None


@dataclass
class FakeGateway:
    #: Requires the end-user header on the MCP endpoint, as a per-user server does.
    require_end_user: bool = False
    #: What /whoami reports the application still has to connect.
    upstreams: list[dict[str, Any]] | None = None
    #: When the calling key retires itself.
    key_expires_at: str | None = None
    #: Overrides what /whoami answers, for the cases about resolving a key.
    whoami: Any | None = None
    #: Answers /whoami with this status instead of 200.
    whoami_status: int = 0
    connections: list[dict[str, Any]] = field(
        default_factory=lambda: [{"provider": "com.notion/mcp", "status": "connected"}]
    )
    tools: list[GatewayTool] = field(
        default_factory=lambda: [
            GatewayTool(name="notion_search", description="search", input_schema={"type": "object", "properties": {}})
        ]
    )
    call_results: dict[str, Any] = field(default_factory=dict)
    call_errors: dict[str, dict[str, Any]] = field(default_factory=dict)
    #: Fails tools/list with this JSON-RPC error, as a server with no account
    #: for the caller can make the whole listing fail.
    list_error: dict[str, Any] | None = None
    #: Frames the tools/call response as an event stream, as the gateway does
    #: when it has a surface change to announce on the same response.
    frame_as_event_stream: bool = False
    requests: list[Recorded] = field(default_factory=list)

    def request(
        self,
        method: str,
        url: str,
        headers: dict[str, str],
        body: bytes | None,
        timeout: float,
    ) -> Response:
        decoded = json.loads(body) if body else None
        self.requests.append(Recorded(method=method, url=url, headers=dict(headers), body=decoded))

        if url.endswith("/whoami"):
            if self.whoami_status:
                return _json(self.whoami_status, {"error": "not_found", "message": "no route"})
            return _json(
                200,
                self.whoami
                if self.whoami is not None
                else {
                    "gateway": "acme",
                    "key": {
                        "name": "prod",
                        **({"expires_at": self.key_expires_at} if self.key_expires_at else {}),
                    },
                    "consumers": [
                        {
                            "slug": "acme",
                            "name": "Acme Agent",
                            "type": "MCP",
                            "active": True,
                            "url": "https://gw.test/acme/mcp",
                            **({"upstreams": self.upstreams} if self.upstreams is not None else {}),
                        }
                    ],
                },
            )
        if "/connections/links" in url:
            return _json(
                201,
                {
                    "connect_url": "https://gw.test/acme/mcp/connect?ticket=t-1",
                    "ticket": "t-1",
                    "provider": (decoded or {}).get("provider"),
                    "expires_at": "2026-01-01T00:15:00Z",
                },
            )
        if "/connections" in url:
            named = parse_qs(urlparse(url).query).get("end_user", [None])[0]
            return _json(
                200,
                {
                    "end_user": named or "",
                    "actor": "end_user" if named else "application",
                    "connections": self.connections,
                },
            )
        if url.endswith("/mcp"):
            if self.require_end_user and not headers.get(END_USER_HEADER):
                return _json(
                    400,
                    {"error": f"invalid end user: {END_USER_HEADER} header is required"},
                )
            rpc = decoded or {}
            if rpc.get("method") == "tools/list":
                if self.list_error is not None:
                    return self._rpc_error(rpc["id"], self.list_error)
                return self._rpc(rpc["id"], {"tools": [_tool_json(t) for t in self.tools]}, False)
            if rpc.get("method") == "tools/call":
                name = rpc["params"]["name"]
                if name in self.call_errors:
                    return self._rpc_error(rpc["id"], self.call_errors[name])
                result = self.call_results.get(
                    name, {"content": [{"type": "text", "text": f"called {name}"}]}
                )
                return self._rpc(rpc["id"], result, self.frame_as_event_stream)
        return _json(404, {"error": "not_found", "message": url})

    def _rpc(self, request_id: int, result: dict[str, Any], framed: bool) -> Response:
        return _envelope({"jsonrpc": "2.0", "id": request_id, "result": result}, framed)

    def _rpc_error(self, request_id: int, error: dict[str, Any]) -> Response:
        return _envelope(
            {"jsonrpc": "2.0", "id": request_id, "error": error}, self.frame_as_event_stream
        )


def _tool_json(tool: GatewayTool) -> dict[str, Any]:
    payload: dict[str, Any] = {"name": tool.name, "inputSchema": tool.input_schema}
    if tool.description:
        payload["description"] = tool.description
    return payload


def _json(status: int, body: Any) -> Response:
    return Response(status=status, headers={"Content-Type": "application/json"}, text=json.dumps(body))


def _envelope(payload: Any, framed: bool) -> Response:
    if not framed:
        return _json(200, payload)
    frames = (
        'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n'
        f"event: message\ndata: {json.dumps(payload)}\n\n"
    )
    return Response(status=200, headers={"Content-Type": "text/event-stream"}, text=frames)
