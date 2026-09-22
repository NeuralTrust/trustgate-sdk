"""An assistant acting for one of its own end users.

The application names the person each call is for, and the moment that person
has not connected an account is a link to show them rather than a failure.

    uv run end_user_agent.py
    uv run end_user_agent.py user_123 "what changed in the runbook this week?"
"""

import sys

import anthropic

from trustgate import (
    ConsentRequiredError,
    EndUserAgent,
    ToolFormat,
    TrustGate,
    TrustGateError,
)

from _config import gateway_env, require

MODEL = "claude-opus-5"
DEFAULT_USER = "viktor.manuel.garcia@gmail.com"
DEFAULT_QUESTION = "find the last issues in Linear"
# A turn is one model call and the tools it asks for. A handful is enough for
# an answer, and a bound means a model that keeps calling stops on its own.
MAX_TURNS = 10


def answer(user: EndUserAgent, client: "anthropic.Anthropic", question: str) -> str:
    # The toolkit is the application's and identical for everyone it acts for;
    # what the handle changes is whose upstream account the gateway reaches for.
    toolkit = user.toolkit(ToolFormat.ANTHROPIC_MESSAGES)

    # A user who has connected nothing is not an error here, it is a link to
    # show them. The gateway does offer each unconnected server as a
    # trustgate_connect_* tool, but a model with nothing else it can call tends
    # to announce the links rather than fetch them - and the program can see the
    # same thing for itself, without spending a turn finding out.
    accounts = user.connections()
    pending = [account for account in accounts if account.status != "connected"]
    if accounts and len(pending) == len(accounts):
        return _connect_links(user, pending)

    messages: list[dict] = [{"role": "user", "content": question}]
    for _ in range(MAX_TURNS):
        message = client.messages.create(
            model=MODEL,
            max_tokens=1024,
            tools=toolkit.tools,
            messages=messages,
        )

        try:
            outputs = toolkit.execute(message)
        except ConsentRequiredError as error:
            # The gateway minted this link for this user; it expires, so it is
            # shown now rather than stored.
            return f"I need access to {error.provider} first: {error.connect_url}"

        if not outputs:
            return "".join(block.text for block in message.content if block.type == "text")

        messages.append({"role": "assistant", "content": message.content})
        messages.extend(outputs)

    return f"stopped after {MAX_TURNS} turns without a final answer"


def _connect_links(user, pending) -> str:
    """One link per server this user has not signed in to.

    Minted here rather than stored: each one carries a ticket that expires, so
    it is worth exactly as much as the moment it is shown in.
    """
    lines = ["No account is connected for this user, so nothing can run yet. Open these:"]
    for account in pending:
        lines.append(f"  {account.provider}: {user.connect_link(account.provider).connect_url}")
    return "\n".join(lines)


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
        # Naming the person is the whole difference from batch.py, and it is a
        # per-call decision rather than something set on the application: the same
        # key and the same application serve both. The name is yours to choose -
        # the gateway namespaces it, so it never collides with another
        # application's.
        user = tg.for_end_user(user_id)
    except TrustGateError as error:
        sys.exit(f"could not reach the gateway: {error}")

    client = anthropic.Anthropic(api_key=api_key)

    print(answer(user, client, question))


if __name__ == "__main__":
    main()
