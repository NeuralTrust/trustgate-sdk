"""What an api key reaches, asked of the gateway.

It is what lets a client be configured with one secret: the slugs were chosen
by whoever created the consumers, and the LLM plane is on a host the MCP URL
says nothing about, so both have to come from the gateway.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from .config import API_KEY_HEADER, Config
from .errors import PlaneUnavailableError, TrustGateError
from .transport import Transport, error_for_response

#: The code a plane answers with for a gateway it does not serve: a Hybrid one,
#: which only its own data plane does.
SERVED_ELSEWHERE = "gateway_served_by_external_data_plane"

#: Who has to act before a server answers a call that runs as the application.
#:
#: ``administrator`` is an instance whose shared account nobody has connected -
#: no caller can connect it, because it is the account every other caller rides
#: on. ``end_user`` is an instance that keeps an account per caller, which an
#: application is not: it names the person it acts for, and the account becomes
#: theirs to connect.
BLOCKED_BY_ADMINISTRATOR = "administrator"
BLOCKED_BY_END_USER = "end_user"


@dataclass(frozen=True)
class KeyUpstream:
    """One MCP server the application is bound to, and what it is waiting for."""

    server: str
    provider: str | None = None
    #: Whose account it reads: ``shared`` or ``user``.
    account: str = "user"
    connected: bool = False
    needs_reconnect: bool = False
    #: ``administrator``, ``end_user``, or ``None`` when the server is ready.
    blocked: str | None = None


@dataclass(frozen=True)
class KeyInfo:
    """The calling key itself. The secret is never echoed."""

    name: str | None = None
    #: When it retires itself. ``None`` means never.
    expires_at: datetime | None = None


@dataclass(frozen=True)
class KeyConsumer:
    """One consumer the key reaches, with the address it is served on."""

    slug: str
    #: The plane this consumer belongs to: MCP, LLM or A2A.
    type: str
    active: bool = True
    #: Where it answers. Empty when the gateway publishes no host for its plane.
    url: str = ""
    name: str | None = None
    #: The servers behind it that read a stored account, answered for this key -
    #: which is the application itself. ``None`` is not "nothing to connect": it
    #: is also what a gateway that could not read the accounts answers, and a
    #: server carrying its own credential is never listed. Read ``blocked``.
    upstreams: list[KeyUpstream] | None = None


@dataclass(frozen=True)
class KeyIdentity:
    """Everything the key can say about itself."""

    gateway: str = ""
    key: KeyInfo = field(default_factory=KeyInfo)
    consumers: list[KeyConsumer] = field(default_factory=list)


def who_am_i(config: Config, transport: Transport) -> KeyIdentity:
    response = transport.request(
        "GET",
        f"{config.base_url}/whoami",
        {API_KEY_HEADER: config.api_key, "Accept": "application/json"},
        None,
        config.timeout,
    )
    if response.status == 404:
        raise TrustGateError(
            f"{config.base_url}/whoami answered 404, so the SDK cannot resolve which "
            "consumers this key reaches. Usually TRUSTGATE_URL is the wrong address: it is "
            "the MCP plane's host on its own, with no consumer path after it — not the "
            "/<application>/mcp endpoint, and not the LLM plane. Otherwise the gateway "
            "predates /whoami and needs upgrading.",
            status=404,
        )
    if response.status >= 400:
        error = error_for_response(response)
        if error.code == SERVED_ELSEWHERE:
            raise TrustGateError(
                f"this key's gateway runs on its own (Hybrid) data plane, which "
                f"{config.base_url} does not serve. Set base_url (or TRUSTGATE_URL) to "
                "the MCP host that data plane is published on.",
                status=error.status,
                code=error.code,
            ) from error
        raise error
    body = response.json() or {}
    key = body.get("key") or {}
    return KeyIdentity(
        gateway=body.get("gateway", ""),
        key=KeyInfo(
            name=key.get("name") or None,
            expires_at=_parse_time(key.get("expires_at")),
        ),
        consumers=[
            KeyConsumer(
                slug=item.get("slug", ""),
                type=str(item.get("type", "")).upper(),
                active=item.get("active", True) is not False,
                url=item.get("url", "") or "",
                name=item.get("name") or None,
                upstreams=_upstreams(item.get("upstreams")),
            )
            for item in (body.get("consumers") or [])
        ],
    )


def _upstreams(raw: object) -> list[KeyUpstream] | None:
    if not isinstance(raw, list):
        return None
    return [
        KeyUpstream(
            server=item.get("server", ""),
            provider=item.get("provider") or None,
            account="shared" if item.get("account") == "shared" else "user",
            connected=item.get("connected") is True,
            needs_reconnect=item.get("needs_reconnect") is True,
            blocked=item.get("blocked")
            if item.get("blocked") in (BLOCKED_BY_ADMINISTRATOR, BLOCKED_BY_END_USER)
            else None,
        )
        for item in raw
        if isinstance(item, dict)
    ]


def _parse_time(raw: object) -> datetime | None:
    """RFC3339 as the gateway writes it, or nothing."""
    if not isinstance(raw, str) or not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def select_consumer(
    identity: KeyIdentity, plane: str, configured: str | None, argument: str
) -> KeyConsumer:
    """Picks the one consumer of a plane, or explains why it cannot.

    A key attached to two consumers of the same type is a legitimate setup that
    this SDK cannot resolve on its own, so it names them and asks - rather than
    guessing and running an agent against the wrong surface.
    """
    candidates = [consumer for consumer in identity.consumers if consumer.type == plane]
    if configured:
        for consumer in candidates:
            if consumer.slug == configured:
                return consumer
        reachable = ", ".join(c.slug for c in candidates)
        raise PlaneUnavailableError(
            f'this API key does not reach a {plane} consumer called "{configured}"'
            + (f"; it reaches {reachable}" if reachable else "")
        )
    if not candidates:
        raise PlaneUnavailableError(
            f"this API key reaches no {plane} consumer. Ask the admin who owns this "
            "application to attach one, or name it explicitly."
        )
    if len(candidates) > 1:
        named = ", ".join(c.slug for c in candidates)
        raise TrustGateError(
            f"this API key reaches several {plane} consumers ({named}); "
            "name the one this agent uses."
        )
    only = candidates[0]
    if not only.url:
        raise PlaneUnavailableError(
            f'the gateway publishes no host for its {plane} plane, so "{only.slug}" has no '
            f"address. Ask an operator to configure that plane's domain, or pass {argument}."
        )
    return only
