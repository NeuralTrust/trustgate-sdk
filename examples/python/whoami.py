"""What this key reaches — the first thing to run when something is off.

Almost every confusion here is the same one: the key in .env is not the key of
the application you think you are running. This asks the gateway and prints its
answer, so there is nothing left to assume.

    uv run whoami.py
"""

import sys

from trustgate import TrustGate, TrustGateError

from _config import gateway_env


def main() -> None:
    gateway_env()

    try:
        identity = TrustGate().identity()
    except TrustGateError as error:
        sys.exit(f"could not reach the gateway: {error}")

    print(f"gateway: {identity.gateway}")
    if not identity.consumers:
        sys.exit("this key reaches no consumer. It may be disabled, or belong to another gateway.")

    for consumer in identity.consumers:
        # Which actor a consumer is decides which example fits it: an
        # application acting as itself is batch.py, one naming its own users is
        # end_user_agent.py.
        if not consumer.acts_for_users:
            actor = "acts as itself -> batch.py"
        elif consumer.identity_source == "app":
            actor = "names its own users -> end_user_agent.py"
        else:
            actor = "its users sign in for themselves - an API key cannot act for them"
        print(f"\n  {consumer.slug}  ({consumer.type}{'' if consumer.active else ', disabled'})")
        if consumer.name:
            print(f"    name:  {consumer.name}")
        if consumer.type == "MCP":
            print(f"    actor: {actor}")
        print(f"    url:   {consumer.url or '(no public host for this plane)'}")


if __name__ == "__main__":
    main()
