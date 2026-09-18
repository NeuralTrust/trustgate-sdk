"""The entry point: one gateway, one API key, two planes."""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import quote

from .agent import Agent, EndUserAgent, end_user_agent
from .config import API_KEY_HEADER, Config, resolve_config
from .connections import list_connections
from .errors import (
    AppActorUnavailableError,
    InvalidRequestError,
    MissingToolsError,
    PlaneUnavailableError,
    TrustGateError,
    UpstreamNotConnectedError,
)
from .mcp import MCPTransport
from .transport import Transport, UrllibTransport
from .types import CONNECTED, Actor, Connection, GatewayTool


@dataclass(frozen=True)
class LLMEndpoint:
    """What the LLM plane needs to be handed to a provider's own client."""

    #: Pass as ``base_url`` to the OpenAI or Anthropic client.
    base_url: str
    api_key: str
    headers: dict[str, str]


class EndUserAgentFactory:
    """What ``connect()`` returns for a consumer whose users sign in for themselves.

    It has no tools of its own to offer, because there is no "itself" to offer
    them to: every call belongs to one named user. Asking for the surface
    without naming one is the mistake this type exists to prevent.
    """

    actor = Actor.END_USER

    def __init__(
        self,
        config: Config,
        transport: Transport,
        slug: str,
        url: str,
        tools: list[GatewayTool],
    ) -> None:
        self._config = config
        self._transport = transport
        self.slug = slug
        self._url = url
        #: The toolkit, which is the same for every user of this application.
        self.tools = tools

    def for_end_user(self, end_user: str) -> EndUserAgent:
        return end_user_agent(self._config, self._transport, self.slug, end_user, self._url, self.tools)


class TrustGate:
    """One gateway, one API key, two planes.

    The key is attached to consumers, and a consumer has one type - so the
    tools live behind an MCP consumer and the models behind an LLM one. The
    same key may be attached to both, which is what lets a single client hand
    out both halves of an agent.
    """

    def __init__(
        self,
        base_url: str | None = None,
        api_key: str | None = None,
        mcp_consumer: str | None = None,
        llm_consumer: str | None = None,
        timeout: float = 30.0,
        transport: Transport | None = None,
    ) -> None:
        self._config = resolve_config(base_url, api_key, mcp_consumer, llm_consumer, timeout)
        self._transport = transport or UrllibTransport()

    @property
    def llm(self) -> LLMEndpoint:
        """The LLM plane, ready for a provider's own SDK.

        The gateway speaks the providers' own APIs, so nothing here wraps their
        clients - it points them somewhere else. Wrapping would mean chasing
        every change they make and breaking streaming on the way.
        """
        slug = self._config.llm_consumer
        if not slug:
            raise PlaneUnavailableError(
                "no LLM consumer configured; pass llm_consumer or set TRUSTGATE_LLM_CONSUMER"
            )
        return LLMEndpoint(
            base_url=f"{self._config.base_url}/{quote(slug)}/v1",
            api_key=self._config.api_key,
            headers={API_KEY_HEADER: self._config.api_key},
        )

    @property
    def mcp_url(self) -> str:
        """The MCP endpoint, for a framework that brings its own client."""
        return f"{self._config.base_url}/{quote(self._mcp_slug())}/mcp"

    def connect(self, requires: list[str] | None = None) -> Agent | EndUserAgentFactory:
        """Opens the agent's surface and proves it is usable before anything runs.

        Three things happen here, and all three are the kind that are cheap now
        and expensive later: which actor this consumer is (it decides, not the
        caller), whether the tools the agent needs are actually on its toolkit,
        and - for an application acting as itself - whether its upstream
        accounts are signed in. That last one has no runtime remedy: nobody is
        present to open a connect link once a batch is going.
        """
        slug = self._mcp_slug()
        actor, connections = self._probe_actor(slug)
        transport = MCPTransport(self._config, self._transport, self.mcp_url)
        tools = transport.list_tools()

        names = {tool.name for tool in tools}
        missing = [name for name in (requires or []) if name not in names]
        if missing:
            raise MissingToolsError(missing, sorted(names))

        if actor is Actor.END_USER:
            return EndUserAgentFactory(self._config, self._transport, slug, self.mcp_url, tools)

        pending = [c for c in connections if c.status != CONNECTED]
        if pending:
            raise UpstreamNotConnectedError(
                [c.provider for c in pending],
                f"{self._config.base_url}/{quote(slug)}/connect",
            )
        return Agent(self._config, self._transport, slug, transport, tools, connections)

    def _probe_actor(self, slug: str) -> tuple[Actor, list[Connection]]:
        """Asks the gateway which actor this consumer is, by asking it something
        only one of the two can answer.

        An application that acts as itself has upstream accounts and lists them;
        one that acts for its users has none of its own and says so, with a
        conflict rather than an empty list. So the refusal is the answer.
        """
        try:
            return Actor.APPLICATION, list_connections(self._config, self._transport, slug)
        except AppActorUnavailableError:
            return Actor.END_USER, []
        except InvalidRequestError as error:
            raise TrustGateError(
                "this gateway cannot report an application actor's own connections, so the SDK "
                "cannot tell which actor the consumer is. Upgrade the gateway, or use the MCP "
                "endpoint directly with TrustGate.mcp_url."
            ) from error

    def _mcp_slug(self) -> str:
        slug = self._config.mcp_consumer
        if not slug:
            raise PlaneUnavailableError(
                "no MCP consumer configured; pass mcp_consumer or set TRUSTGATE_MCP_CONSUMER"
            )
        return slug
