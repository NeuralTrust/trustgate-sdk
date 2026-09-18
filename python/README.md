# trustgate

The TrustGate SDK for Python. 3.10+, standard library only.

```bash
pip install trustgate
```

## Setup

```python
from trustgate import TrustGate, ToolFormat

tg = TrustGate()   # TRUSTGATE_URL + TRUSTGATE_API_KEY
```

Two values, or none if they are in the environment. The consumers behind the
key are asked for: `tg.identity()` reads `GET /whoami` once and remembers it.

```python
identity = tg.identity()
# KeyConsumer(slug="support-agent", type="MCP", url="https://…/support-agent/mcp", acts_for_users=False)
# KeyConsumer(slug="support-llm",   type="LLM", url="https://…/support-llm/v1")
```

`mcp_consumer` and `llm_consumer` (or `TRUSTGATE_MCP_CONSUMER` /
`TRUSTGATE_LLM_CONSUMER`) are only needed when a key reaches two consumers of
the same plane — the SDK names them and refuses rather than guessing.

## An agent that acts as itself

```python
agent = tg.connect(requires=["notion_search"])

agent.mcp                                        # url + headers for a framework
tg.llm()                                         # base_url + api_key for OpenAI/Anthropic
toolkit = agent.toolkit(ToolFormat.OPENAI_RESPONSES)
agent.call_tool("notion_search", {"query": "runbook"})
agent.refresh()                                  # re-read the toolkit
agent.connections                                # its own upstream accounts
```

A batch that must not stop halfway:

```python
try:
    agent = tg.connect(requires=["notion_search"])
except UpstreamNotConnectedError as error:
    sys.exit(f"open {error.connect_url} and sign in to {error.providers}")

for row in rows:
    agent.call_tool("notion_search", {"query": row.query})
```

## An agent that acts for its users

```python
handle = tg.connect()                     # EndUserAgentFactory
alice = handle.for_end_user("user_123")

alice.connections()
alice.connect_link("com.notion/mcp")
alice.toolkit(ToolFormat.ANTHROPIC_MESSAGES)
```

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
| `MissingToolsError` | `requires` names a tool the consumer does not serve |
| `UpstreamNotConnectedError` | the application's own accounts are not signed in |
| `ConsentRequiredError` | an end user has not connected; carries `connect_url` |
| `PolicyBlockedError` | a gateway policy refused the call |
| `ToolNotFoundError` | the tool left the toolkit under a running agent |
| `AppActorUnavailableError` / `EndUserActorUnavailableError` | wrong actor for this consumer |
| `PlaneUnavailableError` | the key reaches no consumer of that plane |
| `AuthenticationError`, `RateLimitedError`, `ServiceUnavailableError`, `TrustGateServerError` | as named |

## Development

```bash
pip install -e ".[dev]"
pytest
```
