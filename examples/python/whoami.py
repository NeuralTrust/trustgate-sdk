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
    expiry = identity.key.expires_at.isoformat() if identity.key.expires_at else "never"
    print(f"key:     {identity.key.name or '(unnamed)'} - expires {expiry}")
    if not identity.consumers:
        sys.exit(
            "this key reaches no application. It may be disabled, or belong to another gateway."
        )

    for consumer in identity.consumers:
        print(f"\n  {consumer.slug}  ({consumer.type}{'' if consumer.active else ', disabled'})")
        if consumer.name:
            print(f"    name:  {consumer.name}")
        print(f"    url:   {consumer.url or '(no public host for this plane)'}")

        # Both actors belong to every MCP application - batch.py runs as the
        # application, end_user_agent.py names a person - so what is worth
        # printing is not which one it is, but what each is still waiting for.
        for upstream in consumer.upstreams or []:
            if upstream.blocked == "administrator":
                state = "an administrator has to connect it on the server"
            elif upstream.blocked == "end_user":
                state = "name the person it acts for -> end_user_agent.py"
            else:
                state = "ready"
            print(f"    server {upstream.server} ({upstream.account} account): {state}")


if __name__ == "__main__":
    main()
