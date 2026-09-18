"""An assistant that acts for its own end users.

The consumer identifies them, so every call names one, and the moment a user
has not connected an account is a link to show them rather than a failure.
"""

from trustgate import ConsentRequiredError, ToolFormat, TrustGate

tg = TrustGate()
handle = tg.connect()  # EndUserAgentFactory: no surface without a user


def answer(user_id: str, question: str, client) -> str:
    user = handle.for_end_user(user_id)
    toolkit = user.toolkit(ToolFormat.ANTHROPIC_MESSAGES)

    message = client.messages.create(
        model="claude-opus-5",
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

    follow_up = client.messages.create(
        model="claude-opus-5",
        max_tokens=1024,
        tools=toolkit.tools,
        messages=[{"role": "user", "content": question}, {"role": "assistant", "content": message.content}, *outputs],
    )
    return "".join(block.text for block in follow_up.content if block.type == "text")
