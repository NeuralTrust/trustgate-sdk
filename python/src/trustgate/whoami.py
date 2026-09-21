"""What an api key reaches, asked of the gateway.

It is what lets a client be configured with one secret: the slugs were chosen
by whoever created the consumers, and the LLM plane is on a host the MCP URL
says nothing about, so both have to come from the gateway.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .config import API_KEY_HEADER, Config
from .errors import PlaneUnavailableError, TrustGateError
from .transport import Transport, error_for_response


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
    acts_for_users: bool = False
    identity_source: str | None = None


@dataclass(frozen=True)
class KeyIdentity:
    """Everything the key can say about itself."""

    gateway: str = ""
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
        raise error_for_response(response)
    body = response.json() or {}
    return KeyIdentity(
        gateway=body.get("gateway", ""),
        consumers=[
            KeyConsumer(
                slug=item.get("slug", ""),
                type=str(item.get("type", "")).upper(),
                active=item.get("active", True) is not False,
                url=item.get("url", "") or "",
                name=item.get("name") or None,
                acts_for_users=item.get("acts_for_users") is True,
                identity_source=item.get("identity_source") or None,
            )
            for item in (body.get("consumers") or [])
        ],
    )


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
