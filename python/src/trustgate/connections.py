"""The connections API: which upstream accounts an actor has, and the link to add one."""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any
from urllib.parse import quote

from .config import API_KEY_HEADER, END_USER_HEADER, Config
from .errors import InvalidRequestError
from .transport import Transport, error_for_response
from .types import ConnectLink, Connection


def connections_path(slug: str, end_user: str | None = None) -> str:
    query = f"?end_user={quote(end_user)}" if end_user else ""
    return f"/{quote(slug)}/connections{query}"


def list_connections(
    config: Config, transport: Transport, slug: str, end_user: str | None = None
) -> list[Connection]:
    response = transport.request(
        "GET",
        f"{config.base_url}{connections_path(slug, end_user)}",
        {API_KEY_HEADER: config.api_key, "Accept": "application/json"},
        None,
        config.timeout,
    )
    if response.status >= 400:
        raise error_for_response(response)
    body = response.json() or {}
    return [_to_connection(item) for item in (body.get("connections") or [])]


def create_connect_link(
    config: Config,
    transport: Transport,
    slug: str,
    end_user: str,
    provider: str | None = None,
) -> ConnectLink:
    payload: dict[str, Any] = {"end_user": end_user}
    if provider:
        payload["provider"] = provider
    response = transport.request(
        "POST",
        f"{config.base_url}/{quote(slug)}/connections/links",
        {
            API_KEY_HEADER: config.api_key,
            END_USER_HEADER: end_user,
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
        json.dumps(payload).encode("utf-8"),
        config.timeout,
    )
    if response.status >= 400:
        raise error_for_response(response)
    body = response.json() or {}
    return ConnectLink(
        connect_url=body.get("connect_url", ""),
        ticket=body.get("ticket", ""),
        provider=body.get("provider") or None,
        expires_at=_to_datetime(body.get("expires_at")) or datetime.now(),
    )


def require_end_user(end_user: str) -> str:
    """The gateway is the authority on what an end-user id may be.

    This only catches the mistake worth catching locally, which is the empty
    one - it would otherwise be sent as a header the gateway reads as "no user
    named" and answer for the wrong actor.
    """
    trimmed = (end_user or "").strip()
    if not trimmed:
        raise InvalidRequestError("an end-user id is required to act for a user")
    return trimmed


def _to_connection(payload: dict[str, Any]) -> Connection:
    return Connection(
        provider=payload.get("provider", ""),
        status=payload.get("status", ""),
        registry=payload.get("registry") or None,
        code=payload.get("code") or None,
        account_ref=payload.get("account_ref") or None,
        expires_at=_to_datetime(payload.get("expires_at")),
    )


def _to_datetime(raw: Any) -> datetime | None:
    if not raw or not isinstance(raw, str):
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
