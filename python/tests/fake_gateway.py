"""A gateway that answers like the real one, without a network."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs, urlparse

from trustgate.transport import Response
from trustgate.types import GatewayTool


@dataclass
class Recorded:
    method: str
    url: str
    headers: dict[str, str]
    body: Any = None


@dataclass
class FakeGateway:
    #: "application" lists its own accounts; "end_user" refuses to.
    actor: str = "application"
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
            if not named and self.actor == "end_user":
                return _json(
                    409,
                    {
                        "error": "consumer_acts_for_users",
                        "message": "consumer acts for its users, not as itself",
                    },
                )
            return _json(
                200,
                {
                    "end_user": named or "",
                    "actor": "end_user" if named else "application",
                    "connections": self.connections,
                },
            )
        if url.endswith("/mcp"):
            rpc = decoded or {}
            if rpc.get("method") == "tools/list":
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
