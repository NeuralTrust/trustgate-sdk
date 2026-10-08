"""The entry point: a gateway and a key, and everything else is asked for."""

from __future__ import annotations

import os
import time
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from urllib.parse import urlparse

from .agent import Agent, EndUserAgent, UserAgent, end_user_agent
from .config import (
    API_KEY_HEADER,
    Config,
    insecure_http_from_env,
    require_safe_url,
    resolve_config,
)
from .connections import list_connections
from .errors import (
    ConsentRequiredError,
    LoginRequiredError,
    MissingToolsError,
    PlaneUnavailableError,
    TrustGateError,
    UpstreamNotConnectedError,
)
from .mcp import MCPTransport
from .transport import Transport, UrllibTransport
from .types import CONNECTED, Connection, GatewayTool, resolve_tool_name
from .user import (
    FileTokenCache,
    TokenCache,
    UserSession,
    UserToken,
    login_flow,
    resolve_store_url,
)
from .whoami import (
    BLOCKED_BY_ADMINISTRATOR,
    BLOCKED_BY_END_USER,
    KeyConsumer,
    KeyIdentity,
    KeyUpstream,
    select_consumer,
    who_am_i,
)


@dataclass(frozen=True)
class LLMEndpoint:
    """What the LLM plane needs to be handed to a provider's own client."""

    #: Pass as ``base_url`` to the OpenAI client. It ends in ``/v1``.
    base_url: str
    # Out of the repr, so an endpoint can be logged without its key.
    api_key: str = field(repr=False)
    headers: dict[str, str] = field(repr=False)
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
        allow_insecure_http: bool | None = None,
    ) -> None:
        self._config = resolve_config(
            base_url, api_key, mcp_consumer, llm_consumer, timeout, allow_insecure_http
        )
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
        consumer = _on_safe_plane(
            select_consumer(self.identity(), "LLM", self._config.llm_consumer, "llm_consumer"),
            self._config,
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
        self._application_only()
        consumer = _on_safe_plane(
            select_consumer(self.identity(), "MCP", self._config.mcp_consumer, "mcp_consumer"),
            self._config,
        )
        # Accounts before tools: a server with no account for the application
        # can fail the listing itself, which would surface as a bare gateway
        # error before this check - the one that says who fixes it - ever ran.
        plane = _on_mcp_plane(self._config, consumer.slug, consumer.url)
        connections = list_connections(plane, self._transport, consumer.slug)
        blocked = _blocked_upstreams(consumer.upstreams, connections)
        required = list(requires or [])
        # Without requires, every server is one the agent may need, so any of
        # them blocked fails the start. With them, only the agent's own: the
        # gateway lists the servers that can answer and leaves the rest out, so
        # a required tool on the listing is a tool whose server has an account.
        if blocked and not required:
            raise UpstreamNotConnectedError(blocked)

        transport = MCPTransport(plane, self._transport, consumer.url)
        try:
            tools = transport.list_tools()
        except (UpstreamNotConnectedError, ConsentRequiredError) as error:
            if blocked:
                raise UpstreamNotConnectedError(blocked) from error
            raise
        if blocked and _missing(tools, required):
            raise UpstreamNotConnectedError(blocked)
        _check_requires(tools, required)

        return Agent(plane, self._transport, consumer.slug, transport, tools, connections)

    @staticmethod
    def login(
        url: str | None = None,
        *,
        cache: TokenCache | None = None,
        open_browser: bool = True,
        force: bool = False,
        timeout: float = 30.0,
        transport: Transport | None = None,
        on_url: Callable[[str], None] | None = None,
        allow_insecure_http: bool | None = None,
    ) -> TrustGateUser:
        """Signs a person in to their own Store. See :meth:`TrustGateUser.login`."""
        return TrustGateUser.login(
            url,
            cache=cache,
            open_browser=open_browser,
            force=force,
            timeout=timeout,
            transport=transport,
            on_url=on_url,
            allow_insecure_http=allow_insecure_http,
        )

    def _application_only(self) -> None:
        """Refuses a person's key where an application's is meant.

        A personal key runs as its owner: it has no application consumer, no
        end users to name and no application accounts, so the handles below
        would each fail on their first call with an answer that says none of
        that. Its owner's Store is :class:`TrustGateUser`.
        """
        if self.identity().key.personal:
            raise TrustGateError(
                "this is a personal key: it runs as its owner, not as an application. "
                "Open its owner's tools and models with TrustGateUser(api_key=...)."
            )

    def for_end_user(self, end_user: str, requires: list[str] | None = None) -> EndUserAgent:
        """The handle for one named person, on the same consumer and the same key.

        The name is asserted by this application and not verified, so the
        gateway namespaces it: two applications naming ``user_123`` never share
        an account. What that person still has to connect is theirs to connect
        - the handle's own connections mint the link to put in front of them -
        which is why there is no startup preflight here and one in
        :meth:`connect`.
        """
        self._application_only()
        consumer = _on_safe_plane(
            select_consumer(self.identity(), "MCP", self._config.mcp_consumer, "mcp_consumer"),
            self._config,
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


class TrustGateUser:
    """A person, signed in, on their own Store.

    The other side of :class:`TrustGate`: no application, but a person with
    what Access grants them - the servers they installed from the Store,
    narrowed to what their user and groups may reach, called with their own
    accounts. Three ways in:

    - ``api_key``: their personal key, from the Portal (Personal key). It
      reaches their tools and their models, and needs no browser: the Store's
      address is asked of the gateway, as an application's key asks for its own.
    - :meth:`login`: signing in through the browser.
    - ``access_token``: a token your own sign-in already holds (a backend that
      ran the OAuth flow for its user).
    """

    def __init__(
        self,
        url: str | None = None,
        access_token: str | None = None,
        timeout: float = 30.0,
        transport: Transport | None = None,
        *,
        token: UserToken | None = None,
        cache: TokenCache | None = None,
        allow_insecure_http: bool | None = None,
        api_key: str | None = None,
        base_url: str | None = None,
    ) -> None:
        self._insecure = (
            insecure_http_from_env() if allow_insecure_http is None else allow_insecure_http
        )
        self._transport = transport or UrllibTransport()
        self._timeout = timeout
        self._cache = cache
        self._identity: KeyIdentity | None = None
        #: The personal key's config when the user came with one; None for a session.
        self._personal: Config | None = None
        self.session: UserSession | None = None
        key = (api_key or "").strip() or (
            "" if (token or access_token) else os.environ.get("TRUSTGATE_PERSONAL_KEY", "").strip()
        )
        if key:
            if token is not None or access_token:
                raise TrustGateError("pass a personal key or a session token, not both")
            # The gateway's own MCP host answers whoami too, so a Store URL is
            # as good a place to ask as the shared entry point.
            ask_at = base_url or (_origin(url) if url else None)
            self._personal = resolve_config(
                ask_at, key, timeout=timeout, allow_insecure_http=self._insecure
            )
            self._url = resolve_store_url(url, self._insecure) if url else None
            return
        #: The Store's MCP endpoint, ``https://<gateway>.<mcp host>/store/mcp``.
        self._url = resolve_store_url(url, self._insecure)
        if token is None:
            raw = (access_token or os.environ.get("TRUSTGATE_ACCESS_TOKEN") or "").strip()
            if not raw:
                raise TrustGateError(
                    "access_token is required (or set TRUSTGATE_ACCESS_TOKEN); "
                    f'to sign in through the browser use TrustGate.login(url="{self.url}")'
                )
            token = UserToken(access_token=raw)
        self.session = UserSession(
            self._url, token, self._transport, timeout, cache, allow_insecure_http=self._insecure
        )

    @property
    def url(self) -> str:
        """The Store's MCP endpoint, ``https://<gateway>.<mcp host>/store/mcp``.

        With a personal key and no ``url`` it is the address the gateway gives
        for the key's Store, asked once.
        """
        if self._url is None:
            self._url = self._personal_consumer("MCP").url
        return self._url

    def identity(self) -> KeyIdentity:
        """What the personal key reaches, asked of the gateway once.

        Only a personal key has one: a session's Store is the URL it signed in to.
        """
        if self._personal is None:
            raise TrustGateError(
                "only a personal key describes itself; a session's Store is its url"
            )
        if self._identity is None:
            identity = who_am_i(self._personal, self._transport)
            if not identity.key.personal:
                raise TrustGateError(
                    "this is an application's API key, not a personal key: it runs as the "
                    "application. Use TrustGate(api_key=...)."
                )
            self._identity = identity
        return self._identity

    def _personal_consumer(self, plane: str) -> KeyConsumer:
        assert self._personal is not None
        found = [c for c in self.identity().consumers if c.type == plane and c.url]
        if not found:
            what = "MCP Store" if plane == "MCP" else "models (the LLM Store)"
            raise PlaneUnavailableError(
                f"this personal key reaches no {what} on its gateway. Ask an administrator "
                "to set it up."
            )
        return _on_safe_plane(found[0], self._personal)

    def llm(self) -> LLMEndpoint:
        """The person's models, ready for a provider's own SDK, through the gateway.

        Only a personal key reaches them: the LLM Store takes the key, not a
        sign-in. With a session, create a Personal key in the Portal and pass
        it as ``api_key``.
        """
        if self._personal is None:
            raise TrustGateError(
                "models take a personal key, not a sign-in: create one in the Portal "
                "(Personal key) and pass it as TrustGateUser(api_key=...)."
            )
        consumer = self._personal_consumer("LLM")
        key = self._personal.api_key
        return LLMEndpoint(
            base_url=consumer.url,
            api_key=key,
            headers={API_KEY_HEADER: key},
            consumer=consumer.slug,
        )

    @classmethod
    def login(
        cls,
        url: str | None = None,
        *,
        cache: TokenCache | None = None,
        open_browser: bool = True,
        force: bool = False,
        timeout: float = 30.0,
        transport: Transport | None = None,
        on_url: Callable[[str], None] | None = None,
        allow_insecure_http: bool | None = None,
    ) -> TrustGateUser:
        """Signs in through the browser, or reuses the session from last time.

        The session is kept in ``cache`` - by default a file in
        ``~/.trustgate`` only this user can read - so a script signs in once
        and runs again without a browser until the sign-in ends (a day, on
        NeuralTrust's cloud). Pass a :class:`MemoryTokenCache` to keep nothing
        on disk, and ``force=True`` to sign in again regardless.

        The browser comes back to a port on this machine, so this is for the
        person's own computer. A server acting for many people is an
        application, with an API key: see :class:`TrustGate`.
        """
        insecure = insecure_http_from_env() if allow_insecure_http is None else allow_insecure_http
        resolved = resolve_store_url(url, insecure)
        http = transport or UrllibTransport()
        store = cache if cache is not None else FileTokenCache()

        def make(token: UserToken) -> TrustGateUser:
            return cls(
                resolved,
                timeout=timeout,
                transport=http,
                token=token,
                cache=store,
                allow_insecure_http=insecure,
            )

        if not force:
            cached = store.load(resolved)
            if cached is not None:
                session = UserSession(
                    resolved, cached, http, timeout, store, allow_insecure_http=insecure
                )
                try:
                    if cached.expires_soon(time.time()):
                        if not session.renew():
                            raise LoginRequiredError(resolved)
                    return make(session.token)
                except LoginRequiredError:
                    pass
        token = login_flow(
            resolved,
            http,
            timeout,
            open_browser=open_browser,
            on_url=on_url,
            allow_insecure_http=insecure,
        )
        store.save(resolved, token)
        return make(token)

    def logout(self) -> None:
        """Forgets the session kept for this Store. The browser's sign-in stays."""
        if self._cache is not None and self._url is not None:
            self._cache.clear(self._url)

    def connect(self, requires: list[str] | None = None) -> UserAgent:
        """Opens this person's Store and checks the tools the agent needs are on it.

        A server whose account the person has not connected yet is not on the
        surface; :attr:`UserAgent.needs_connect` names those and
        :meth:`UserAgent.connect_link` is the page to connect them.
        """
        url = self.url
        if self._personal is not None:
            # The key travels as an application's does; the gateway knows it is a person's.
            config = replace(self._personal, base_url=_origin(url))
            transport = MCPTransport(config, self._transport, url)
        else:
            config = Config(
                base_url=_origin(url),
                api_key="",
                timeout=self._timeout,
                allow_insecure_http=self._insecure,
            )
            transport = MCPTransport(config, self._transport, url, credentials=self.session)
        tools = transport.list_tools()
        missing = _missing(tools, list(requires or []))
        if missing:
            raise MissingToolsError(
                missing,
                sorted(tool.name for tool in tools),
                "Install them from the Store, or ask an admin to grant them in Access.",
            )
        return UserAgent(transport, tools)


def _origin(url: str) -> str:
    parsed = urlparse(url)
    return f"{parsed.scheme}://{parsed.netloc}"


def _on_safe_plane(consumer: KeyConsumer, config: Config) -> KeyConsumer:
    """The consumer, once its address is one the key may be sent to.

    The key already went to the base URL to ask, so this is not about trusting
    the answer's host - the LLM plane lives on another one by design. It is
    about the scheme: an https gateway must not be able to point the key at
    plain http.
    """
    require_safe_url(
        consumer.url,
        config.allow_insecure_http,
        f'the address the gateway gave for "{consumer.slug}"',
    )
    return consumer


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
    missing = _missing(tools, requires)
    if missing:
        raise MissingToolsError(missing, sorted(tool.name for tool in tools))


def _missing(tools: list[GatewayTool], requires: list[str]) -> list[str]:
    names = {tool.name for tool in tools}
    return [name for name in requires if resolve_tool_name(name, tools) not in names]


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
        KeyUpstream(
            server=connection.registry or connection.provider,
            provider=connection.provider,
            account="shared" if connection.shared else "user",
            blocked=BLOCKED_BY_ADMINISTRATOR if connection.shared else BLOCKED_BY_END_USER,
        )
        for connection in connections
        if connection.status != CONNECTED
    ]
