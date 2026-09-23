"""The entry point: a gateway and a key, and everything else is asked for."""

from __future__ import annotations

from dataclasses import dataclass, replace

from .agent import Agent, EndUserAgent, end_user_agent
from .config import API_KEY_HEADER, Config, resolve_config
from .connections import list_connections
from .errors import MissingToolsError, UpstreamNotConnectedError
from .mcp import MCPTransport
from .transport import Transport, UrllibTransport
from .types import CONNECTED, Connection, GatewayTool, resolve_tool_name
from .whoami import KeyIdentity, KeyUpstream, select_consumer, who_am_i


@dataclass(frozen=True)
class LLMEndpoint:
    """What the LLM plane needs to be handed to a provider's own client."""

    #: Pass as ``base_url`` to the OpenAI client. It ends in ``/v1``.
    base_url: str
    api_key: str
    headers: dict[str, str]
    #: The consumer behind it, for logs and for error messages.
    consumer: str

    @property
    def anthropic_base_url(self) -> str:
        """Pass as ``base_url`` to the Anthropic client.

        The two clients disagree on where the version goes. OpenAI's is handed
        a base that already ends in ``/v1`` and appends ``/chat/completions``;
        Anthropic's appends ``/v1/messages`` to what it is given, so handing it
        ``base_url`` asks the gateway for ``/v1/v1/messages``. This is the
        application's root, the one every dialect but OpenAI's hangs from.
        """
        return _without_version(self.base_url)


def _without_version(url: str) -> str:
    trimmed = url.rstrip("/")
    return trimmed[: -len("/v1")] if trimmed.endswith("/v1") else trimmed


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

    def connect(self, requires: list[str] | None = None) -> Agent:
        """Opens the application's own surface and proves it is usable.

        Two things happen here, and both are the kind that are cheap now and
        expensive later: whether the tools the agent needs are actually on its
        toolkit, and whether the servers behind it have an account to call
        with. The second has no runtime remedy for this handle - nobody is
        present to open a connect link once a batch is going - which is the
        whole reason it is checked at startup.

        This is the application actor: the key and nothing else, so the gateway
        runs the calls as ``app:<consumer_id>``. For a call on behalf of a
        person, use :meth:`for_end_user`; both work on the same consumer,
        because who a request runs as is read from the request rather than
        declared anywhere.
        """
        consumer = select_consumer(
            self.identity(), "MCP", self._config.mcp_consumer, "mcp_consumer"
        )
        # Accounts before tools: a server with no account for the application
        # can fail the listing itself, which would surface as a bare gateway
        # error before this check - the one that says who fixes it - ever ran.
        plane = _on_mcp_plane(self._config, consumer.slug, consumer.url)
        connections = list_connections(plane, self._transport, consumer.slug)
        blocked = _blocked_upstreams(consumer.upstreams, connections)
        if blocked:
            raise UpstreamNotConnectedError(blocked)

        transport = MCPTransport(plane, self._transport, consumer.url)
        tools = transport.list_tools()
        _check_requires(tools, list(requires or []))

        return Agent(plane, self._transport, consumer.slug, transport, tools, connections)

    def for_end_user(self, end_user: str, requires: list[str] | None = None) -> EndUserAgent:
        """The handle for one named person, on the same consumer and the same key.

        The name is asserted by this application and not verified, so the
        gateway namespaces it: two applications naming ``user_123`` never share
        an account. What that person still has to connect is theirs to connect
        - the handle's own connections mint the link to put in front of them -
        which is why there is no startup preflight here and one in
        :meth:`connect`.
        """
        consumer = select_consumer(
            self.identity(), "MCP", self._config.mcp_consumer, "mcp_consumer"
        )
        agent = end_user_agent(
            _on_mcp_plane(self._config, consumer.slug, consumer.url),
            self._transport,
            consumer.slug,
            end_user,
            consumer.url,
            [],
        )
        _check_requires(agent.refresh(), list(requires or []))
        return agent


def _on_mcp_plane(config: Config, slug: str, url: str) -> Config:
    """The config for calls on the MCP plane, addressed where whoami said it is.

    The consumer's own endpoints (``/<slug>/connections``) sit next to its MCP
    endpoint, on that plane's host. That is ``base_url`` when the caller gave
    their gateway's address, but not when they started from the shared entry
    point, which serves whoami and nothing else - so they always go to the
    plane the answer named.
    """
    suffix = f"/{slug}/mcp"
    trimmed = url.rstrip("/")
    if not trimmed.endswith(suffix):
        return config
    return replace(config, base_url=trimmed[: -len(suffix)])


def _check_requires(tools: list[GatewayTool], requires: list[str]) -> None:
    """The tools an agent was written around, checked before anything runs.

    Each one is resolved the way call_tool resolves it, so an agent may require
    the name its server gave the tool and leave the gateway's server prefix to
    the gateway.
    """
    names = {tool.name for tool in tools}
    missing = [name for name in requires if resolve_tool_name(name, tools) not in names]
    if missing:
        raise MissingToolsError(missing, sorted(names))


def _blocked_upstreams(
    upstreams: list[KeyUpstream] | None, connections: list[Connection]
) -> list[KeyUpstream]:
    """What this application still has to have connected before it can run.

    ``whoami`` answers it best, because it also names who has to act. But the
    field is absent on a gateway too old to send it, and an absent list is not
    an empty one: taking it for "nothing to connect" is how a batch gets past
    its own startup check and fails on the first row instead, which is the
    failure the check exists to prevent. So when it is missing the connections
    list answers, as it did before ``whoami`` carried this at all.
    """
    if upstreams is not None:
        return [upstream for upstream in upstreams if upstream.blocked]
    return [
        KeyUpstream(server=connection.registry or connection.provider)
        for connection in connections
        if connection.status != CONNECTED
    ]
