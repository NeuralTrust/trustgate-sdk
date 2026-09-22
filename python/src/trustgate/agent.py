"""The handles `connect()` hands out, one per actor."""

from __future__ import annotations

from typing import Any

from .config import END_USER_HEADER, Config
from .connections import create_connect_link, list_connections, require_end_user
from .formats import ConversionWarning, ToolResult, adapter_for, restore_arguments
from .mcp import MCPTransport
from .schema import Schema
from .transport import Transport
from .types import (
    Actor,
    ConnectLink,
    Connection,
    Endpoint,
    GatewayTool,
    ToolCall,
    ToolFormat,
    resolve_tool_name,
)


class Toolkit:
    """A tool surface in one provider's dialect, with the executor that belongs to it.

    They travel together because they are two halves of one translation: what
    ``tools`` added on the way out, ``execute`` has to undo on the way back.
    """

    def __init__(
        self,
        tools: list[Any],
        warnings: list[ConversionWarning],
        tool_format: ToolFormat,
        originals: dict[str, Schema],
        transport: MCPTransport,
    ) -> None:
        #: Pass this straight to the provider's API.
        self.tools = tools
        #: Tools whose schema could not be expressed in the requested dialect.
        self.warnings = warnings
        self._format = tool_format
        self._originals = originals
        self._transport = transport

    def calls(self, output: Any) -> list[ToolCall]:
        """The calls the model asked for, read out of the provider's response."""
        return adapter_for(self._format).extract_calls(output)

    def execute(self, output: Any) -> list[Any]:
        """Runs the calls the model asked for and returns what to send back.

        Every call goes to the gateway, so the policy, the audit trail and the
        upstream credentials stay where they were. The caller's process only
        decides whether to make the call at all.
        """
        adapter = adapter_for(self._format)
        results = []
        for call in adapter.extract_calls(output):
            arguments = restore_arguments(call.arguments, self._originals.get(call.name))
            result = self._transport.call_tool(call.name, arguments)
            results.append(ToolResult(call=call, result=result))
        return adapter.to_outputs(results)


class _ToolSurface:
    """What both handles share: a surface, and the ways to spend it."""

    def __init__(self, transport: MCPTransport, tools: list[GatewayTool]) -> None:
        self._transport = transport
        self.tools = tools

    @property
    def mcp(self) -> Endpoint:
        """URL and headers for a framework that brings its own MCP client."""
        return Endpoint(url=self._transport.url, headers=self._transport.headers)

    def toolkit(self, tool_format: ToolFormat | str, strict: bool = False) -> Toolkit:
        """The same surface, translated for a provider you call directly."""
        resolved = ToolFormat(tool_format)
        conversion = adapter_for(resolved).convert(self.tools, strict)
        return Toolkit(
            conversion.tools, conversion.warnings, resolved, conversion.originals, self._transport
        )

    def call_tool(self, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        """One tool, called directly. The escape hatch under the toolkits.

        The server prefix is optional here: "list_issues" reaches
        "linear_list_issues" while Linear is the only server of this application
        that serves it. The gateway put that prefix there, so a caller writing
        the name by hand should not have to.
        """
        return self._transport.call_tool(resolve_tool_name(name, self.tools), arguments)

    def refresh(self) -> list[GatewayTool]:
        """Re-reads the surface.

        An admin owns this toolkit and can change it under a running agent, so
        a long-lived process re-reads rather than trusting the list it took at
        startup.
        """
        self.tools = self._transport.list_tools()
        return self.tools


class Agent(_ToolSurface):
    """An application's handle on its gateway.

    It speaks as the application itself: one principal, its own upstream
    accounts, nothing per-user. Which handle you get is not a choice made here -
    it follows from how the consumer was configured, which is why ``connect()``
    returns one of these or refuses.
    """

    actor = Actor.APPLICATION

    def __init__(
        self,
        config: Config,
        transport_impl: Transport,
        slug: str,
        transport: MCPTransport,
        tools: list[GatewayTool],
        connections: list[Connection],
    ) -> None:
        super().__init__(transport, tools)
        self._config = config
        self._http = transport_impl
        self.slug = slug
        #: The application's own upstream accounts, as of ``connect()``.
        self.connections = connections

    def refresh_connections(self) -> list[Connection]:
        """What the application still owes before it can call every server."""
        return list_connections(self._config, self._http, self.slug)

    def for_end_user(self, end_user: str) -> "EndUserAgent":
        """The same application, acting for one named person.

        No round trip and no second surface to read: the toolkit an admin bound
        is the application's, identical for everyone it acts for. What changes
        is one header, and with it whose upstream account the gateway reaches
        for.
        """
        return end_user_agent(
            self._config,
            self._http,
            self.slug,
            end_user,
            self._transport.url,
            self.tools,
        )


class EndUserAgent(_ToolSurface):
    """An application's handle for one of its own end users.

    The user travels in a header, so a handle is a header and nothing more -
    but the MCP endpoint's headers are fixed when a client connects, which is
    why each user needs their own transport rather than a shared one.
    """

    actor = Actor.END_USER

    def __init__(
        self,
        config: Config,
        transport_impl: Transport,
        slug: str,
        end_user: str,
        transport: MCPTransport,
        tools: list[GatewayTool],
    ) -> None:
        super().__init__(transport, tools)
        self._config = config
        self._http = transport_impl
        self.slug = slug
        self.end_user = end_user

    def connections(self) -> list[Connection]:
        """Which servers this user has connected, and which they have not."""
        return list_connections(self._config, self._http, self.slug, self.end_user)

    def connect_link(self, provider: str | None = None) -> ConnectLink:
        """The page to put in front of this user so they can connect an account.

        Naming a provider narrows it to that one server; omitting it covers
        every server of the application that forwards a credential. The link
        expires, so it is minted when it is about to be shown, not cached.
        """
        return create_connect_link(self._config, self._http, self.slug, self.end_user, provider)


def end_user_agent(
    config: Config,
    transport_impl: Transport,
    slug: str,
    raw_end_user: str,
    url: str,
    tools: list[GatewayTool],
) -> EndUserAgent:
    """Builds the per-user handle, with the header that names them."""
    end_user = require_end_user(raw_end_user)
    transport = MCPTransport(config, transport_impl, url, {END_USER_HEADER: end_user})
    return EndUserAgent(config, transport_impl, slug, end_user, transport, tools)
