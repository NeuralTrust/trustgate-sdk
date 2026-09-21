"""An assistant that acts for its own end users.

The consumer identifies them, so every call names one, and the moment a user
has not connected an account is a link to show them rather than a failure.

    uv run end_user_agent.py
    uv run end_user_agent.py user_123 "what changed in the runbook this week?"
"""

import sys

import anthropic

from trustgate import (
    ConsentRequiredError,
    EndUserAgentFactory,
    ToolFormat,
    TrustGate,
    TrustGateError,
)

from _config import gateway_env, require

MODEL = "claude-opus-5"
DEFAULT_USER = "user_123"
DEFAULT_QUESTION = "find the incident runbook and summarise it"


def answer(handle, client: "anthropic.Anthropic", user_id: str, question: str) -> str:
    # The handle has no surface of its own: every call belongs to one user, and
    # the toolkit is read as the first one named rather than as the application.
    user = handle.for_end_user(user_id)
    toolkit = user.toolkit(ToolFormat.ANTHROPIC_MESSAGES)

    message = client.messages.create(
        model=MODEL,
        max_tokens=1024,
        tools=toolkit.tools,
        messages=[{"role": "user", "content": question}],
    )

    try:
        outputs = toolkit.execute(message)
    except ConsentRequiredError as error:
        # The gateway minted this link for this user; it expires, so it is
        # shown now rather than stored.
        return f"I need access to {error.provider} first: {error.connect_url}"

    if not outputs:
        return "".join(block.text for block in message.content if block.type == "text")

    follow_up = client.messages.create(
        model=MODEL,
        max_tokens=1024,
        tools=toolkit.tools,
        messages=[
            {"role": "user", "content": question},
            {"role": "assistant", "content": message.content},
            *outputs,
        ],
    )
    return "".join(block.text for block in follow_up.content if block.type == "text")


def main() -> None:
    gateway_env()
    api_key = require(
        "ANTHROPIC_API_KEY",
        "This example calls Anthropic directly; the key is yours, not the gateway's.",
    )

    user_id = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_USER
    question = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_QUESTION

    tg = TrustGate()
    try:
        handle = tg.connect()  # EndUserAgentFactory: no surface without a user
    except TrustGateError as error:
        sys.exit(f"could not reach the gateway: {error}")

    # The consumer decides this, not the caller: only an application that names
    # its own users has end users this key can speak for.
    if not isinstance(handle, EndUserAgentFactory):
        sys.exit(
            "this application acts as itself, so it has no end users to answer for - "
            "see batch.py for that shape."
        )
    client = anthropic.Anthropic(api_key=api_key)

    print(answer(handle, client, user_id, question))


if __name__ == "__main__":
    main()
