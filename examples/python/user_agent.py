"""An assistant for yourself, on your own Store.

No application and no API key: you sign in as yourself, and the tools are the
servers you installed from the Store, narrowed to what Access grants you. The
first run opens your browser; later runs reuse the session until it ends.

    uv run user_agent.py
    uv run user_agent.py "what changed in the runbook this week?"
"""

import sys

import anthropic

from trustgate import ConsentRequiredError, ToolFormat, TrustGate, TrustGateError, UserAgent

from _config import load_env_file, require

MODEL = "claude-opus-5"
DEFAULT_QUESTION = "find my last issues in Linear"
# A turn is one model call and the tools it asks for. A handful is enough for
# an answer, and a bound means a model that keeps calling stops on its own.
MAX_TURNS = 10


def answer(me: UserAgent, client: "anthropic.Anthropic", question: str) -> str:
    toolkit = me.toolkit(ToolFormat.ANTHROPIC_MESSAGES)

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
            return f"Connect {error.provider} first: {error.connect_url}"

        if not outputs:
            return "".join(block.text for block in message.content if block.type == "text")

        messages.append({"role": "assistant", "content": message.content})
        messages.extend(outputs)

    return f"stopped after {MAX_TURNS} turns without a final answer"


def main() -> None:
    load_env_file()
    store_url = require(
        "TRUSTGATE_STORE_URL",
        "It is your Store's MCP URL, https://<gateway>.<mcp host>/store/mcp - the "
        "console shows it where the Store is added to an MCP client.",
    )
    api_key = require(
        "ANTHROPIC_API_KEY",
        "This example calls Anthropic directly; the key is yours, not the gateway's.",
    )
    question = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_QUESTION

    try:
        # The browser opens on the first run only: the session is kept in
        # ~/.trustgate and renewed, until the sign-in itself ends.
        me = TrustGate.login(url=store_url).connect()
    except TrustGateError as error:
        sys.exit(f"could not open your Store: {error}")

    # A server whose account you have not connected is not on the surface yet;
    # one link connects all of them, and the next run picks them up.
    if me.needs_connect:
        link = me.connect_link()
        print(f"Not connected yet: {', '.join(me.needs_connect)}.")
        if link is not None:
            print(f"Connect them here, then run this again: {link.connect_url}\n")

    print(answer(me, anthropic.Anthropic(api_key=api_key), question))


if __name__ == "__main__":
    main()
