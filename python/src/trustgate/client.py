"""The entry point: a gateway and a key, and everything else is asked for."""

from __future__ import annotations

from dataclasses import dataclass

from .agent import Agent, EndUserAgent, end_user_agent
from .config import API_KEY_HEADER, Config, resolve_config
from .connections import list_connections
from .errors import (
    EndUserActorUnavailableError,
    MissingToolsError,
    TrustGateError,
    UpstreamNotConnectedError,
)
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
        tools: list[GatewayTool] | None,
        requires: list[str] | None = None,
    ) -> None:
        self._config = config
        self._transport = transport
        self._consumer = consumer
        self._tools = tools
        self._requires = list(requires or [])

    @property
    def slug(self) -> str:
        return self._consumer.slug

    @property
    def tools(self) -> list[GatewayTool]:
        """The toolkit, which is the same for every user of this application."""
        if self._tools is None:
            raise TrustGateError(
                "this application names its own users, so its toolkit cannot be read "
                "without being one of them: call for_end_user(...) and read it from the "
                "handle."
            )
        return self._tools

    def for_end_user(self, end_user: str) -> EndUserAgent:
        agent = end_user_agent(
            self._config,
            self._transport,
            self._consumer.slug,
            end_user,
            self._consumer.url,
            self._tools or [],
        )
        if self._tools is None:
            # The toolkit is the same for every user, but the endpoint refuses a
            # request that names none - so the first handle reads it, the rest
            # share it, and the `requires` check connect() could not run lands
            # here instead.
            tools = agent.refresh()
            _check_requires(tools, self._requires)
            self._tools = tools
        return agent


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

        # An application that names its own users has no surface of its own to
        # ask on: every request to it must say which user it is for, and one
        # that does not is refused. So there is nothing to list here, and the
        # preflight moves to the first named user.
        if consumer.identity_source == "app":
            return EndUserAgentFactory(
                self._config, self._transport, consumer, None, list(requires or [])
            )

        transport = MCPTransport(self._config, self._transport, consumer.url)
        tools = transport.list_tools()
        _check_requires(tools, list(requires or []))

        # The consumer says which actor it is, so there is nothing to infer and
        # nothing for the caller to configure wrongly. What is left here acting
        # for users signs them in itself, and this key is not one of them: the
        # end-user header means nothing on such a consumer, so a handle minted
        # from it would quietly run every user as the application.
        if consumer.acts_for_users:
            raise EndUserActorUnavailableError(
                f'"{consumer.slug}" signs its users in itself, so an API key cannot act '
                "for one of them. A key reaches this consumer as the application, which "
                "is not who its calls are supposed to be for."
            )

        connections = list_connections(self._config, self._transport, consumer.slug)
        pending = [c for c in connections if c.status != CONNECTED]
        if pending:
            raise UpstreamNotConnectedError(
                [c.provider for c in pending], _connect_page(consumer)
            )
        return Agent(
            self._config, self._transport, consumer.slug, transport, tools, connections
        )


def _check_requires(tools: list[GatewayTool], requires: list[str]) -> None:
    """The tools an agent was written around, checked before anything runs."""
    names = {tool.name for tool in tools}
    missing = [name for name in requires if name not in names]
    if missing:
        raise MissingToolsError(missing, sorted(names))


def _connect_page(consumer: KeyConsumer) -> str:
    """The page an operator opens to sign the application in to its own accounts."""
    if consumer.url.endswith("/mcp"):
        return consumer.url[: -len("/mcp")] + "/connect"
    return consumer.url
