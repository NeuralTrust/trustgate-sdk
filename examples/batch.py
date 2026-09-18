"""A nightly job, which is the case a connect link cannot help.

Once this is running there is nobody to open a URL, so everything that could
stop it is checked before the first row: the tools it was written around, and
the upstream accounts it will need.
"""

import logging
import sys

from trustgate import MissingToolsError, ToolFormat, TrustGate, UpstreamNotConnectedError

log = logging.getLogger(__name__)
tg = TrustGate()

try:
    agent = tg.connect(requires=["notion_search", "linear_create_issue"])
except MissingToolsError as error:
    sys.exit(f"this application cannot run: its toolkit is missing {error.missing}")
except UpstreamNotConnectedError as error:
    sys.exit(f"this application has not signed in to {error.providers}: open {error.connect_url}")

# An account can still be revoked mid-run, so a long job re-reads between
# batches rather than finding out on the call that fails.
for batch in range(3):
    pending = [c for c in agent.refresh_connections() if c.status != "connected"]
    if pending:
        log.error("stopping: %s went away mid-run", [c.provider for c in pending])
        break

    result = agent.call_tool("notion_search", {"query": f"incidents week {batch}"})
    log.info("batch %s: %s", batch, result.get("structuredContent") or result.get("content"))
