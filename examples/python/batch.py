"""A nightly job, which is the case a connect link cannot help.

Once this is running there is nobody to open a URL, so everything that could
stop it is checked before the first row: the tools it was written around, and
the upstream accounts it will need.

    uv run batch.py
"""

import logging
import sys

from trustgate import (
    EndUserAgentFactory,
    MissingToolsError,
    TrustGate,
    TrustGateError,
    UpstreamNotConnectedError,
)

from _config import gateway_env

# The tools your application carries, by the names their own servers gave them:
# the gateway serves Linear's "list_issues" as "linear_list_issues", and that
# prefix is its doing, so it is not written here. Replace these with yours - the
# Routing tab lists them, and so does the error this raises.
REQUIRED_TOOLS = ["list_issues"]
# The tool the loop below spends its batches on, and the arguments it takes -
# which are the tool's own, so they change when you change the tool. One of
# REQUIRED_TOOLS, so the preflight has already proved it is there.
WORK_TOOL = REQUIRED_TOOLS[0]
WORK_ARGUMENTS = {}
BATCHES = 3

log = logging.getLogger("batch")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    gateway_env()

    tg = TrustGate()
    try:
        agent = tg.connect(requires=REQUIRED_TOOLS)
    except MissingToolsError as error:
        # The error names what the toolkit does carry, which is what turns this
        # from a dead end into the list to put in REQUIRED_TOOLS.
        sys.exit(f"this application cannot run: {error}")
    except UpstreamNotConnectedError as error:
        sys.exit(
            f"this application has not signed in to {error.providers}: open {error.connect_url}"
        )
    except TrustGateError as error:
        # A wrong URL or a key the gateway does not know lands here. Said as a
        # sentence, because a traceback is not what a first run needs.
        sys.exit(f"could not reach the gateway: {error}")

    # A batch runs as the application. An application that names its own users
    # has no such actor - there is nobody for a nightly job to be - so this is
    # the wrong program for it, and saying so beats failing on the first call.
    if isinstance(agent, EndUserAgentFactory):
        sys.exit(
            "this application acts for its own end users, so it has no accounts of its "
            "own for a batch to run on - see end_user_agent.py for that shape."
        )

    log.info("running as %s", agent.slug)

    # An account can still be revoked mid-run, so a long job re-reads between
    # batches rather than finding out on the call that fails.
    for batch in range(BATCHES):
        pending = [c for c in agent.refresh_connections() if c.status != "connected"]
        if pending:
            log.error("stopping: %s went away mid-run", [c.provider for c in pending])
            break

        result = agent.call_tool(WORK_TOOL, WORK_ARGUMENTS)
        log.info(
            "batch %s: %s", batch, result.get("structuredContent") or result.get("content")
        )


if __name__ == "__main__":
    main()
