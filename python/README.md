# trustgate-sdk

The TrustGate SDK for Python. 3.10+, standard library only.

```bash
pip install trustgate-sdk
```

## Setup

```python
from trustgate import TrustGate, ToolFormat

tg = TrustGate()   # TRUSTGATE_API_KEY
```

The key is the whole configuration, or nothing if it is in the environment.
The gateway it belongs to, and the applications behind it, are asked for:
`tg.identity()` asks once and remembers it. Set `TRUSTGATE_URL` (or `base_url`)
only for a gateway of your own, such as a private data plane.

```python
identity = tg.identity()
# identity.key -> KeyInfo(name="prod", expires_at=None)   # None means never
# KeyConsumer(slug="support-agent", type="MCP", url="https://…/support-agent/mcp",
#             upstreams=[KeyUpstream(server="Notion", account="shared", connected=True)])
# KeyConsumer(slug="support-llm",   type="LLM", url="https://…/support-llm/v1")
```

`key.expires_at` is the 401 you would otherwise meet mid-run, and `upstreams`
is the refusal you would otherwise meet on the first tool call — both answered
before anything starts.

`mcp_consumer` and `llm_consumer` (or `TRUSTGATE_MCP_CONSUMER` /
`TRUSTGATE_LLM_CONSUMER`) are only needed when a key reaches two applications on
the same plane — the SDK names them and refuses rather than guessing.

## An agent that acts as the application

```python
agent = tg.connect(requires=["search"])

agent.mcp                                        # url + headers for a framework
tg.llm()                                         # base_url for OpenAI, anthropic_base_url for Anthropic
toolkit = agent.toolkit(ToolFormat.OPENAI_RESPONSES)
agent.call_tool("search", {"query": "runbook"})
agent.refresh()                                  # re-read the toolkit
agent.connections                                # its own upstream accounts
```

A batch that must not stop halfway:

```python
try:
    agent = tg.connect(requires=["search"])
except UpstreamNotConnectedError as error:
    sys.exit(str(error))   # names each server and who fixes it

for row in rows:
    agent.call_tool("search", {"query": row.query})
```

The gateway serves a tool under the server it came from - Notion's `search` as
`notion_search` - so two servers with a `search` stay apart. That prefix is the
gateway's, so `requires` and `call_tool` take the name the server itself gave the
tool and add it; naming a tool two of your servers serve is the one case they
ask instead.

## An agent acting for one of its users

```python
alice = tg.for_end_user("user_123")
# or, from an agent you already have - no round trip, same toolkit:
bob = agent.for_end_user("user_456")

alice.connections()
alice.connect_link("com.notion/mcp")
alice.toolkit(ToolFormat.ANTHROPIC_MESSAGES)
```

Both handles work on the same application and the same key: who a call runs as
comes from the call, not from anything configured on the application. The name is
yours to choose and the gateway namespaces it, so two applications naming
`user_123` never reach the same account.

## The model call, with tools

```python
toolkit = agent.toolkit(ToolFormat.OPENAI_RESPONSES, strict=True)
for warning in toolkit.warnings:
    log.warning("%s could not be strict: %s", warning.tool, warning.reason)

response = client.responses.create(model="gpt-5.2", tools=toolkit.tools, input=messages)
while any(item.type == "function_call" for item in response.output):
    response = client.responses.create(
        model="gpt-5.2",
        tools=toolkit.tools,
        previous_response_id=response.id,
        input=toolkit.execute(response.output),
    )
```

`execute()` reads the provider's own objects as well as plain dicts, so the
response from the OpenAI or Anthropic SDK can be passed straight in.

## Your own HTTP client

```python
tg = TrustGate(..., transport=MyTransport())
```

`Transport` is a one-method protocol. The default is `UrllibTransport`; the
tests use a fake one. It is also where a retry policy or a proxy belongs.

## Errors

| Class | When |
|---|---|
| `MissingToolsError` | `requires` names a tool the application does not serve |
| `UpstreamNotConnectedError` | a server the application calls has no account behind it; `servers` names them and the message says who connects it |
| `ConsentRequiredError` | an end user has not connected; carries `connect_url` |
| `PolicyBlockedError` | a gateway policy refused the call |
| `ToolNotFoundError` | the tool left the toolkit under a running agent |
| `PlaneUnavailableError` | the key reaches no application on that plane |
| `AuthenticationError`, `RateLimitedError`, `ServiceUnavailableError`, `TrustGateServerError` | as named |

## Development

```bash
uv sync --extra dev
uv run pytest
```

[CONTRIBUTING.md](../CONTRIBUTING.md) has every check CI runs.
