"""Where the examples get their placeholders from.

Every one of them needs a key, and the SDK already reads it from
TRUSTGATE_API_KEY (and TRUSTGATE_URL, when the gateway is not NeuralTrust's
cloud). This only adds the part the SDK cannot: saying which variable is
missing, and where to find its value, instead of failing on the first request.
"""

import os
import sys

# Copied from .env.example on the first run, so a missing value points at a file
# that already exists rather than at documentation.
ENV_FILE = ".env"


def load_env_file() -> None:
    """Reads .env next to the examples. Real values in the environment win."""
    path = os.path.join(os.path.dirname(__file__), ENV_FILE)
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


def require(name: str, where: str) -> str:
    """The value, or an exit that says which one and where to get it."""
    value = os.environ.get(name, "").strip()
    if not value or value.startswith("<"):
        sys.exit(
            f"{name} is not set. {where}\n"
            f"Put it in examples/python/{ENV_FILE} (copy {ENV_FILE}.example) "
            f"or export it before running."
        )
    return value


def gateway_env() -> None:
    """Checks the key the SDK reads, before it is constructed."""
    load_env_file()
    require(
        "TRUSTGATE_API_KEY",
        "It is the application's API key — the Authentication block of its General tab issues one.",
    )
