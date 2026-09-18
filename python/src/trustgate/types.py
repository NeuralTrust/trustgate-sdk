"""The shapes the SDK hands back."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any

Schema = dict[str, Any]


class Actor(str, Enum):
    """Which actor a handle speaks as. The consumer decides this, not the caller."""

    APPLICATION = "application"
    END_USER = "end_user"


class ToolFormat(str, Enum):
    """The tool shapes the SDK can emit.

    These are model providers, not agent frameworks. A framework brings its own
    MCP client, so it takes the gateway's URL and lists the tools itself - there
    is nothing to convert. Conversion only happens when you call a provider's
    API directly, which is why nothing here is called "langchain".
    """

    OPENAI_RESPONSES = "openai-responses"
    OPENAI_CHAT = "openai-chat"
    ANTHROPIC_MESSAGES = "anthropic-messages"
    GEMINI = "gemini"


@dataclass(frozen=True)
class GatewayTool:
    """A tool as the gateway serves it, before any provider dialect is applied."""

    name: str
    input_schema: Schema = field(default_factory=lambda: {"type": "object", "properties": {}})
    description: str | None = None
    title: str | None = None
    output_schema: Schema | None = None


@dataclass(frozen=True)
class Connection:
    """One upstream account of an actor, as the connections API reports it."""

    provider: str
    status: str
    registry: str | None = None
    code: str | None = None
    account_ref: str | None = None
    expires_at: datetime | None = None


@dataclass(frozen=True)
class ConnectLink:
    """The link an end user opens to connect their own account."""

    connect_url: str
    ticket: str
    expires_at: datetime
    provider: str | None = None


@dataclass(frozen=True)
class Endpoint:
    """Everything a provider's client needs to reach the gateway."""

    url: str
    headers: dict[str, str]


@dataclass(frozen=True)
class ToolCall:
    """A tool call as the SDK understands it, whatever provider asked for it."""

    id: str
    name: str
    arguments: dict[str, Any]


CONNECTED = "connected"
NEEDS_RECONNECT = "needs_reconnect"
NOT_CONNECTED = "not_connected"
