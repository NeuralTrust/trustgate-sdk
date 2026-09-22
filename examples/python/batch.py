"""A nightly triage run — the case a connect link cannot help.

Once this is going there is nobody to open a URL, so everything that could stop
it is checked before the first issue: the tools it was written around, and the
upstream accounts it will need.

Then it earns its keep. For each issue sitting in triage it asks a model one
question — does this need a human tonight? — and hands it the application's whole
toolkit to answer with. The model reads the issue, looks up whatever else it
wants, and every one of those calls goes back through the gateway: same policy,
same audit, same per-application credentials. It never sees a token.

    uv run batch.py
"""

import json
import logging
import shutil
import sys
import textwrap

from trustgate import (
    MissingToolsError,
    PlaneUnavailableError,
    ToolFormat,
    TrustGate,
    TrustGateError,
    UpstreamNotConnectedError,
    result_to_text,
)

from _config import gateway_env, require

# The tools this program calls itself, by the names their own servers gave them:
# the gateway serves Linear's "list_issues" as "linear_list_issues", and that
# prefix is its doing, so it is not written here. Replace with yours - the
# Routing tab lists them, and so does the error this raises.
QUEUE_TOOL = "list_issues"
REQUIRED_TOOLS = [QUEUE_TOOL]
QUEUE_ARGUMENTS: dict = {}

# Triage is a judgement made many times over, which is the shape a small model
# is for. Through the gateway this name is whichever model it routes; called
# directly it is Anthropic's own.
MODEL = "auto"
QUESTION = (
    "Does this issue need a human tonight, or can it wait for the morning?\n"
    "Look up whatever you need first.\n"
    "Then answer in one line, plain text: the word TONIGHT or WAIT, an em dash, "
    "and one sentence of reason. No markdown, no second paragraph."
)
# What the answer is allowed to be. Longest first, so no verdict is read as the
# prefix of another.
VERDICTS = ("TONIGHT", "WAIT")
MAX_ISSUES = 5
# One model call and the tools it asks for. A bound means an issue that sends
# the model round in circles costs one issue rather than the whole run.
MAX_TURNS = 6

log = logging.getLogger("triage")


def queue(agent) -> list[dict]:
    """The issues to look at, read straight off the tool.

    This one call the program makes itself: which queue to work is its decision,
    not the model's, and a batch that let the model choose its own input would
    be a different program.
    """
    said = result_to_text(agent.call_tool(QUEUE_TOOL, QUEUE_ARGUMENTS))
    try:
        body = json.loads(said)
    except ValueError:
        sys.exit(f"{QUEUE_TOOL} did not answer with JSON, so this run has no queue: {said[:200]}")
    issues = body.get("issues") if isinstance(body, dict) else body
    if not isinstance(issues, list):
        sys.exit(f"{QUEUE_TOOL} answered with no list of issues: {said[:200]}")
    return issues[:MAX_ISSUES]


def verdict(agent, client, issue: dict) -> str:
    """One issue, judged - with the whole toolkit available to judge it."""
    toolkit = agent.toolkit(ToolFormat.ANTHROPIC_MESSAGES)
    messages: list[dict] = [
        {"role": "user", "content": f"{QUESTION}\n\n{json.dumps(issue, separators=(',', ':'))}"}
    ]

    for _ in range(MAX_TURNS):
        message = client.messages.create(
            model=MODEL, max_tokens=300, tools=toolkit.tools, messages=messages
        )
        outputs = toolkit.execute(message)
        if not outputs:
            return " ".join(block.text for block in message.content if block.type == "text").strip()
        messages.append({"role": "assistant", "content": message.content})
        messages.extend(outputs)

    return f"(no verdict after {MAX_TURNS} turns)"


def split_verdict(answer: str) -> tuple[str, str]:
    """The call and the reason, out of whatever the model actually wrote.

    It is asked for one plain line and mostly gives one, but a model told to be
    brief still reaches for bold and paragraphs - and a digest that reprints
    "**WAIT**" and four sentences is not a digest.
    """
    flat = " ".join(answer.replace("*", " ").replace("#", " ").split())
    for name in VERDICTS:
        if flat.upper().startswith(name):
            return name, flat[len(name) :].lstrip(" -–—:,.").strip()
    return "?", flat


def render(issue: dict, answer: str, width: int) -> str:
    """One issue as two lines: the call and the title, then the reason under it."""
    call, reason = split_verdict(answer)
    name = str(issue.get("id") or issue.get("identifier") or "?")
    title = " ".join(str(issue.get("title") or "").split())

    head = f"  {call:<{len(max(VERDICTS, key=len))}}  {name}"
    if title:
        head += "  " + textwrap.shorten(title, max(20, width - len(head) - 2), placeholder="…")
    indent = " " * (len(max(VERDICTS, key=len)) + 4)
    body = textwrap.fill(
        reason, width=max(40, width), initial_indent=indent, subsequent_indent=indent
    )
    return f"{head}\n{body}" if reason else head


def model_client(tg: TrustGate):
    """The model, through the gateway when this key reaches one.

    Then the whole agent stands on one secret and the model calls are governed
    like the tool calls. A key that reaches no models falls back to
    Anthropic directly, which is a key of your own and a call nobody sees.
    """
    import anthropic

    try:
        llm = tg.llm()
    except PlaneUnavailableError:
        log.info("this key reaches no models; calling Anthropic directly")
        return anthropic.Anthropic(
            api_key=require(
                "ANTHROPIC_API_KEY",
                "This key reaches no models, so the model call needs a key of yours.",
            )
        )
    log.info("models through %s", llm.consumer)
    return anthropic.Anthropic(base_url=llm.anthropic_base_url, api_key=llm.api_key)


def main() -> None:
    # The run's own lines are the output; an HTTP log line per model call is
    # someone else's debugging, and there is one for every turn of every issue.
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    for noisy in ("httpx", "httpcore", "anthropic"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    gateway_env()

    tg = TrustGate()
    try:
        agent = tg.connect(requires=REQUIRED_TOOLS)
    except MissingToolsError as error:
        # The error names what the toolkit does carry, which is what turns this
        # from a dead end into the list to put in REQUIRED_TOOLS.
        sys.exit(f"this application cannot run: {error}")
    except UpstreamNotConnectedError as error:
        # The message names each server and who fixes it: an administrator for a
        # shared account, or this code, with the call to make, for a per-user one.
        sys.exit(str(error))
    except TrustGateError as error:
        # A wrong URL or a key the gateway does not know lands here. Said as a
        # sentence, because a traceback is not what a first run needs.
        sys.exit(f"could not reach the gateway: {error}")

    client = model_client(tg)
    issues = queue(agent)
    width = min(shutil.get_terminal_size((88, 20)).columns, 100)

    print()
    print(f"  triage · {agent.slug} · {len(agent.tools)} tools · {len(issues)} issues")
    print()

    calls: list[str] = []
    for issue in issues:
        # An account can be revoked mid-run, so a long job re-reads between rows
        # rather than finding out on the call that fails.
        pending = [c for c in agent.refresh_connections() if c.status != "connected"]
        if pending:
            log.error("  stopping: %s went away mid-run", [c.provider for c in pending])
            break

        answer = verdict(agent, client, issue)
        calls.append(split_verdict(answer)[0])
        print(render(issue, answer, width))
        print()

    tonight = calls.count("TONIGHT")
    print(f"  {tonight} tonight, {len(calls) - tonight} can wait.")
    print()


if __name__ == "__main__":
    main()
