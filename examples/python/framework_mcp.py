"""The same consumer, handed to a framework that brings its own MCP client.

There is no tool list and no execution loop here: the framework lists and calls
for itself. All the SDK contributes is a checked URL and its headers - and the
model endpoint, so this file holds no OpenAI key either.

This is the shorter path when you already have a framework. The other one, for
when you call a model provider directly and there is no MCP client anywhere, is
batch.py and end_user_agent.py.

    uv run framework_mcp.py
"""

import asyncio
import sys

from pydantic_ai import Agent
from pydantic_ai.mcp import MCPToolset, StreamableHttpTransport
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

from trustgate import (
    MissingToolsError,
    PlaneUnavailableError,
    TrustGate,
    TrustGateError,
    UpstreamNotConnectedError,
)

from _config import gateway_env, require

# The tools this agent was written around, by the names their own servers gave
# them. The framework will list the rest for itself; this is only the preflight.
REQUIRES = ["list_issues"]
MODEL = "gpt-5.2"
QUESTION = "what is in triage right now, and what should I look at first?"


def model(tg: TrustGate) -> OpenAIChatModel:
    """The model, through the gateway when this key reaches one.

    Then the whole agent stands on one secret and the model calls are governed
    like the tool calls. A key that reaches no LLM consumer falls back to OpenAI
    directly, which is a key of your own and a call nobody sees.
    """
    try:
        llm = tg.llm()
        provider = OpenAIProvider(base_url=llm.base_url, api_key=llm.api_key)
    except PlaneUnavailableError:
        provider = OpenAIProvider(
            api_key=require(
                "OPENAI_API_KEY",
                "This key reaches no LLM consumer, so the model call needs one of yours.",
            )
        )
    return OpenAIChatModel(MODEL, provider=provider)


async def main() -> None:
    gateway_env()

    tg = TrustGate()
    try:
        application = tg.connect(requires=REQUIRES)
    except MissingToolsError as error:
        sys.exit(f"this application cannot run: {error}")
    except UpstreamNotConnectedError as error:
        sys.exit(str(error))
    except TrustGateError as error:
        sys.exit(f"could not reach the gateway: {error}")

    # The whole handover: a URL the SDK has already proved reachable, and the
    # headers that authenticate it. The framework does the rest of MCP.
    endpoint = application.mcp
    toolset = MCPToolset(StreamableHttpTransport(endpoint.url, headers=endpoint.headers))

    agent = Agent(
        model(tg),
        toolsets=[toolset],
        instructions="Answer from the tools. Be brief.",
    )
    async with agent:
        print((await agent.run(QUESTION)).output)


if __name__ == "__main__":
    asyncio.run(main())
