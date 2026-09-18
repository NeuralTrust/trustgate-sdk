"""TrustGate SDK - governed tools and models for agents.

An admin creates the consumer and decides what it may reach; this package
points an agent at it. What it adds on top of a plain HTTP call is the part
that is easy to get wrong: which actor a call speaks as, whether the tools the
agent was written around are still on its toolkit, and what to do when an
upstream account is not connected.
"""

from .agent import Agent, EndUserAgent, Toolkit
from .client import EndUserAgentFactory, LLMEndpoint, TrustGate
from .config import API_KEY_HEADER, END_USER_HEADER
from .errors import (
    AppActorUnavailableError,
    AuthenticationError,
    ConsentRequiredError,
    EndUserActorUnavailableError,
    InvalidRequestError,
    MissingToolsError,
    PlaneUnavailableError,
    PolicyBlockedError,
    RateLimitedError,
    ServiceUnavailableError,
    ToolNotFoundError,
    TrustGateError,
    TrustGateServerError,
    UpstreamNotConnectedError,
)
from .formats import ConversionWarning, adapter_for, result_to_text
from .mcp import MCPTransport
from .schema import StrictResult, inline_refs, strip_injected_nulls, to_strict
from .transport import Response, Transport, UrllibTransport
from .whoami import KeyConsumer, KeyIdentity, select_consumer, who_am_i
from .types import (
    Actor,
    ConnectLink,
    Connection,
    Endpoint,
    GatewayTool,
    ToolCall,
    ToolFormat,
)

__version__ = "0.1.0"

__all__ = [
    "Actor",
    "Agent",
    "API_KEY_HEADER",
    "AppActorUnavailableError",
    "AuthenticationError",
    "ConnectLink",
    "Connection",
    "ConsentRequiredError",
    "ConversionWarning",
    "END_USER_HEADER",
    "Endpoint",
    "EndUserActorUnavailableError",
    "EndUserAgent",
    "EndUserAgentFactory",
    "GatewayTool",
    "KeyConsumer",
    "KeyIdentity",
    "InvalidRequestError",
    "LLMEndpoint",
    "MCPTransport",
    "MissingToolsError",
    "PlaneUnavailableError",
    "PolicyBlockedError",
    "RateLimitedError",
    "Response",
    "ServiceUnavailableError",
    "StrictResult",
    "ToolCall",
    "ToolFormat",
    "ToolNotFoundError",
    "Toolkit",
    "Transport",
    "TrustGate",
    "TrustGateError",
    "TrustGateServerError",
    "UpstreamNotConnectedError",
    "UrllibTransport",
    "adapter_for",
    "inline_refs",
    "result_to_text",
    "select_consumer",
    "strip_injected_nulls",
    "to_strict",
    "who_am_i",
]
