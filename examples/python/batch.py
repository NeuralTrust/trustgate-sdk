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

# Replace with the tools your application actually carries. The names are the
# server's own, as its Routing tab lists them.
REQUIRED_TOOLS = ["notion_search", "linear_create_issue"]
BATCHES = 3

log = logging.getLogger("batch")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    gateway_env()

    tg = TrustGate()
    try:
        agent = tg.connect(requires=REQUIRED_TOOLS)
    except MissingToolsError as error:
        sys.exit(f"this application cannot run: its toolkit is missing {error.missing}")
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

        result = agent.call_tool("notion_search", {"query": f"incidents week {batch}"})
        log.info(
            "batch %s: %s", batch, result.get("structuredContent") or result.get("content")
        )


if __name__ == "__main__":
    main()
