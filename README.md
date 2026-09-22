# TrustGate SDK

Point an agent at a TrustGate gateway, in TypeScript or Python.

An admin creates an MCP consumer for the agent and decides which tools it may
reach. This SDK is the other half of that: it hands those tools to whatever is
driving the model, and it answers the three questions MCP itself does not
carry — **which actor** a call speaks as, **which credential** it travels with,
and **what to do when an upstream account is not connected**.

```bash
npm install @neuraltrust/trustgate     # TypeScript, Node 18+
pip install trustgate-sdk              # Python 3.10+
```

## Two ways in, and which one you want

The gateway is an MCP server, so an agent framework that brings its own MCP
client needs nothing from this package but a URL and two headers:

```ts
const agent = await tg.connect({ requires: ['search'] })
new MCPServerStreamableHttp({ url: agent.mcp.url, headers: agent.mcp.headers })
```

That covers the OpenAI Agents SDK, the Claude Agent SDK, LangChain, Mastra and
anything else with an MCP client — no adapter per framework, because the
framework already is one.

When you call a model provider's API directly there is no MCP client anywhere
in the picture, so the SDK lists the tools, translates them into that
provider's function-calling dialect, and runs the calls:

```ts
const { tools, execute } = agent.toolkit<
  OpenAI.Responses.Tool,
  OpenAI.Responses.ResponseInputItem
>(ToolFormat.OpenAIResponses)

let res = await openai.responses.create({ model: 'gpt-5.2', tools, input })
while (res.output.some((o) => o.type === 'function_call')) {
  res = await openai.responses.create({
    model: 'gpt-5.2',
    tools,
    previous_response_id: res.id,
    input: await execute(res.output),
  })
}
```

Every one of those calls still goes through the gateway, so policy, audit and
per-user credentials stay where they were. Your process only decides *whether*
to make the call.

The provider's own types are named at the call, in your project: the SDK
depends on no provider package, so `tools` and the executor's output are
whatever that line says they are, and nothing needs a cast.

`ToolFormat` names providers, not frameworks — `OpenAIResponses`, `OpenAIChat`,
`AnthropicMessages`, `Gemini` — because translating is only ever needed on that
path.

## One secret, nothing else

```ts
const tg = new TrustGate({ baseUrl: 'https://gw.acme.ai', apiKey: 'ag_…' })
```

That is the whole configuration. The consumers behind a key were created by an
admin, in the console, and their slugs never travelled with the key — so the
gateway is asked: `GET /whoami` answers with the consumers this key reaches and
the address of each. Name a slug only when a key reaches two consumers of the
same plane, which the SDK will not guess at.

## The LLM plane

If the gateway also fronts your models, the same key configures the provider's
own client — including its base URL, which lives on a different host from the
MCP one and is the thing no client could work out for itself.

```ts
const llm = await tg.llm()
const openai = new OpenAI({ baseURL: llm.baseUrl, apiKey: llm.apiKey })
```

Nothing is wrapped: wrapping would mean chasing every change OpenAI and
Anthropic make, and breaking streaming on the way. Models and tools, one key,
both governed.

## What `connect()` proves before anything runs

1. **That the tools you need are there.** The toolkit belongs to an admin and
   can be narrowed without warning. `requires` turns that into a refusal at
   startup instead of a failure mid-conversation.
2. **That the servers have an account to call with.** There is no runtime
   remedy for a missing account in a batch: nobody is there to open a connect
   link once it is running. The refusal names the servers and who can connect
   them, which for this handle is never the caller.

```python
try:
    agent = tg.connect(requires=["search", "create_issue"])
except MissingToolsError as e:
    sys.exit(f"the consumer is missing {e.missing}; ask your admin")
except UpstreamNotConnectedError as e:
    sys.exit(str(e))   # names the servers and who has to connect them
```

`tg.identity()` answers the third thing a long run wants to know before it
starts: `key.expires_at`, which is `None` when the key never expires and
otherwise the 401 you would have met somewhere in the middle.

## Agents that act for their users

Naming the person a call is for is a per-call decision, not a setting: the same
key and the same application serve both actors, and the gateway reads which one
from the request.

```ts
const alice = await tg.forEndUser('user_123')

try {
  await alice.toolkit(ToolFormat.OpenAIResponses).execute(response.output)
} catch (error) {
  if (error instanceof ConsentRequiredError) {
    reply(`I need access to ${error.provider}: ${error.connectUrl}`)
  }
}
```

The link arrives inside the error, because that is where the gateway mints it.
`alice.connections()` and `alice.connectLink()` do the same thing ahead of
time, when you would rather ask than fail.

The name is yours to choose. The gateway namespaces it by application, so two
applications naming `user_123` never reach the same account — which is also why
only an application's own credential may assert one: a request carrying a
person's own token is already that person.

## Running something

[`examples/`](examples) holds four programs that run as they are, two per
language — a batch job and an end-user assistant. Each project builds the SDK
from this repository and takes its gateway and key from a `.env` you copy from
the `.env.example` beside it:

```sh
cd examples/python && cp .env.example .env && uv run batch.py
cd examples/typescript && cp .env.example .env && npm install && npm run openai
```

## Reading the docs for your language

- [`typescript/`](typescript) — `@neuraltrust/trustgate`
- [`python/`](python) — `trustgate`

Both track the same gateway contract and the same behaviour; the tests in each
are written against the same cases.

## Requirements

A TrustGate gateway that serves `GET /whoami` and the application-actor form
of `GET /{slug}/connections`. The first is how the SDK resolves a key into its
consumers; the second is the batch preflight. It says so plainly if the gateway
predates either.

## License

Apache 2.0.
