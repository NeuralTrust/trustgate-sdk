"""The entry point: a gateway and a key, and everything else is asked for."""

from __future__ import annotations

from dataclasses import dataclass

from .agent import Agent, EndUserAgent, end_user_agent
from .config import API_KEY_HEADER, Config, resolve_config
from .connections import list_connections
from .errors import MissingToolsError, UpstreamNotConnectedError
from .mcp import MCPTransport
from .transport import Transport, UrllibTransport
from .types import CONNECTED, Actor, GatewayTool
from .whoami import KeyConsumer, KeyIdentity, select_consumer, who_am_i


@dataclass(frozen=True)
class LLMEndpoint:
    """What the LLM plane needs to be handed to a provider's own client."""

    #: Pass as ``base_url`` to the OpenAI or Anthropic client.
    base_url: str
    api_key: str
    headers: dict[str, str]
    #: The consumer behind it, for logs and for error messages.
    consumer: str


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
        consumer: KeyConsumer,
        tools: list[GatewayTool],
    ) -> None:
        self._config = config
        self._transport = transport
        self._consumer = consumer
        #: The toolkit, which is the same for every user of this application.
        self.tools = tools

    @property
    def slug(self) -> str:
        return self._consumer.slug

    def for_end_user(self, end_user: str) -> EndUserAgent:
        return end_user_agent(
            self._config, self._transport, self._consumer.slug, end_user, self._consumer.url, self.tools
        )


class TrustGate:
    """A gateway and a key, and everything else is asked for.

    The key is attached to consumers, and a consumer has one type - so the
    tools live behind an MCP consumer and the models behind an LLM one. Their
    slugs were chosen by whoever created them, and the two planes do not share
    a host, so neither is something a caller should have to carry: the gateway
    is asked once, at ``connect()``, and answers both.
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
        self._identity: KeyIdentity | None = None

    def identity(self) -> KeyIdentity:
        """What this key reaches.

        Read once and remembered: it is a property of the key, and a
        long-lived process should not re-ask on every call.
        """
        if self._identity is None:
            self._identity = who_am_i(self._config, self._transport)
        return self._identity

    def llm(self) -> LLMEndpoint:
        """The LLM plane, ready for a provider's own SDK.

        The gateway speaks the providers' own APIs, so nothing here wraps their
        clients - it points them somewhere else. Wrapping would mean chasing
        every change they make and breaking streaming on the way.
        """
        consumer = select_consumer(
            self.identity(), "LLM", self._config.llm_consumer, "llm_consumer"
        )
        return LLMEndpoint(
            base_url=consumer.url,
            api_key=self._config.api_key,
            headers={API_KEY_HEADER: self._config.api_key},
            consumer=consumer.slug,
        )

    def connect(self, requires: list[str] | None = None) -> Agent | EndUserAgentFactory:
        """Opens the agent's surface and proves it is usable before anything runs.

        Three things happen here, and all three are the kind that are cheap now
        and expensive later: which actor this consumer is (it decides, not the
        caller), whether the tools the agent needs are actually on its toolkit,
        and - for an application acting as itself - whether its upstream
        accounts are signed in. That last one has no runtime remedy: nobody is
        present to open a connect link once a batch is going.
        """
        consumer = select_consumer(
            self.identity(), "MCP", self._config.mcp_consumer, "mcp_consumer"
        )
        transport = MCPTransport(self._config, self._transport, consumer.url)
        tools = transport.list_tools()

        names = {tool.name for tool in tools}
        missing = [name for name in (requires or []) if name not in names]
        if missing:
            raise MissingToolsError(missing, sorted(names))

        # The consumer says which actor it is, so there is nothing to infer and
        # nothing for the caller to configure wrongly.
        if consumer.acts_for_users:
            return EndUserAgentFactory(self._config, self._transport, consumer, tools)

        connections = list_connections(self._config, self._transport, consumer.slug)
        pending = [c for c in connections if c.status != CONNECTED]
        if pending:
            raise UpstreamNotConnectedError(
                [c.provider for c in pending], _connect_page(consumer)
            )
        return Agent(
            self._config, self._transport, consumer.slug, transport, tools, connections
        )


def _connect_page(consumer: KeyConsumer) -> str:
    """The page an operator opens to sign the application in to its own accounts."""
    if consumer.url.endswith("/mcp"):
        return consumer.url[: -len("/mcp")] + "/connect"
    return consumer.url
