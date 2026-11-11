"""One of the application's A2A agents, handed to the A2A SDK.

The SDK does not speak A2A: it finds the agent behind the key and hands over
its address and the headers that authenticate it. a2a-sdk fetches the card and
sends the message, both through the gateway.

    uv run a2a_agent.py "Travel planner" "plan a weekend in Lisbon"
    uv run a2a_agent.py "Travel planner" "plan a weekend in Lisbon" user_123
"""

import asyncio
import sys

import httpx
from a2a.client import ClientConfig, create_client
from a2a.helpers import get_stream_response_text, new_text_message
from a2a.types import Role, SendMessageRequest

from trustgate import TrustGate, TrustGateError

from _config import gateway_env


async def main() -> None:
    gateway_env()
    if len(sys.argv) < 3:
        sys.exit("usage: a2a_agent.py <agent name or id> <message> [end user]")
    name, text = sys.argv[1], sys.argv[2]
    end_user = sys.argv[3] if len(sys.argv) > 3 else None

    try:
        agent = TrustGate().agent(name, end_user=end_user)
    except TrustGateError as error:
        sys.exit(str(error))

    async with httpx.AsyncClient(headers=agent.headers, timeout=120) as http:
        client = await create_client(agent.url, client_config=ClientConfig(httpx_client=http))
        request = SendMessageRequest(message=new_text_message(text, role=Role.ROLE_USER))
        async for event in client.send_message(request):
            print(get_stream_response_text(event))


if __name__ == "__main__":
    asyncio.run(main())
