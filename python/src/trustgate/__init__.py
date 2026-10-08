"""TrustGate SDK - governed tools and models for agents.

An admin creates the consumer and decides what it may reach; this package
points an agent at it. What it adds on top of a plain HTTP call is the part
that is easy to get wrong: which actor a call speaks as, whether the tools the
agent was written around are still on its toolkit, and what to do when an
upstream account is not connected.
"""

from .agent import Agent, EndUserAgent, Toolkit, UserAgent
from .client import LLMEndpoint, TrustGate, TrustGateUser
from .config import API_KEY_HEADER, END_USER_HEADER
from .errors import (
    AuthenticationError,
    ConsentRequiredError,
    InvalidRequestError,
    LoginRequiredError,
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
from .types import (
    Actor,
    Connection,
    ConnectLink,
    Endpoint,
    GatewayTool,
    ToolCall,
    ToolFormat,
)
from .user import FileTokenCache, MemoryTokenCache, TokenCache, UserToken
from .whoami import (
    KeyConsumer,
    KeyIdentity,
    KeyInfo,
    KeyUpstream,
    select_consumer,
    who_am_i,
)

__version__ = "0.3.1"

__all__ = [
    "Actor",
    "Agent",
    "API_KEY_HEADER",
    "AuthenticationError",
    "ConnectLink",
    "Connection",
    "ConsentRequiredError",
    "ConversionWarning",
    "END_USER_HEADER",
    "Endpoint",
    "FileTokenCache",
    "EndUserAgent",
    "GatewayTool",
    "KeyConsumer",
    "KeyIdentity",
    "KeyInfo",
    "KeyUpstream",
    "InvalidRequestError",
    "LLMEndpoint",
    "LoginRequiredError",
    "MCPTransport",
    "MemoryTokenCache",
    "MissingToolsError",
    "PlaneUnavailableError",
    "PolicyBlockedError",
    "RateLimitedError",
    "Response",
    "ServiceUnavailableError",
    "StrictResult",
    "ToolCall",
    "TokenCache",
    "ToolFormat",
    "ToolNotFoundError",
    "Toolkit",
    "Transport",
    "TrustGate",
    "TrustGateError",
    "TrustGateServerError",
    "TrustGateUser",
    "UpstreamNotConnectedError",
    "UserAgent",
    "UrllibTransport",
    "UserToken",
    "adapter_for",
    "inline_refs",
    "result_to_text",
    "select_consumer",
    "strip_injected_nulls",
    "to_strict",
    "who_am_i",
]
